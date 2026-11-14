// `sous status --json` and `sous wait`: what an agent driving a run reads instead of the run's printed log.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog, procStartTime, writeCommand } from '../src/run/index.ts'
import { WAIT_EXIT_CODES } from '../src/contracts/index.ts'
import type { EventBody, RunStatus, RunWait } from '../src/contracts/index.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { sous, runDirOf, waitFor } from './helpers/sous-proc.ts'

async function ran(args: string[], workspace: string) {
  const r = sous(args, workspace, join(workspace, 'sessions'))
  const code = await r.exitWithin()
  return { code, output: r.output() }
}

const json = <T>(output: string) => JSON.parse(output) as T

test('a checks-and-gate run: wait stops at the gate with its commands, status --json says the same as status, and wait ends with the run', async (t) => {
  const workspace = gitWorkspace('sous-wait-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'ship\nit', nodes: [
    { id: 'lint', kind: 'check', command: 'true' },
    { id: 'ship', kind: 'gate', needs: ['lint'], brief: 'Ship it?' },
    { id: 'after', kind: 'check', needs: ['ship'], command: 'true' },
  ] }))
  const run = sous(['run', graph], workspace, join(workspace, 'sessions'))
  t.after(() => run.child.kill('SIGINT'))
  await waitFor(workspace, (e) => e.type === 'run.created')
  const id = runDirOf(workspace)!.split('/').at(-1)!

  const waited = await ran(['wait', '--json', '--timeout', '20'], workspace)
  assert.equal(waited.code, WAIT_EXIT_CODES.waiting, waited.output)
  const w = json<RunWait>(waited.output)
  assert.equal(w.wait, 'waiting')
  assert.deepEqual([w.id, w.state, w.goal, w.mode, w.result], [id, 'running', 'ship\nit', 'git', { branch: `sous/${id}` }])
  assert.deepEqual(w.nodes.map((n) => [n.id, n.kind, n.status, n.summary]), [['lint', 'check', 'completed', 'check passed'], ['ship', 'gate', 'waiting', undefined], ['after', 'check', 'pending', undefined]])
  assert.deepEqual(w.waiting.map(({ seq, ...a }) => a), [{ kind: 'gate', node: 'ship', text: 'Ship it?', commands: { approve: 'sous approve ship', reject: 'sous cancel ship' } }])

  // Waiting again changes nothing: the gate still waits, so wait returns at once instead of blocking.
  const again = await ran(['wait'], workspace)
  assert.equal(again.code, 4)
  assert.match(again.output, new RegExp(`^run ${id} waits for you: approval of gate ship \\(exit 4\\)\\nrun ${id} running: ship\\.\\.\\.\\n`))

  const status = await ran(['status', '--json'], workspace)
  const { at, ...s } = json<RunStatus>(status.output)
  const { at: _at, wait: _wait, ...fromWait } = w
  assert.deepEqual(s, fromWait)
  const text = await ran(['status'], workspace)
  assert.equal(text.output, `run ${id} running: ship...\n  result: branch sous/${id}\n  lint completed: check passed\n  ship waiting\n  after pending\n` +
    'approvals for you (sous approve <node>, or sous cancel <node> to reject):\n  ship: Ship it?\n')

  assert.equal((await ran(['approve', w.waiting[0].node], workspace)).code, 0)
  const done = await ran(['wait', '--timeout', '20'], workspace)
  assert.equal(done.code, WAIT_EXIT_CODES.completed, done.output)
  assert.match(done.output, new RegExp(`^run ${id} completed \\(exit 0\\)\\nrun ${id} completed: ship\\.\\.\\.\\n`))
  assert.equal(await run.exitWithin(), 0, run.output())
})

test('wait reports a run whose supervisor stopped, and status --json says how to resume it', async (t) => {
  const workspace = gitWorkspace('sous-wait-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'g', nodes: [{ id: 'ship', kind: 'gate', brief: 'Ship?' }] }))
  const run = sous(['run', graph], workspace, join(workspace, 'sessions'))
  t.after(() => run.child.kill('SIGINT'))
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'ship')
  run.child.kill('SIGINT')
  assert.equal(await run.exitWithin(), 1, run.output())
  const id = runDirOf(workspace)!.split('/').at(-1)!

  const waited = await ran(['wait', id, '--json'], workspace)
  assert.equal(waited.code, WAIT_EXIT_CODES.stopped, waited.output)
  const w = json<RunWait>(waited.output)
  assert.deepEqual([w.wait, w.state, w.resume, w.waiting.length], ['stopped', 'stopped', `sous resume ${id}`, 1])
  assert.match((await ran(['wait', id], workspace)).output, new RegExp(`^run ${id} stopped before it was over; continue it with: sous resume ${id} \\(exit 5\\)\\n`))
})

/** A run written by hand whose lock names this test process, so it counts as running for as long as the lock is there. */
function handRun(workspace: string, id: string, events: EventBody[]) {
  const runDir = join(workspace, '.sous', 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  for (const e of events) log.append(e)
  log.close()
  const lock = join(runDir, 'lock')
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: procStartTime(process.pid) }) + '\n')
  return { runDir, unlock: () => rmSync(lock) }
}

test('wait does not stop for an ask whose answer is sent but not yet applied, and times out', async () => {
  const workspace = gitWorkspace('sous-wait-')
  const { runDir, unlock } = handRun(workspace, '20261101T000000Z-aaaa', [
    { type: 'run.created', goal: 'g', workspace, mode: 'git' },
    { type: 'node.added', node: { id: 'lead', kind: 'lead', brief: 'b' }, by: 'goal' },
    { type: 'node.added', node: { id: 'ship', kind: 'gate', brief: 'Ship?' }, by: 'graph' },
    { type: 'lead.delivered', node: 'lead', requestId: 'evt-1', text: 'b', mode: 'queue' },
    { type: 'lead.call', node: 'lead', callId: 'c1', call: { tool: 'escalate', question: 'Which one?' }, ok: true, result: 'sent' },
    { type: 'message', from: 'ship', to: 'person', body: 'Ship?', mode: 'queue' },
  ])
  writeCommand(runDir, { type: 'answer', node: 'lead', text: 'That one.' })
  writeCommand(runDir, { type: 'approve', node: 'ship' })
  const sent = await ran(['wait', '--json', '--timeout', '1'], workspace)
  assert.equal(sent.code, WAIT_EXIT_CODES.timeout, sent.output)
  assert.deepEqual(json<RunWait>(sent.output).waiting.map((a) => [a.kind, a.node, a.commands, a.sent]), [
    ['question', 'lead', { answer: 'sous answer lead "<answer>"' }, true],
    ['gate', 'ship', { approve: 'sous approve ship', reject: 'sous cancel ship' }, true],
  ])
  assert.match((await ran(['status'], workspace)).output, /\n {2}lead: Which one\? \(answer sent\)\n/)
  assert.match((await ran(['wait', '--timeout', '0'], workspace)).output, /^run \S+ still running after 0 s \(exit 6\)\n/)

  // Once the supervisor would have refused them (the files gone), the asks wait again.
  rmSync(join(runDir, 'commands'), { recursive: true })
  const asks = await ran(['wait', '--timeout', '5'], workspace)
  assert.equal(asks.code, WAIT_EXIT_CODES.waiting, asks.output)
  assert.match(asks.output, /^run \S+ waits for you: a question from lead, approval of gate ship \(exit 4\)\n/)
  unlock()
})

test('wait exits 3 for a failed run and for one whose lead completed over a failed check; 0 only when it completed clean', async () => {
  const workspace = gitWorkspace('sous-wait-')
  const created: EventBody[] = [
    { type: 'run.created', goal: 'g', workspace, mode: 'git' },
    { type: 'node.added', node: { id: 'lead', kind: 'lead', brief: 'b' }, by: 'goal' },
  ]
  const over: EventBody[] = [
    { type: 'lead.call', node: 'lead', callId: 'c1', call: { tool: 'spawn', children: [{ id: 'c', kind: 'check', command: 'false' }] }, ok: true, result: 'spawned' },
    { type: 'node.failed', node: 'c', reason: 'exit 1' },
    { type: 'lead.call', node: 'lead', callId: 'c2', call: { tool: 'complete', summary: 'done anyway' }, ok: true, result: 'completed with failed checks: c' },
    { type: 'run.completed', summary: 'completed with failed checks: c. done anyway' },
  ]
  handRun(workspace, '20261101T000000Z-aaaa', [...created, ...over]).unlock()
  const flagged = await ran(['wait', '20261101T000000Z-aaaa', '--json'], workspace)
  assert.equal(flagged.code, WAIT_EXIT_CODES.failed, flagged.output)
  const w = json<RunWait>(flagged.output)
  assert.deepEqual([w.state, w.wait, w.nodes[0].failedChecks, w.nodes[1].parent], ['completed', 'failed', ['c'], 'lead'])
  assert.match((await ran(['wait', '20261101T000000Z-aaaa'], workspace)).output, /^run \S+ completed with failed checks \(exit 3\)\n/)

  handRun(workspace, '20261101T000001Z-bbbb', [...created, { type: 'node.failed', node: 'lead', reason: 'gave up' }, { type: 'run.failed', reason: 'failed nodes: lead' }]).unlock()
  const failed = await ran(['wait', '--json'], workspace)
  assert.equal(failed.code, WAIT_EXIT_CODES.failed, failed.output)
  assert.deepEqual([json<RunWait>(failed.output).state, json<RunWait>(failed.output).reason], ['failed', 'failed nodes: lead'])
  assert.match((await ran(['status'], workspace)).output, /^run \S+ failed: g\n {2}failed nodes: lead\n/)
})
