import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { main } from '../src/cli.ts'
import { readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRecords, fakeLeadRunner } from './fixtures/fake-lead.ts'
import { fakeBin, murm, runDirOf, waitFor } from './fixtures/murm-proc.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

function setup(steps: FakeStep[]) {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a greeting',
    agent: 'claude',
    nodes: [
      { id: 'write', kind: 'work', brief: `Write hello.txt.\n${fakePlan(steps)}` },
      { id: 'test', kind: 'check', command: 'grep -q hello hello.txt', needs: ['write'] },
    ],
  }))
  return { workspace, graph, sessions: join(workspace, 'sessions') }
}

test('murm run completes a work then check graph and murm status shows it', async () => {
  const { workspace, graph, sessions } = setup([{ write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello.txt' } }])
  const run = murm(['run', graph], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /turn.ended +write turn 1 done: wrote hello.txt/)
  assert.match(run.output(), /run.completed +2 nodes completed/)
  const runDir = runDirOf(workspace)!
  assert.match(runDir, /\/\d{8}T\d{6}Z-[0-9a-f]{4}$/)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).goal, 'write a greeting')
  assert.equal(existsSync(join(runDir, 'lock')), false)

  const status = murm(['status', '--workspace', workspace], tmpdir(), sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /^run \S+ completed: write a greeting\n  write completed on claude turns 1: wrote hello.txt\n  test completed/)
})

test('murm run checks the agents on PATH: a node without an agent falls back to codex; a node naming claude fails', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write two files',
    nodes: [
      { id: 'any', kind: 'work', brief: `Write a.\n${fakePlan([{ write: { 'a.txt': 'a' }, result: { status: 'done', summary: 'wrote a' } }])}` },
      { id: 'pinned', kind: 'work', agent: 'claude', brief: `Write b.\n${fakePlan([{ result: { status: 'done', summary: 'wrote b' } }])}` },
    ],
  }))
  // Only codex and pi are on PATH: no claude, and no other directory.
  const run = murm(['run', graph], workspace, join(workspace, 'sessions'), fakeBin(['codex', 'pi']))
  assert.equal(await run.exit, 1, run.output())
  assert.match(run.output(), /^agents: codex, pi, lead; not available: claude \(claude not found\)$/m)
  const state = fold(readEvents(runDirOf(workspace)!))
  assert.deepEqual([state.nodes.get('any')!.status, state.nodes.get('any')!.turns[0].agent], ['completed', 'codex'])
  assert.equal(state.nodes.get('pinned')!.reason, 'agent claude is not available (claude not found)')
  assert.match(run.output(), /turn.started +any turn 1 start on codex pid/)
})

test("a graph that shadows a built-in with a lead agent: a work node's default skips it for the next worker agent", async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a', agents: { claude: { runs: 'lead' } },
    nodes: [{ id: 'w', kind: 'work', brief: `Write a.\n${fakePlan([{ result: { status: 'done', summary: 'wrote a' } }])}` }],
  }))
  const run = murm(['run', graph], workspace, join(workspace, 'sessions'))
  assert.equal(await run.exit, 0, run.output())
  assert.equal(fold(readEvents(runDirOf(workspace)!)).nodes.get('w')!.turns[0].agent, 'codex')
})

test("a lead whose node model is on another provider runs when that provider, not the default one, has a credential", async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const graph = join(workspace, 'graph.json')
  const brief = `Plan.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'planned' }] }])}`
  writeFileSync(graph, JSON.stringify({ goal: 'plan', nodes: [{ id: 'planner', kind: 'lead', model: 'openai-codex/gpt-5.5', brief }] }))
  const code = await main(['run', graph, '--workspace', workspace], {
    getAdapter: () => { throw new Error('no workers in this run') },
    createLeadRunner: fakeLeadRunner,
    hasLeadCredential: async (provider) => provider === 'openai-codex',
  })
  assert.equal(code, 0)
  assert.equal(fold(readEvents(runDirOf(workspace)!)).nodes.get('planner')!.summary, 'planned')
})

test('SIGINT stops the running turn group, a SIGTERM-ignoring grandchild included, and leaves the run resumable', async () => {
  const { workspace, graph, sessions } = setup([{ spawnSleeper: 'ignore-term', sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])
  const run = murm(['run', graph], workspace, sessions)
  let grandchild: number | undefined
  for (let i = 0; i < 100 && grandchild === undefined; i++) {
    await sleep(100)
    const file = existsSync(sessions) && readdirSync(sessions).find((f) => f.endsWith('.grandchild'))
    if (file) grandchild = Number(readFileSync(join(sessions, file), 'utf8'))
  }
  assert.ok(grandchild, 'the worker started its grandchild')
  run.child.kill('SIGINT')
  assert.equal(await run.exit, 1, run.output())

  const events = readEvents(runDirOf(workspace)!)
  const types = events.map((e) => e.type)
  assert.deepEqual(types.slice(-2), ['turn.interrupted', 'turn.ended'])
  assert.ok(!types.includes('run.failed'))
  const started = events.find((e) => e.type === 'turn.started')!
  assert.throws(() => process.kill(started.type === 'turn.started' ? started.pid : 0, 0), /ESRCH/)
  // The supervisor exits only after the group is gone: SIGKILL after the 5 s grace for this grandchild.
  assert.throws(() => process.kill(grandchild!, 0), /ESRCH/)
  assert.equal(existsSync(join(runDirOf(workspace)!, 'lock')), false)
  assert.match(run.output(), /continue with: murm resume /)
})

test('murm cancel from another terminal cancels a subtree, stops its worker and cancels its lead', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const sessions = join(workspace, 'sessions')
  const worker = { id: 'w', kind: 'work' as const, brief: `Wait.\n${fakePlan([{ sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])}` }
  const sub = { id: 'sub', kind: 'lead' as const, brief: `Run w.\n${fakeLeadPlan([{ calls: [{ tool: 'spawn', children: [worker] }] }])}` }
  const goal = `Ship it.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [sub] }] },
    { calls: [{ tool: 'complete', summary: 'shipped without sub' }] },
  ])}`
  const run = murm(['run', goal], workspace, sessions)
  const started = await waitFor(workspace, (e) => e.type === 'turn.started' && e.node === 'w')
  const cancel = murm(['cancel', 'sub'], workspace, sessions)
  assert.equal(await cancel.exit, 0, cancel.output())
  assert.equal(await run.exit, 0, run.output())

  const runDir = runDirOf(workspace)!
  const state = fold(readEvents(runDir))
  assert.deepEqual(['sub', 'w'].map((id) => state.nodes.get(id)!.reason), ['cancelled by person', 'cancelled by person'])
  assert.equal(state.nodes.get('w')!.turns[0].interrupted?.reason, 'cancelled by person')
  assert.throws(() => process.kill(started.type === 'turn.started' ? started.pid : 0, 0), /ESRCH/)
  assert.deepEqual(fakeLeadRecords(runDir).filter((r) => r.op === 'cancel'), [{ op: 'cancel', node: 'sub' }])
  assert.equal(state.summary, 'shipped without sub')
  assert.deepEqual(readdirSync(join(runDir, 'commands')), [])
})

test('murm answer delivers to a lead that asked the person, and murm status lists the question', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const sessions = join(workspace, 'sessions')
  const goal = `Pick a database.\n${fakeLeadPlan([
    { calls: [{ tool: 'escalate', question: 'Which database?' }] },
    { calls: [{ tool: 'complete', summary: 'picked' }] },
  ])}`
  const run = murm(['run', goal], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'lead.turn')
  assert.match(run.output(), /Question from lead:\nWhich database\?\nAnswer with: murm answer lead/)

  const status = murm(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /\n  lead waiting\nquestions for you \(murm answer <node> "<answer>"\):\n  lead: Which database\?\n$/)

  const answer = murm(['answer', 'lead', 'Postgres.'], workspace, sessions)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await run.exit, 0, run.output())
  const events = readEvents(runDirOf(workspace)!)
  const message = events.find((e) => e.type === 'message')!
  assert.deepEqual(message.type === 'message' && [message.from, message.to, message.body], ['person', 'lead', 'Postgres.'])
  const last = events.findLast((e) => e.type === 'lead.delivered')!
  assert.deepEqual(last.type === 'lead.delivered' && [last.requestId, last.text], [`evt-${message.seq}`, 'Message from person:\nPostgres.'])
})
