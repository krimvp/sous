// Merging through real git repositories: node worktrees, the merge queue, the integrator, and resume mid-merge.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createIntegration, createNodeWorktree, mergeInProgress } from '../src/git.ts'
import { openLog, readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { SupervisorOptions } from '../src/supervisor.ts'
import { toAtif } from '../src/trace/atif.ts'
import { toOtlp } from '../src/trace/otlp.ts'
import { loadRun } from '../src/trace/run.ts'
import { INTEGRATOR } from '../src/types.ts'
import type { Event, GraphFile, LeadHost, NodeSpec } from '../src/types.ts'
import { checkAtif } from './atif-checker.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRunner } from './fixtures/fake-lead.ts'
import type { FakeLeadStep } from './fixtures/fake-lead.ts'
import { git, gitWorkspace } from './fixtures/git-repo.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'
import { sous } from './fixtures/sous-proc.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, steps: FakeStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'work', agent: 'claude', brief: `Do ${id}.\n${fakePlan(steps)}`, ...extra })
/** A graph-defined integrator that plays `steps`: its standing instructions come first in its prompt. */
const integrator = (steps: FakeStep[]): GraphFile['agents'] => ({ integrator: { runs: 'codex', instructions: fakePlan(steps) } })
/** A worker step waits for this until node a is merged into the integration branch, so its edit comes second. */
const AFTER_A = "git log --format=%s sous/r1 | grep -qx 'sous: merge a'"
const COMMIT = 'git -c user.name=I -c user.email=i@example.com commit -q --no-edit'

/** Runs `nodes` in a git workspace whose first commit holds `files`. */
async function runGraph(nodes: NodeSpec[], opts: { files?: Record<string, string>; agents?: GraphFile['agents']; workspace?: string } & Partial<SupervisorOptions> = {}) {
  const workspace = opts.workspace ?? gitWorkspace('sous-merge-', opts.files)
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test goal', workspace, graph: { goal: 'test goal', agents: opts.agents, nodes } })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  log.close()
  const sessions = join(workspace, 'sessions')
  const adapter = fakeAdapter(sessions)
  const outcome = await runSupervisor({ workspace, runDir, getAdapter: () => adapter, createLeadRunner: opts.createLeadRunner ?? fakeLeadRunner, onEvent: opts.onEvent })
  const events = readEvents(runDir)
  const integration = join(runDir, 'integration')
  const prompts = (node: string) => {
    const session = fold(events).nodes.get(node)!.turns[0].sessionId
    return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts as string[]
  }
  return { workspace, runDir, integration, outcome, events, state: fold(events), prompts }
}

const mergeDone = (events: Event[], node: string) => events.flatMap((e) => (e.type === 'merge.done' && e.node === node ? [e] : []))[0]
const show = (cwd: string, path: string) => git(cwd, 'show', `sous/r1:${path}`)

test('two work nodes run in parallel in their own worktrees, both merge, and a check that needs both sees both', async (t) => {
  // Each worker waits until the other is running, so the turns overlap however slowly they start. The wait is
  // bounded (10 s), so turns that never overlap fail the test below instead of hanging it.
  const rendezvous = mkdtempSync(join(tmpdir(), 'sous-rendezvous-'))
  t.after(() => rmSync(rendezvous, { recursive: true, force: true }))
  const slow = (file: string, other: string): FakeStep[] => [{
    write: { [file]: `${file}\n` },
    sh: `touch '${join(rendezvous, file)}'; i=0; until [ -e '${join(rendezvous, other)}' ] || [ $i -ge 500 ]; do sleep 0.02; i=$((i+1)); done`,
    result: done(`wrote ${file}`),
  }]
  const { workspace, runDir, integration, outcome, events, state, prompts } = await runGraph([
    work('a', slow('a.txt', 'b.txt')),
    work('b', slow('b.txt', 'a.txt')),
    { id: 'both', kind: 'check', command: 'cat a.txt b.txt', needs: ['a', 'b'] },
  ])
  assert.equal(outcome, 'completed')
  const span = (node: string) => ['turn.started', 'turn.ended'].map((type) => events.find((e) => e.type === type && 'node' in e && e.node === node)!.seq)
  assert.ok(span('a')[0] < span('b')[1] && span('b')[0] < span('a')[1], 'the two turns overlap')
  assert.ok(prompts('a')[0].includes([
    `Work in the directory ${join(runDir, 'worktrees', 'a')}, a git worktree on branch sous/r1.a; sous commits your changes there when you finish.`,
    'Do not switch branches, commit elsewhere, stash, reset or push. Do only this task.',
  ].join('\n')))
  assert.deepEqual(['a', 'b'].map((n) => mergeDone(events, n)?.by), ['supervisor', 'supervisor'])
  assert.equal(state.nodes.get('both')!.checks[0].output, 'a.txt\nb.txt\n')
  assert.equal(show(workspace, 'b.txt'), 'b.txt')
  assert.equal(existsSync(join(workspace, 'a.txt')), false, "the person's checkout is untouched")
  assert.equal(git(integration, 'status', '--porcelain', '--untracked-files=no'), '')
  // A node completes with its merge: a check that needs it starts after merge.done.
  const doneB = mergeDone(events, 'b')!.seq
  assert.ok(events.find((e) => e.type === 'check.ended' && e.node === 'both')!.seq > doneB)
})

test('a worker that switches its worktree to another branch fails its node, and nothing of it is committed or merged', async () => {
  const { integration, outcome, events, state, runDir } = await runGraph([
    work('stray', [{ write: { 'stray.txt': 'stray\n' }, sh: 'git switch -q -c other', result: done('wrote stray.txt') }]),
  ])
  assert.equal(outcome, 'failed')
  const tree = join(runDir, 'worktrees', 'stray')
  assert.equal(state.nodes.get('stray')!.reason,
    `the worker left branch sous/r1.stray: its worktree ${tree} is on branch other, so its work is not committed or merged`)
  assert.ok(!events.some((e) => e.type === 'merge.queued'))
  assert.equal(git(tree, 'status', '--porcelain'), '?? stray.txt', 'sous committed nothing')
  assert.equal(existsSync(join(integration, 'stray.txt')), false)
})

test('a node with no changes merges by nothing', async () => {
  const { outcome, events, state } = await runGraph([work('noop', [{ result: done('nothing to change') }])])
  assert.equal(outcome, 'completed')
  assert.equal(mergeDone(events, 'noop')?.by, 'nothing')
  assert.equal(state.nodes.get('noop')!.summary, 'nothing to change')
})

test('two nodes editing the same line conflict; the integrator resolves the merge in the integration worktree', async () => {
  const { workspace, runDir, integration, outcome, events, state, prompts } = await runGraph([
    work('a', [{ write: { 'f.txt': 'a\n' }, result: done('a') }]),
    work('b', [{ waitFor: AFTER_A, write: { 'f.txt': 'b\n' }, result: done('b') }], { command: 'grep -q b f.txt' }),
  ], {
    files: { 'f.txt': 'base\n' },
    agents: integrator([{ sh: `printf 'a\\nb\\n' > f.txt && git add f.txt && ${COMMIT}`, result: done('kept both lines') }]),
  })
  assert.equal(outcome, 'completed')
  const conflict = events.flatMap((e) => (e.type === 'merge.conflict' ? [e] : []))
  assert.deepEqual(conflict.map((e) => [e.node, e.files]), [['b', ['f.txt']]])
  assert.equal(mergeDone(events, 'b')?.by, 'integrator')
  assert.equal(show(workspace, 'f.txt'), 'a\nb')
  assert.equal(mergeInProgress(integration), false)
  // The integrator: a standing node of the run, idle after the request, run by the graph's integrator agent.
  const ig = state.nodes.get(INTEGRATOR)!
  assert.deepEqual([ig.spec.standing, ig.spec.parent, ig.status, ig.turns[0].agent], [true, undefined, 'idle', 'integrator'])
  const request = prompts(INTEGRATOR)[0]
  assert.match(request, new RegExp(`You work in ${integration}, the integration worktree on branch sous/r1`))
  assert.match(request, /Merge node b \(branch sous\/r1\.b\) into sous\/r1\.[^]*conflicts in:\n- f\.txt[^]*grep -q b f\.txt[^]*Brief of b:\nDo b\.[^]*Already merged, in order:\n- a: Do a\./)
  // The merge shows in b's trace; the integrator has its own trajectory under the root; the document stays valid ATIF.
  const loaded = loadRun(runDir, (_, raw) => fakeAdapter(tmpdir()).parse(raw))
  const spans = (toOtlp(loaded) as { resourceSpans: { scopeSpans: { spans: { spanId: string; parentSpanId?: string; name: string }[] }[] }[] })
    .resourceSpans[0].scopeSpans[0].spans
  const nodeB = spans.find((s) => s.name === 'work b')!
  assert.deepEqual(spans.filter((s) => s.parentSpanId === nodeB.spanId && /^merge\./.test(s.name)).map((s) => s.name), ['merge.queued', 'merge.conflict', 'merge.done'])
  const doc = toAtif(loaded) as { subagent_trajectories: { trajectory_id: string; steps: { message: string }[] }[] }
  assert.deepEqual(checkAtif(doc), [])
  const trajectory = (id: string) => doc.subagent_trajectories.find((t) => t.trajectory_id === `r1/${id}`)!
  assert.ok(trajectory(INTEGRATOR))
  assert.deepEqual(trajectory('b').steps.map((s) => s.message).filter((m) => /^Merge/.test(m)), [
    'Merge queued: branch sous/r1.b',
    'Merge conflict, sent to the integrator: conflict in f.txt',
    `Merged by integrator at ${mergeDone(events, 'b')?.commit}`,
  ])
})

test('conflict markers committed by the integrator fail verification, at any marker size; one retry, then the merge is done', async () => {
  for (const attributes of [{}, ...[10, 3, -1].map((size) => ({ '.gitattributes': `f.txt conflict-marker-size=${size}\n` }))] as Record<string, string>[]) {
    const { integration, outcome, events, state, prompts } = await runGraph([
      work('a', [{ write: { 'f.txt': 'a\n' }, result: done('a') }]),
      work('b', [{ waitFor: AFTER_A, write: { 'f.txt': 'b\n' }, result: done('b') }]),
    ], {
      files: { 'f.txt': 'base\n', ...attributes },
      agents: integrator([
        { sh: `git add f.txt && ${COMMIT}`, result: done('committed') },
        { sh: `printf 'a\\nb\\n' > f.txt && git add f.txt && ${COMMIT} -m fix`, result: done('removed the markers') },
      ]),
    })
    assert.equal(outcome, 'completed')
    assert.equal(state.nodes.get(INTEGRATOR)!.turns.length, 2)
    assert.match(prompts(INTEGRATOR)[1], /Node b is not merged yet: conflict markers remain in f\.txt/)
    assert.equal(mergeDone(events, 'b')?.by, 'integrator')
    assert.equal(readFileSync(join(integration, 'f.txt'), 'utf8'), 'a\nb\n')
  }
})

test("a check that dirties the integration worktree does not fail the next node's merge: the tree is reset before each merge", async () => {
  const { workspace, integration, outcome, events } = await runGraph([
    // a's check changes a tracked file and adds one wherever it runs: in a's worktree (committed with a), then in the
    // integration worktree after a's merge, where nothing commits them.
    work('a', [{ result: done('a') }], { command: 'echo touched >> f.txt && echo x > scratch-$$.txt' }),
    work('b', [{ write: { 'f.txt': 'b\n' }, result: done('b') }], { needs: ['a'] }),
  ], { files: { 'f.txt': 'base\n' } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(['a', 'b'].map((n) => mergeDone(events, n)?.by), ['supervisor', 'supervisor'])
  assert.equal(show(workspace, 'f.txt'), 'b')
  assert.equal(git(integration, 'status', '--porcelain'), '', 'the integration worktree is clean after the last merge')
})

test('an integrator that leaves changes uncommitted is sent back once, told which paths; its merge is done once they are committed', async () => {
  const { workspace, integration, outcome, events, state, prompts } = await runGraph([
    work('a', [{ write: { 'f.txt': 'a\n' }, result: done('a') }]),
    work('b', [{ waitFor: AFTER_A, write: { 'f.txt': 'b\n' }, result: done('b') }]),
  ], {
    files: { 'f.txt': 'base\n', 'g.txt': 'g\n' },
    agents: integrator([
      // The merge is committed, but a tracked file is changed and three files are left over, one with a space in its name.
      { sh: `printf 'a\\nb\\n' > f.txt && git add f.txt && ${COMMIT} && echo more >> g.txt && touch forgotten.txt 'new file.txt' && mkdir scratch && touch scratch/junk`, result: done('merged, with leftovers') },
      { sh: `git checkout -- g.txt && git add forgotten.txt && rm -r 'new file.txt' scratch && ${COMMIT} -m 'add the helper'`, result: done('committed the helper') },
    ]),
  })
  assert.equal(outcome, 'completed')
  assert.equal(state.nodes.get(INTEGRATOR)!.turns.length, 2)
  assert.match(prompts(INTEGRATOR)[1], /Node b is not merged yet: uncommitted changes remain in g\.txt, forgotten\.txt, new file\.txt, scratch\/: commit what belongs to the merge and delete the rest/)
  assert.equal(mergeDone(events, 'b')?.by, 'integrator')
  assert.equal(git(workspace, 'ls-tree', '--name-only', 'sous/r1'), 'f.txt\nforgotten.txt\ng.txt')
  assert.equal(git(integration, 'status', '--porcelain'), '')
})

test('an integrator that aborts the merge does not get it accepted: after a retry the merge fails', async () => {
  const abort = { sh: 'git merge --abort', result: done('done, honestly') }
  const { integration, outcome, events, state } = await runGraph([
    work('a', [{ write: { 'f.txt': 'a\n' }, result: done('a') }]),
    work('b', [{ waitFor: AFTER_A, write: { 'f.txt': 'b\n' }, result: done('b') }]),
  ], { files: { 'f.txt': 'base\n' }, agents: integrator([abort, abort]) })
  assert.equal(outcome, 'failed')
  assert.equal(mergeDone(events, 'b'), undefined)
  assert.equal(state.nodes.get('b')!.reason, 'merge failed: not verified after a retry: branch sous/r1.b is not merged')
  assert.equal(readFileSync(join(integration, 'f.txt'), 'utf8'), 'a\n')
})

test('a queued node with a message resumes its worker before merging; once merged, messages to it are refused', async () => {
  const sendTo = (callId: string) => ({ tool: 'send' as const, to: 'w', body: `Message ${callId}.`, mode: 'queue' as const })
  let host: LeadHost
  const refused: string[] = []
  let queued = 0
  const steps: FakeLeadStep[] = [
    { calls: [{ tool: 'spawn', children: [{ id: 'w', kind: 'work', agent: 'claude', brief: `W.\n${fakePlan([
      { write: { 'w.txt': 'old\n' }, result: done('wrote old') },
      { write: { 'w.txt': 'corrected\n' }, result: done('wrote corrected') },
    ])}` }] }] },
    { calls: [{ tool: 'complete', summary: 'ok' }] },
  ]
  const { integration, outcome, events, state, prompts } = await runGraph([{ id: 'lead', kind: 'lead', brief: `Lead.\n${fakeLeadPlan(steps)}` }], {
    createLeadRunner: (o) => ((host = o.host), fakeLeadRunner(o)),
    onEvent: (e) => {
      if (e.type === 'merge.queued' && ++queued === 1) host.act('lead', 'early', sendTo('early'))
      if (e.type === 'merge.done') refused.push(host.act('lead', 'late', sendTo('late')))
    },
  })
  assert.equal(outcome, 'completed')
  const w = state.nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => t.mode), ['start', 'resume'])
  assert.match(prompts('w')[1], /^Message from lead:\nMessage early\./)
  assert.deepEqual(events.filter((e) => e.type.startsWith('merge.') && 'node' in e && e.node === 'w').map((e) => e.type),
    ['merge.queued', 'merge.withdrawn', 'merge.queued', 'merge.done'])
  assert.equal(readFileSync(join(integration, 'w.txt'), 'utf8'), 'corrected\n')
  assert.deepEqual(refused, ['refused: w is already completed'])
})

test('a check that fails after a clean merge goes to the integrator, which fixes it on top of the merge', async () => {
  const { workspace, outcome, events, state } = await runGraph([
    work('a', [{ write: { 'a.txt': 'a\n' }, result: done('a') }]),
    // Passes in b's own worktree, which has no a.txt; fails once a is merged.
    work('b', [{ waitFor: AFTER_A, write: { 'b.txt': 'b\n' }, result: done('b') }], { command: 'test ! -e a.txt || test -e fixed.txt' }),
  ], { agents: integrator([{ sh: `touch fixed.txt && git add fixed.txt && ${COMMIT} -m fix`, result: done('fixed') }]) })
  assert.equal(outcome, 'completed')
  const conflict = events.flatMap((e) => (e.type === 'merge.conflict' ? [e] : []))
  assert.deepEqual(conflict.map((e) => [e.node, e.reason, e.files]), [['b', 'check failed after the merge (exit 1)', []]])
  assert.equal(mergeDone(events, 'b')?.by, 'integrator')
  assert.equal(git(workspace, 'log', '-1', '--format=%s', 'sous/r1'), 'fix')
  assert.equal(git(workspace, 'log', '-1', '--format=%s', 'sous/r1~1'), 'sous: merge b')
  assert.equal(state.nodes.get('b')!.status, 'completed')
})

test('an integrator that is blocked fails the node, its lead is told, and the integration branch drops the merge', async () => {
  const lead: NodeSpec = { id: 'lead', kind: 'lead', brief: `Lead.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [
      { id: 'a', kind: 'work', agent: 'claude', brief: `A.\n${fakePlan([{ write: { 'f.txt': 'a\n' }, result: done('a') }])}` },
      { id: 'b', kind: 'work', agent: 'claude', brief: `B.\n${fakePlan([{ waitFor: AFTER_A, write: { 'f.txt': 'b\n' }, result: done('b') }])}` },
    ] }] },
    {},
    { calls: [{ tool: 'complete', summary: 'a merged, b did not' }] },
  ] satisfies FakeLeadStep[])}` }
  const { integration, outcome, events, state } = await runGraph([lead], {
    files: { 'f.txt': 'base\n' },
    agents: integrator([{ result: { status: 'blocked', summary: 'both sides rewrite the line', question: 'Which line wins?' } }]),
  })
  assert.equal(outcome, 'completed')
  assert.equal(state.nodes.get('b')!.reason, 'merge failed: the integrator is blocked: Which line wins?')
  const told = events.filter((e) => e.type === 'lead.delivered' && e.node === 'lead').map((e) => e.type === 'lead.delivered' && e.text)
  assert.ok(told.includes('Child b failed: merge failed: the integrator is blocked: Which line wins?'), told.join('\n'))
  assert.equal(mergeInProgress(integration), false)
  assert.equal(readFileSync(join(integration, 'f.txt'), 'utf8'), 'a\n')
  assert.equal(state.nodes.get(INTEGRATOR)!.status, 'idle')
})

test('sous resume aborts a merge left in progress without an integrator request and merges again', async () => {
  const workspace = gitWorkspace('sous-merge-')
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  // Node w finished and was queued; the supervisor stopped in the middle of its merge.
  const created = createIntegration(workspace, 'r1', runDir)
  const tree = createNodeWorktree(workspace, 'r1', runDir, 'w', created.base!)
  git(tree.path, 'commit', '-q', '--allow-empty', '-m', 'w')
  const integration = join(runDir, 'integration')
  git(integration, 'merge', '--no-ff', '--no-commit', tree.branch)
  assert.equal(mergeInProgress(integration), true)
  mkdirSync(join(runDir, 'commands'), { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace })
  log.append({ type: 'integration.created', branch: created.branch, path: created.path, base: created.base! })
  log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'w', agent: 'claude' }, by: 'graph' })
  log.append({ type: 'merge.queued', node: 'w', branch: tree.branch })
  log.close()
  const resumed = sous(['resume'], workspace, join(workspace, 'sessions'))
  assert.equal(await resumed.exit, 0, resumed.output())
  const events = readEvents(runDir)
  assert.equal(mergeDone(events, 'w')?.by, 'supervisor')
  assert.equal(events.filter((e) => e.type === 'integration.created').length, 1, 'the integration already existed')
  assert.equal(git(integration, 'log', '-1', '--format=%s'), 'sous: merge w')
  assert.equal(mergeInProgress(integration), false)
  assert.match(resumed.output(), /^result: branch sous\/r1$/m)
})

test('a merge whose integration worktree cannot be checked out again fails the node, not the supervisor', async () => {
  const workspace = gitWorkspace('sous-merge-')
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  const created = createIntegration(workspace, 'r1', runDir)
  const tree = createNodeWorktree(workspace, 'r1', runDir, 'w', created.base!)
  git(tree.path, 'commit', '-q', '--allow-empty', '-m', 'w')
  // The integration worktree is gone and something else sits at its path, so it cannot be added again on resume.
  git(workspace, 'worktree', 'remove', '--force', created.path)
  mkdirSync(created.path)
  writeFileSync(join(created.path, 'in-the-way.txt'), 'x\n')
  mkdirSync(join(runDir, 'commands'), { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace })
  log.append({ type: 'integration.created', branch: created.branch, path: created.path, base: created.base! })
  log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'w', agent: 'claude' }, by: 'graph' })
  log.append({ type: 'merge.queued', node: 'w', branch: tree.branch })
  log.close()
  const resumed = sous(['resume'], workspace, join(workspace, 'sessions'))
  assert.equal(await resumed.exit, 1, resumed.output())
  const state = fold(readEvents(runDir))
  assert.equal(state.status, 'failed')
  assert.match(state.nodes.get('w')!.reason!, /^merge failed: supervisor error: git worktree add \S+ sous\/r1 failed in /)
  assert.doesNotMatch(resumed.output(), /continue with: sous resume/)
})

test('a workspace that is not a git repository fails the run with a clear reason', async () => {
  const { outcome, state } = await runGraph([work('w', [{ result: done('w') }])], { workspace: mkdtempSync(join(tmpdir(), 'sous-plain-')) })
  assert.equal(outcome, 'failed')
  assert.match(state.reason!, /^\/\S+ must be a git repository with at least one commit$/)
  assert.equal(state.nodes.get('w')!.turns.length, 0)
})
