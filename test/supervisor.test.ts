import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog, readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { NodeSpec } from '../src/types.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })

async function runGraph(nodes: NodeSpec[], graceMs?: number) {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-ws-'))
  const runDir = join(workspace, 'run')
  mkdirSync(runDir)
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test goal', workspace })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  log.close()
  const sessions = join(workspace, 'sessions')
  const outcome = await runSupervisor({ workspace, runDir, getAdapter: () => fakeAdapter(sessions), graceMs })
  const events = readEvents(runDir)
  return { workspace, outcome, events, state: fold(events), sessions }
}

const work = (id: string, steps: FakeStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'work', harness: 'claude', brief: `Do ${id}.\n${fakePlan(steps)}`, ...extra })

test('a work node then a check node completes the run', async () => {
  const { workspace, outcome, events, state } = await runGraph([
    work('build', [{ write: { 'out.txt': 'hello\n' }, result: done('wrote out.txt') }]),
    { id: 'verify', kind: 'check', command: 'grep -q hello out.txt && echo verified', needs: ['build'] },
  ])
  assert.equal(outcome, 'completed')
  assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'hello\n')
  assert.deepEqual(events.map((e) => e.type), [
    'run.created', 'node.added', 'node.added',
    'turn.started', 'turn.session', 'turn.ended', 'node.completed',
    'check.ended', 'node.completed', 'run.completed',
  ])
  assert.equal(state.nodes.get('verify')?.checks[0].output, 'verified\n')
  assert.deepEqual(state.nodes.get('build')?.turns[0].result, done('wrote out.txt'))
})

test('a failing acceptance check resumes the session with the check output, then passes', async () => {
  const { outcome, state, sessions } = await runGraph([
    work('fix', [
      { write: { 'v.txt': 'bad' }, result: done('first try') },
      { write: { 'v.txt': 'good' }, result: done('fixed') },
    ], { command: 'cat v.txt; grep -q good v.txt' }),
  ])
  assert.equal(outcome, 'completed')
  const node = state.nodes.get('fix')!
  assert.equal(node.summary, 'fixed')
  assert.deepEqual(node.turns.map((t) => [t.mode, t.check?.exitCode]), [['start', 1], ['resume', 0]])
  assert.equal(node.turns[0].sessionId, node.turns[1].sessionId)
  const session = JSON.parse(readFileSync(join(sessions, `${node.turns[0].sessionId}.json`), 'utf8'))
  assert.match(session.prompts[1], /acceptance check failed \(exit code 1\)[\s\S]*bad/)
})

test('a node that stays failing after two fix rounds fails', async () => {
  const bad = { result: done('tried') }
  const { outcome, state } = await runGraph([work('stuck', [bad, bad, bad, bad], { command: 'false' })])
  assert.equal(outcome, 'failed')
  const node = state.nodes.get('stuck')!
  assert.equal(node.turns.length, 3)
  assert.match(node.reason!, /after 2 fix rounds/)
})

test('a failed node fails every node that needs it, transitively', async () => {
  const { outcome, state, events } = await runGraph([
    work('a', [{ result: { status: 'needs_input', summary: 'unclear', question: 'which file?' } }]),
    work('b', [{ result: done('b') }], { needs: ['a'] }),
    { id: 'c', kind: 'check', command: 'true', needs: ['b'] },
    work('d', [{ result: done('d') }]),
  ])
  assert.equal(outcome, 'failed')
  assert.equal(state.nodes.get('a')?.reason, 'needs_input: which file?')
  assert.equal(state.nodes.get('b')?.reason, 'needs a, which failed')
  assert.equal(state.nodes.get('c')?.reason, 'needs b, which failed')
  assert.equal(state.nodes.get('d')?.status, 'completed')
  assert.equal(state.nodes.get('b')?.turns.length, 0)
  assert.equal(events.at(-1)?.type, 'run.failed')
})

test('a missing result gets one reminder; a second miss fails the node', async () => {
  const { state } = await runGraph([
    work('ok', [{}, { result: done('done after reminder') }]),
    work('never', [{}, {}]),
  ])
  assert.equal(state.nodes.get('ok')?.status, 'completed')
  assert.equal(state.nodes.get('ok')?.turns[0].error, 'no end-of-turn marker in the output')
  assert.equal(state.nodes.get('never')?.status, 'failed')
  assert.equal(state.nodes.get('never')?.turns.length, 2)
})

test('a turn that keeps running after its result is stopped after the grace period', async () => {
  const started = Date.now()
  const { outcome, state } = await runGraph([work('linger', [{ result: done('ok'), lingerMs: 60_000 }])], 300)
  assert.equal(outcome, 'completed')
  assert.ok(Date.now() - started < 10_000)
  assert.equal(state.nodes.get('linger')?.turns[0].signal, 'SIGTERM')
})

test('writing nodes run one at a time; read-only nodes run alongside', async () => {
  const slow = [{ sleepMs: 300, result: done('ok') }]
  const { outcome, events } = await runGraph([
    work('w1', slow), work('w2', slow), work('r1', slow, { readOnly: true }), work('r2', slow, { readOnly: true }),
  ])
  assert.equal(outcome, 'completed')
  const span = (node: string) => {
    const at = (type: string) => events.find((e) => e.type === type && 'node' in e && e.node === node)!.seq
    return [at('turn.started'), at('turn.ended')]
  }
  const overlap = (a: string, b: string) => span(a)[0] < span(b)[1] && span(b)[0] < span(a)[1]
  assert.equal(overlap('w1', 'w2'), false)
  assert.equal(overlap('r1', 'r2'), true)
  assert.equal(overlap('w1', 'r1'), true)
})

const grandchildOf = (sessions: string) =>
  Number(readFileSync(join(sessions, readdirSync(sessions).find((f) => f.endsWith('.grandchild'))!), 'utf8'))

test('processes a worker leaves behind are stopped before its turn counts as ended', async () => {
  const { outcome, sessions } = await runGraph([work('bg', [{ spawnSleeper: true, result: done('ok') }])])
  assert.equal(outcome, 'completed')
  assert.throws(() => process.kill(grandchildOf(sessions), 0), /ESRCH/)
})

test('a group that ignores SIGTERM is killed before the supervisor finishes', async () => {
  const { outcome, sessions } = await runGraph([work('stubborn', [{ spawnSleeper: 'ignore-term', result: done('ok'), lingerMs: 60_000 }])], 200)
  assert.equal(outcome, 'completed')
  assert.throws(() => process.kill(grandchildOf(sessions), 0), /ESRCH/)
})
