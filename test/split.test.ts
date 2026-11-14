// The splitter: a standing agent that proposes each lead's split before its brief. Real git worktrees, fake workers
// and the scripted fake lead runner; the approval gate and recovery through real `sous` processes.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fold, openLog, readEvents, writeCommand } from '../src/run/index.ts'
import { runSupervisor } from '../src/supervisor/index.ts'
import type { SupervisorOptions } from '../src/supervisor/index.ts'
import { toAtif } from '../src/trace/atif.ts'
import { toOtlp } from '../src/trace/otlp.ts'
import { loadRun } from '../src/trace/index.ts'
import { HARNESSES, PERSON, SPLITTER } from '../src/contracts/index.ts'
import type { ChildSpec, Definitions, Event, EventBody, NodeSpec } from '../src/contracts/index.ts'
import { checkAtif } from './helpers/atif-checker.ts'
import { fakeAdapter, fakePlan } from './helpers/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRunner } from './helpers/fake-lead.ts'
import type { FakeLeadStep } from './helpers/fake-lead.ts'
import { git, gitWorkspace } from './helpers/git-repo.ts'
import { runDirOf, sous, waitFor } from './helpers/sous-proc.ts'
import type { FakeStep } from './helpers/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
/** A splitter that plays `steps`: its standing instructions come first in its prompt. */
const splitter = (steps: FakeStep[]): Definitions => ({ agents: { [SPLITTER]: { runs: 'codex', instructions: fakePlan(steps) } } })
/** Writes a proposal for `lead`; the splitter works in <runDir>/worktrees/splitter. */
const propose = (lead: string, parts: unknown[]) => ({ [`../../splits/${lead}.json`]: JSON.stringify({ parts }) })
const task = (id: string, steps: FakeStep[]): ChildSpec => ({ id, kind: 'work', brief: `Do ${id}.\n${fakePlan(steps)}` })
const lead = (steps: FakeLeadStep[], id = 'lead'): NodeSpec => ({ id, kind: 'lead', brief: `Lead the test goal.\n${fakeLeadPlan(steps)}` })

/** Runs `nodes` in a git workspace whose first commit holds `files`, with the definitions `defs`. */
async function runGraph(nodes: NodeSpec[], defs: Definitions, opts: {
  files?: Record<string, string>; more?: EventBody[]; approveSplits?: boolean; onEvent?: (e: Event, runDir: string) => void
} & Omit<Partial<SupervisorOptions>, 'onEvent'> = {}) {
  const { files, more, approveSplits, onEvent, ...rest } = opts
  const workspace = gitWorkspace('sous-split-', files)
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test goal', workspace, graph: { goal: 'test goal', ...defs, nodes }, ...(approveSplits ? { approveSplits } : {}) })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  for (const body of more ?? []) log.append(body)
  log.close()
  const sessions = join(workspace, 'sessions')
  const adapter = fakeAdapter(sessions)
  const outcome = await runSupervisor({
    workspace, runDir, getAdapter: () => adapter, createLeadRunner: fakeLeadRunner, ...rest, onEvent: onEvent && ((e) => onEvent(e, runDir)),
  })
  const events = readEvents(runDir)
  const state = fold(events)
  const prompts = (node: string) => {
    const session = state.nodes.get(node)!.turns.findLast((t) => t.sessionId)!.sessionId
    return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts as string[]
  }
  return { workspace, runDir, outcome, events, state, prompts }
}

const briefOf = (events: Event[], node = 'lead') =>
  events.flatMap((e) => (e.type === 'lead.delivered' && e.node === node && e.requestId === `${node}:brief` ? [e.text] : []))[0]
const splitEvents = (events: Event[]) =>
  events.flatMap((e) => (e.type === 'split.requested' || e.type === 'split.proposed' || e.type === 'split.failed' ? [e] : []))

test('the splitter reads the merged work in its own worktree and proposes a split; the lead gets it in its brief', async () => {
  const parts = [task('a', [{ write: { 'a.txt': 'a\n' }, result: done('wrote a') }]), { id: 'test-a', kind: 'check', command: 'test -f a.txt', needs: ['a'] }]
  const { workspace, runDir, outcome, events, state, prompts } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: parts as ChildSpec[] }] },
    {},
    { calls: [{ tool: 'complete', summary: 'a written and checked' }] },
  ])], splitter([{
    sh: 'cp modules.txt ../../splits/seen.txt',
    write: { ...propose('lead', parts), 'scratch.txt': 'the splitter wrote this\n' },
    result: done('one work part and its check'),
  }]), { files: { 'modules.txt': 'module a\n' } })
  assert.equal(outcome, 'completed')
  const worktree = join(runDir, 'worktrees', SPLITTER)
  assert.equal(readFileSync(join(runDir, 'splits', 'seen.txt'), 'utf8'), 'module a\n', 'the splitter sees the code')
  assert.deepEqual(splitEvents(events).map((e) => e.type), ['split.requested', 'split.proposed'])
  assert.deepEqual(state.nodes.get('lead')!.split?.parts, parts)
  // The request tells the splitter the lead's task, where it reads, and where the proposal goes.
  const prompt = prompts(SPLITTER)[0]
  assert.match(prompt, /^You are the splitter of a larger goal\.\n\nGoal: test goal\n\nYour standing instructions:\nFAKE_PLAN/)
  assert.match(prompt, /Message from supervisor:\nPropose a split for lead lead\.\n\nIts task:\nLead the test goal\./)
  assert.match(prompt, new RegExp(`The worktree ${worktree} holds the run's merged work at commit [0-9a-f]{40}\\.`))
  assert.match(prompt, new RegExp(`A work part may name an agent of ${HARNESSES.join(', ')} \\(default [a-z]+\\); a lead part one of lead`))
  assert.match(prompt, /Lead lead is at depth 1 of at most 3, so it may have lead parts\./)
  assert.match(prompt, /Propose at most 12 parts\. Ids must be new in the run \(taken: lead\)/)
  assert.ok(prompt.includes(`Write the proposal as a JSON object to ${join(runDir, 'splits', 'lead.json')} (its directory exists):`))
  // The lead's brief carries the proposal; it arrives before anything else.
  const brief = briefOf(events)
  assert.ok(brief.includes(`The run's splitter proposed this split of your task: one work part and its check\n\`\`\`json\n${JSON.stringify(parts, null, 2)}\n\`\`\``))
  assert.ok(events.findIndex((e) => e.type === 'split.proposed') < events.findIndex((e) => e.type === 'lead.delivered'))
  // A standing node outside the tree: idle afterwards; what it wrote never reaches the result.
  const sp = state.nodes.get(SPLITTER)!
  assert.deepEqual([sp.spec.standing, sp.spec.parent, sp.status, sp.turns[0].agent], [true, undefined, 'idle', SPLITTER])
  assert.equal(git(workspace, 'ls-tree', '--name-only', 'sous/r1'), 'a.txt\nmodules.txt')
  // Traces show what was proposed beside what the lead did.
  const loaded = loadRun(runDir, (_, raw) => fakeAdapter(tmpdir()).parse(raw))
  const doc = toAtif(loaded) as { subagent_trajectories: { trajectory_id: string; steps: { message: string; extra?: { parts?: unknown } }[] }[] }
  assert.deepEqual(checkAtif(doc), [])
  const steps = doc.subagent_trajectories.find((t) => t.trajectory_id === 'r1/lead')!.steps
  const proposed = steps.findIndex((s) => s.message === 'Split proposed by the splitter: one work part and its check')
  assert.deepEqual(steps[proposed].extra?.parts, parts)
  assert.ok(proposed > 0 && proposed < steps.findIndex((s) => s.message.startsWith('You are lead lead')))
  assert.ok(doc.subagent_trajectories.some((t) => t.trajectory_id === `r1/${SPLITTER}`))
  const spans = (toOtlp(loaded) as { resourceSpans: { scopeSpans: { spans: { spanId: string; parentSpanId?: string; name: string }[] }[] }[] })
    .resourceSpans[0].scopeSpans[0].spans
  const leadSpan = spans.find((s) => s.name === 'lead lead')!
  assert.ok(spans.some((s) => s.name === 'split' && s.parentSpanId === leadSpan.spanId))
})

test('a sub-lead gets its split from the same splitter session, on a worktree reset to the work merged since', async () => {
  const subParts = [task('sub-b', [{ result: done('b') }])]
  const { outcome, events, state, prompts } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [
      task('a', [{ write: { 'a.txt': 'a\n' }, result: done('wrote a') }]),
      { id: 'sub', kind: 'lead', needs: ['a'], brief: `Do b.\n${fakeLeadPlan([
        { calls: [{ tool: 'spawn', children: subParts }] },
        { calls: [{ tool: 'complete', summary: 'b done' }] },
      ])}` },
    ] }] },
    {},
    {},
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ])], splitter([
    { write: { ...propose('lead', [task('a', [])]), 'scratch.txt': 'x\n' }, result: done('a first') },
    { sh: 'test -f a.txt && test ! -e scratch.txt && echo reset > ../../splits/checked', write: propose('sub', subParts), result: done('b alone') },
  ]))
  assert.equal(outcome, 'completed')
  assert.deepEqual(splitEvents(events).map((e) => [e.type, e.node]), [
    ['split.requested', 'lead'], ['split.proposed', 'lead'], ['split.requested', 'sub'], ['split.proposed', 'sub'],
  ])
  assert.equal(readFileSync(join(state.workspace, '.sous', 'runs', 'r1', 'splits', 'checked'), 'utf8'), 'reset\n')
  const sp = state.nodes.get(SPLITTER)!
  assert.deepEqual(sp.turns.map((t) => t.mode), ['start', 'resume'])
  assert.match(prompts(SPLITTER)[1], /^Message from supervisor:\nPropose a split for lead sub\.\n\nIts task:\nDo b\./)
  assert.match(prompts(SPLITTER)[1], /Lead sub is at depth 2 of at most 3/)
  assert.match(briefOf(events, 'sub'), /The run's splitter proposed this split of your task: b alone/)
})

test('subtrees have their own splitters: a sub-lead inherits its lead\'s, roles override it, and splitters run in parallel', async () => {
  const sub = (id: string) => ({ id, kind: 'lead' as const, brief: `Do ${id}.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [task(`${id}-w`, [{ result: done(id) }])] }] },
    { calls: [{ tool: 'complete', summary: `${id} done` }] },
  ])}` })
  const top: NodeSpec = { ...lead([
    { calls: [
      { tool: 'spawn', children: [{ ...sub('bad'), roles: { splitter: 'claude' } }] },
      { tool: 'spawn', children: [{ ...sub('fe'), roles: { splitter: 'planner-b' } }, sub('be')] },
    ] },
    {}, {},
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ]), roles: { splitter: 'planner-a' } }
  const slow = (id: string, parts: unknown[]): FakeStep => ({ sleepMs: 400, write: propose(id, parts), result: done(`${id} split`) })
  const { outcome, events, state, prompts } = await runGraph([top], { agents: {
    'planner-a': { runs: 'codex', instructions: fakePlan([{ write: propose('lead', [task('top-w', [])]), result: done('top split') }, slow('be', [task('be-w', [])])]) },
    'planner-b': { runs: 'claude', instructions: fakePlan([slow('fe', [task('fe-w', [])])]) },
  } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(splitEvents(events).flatMap((e) => (e.type === 'split.requested' ? [[e.node, e.agent]] : [])), [
    ['lead', 'planner-a'], ['fe', 'planner-b'], ['be', 'planner-a'],
  ])
  // Only an agent the run defines may fill a role a lead gives; the child keeps the parent's splitter otherwise.
  assert.deepEqual(events.flatMap((e) => (e.type === 'lead.call' && e.node === 'lead' ? [e.result] : [])).slice(0, 2), [
    'refused: child bad: roles.splitter: claude is not an agent the run defines',
    'spawned fe, be; their outcomes will be delivered to you',
  ])
  // One standing node per splitter agent, each in its own session; fe's and be's splits overlap.
  assert.deepEqual([...state.nodes.values()].filter((n) => n.spec.standing).map((n) => [n.spec.id, n.spec.agent, n.turns.length]), [
    ['splitter.planner-a', 'planner-a', 2], ['splitter.planner-b', 'planner-b', 1],
  ])
  const span = (node: string, turn: number) => ['turn.started', 'turn.ended'].map((type) =>
    events.find((e) => e.type === type && 'turn' in e && e.node === node && e.turn === turn)!.seq)
  const [a, b] = [span('splitter.planner-a', 2), span('splitter.planner-b', 1)]
  assert.ok(a[0] < b[1] && b[0] < a[1], 'the two splitters ran at the same time')
  assert.match(prompts('splitter.planner-b')[0], /Propose a split for lead fe\./)
  assert.match(briefOf(events), /A lead child may take roles \{"splitter": "<agent>"\}: [^]*\(yours: planner-a; without roles a child keeps yours\)\. Agents for roles: planner-a, planner-b\./)
  assert.match(prompts('splitter.planner-a')[0], /A lead part may set roles \{"splitter": "<agent>"\} to give its subtree another splitter, one of planner-a, planner-b/)
})

test('leads ready together get one request each, in order, even when the first needs a retry', async () => {
  const steps = (id: string): FakeLeadStep[] => [
    { calls: [{ tool: 'spawn', children: [task(`${id}-w`, [{ result: done(id) }])] }] },
    { calls: [{ tool: 'complete', summary: `${id} done` }] },
  ]
  const { outcome, events, prompts } = await runGraph([lead(steps('l1'), 'l1'), lead(steps('l2'), 'l2')], splitter([
    { result: done('forgot to write') },
    { write: propose('l1', [task('l1-w', [])]), result: done('l1 split') },
    { write: propose('l2', [task('l2-w', [])]), result: done('l2 split') },
  ]))
  assert.equal(outcome, 'completed')
  assert.deepEqual(splitEvents(events).map((e) => [e.type, e.node]), [
    ['split.requested', 'l1'], ['split.requested', 'l2'], ['split.proposed', 'l1'], ['split.proposed', 'l2'],
  ])
  assert.deepEqual(prompts(SPLITTER).map((p) => p.match(/^(?:[^]*?Message from supervisor:\n)?(Propose a split for lead \w+|Your proposal for lead \w+)/)?.[1]), [
    'Propose a split for lead l1', 'Your proposal for lead l1', 'Propose a split for lead l2',
  ])
})

test('cancelling a lead stops the splitter turn working on its split', async () => {
  const started = Date.now()
  const { outcome, events, state } = await runGraph([lead([])], splitter([{ sleepMs: 60_000, result: done('too late') }]), {
    onEvent: (e) => {
      if (e.type !== 'turn.started' || e.node !== SPLITTER) return
      const commands = join(dirname(dirname(dirname(e.outFile))), 'commands')
      writeFileSync(join(commands, 'cancel.tmp'), JSON.stringify({ type: 'cancel', node: 'lead' }))
      renameSync(join(commands, 'cancel.tmp'), join(commands, 'cancel.json'))
    },
  })
  assert.equal(outcome, 'failed')
  assert.ok(Date.now() - started < 30_000, 'the splitter turn was stopped')
  assert.equal(state.nodes.get(SPLITTER)!.turns[0].interrupted?.reason, 'lead finished before its split')
  assert.deepEqual(splitEvents(events).map((e) => (e.type === 'split.failed' ? e.reason : e.type)), ['split.requested', 'lead finished before its split'])
})

test('a splitter turn that took the request but was cut short before starting gets the request again on resume', async () => {
  const request = 'Propose a split for lead lead. (the request a stopped supervisor sent)'
  const { outcome, events, prompts } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [task('a', [{ result: done('a') }])] }] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], splitter([{ write: propose('lead', [task('a', [])]), result: done('recovered split') }]), {
    resume: true,
    more: [
      { type: 'split.requested', node: 'lead', agent: SPLITTER },
      { type: 'node.added', node: { id: SPLITTER, kind: 'work', standing: true, agent: SPLITTER, brief: 'Split.' }, by: 'supervisor' },
      { type: 'message', from: 'supervisor', to: SPLITTER, body: request, mode: 'queue' },
      { type: 'turn.started', node: SPLITTER, turn: 1, mode: 'start', harness: 'codex', agent: SPLITTER, pid: 999_999_999, outFile: '/nonexistent/turn-1.jsonl', errFile: '/nonexistent/turn-1.err' },
    ],
  })
  assert.equal(outcome, 'completed')
  assert.match(prompts(SPLITTER)[0], new RegExp(`Message from supervisor:\n${request.replace(/[.()]/g, '\\$&')}`))
  assert.deepEqual(splitEvents(events).map((e) => e.type), ['split.requested', 'split.proposed'])
})

test('on resume, a request already sent to one splitter is not sent again because another splitter settled since', async () => {
  const leadOf = (id: string): NodeSpec => ({ ...lead([
    { calls: [{ tool: 'spawn', children: [task(`${id}-w`, [{ result: done(id) }])] }] },
    { calls: [{ tool: 'complete', summary: `${id} done` }] },
  ], id), roles: { splitter: `p${id}` } })
  const request = 'Propose a split for lead l1. (sent before the stop)'
  const { outcome, events, prompts } = await runGraph([leadOf('l1'), leadOf('l2')], { agents: {
    pl1: { runs: 'codex', instructions: fakePlan([{ write: propose('l1', [task('l1-w', [])]), result: done('l1 split') }]) },
    pl2: { runs: 'codex', instructions: fakePlan([]) },
  } }, {
    resume: true,
    more: [
      { type: 'split.requested', node: 'l1', agent: 'pl1' },
      { type: 'split.requested', node: 'l2', agent: 'pl2' },
      { type: 'node.added', node: { id: 'splitter.pl1', kind: 'work', standing: true, agent: 'pl1', brief: 'Split.' }, by: 'supervisor' },
      { type: 'message', from: 'supervisor', to: 'splitter.pl1', body: request, mode: 'queue' },
      { type: 'split.proposed', node: 'l2', parts: [task('l2-w', [])], summary: 'l2 split' },
    ],
  })
  assert.equal(outcome, 'completed')
  assert.equal(events.filter((e) => e.type === 'message' && e.to === 'splitter.pl1').length, 1)
  assert.ok(prompts('splitter.pl1')[0].includes(request))
})

test('an invalid proposal goes back to the splitter once with the reason; the corrected one is proposed', async () => {
  const { outcome, events, prompts } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [task('a', [{ result: done('a') }])] }] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], splitter([
    { write: propose('lead', [{ id: 'a', kind: 'work', brief: 'a', needs: ['later'] }]), result: done('first try') },
    { write: propose('lead', [{ id: 'a', kind: 'work', brief: 'a' }]), result: done('second try') },
  ]))
  assert.equal(outcome, 'completed')
  assert.match(prompts(SPLITTER)[1], /^Message from supervisor:\nYour proposal for lead lead is not valid: child a: needs may name only earlier siblings, not later\n\nWrite a corrected proposal to \S+\/splits\/lead\.json, then report done again\./)
  assert.deepEqual(splitEvents(events).map((e) => [e.type, e.type === 'split.proposed' ? e.summary : undefined]), [
    ['split.requested', undefined], ['split.proposed', 'second try'],
  ])
})

test('without a valid proposal after a retry, or with a blocked splitter, the lead splits on its own', async () => {
  const steps: FakeLeadStep[] = [
    { calls: [{ tool: 'spawn', children: [task('a', [{ result: done('a') }])] }] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ]
  const invalid = await runGraph([lead(steps)], splitter([
    { result: done('wrote nothing') },
    { write: { '../../splits/lead.json': '{"parts": [' }, result: done('broken') },
  ]))
  assert.equal(invalid.outcome, 'completed')
  const reason = (events: Event[]) => events.flatMap((e) => (e.type === 'split.failed' ? [e.reason] : []))
  assert.equal(reason(invalid.events).length, 1)
  assert.match(reason(invalid.events)[0], /^no valid proposal after a retry: \S+\/splits\/lead\.json is not valid JSON: /)
  assert.match(invalid.prompts(SPLITTER)[1], /not valid: no proposal was written to \S+\/splits\/lead\.json/)
  assert.match(briefOf(invalid.events), /The run's splitter proposed no split \(no valid proposal after a retry: [^]*\)\. Split the task yourself\.\n$/)

  const blocked = await runGraph([lead(steps)], splitter([{ result: { status: 'blocked', summary: 'no access', question: 'Where is the code?' } }]))
  assert.equal(blocked.outcome, 'completed')
  assert.deepEqual(reason(blocked.events), ['the splitter is blocked: Where is the code?'])

  const missing = await runGraph([lead(steps)], splitter([]), { unavailable: { commands: ['codex'], leadProviders: [] } })
  assert.equal(missing.outcome, 'completed')
  assert.deepEqual(reason(missing.events), ['agent splitter is not available (codex not found)'])
})

// ---- The person approves splits (--approve-splits), through real processes ---------------------

function goalRun(steps: FakeStep[], leadSteps: FakeLeadStep[]) {
  const workspace = gitWorkspace('sous-split-cli-')
  const agents = join(workspace, 'agents.json')
  writeFileSync(agents, JSON.stringify(splitter(steps)))
  return { workspace, agents, sessions: join(workspace, 'sessions'), goal: `Ship it.\n${fakeLeadPlan(leadSteps)}` }
}

const leadDone: FakeLeadStep[] = [{ calls: [{ tool: 'spawn', children: [task('a', [{ result: done('a') }])] }] }, {}, {}, { calls: [{ tool: 'complete', summary: 'shipped' }] }]
const proposal = [{ id: 'a', kind: 'work', brief: 'Write a.\nSecond line.' }, { id: 'b', kind: 'work', agent: 'pi', brief: 'Write b.', needs: ['a'] }]

test('with --approve-splits a lead waits until the person approves its split; sous status lists it', async () => {
  const { workspace, agents, sessions, goal } = goalRun([{ write: propose('lead', proposal), result: done('a, then b') }], leadDone)
  const run = sous(['run', goal, '--agents', agents, '--approve-splits'], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'lead' && e.to === 'person')
  const status = sous(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /\n  lead waiting\n  splitter idle on splitter turns 1: a, then b\nsplits for you to approve \(sous approve <lead>, or sous answer <lead> "<changes>"\):\n  lead: Proposed split for lead: a, then b - a \(work\): Write a\. - b \(work, pi, needs a\): Write b\.\n$/)
  assert.equal(await sous(['approve', SPLITTER], workspace, sessions).exit, 1)

  const approve = sous(['approve', 'lead'], workspace, sessions)
  assert.equal(await approve.exit, 0, approve.output())
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /\nProposed split for lead: a, then b\n- a \(work\): Write a\.\n- b \(work, pi, needs a\): Write b\.\nApprove with: sous approve lead, or give lead changes with: sous answer lead "<changes>"\n/)
  const events = readEvents(runDirOf(workspace)!)
  const delivered = events.flatMap((e) => (e.type === 'lead.delivered' ? [e.text] : []))
  assert.match(delivered[0], /The run's splitter proposed this split of your task: a, then b/)
  assert.equal(delivered[1], 'Message from person:\nThe person approved the proposed split.')
  assert.equal(fold(events).nodes.get('lead')!.status, 'completed')
})

test('with --approve-splits the person may answer with changes instead; without a splitter the flag is an error', async () => {
  const { workspace, agents, sessions, goal } = goalRun([{ write: propose('lead', proposal), result: done('a, then b') }], leadDone)
  const run = sous(['run', goal, '--agents', agents, '--approve-splits'], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'lead' && e.to === 'person')
  const answer = sous(['answer', 'lead', 'Skip b.'], workspace, sessions)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await run.exit, 0, run.output())
  const events = readEvents(runDirOf(workspace)!)
  assert.deepEqual(events.flatMap((e) => (e.type === 'lead.delivered' ? [e.text.split('\n')[0]] : [])).slice(0, 2), [
    'You are lead lead, one part of a larger goal.', 'Message from person:',
  ])
  assert.ok(events.some((e) => e.type === 'lead.delivered' && e.text === 'Message from person:\nSkip b.'))

  const other = gitWorkspace('sous-split-cli-')
  const plain = sous(['run', 'Ship it.', '--approve-splits'], other, sessions)
  assert.equal(await plain.exit, 1)
  assert.match(plain.output(), /--approve-splits needs a splitter: define an agent named splitter/)
})

test("with --approve-splits a lead is neither reminded nor abandoned while its child lead's split waits for the person", async () => {
  // Only the child has a splitter: the parent gets its brief at once, spawns the child, and then has nothing to do but wait.
  const subParts = [task('sub-w', [{ result: done('w') }])]
  const sub: ChildSpec = { id: 'sub', kind: 'lead', roles: { splitter: 'planner' }, brief: `Do sub.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: subParts }] },
    {},
    { calls: [{ tool: 'complete', summary: 'sub done' }] },
  ])}` }
  const { outcome, events, state } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [sub] }] },
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ])], { agents: { planner: { runs: 'codex', instructions: fakePlan([{ write: propose('sub', subParts), result: done('one part') }]) } } }, {
    approveSplits: true,
    // The person takes a moment to approve: long enough for two reminders to go out and the parent to be abandoned.
    onEvent: (e, runDir) => {
      if (e.type === 'message' && e.from === 'sub' && e.to === PERSON) setTimeout(() => writeCommand(runDir, { type: 'approve', node: 'sub' }), 500)
    },
  })
  assert.equal(outcome, 'completed')
  assert.deepEqual(events.flatMap((e) => (e.type === 'lead.delivered' && e.node === 'lead' ? [e.text.split('\n')[0]] : [])), [
    'You are lead lead, one part of a larger goal.', 'Child sub completed: sub done',
  ])
  assert.equal(state.summary, 'all done')
})

test('a splitter turn cut short by a SIGKILL is resumed with a recovery note, and its proposal reaches the lead once', async () => {
  const { workspace, agents, sessions, goal } = goalRun([
    { sleepMs: 60_000, result: done('too late') },
    { write: propose('lead', [task('a', [])]), result: done('after recovery') },
  ], leadDone)
  const run = sous(['run', goal, '--agents', agents], workspace, sessions)
  const session = await waitFor(workspace, (e) => e.type === 'turn.session' && e.node === SPLITTER)
  // Kill the supervisor once the splitter has its prompt.
  const file = join(sessions, `${session.type === 'turn.session' ? session.sessionId : ''}.json`)
  for (let i = 0; i < 200 && !existsSync(file); i++) await sleep(25)
  run.child.kill('SIGKILL')
  await run.exit
  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  const events = readEvents(runDirOf(workspace)!)
  const sp = fold(events).nodes.get(SPLITTER)!
  assert.deepEqual(sp.turns.map((t) => [t.recovery ?? false, t.result?.summary]), [[false, undefined], [true, 'after recovery']])
  assert.deepEqual(splitEvents(events).map((e) => e.type), ['split.requested', 'split.proposed'])
  assert.equal(events.filter((e) => e.type === 'message' && e.to === SPLITTER).length, 1)
  assert.equal(events.filter((e) => e.type === 'lead.delivered' && e.requestId === 'lead:brief').length, 1)
})
