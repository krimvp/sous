// What the supervisor records when something under it breaks: a lead runner that cannot take a delivery, a harness
// that cannot start, a turn whose output cannot be read, a merge that fails, a graph nothing can start.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { getAdapter } from '../src/adapters/index.ts'
import { openLog, readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { Event, EventBody, LeadRunner, NodeSpec, TurnSpec, WorkerAdapter } from '../src/types.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import { git, gitWorkspace } from './fixtures/git-repo.ts'
import { fakeBin } from './fixtures/sous-proc.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'work', agent: 'claude', brief: `Do ${id}.\n${fakePlan([{ write: { [`${id}.txt`]: id }, result: done(`did ${id}`) }])}`, ...extra })

/** Runs `nodes` (added by the graph) to the end, with the real adapters unless `adapter` replaces the worker. */
async function run(nodes: NodeSpec[], opts: { adapter?: (sessions: string) => WorkerAdapter; onEvent?: (e: Event, workspace: string) => void; lead?: LeadRunner; more?: EventBody[] } = {}) {
  const workspace = gitWorkspace('sous-err-')
  const runDir = join(workspace, 'run')
  mkdirSync(runDir)
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'goal', workspace })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  for (const body of opts.more ?? []) log.append(body)
  log.close()
  const sessions = join(workspace, 'sessions')
  const adapter = opts.adapter?.(sessions)
  const outcome = await runSupervisor({
    workspace, runDir, graceMs: 200,
    getAdapter: (name) => adapter ?? getAdapter(name),
    ...(opts.lead ? { createLeadRunner: () => opts.lead! } : {}),
    onEvent: opts.onEvent && ((e) => opts.onEvent!(e, workspace)),
  })
  const events = readEvents(runDir)
  return { workspace, runDir, outcome, events, state: fold(events) }
}

const of = <T extends Event['type']>(events: Event[], type: T) => events.filter((e): e is Extract<Event, { type: T }> => e.type === type)

test('a lead runner that cannot take a delivery fails the lead and everything below it, and the run', { timeout: 30_000 }, async () => {
  const lead: LeadRunner = {
    deliver: async () => { throw new Error('no provider reachable') },
    cancel: async () => {}, resume: async () => {}, close: async () => {},
  }
  const { outcome, state, events } = await run([
    { id: 'boss', kind: 'lead', brief: 'Lead.' },
    // Below the lead, waiting for the person: the lead's failure ends it too.
    { id: 'approve', kind: 'gate', parent: 'boss', brief: 'Ship it?' },
  ], { lead })
  assert.equal(outcome, 'failed')
  assert.deepEqual(of(events, 'node.failed').map((e) => [e.node, e.reason]), [
    ['boss', 'lead runner: no provider reachable'], ['approve', 'lead boss failed'],
  ])
  assert.equal(state.reason, 'failed nodes: boss')
})

test('a harness that is not installed fails its node with the command named, and the run', { timeout: 30_000 }, async () => {
  const path = process.env.PATH
  process.env.PATH = fakeBin([], ['git']) // git, and no claude
  try {
    const { outcome, state, events } = await run([work('w')])
    assert.equal(outcome, 'failed')
    const [failed] = of(events, 'node.failed')
    assert.equal(failed?.node, 'w')
    assert.match(failed!.reason, /^supervisor error: could not start claude in \S+/)
    assert.equal(state.nodes.get('w')!.turns.length, 0, 'no turn started')
    assert.equal(of(events, 'run.failed').length, 1)
  } finally {
    process.env.PATH = path
  }
})

test("a turn whose output file cannot be read ends with that error, and the node's missing result is reminded once", { timeout: 30_000 }, async () => {
  // The worker ran, but its output is gone by the time the supervisor reads it.
  const vanishing = (sessions: string): WorkerAdapter => {
    const fake = fakeAdapter(sessions)
    const lose = (turn: ReturnType<WorkerAdapter['start']>, spec: TurnSpec) => ({ ...turn, exit: turn.exit.then((exit) => (rmSync(spec.outFile), exit)) })
    return { ...fake, start: (spec) => lose(fake.start(spec), spec), resume: (spec) => lose(fake.resume(spec), spec) }
  }
  const { outcome, state } = await run([work('w')], { adapter: vanishing })
  assert.equal(outcome, 'failed')
  const turns = state.nodes.get('w')!.turns
  assert.equal(turns.length, 2, 'one reminder, then the node fails')
  for (const turn of turns) {
    assert.match(turn.error!, /^cannot read turn output: ENOENT/)
    assert.equal(turn.result, undefined)
  }
  assert.equal(state.nodes.get('w')!.reason, 'turn 2 ended without a structured result')
})

test("a merge that throws fails the node with merge.failed, and the node's dependents fail with it", { timeout: 30_000 }, async () => {
  // The node's branch and worktree disappear as it joins the merge queue.
  const worktrees = new Map<string, { path: string; branch: string }>()
  const { outcome, state, events } = await run([work('w'), work('after', { needs: ['w'] })], {
    adapter: fakeAdapter,
    onEvent(e, workspace) {
      if (e.type === 'worktree.created') worktrees.set(e.node, { path: e.path, branch: e.branch })
      if (e.type === 'merge.queued' && e.node === 'w') {
        const tree = worktrees.get('w')!
        git(workspace, 'worktree', 'remove', '--force', tree.path)
        git(workspace, 'branch', '-D', tree.branch)
      }
    },
  })
  assert.equal(outcome, 'failed')
  const failed = of(events, 'merge.failed')
  assert.deepEqual(failed.map((e) => e.node), ['w'])
  assert.match(failed[0]!.reason, /^supervisor error: /)
  assert.match(state.nodes.get('w')!.reason!, /^merge failed: supervisor error: /)
  assert.equal(state.nodes.get('after')!.reason, 'needs w, which failed')
  assert.equal(of(events, 'merge.done').length, 0)
})

test('a graph whose nodes wait for each other forever fails the run with run.failed: no node can start', { timeout: 30_000 }, async () => {
  // A cycle cannot be written as a graph file, but a log can hold one.
  const { outcome, state, events } = await run([work('a', { needs: ['b'] }), work('b', { needs: ['a'] })], { adapter: fakeAdapter })
  assert.equal(outcome, 'failed')
  assert.deepEqual(of(events, 'run.failed').map((e) => e.reason), ['no node can start'])
  assert.equal(state.reason, 'no node can start')
  assert.deepEqual(of(events, 'turn.started'), [])
})
