// `sous run --max-cost`: a run stops once the cost its turns reported reaches its budget, and continues only with a
// higher one, through real `sous` processes and fake workers that report usage as Claude Code does.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fold, readEvents } from '../src/run/index.ts'
import type { Event, NodeSpec, RunStatus, RunWait } from '../src/contracts/index.ts'
import { WAIT_EXIT_CODES } from '../src/contracts/index.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { fakePlan } from './helpers/fake-adapter.ts'
import { sous, runDirOf, waitFor } from './helpers/sous-proc.ts'
import type { FakeStep } from './helpers/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, steps: FakeStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'work', brief: `Do ${id}.\n${fakePlan(steps)}`, ...extra })
const tokens = { inputTokens: 1000, outputTokens: 10, cachedTokens: 0 }

function workspaceWith(nodes: NodeSpec[]) {
  const workspace = gitWorkspace('sous-budget-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'g', agent: 'claude', nodes }))
  return { workspace, graph, sessions: join(workspace, 'sessions') }
}

async function ran(args: string[], workspace: string, sessions: string) {
  const r = sous(args, workspace, sessions)
  const code = await r.exitWithin()
  return { code, output: r.output() }
}

const turnsOf = (runDir: string) => {
  const state = fold(readEvents(runDir))
  return Object.fromEntries([...state.nodes.values()].filter((n) => !n.spec.standing).map((n) => [n.spec.id, n.turns.length]))
}

test('a run stops at its budget: no new turn, running turns stopped resumable; status, wait and resume say how to go on', async () => {
  const { workspace, graph, sessions } = workspaceWith([
    // Like Claude Code, a's second turn reports its session's running total: it costs 0.15, not 0.45.
    work('a', [
      { write: { 'hello.txt': 'nope\n' }, result: done('wrote it'), usage: { ...tokens, sessionCostUsd: 0.3 } },
      { write: { 'hello.txt': 'hello\n' }, result: done('fixed it'), usage: { ...tokens, sessionCostUsd: 0.45 } },
    ], { command: 'grep -q hello hello.txt' }),
    work('slow', [{ say: 'working', sleepMs: 60_000, result: done('too late') }, { result: done('slow resumed') }]),
    // Turns that report no cost, as Codex and Droid workers do: not counted, and said once.
    work('d', [{ result: done('d'), usage: tokens }]),
    work('e', [{ result: done('e'), usage: tokens }]),
    work('b', [{ result: done('b'), usage: { ...tokens, costUsd: 0.1 } }], { needs: ['a'] }),
    work('c', [{ result: done('c') }], { needs: ['b'] }),
  ])
  const run = sous(['run', graph, '--max-cost', '0.5'], workspace, sessions)
  assert.equal(await run.exitWithin(), 1, run.output())
  const runDir = runDirOf(workspace)!
  const id = runDir.split('/').at(-1)!
  const events = readEvents(runDir)
  const created = events[0]
  assert.equal(created.type === 'run.created' && created.maxCost, 0.5)
  // a's two turns (0.45) stay under the budget, so b runs; b's 0.10 reaches it.
  const reached = events.filter((e) => e.type === 'budget.reached')
  assert.equal(reached.length, 1)
  assert.ok(reached[0].type === 'budget.reached' && Math.abs(reached[0].spentUsd - 0.55) < 1e-9 && reached[0].maxCostUsd === 0.5)
  assert.deepEqual(turnsOf(runDir), { a: 2, slow: 1, d: 1, e: 1, b: 1, c: 0 })
  const slow = fold(events).nodes.get('slow')!.turns[0]
  assert.equal(slow.interrupted?.reason, 'the run reached its cost budget')
  assert.ok(!events.some((e) => e.seq > reached[0].seq && e.type === 'turn.started'), 'no turn starts after the budget is reached')

  const out = run.output()
  assert.match(out, /^budget: \$0\.50 of reported cost; a cost is known when a turn ends, so running turns can overshoot it, and turns that report no cost \(Codex and Droid workers, leads and Pi workers on Ollama\) are not counted$/m)
  assert.equal(out.match(/^note: .* reported no cost; turns that report none are not counted against the \$0\.50 budget$/gm)?.length, 1, out)
  assert.match(out, /budget\.reached +\$0\.55 reported of a \$0\.50 budget: no new turn starts, running turns are stopped/)
  const usage = 'usage: 5,000 tokens in (0 cached), 50 out; $0.55 cost reported of a $0.50 budget (2 turns reported no cost and are not counted against it)'
  const stopped = `stopped at its cost budget: $0.55 reported of $0.50 (a cost is known when a turn ends, so turns in flight can overshoot)`
  assert.ok(out.endsWith(`${usage}\n${stopped}; continue with a higher budget: sous resume ${id} --max-cost <usd>\n`), out)

  const status = await ran(['status'], workspace, sessions)
  assert.match(status.output, new RegExp(`^run ${id} stopped: g\n  ${stopped.replace(/[$().]/g, '\\$&')}\n  result: [^\n]+\n  ${usage.replace(/[$().]/g, '\\$&')}\n`))
  assert.match(status.output, new RegExp(`\ncontinue it with: sous resume ${id} --max-cost <usd>\n`))
  const json: RunStatus = JSON.parse((await ran(['status', '--json'], workspace, sessions)).output)
  assert.deepEqual([json.state, json.resume, json.usage?.maxCostUsd, json.usage?.unpriced, json.budget?.maxCostUsd], ['stopped', `sous resume ${id} --max-cost <usd>`, 0.5, 2, 0.5])
  assert.ok(Math.abs(json.budget!.spentUsd - 0.55) < 1e-9)
  const waited = await ran(['wait', '--json'], workspace, sessions)
  assert.equal(waited.code, WAIT_EXIT_CODES.stopped, waited.output)
  assert.equal((JSON.parse(waited.output) as RunWait).wait, 'stopped')
  assert.match((await ran(['wait'], workspace, sessions)).output, new RegExp(
    `^run ${id} stopped at its cost budget \\(\\$0\\.55 reported of \\$0\\.50\\); continue it with a higher budget: sous resume ${id} --max-cost <usd> \\(exit 5\\)\n`))

  // Without a budget above what was spent, the run is not resumed, and nothing is appended.
  const before = readEvents(runDir).length
  for (const args of [['resume'], ['resume', '--max-cost', '0.52']]) {
    const refused = await ran(args, workspace, sessions)
    assert.equal(refused.code, 1, refused.output)
    assert.match(refused.output, new RegExp(`^sous: run ${id} stopped at its cost budget: \\$0\\.55 reported of \\$0\\.5[02]; continue it with a higher budget: sous resume ${id} --max-cost <usd> with more than \\$0\\.55$`, 'm'))
  }
  assert.equal(readEvents(runDir).length, before)

  // A higher budget continues it: the stopped turn's session resumes, the finished turns are not run again.
  const resumed = await ran(['resume', '--max-cost', '2'], workspace, sessions)
  assert.equal(resumed.code, 0, resumed.output)
  const after = readEvents(runDir)
  assert.ok(after.some((e) => e.type === 'run.resumed' && e.maxCost === 2))
  assert.deepEqual(turnsOf(runDir), { a: 2, slow: 2, d: 1, e: 1, b: 1, c: 1 })
  const state = fold(after)
  assert.deepEqual([state.status, state.nodes.get('slow')!.turns[1].recovery, state.nodes.get('slow')!.summary], ['completed', true, 'slow resumed'])
  assert.match(resumed.output, /\$0\.55 cost reported of a \$2\.00 budget/)
})

test('a turn that ended past the budget while the supervisor was down: resume stops again without a turn; a higher budget finishes it', async () => {
  const { workspace, graph, sessions } = workspaceWith([
    work('w', [{ sleepMs: 500, result: done('finished while down'), usage: { ...tokens, costUsd: 0.6 } }]),
    work('x', [{ result: done('x') }], { needs: ['w'] }),
  ])
  const run = sous(['run', graph, '--max-cost', '0.5'], workspace, sessions)
  const started = await waitFor(workspace, (e) => e.type === 'turn.started' && e.node === 'w')
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  const pid = (started as Extract<Event, { type: 'turn.started' }>).pid
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0)
      await sleep(50)
    } catch {
      break
    }
  }
  // The log has no cost yet, so resume starts; recovering w's turn records its cost, and the run stops at once.
  const first = await ran(['resume'], workspace, sessions)
  assert.equal(first.code, 1, first.output)
  assert.match(first.output, /stopped at its cost budget: \$0\.60 reported of \$0\.50 .*; continue with a higher budget: sous resume \S+ --max-cost <usd>\n$/)
  assert.deepEqual(turnsOf(runDir), { w: 1, x: 0 })
  assert.equal(readEvents(runDir).filter((e) => e.type === 'budget.reached').length, 1)

  // The same refused state again: the spend is in the log now.
  const again = await ran(['resume'], workspace, sessions)
  assert.equal(again.code, 1, again.output)
  assert.match(again.output, /^sous: run \S+ stopped at its cost budget: \$0\.60 reported of \$0\.50/m)

  const raised = await ran(['resume', '--max-cost', '1'], workspace, sessions)
  assert.equal(raised.code, 0, raised.output)
  assert.deepEqual(turnsOf(runDir), { w: 1, x: 1 })
  assert.equal(fold(readEvents(runDir)).status, 'completed')
})
