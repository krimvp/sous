// Leads on a CLI harness: each lead turn is a turn of the fake harness that ends with a LeadResult, whose calls the
// supervisor applies after the turn (call IDs t<turn>.<index>).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fold, openLog, readEvents } from '../src/run/index.ts'
import { runSupervisor } from '../src/supervisor/index.ts'
import type { SupervisorOptions } from '../src/supervisor/index.ts'
import type { Definitions, Event, LeadCall, NodeSpec, TurnSpec } from '../src/contracts/index.ts'
import { exportAtif } from '../src/trace/index.ts'
import { checkAtif } from './helpers/atif-checker.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { fakeAdapter, fakePlan } from './helpers/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRunner } from './helpers/fake-lead.ts'
import type { FakeStep } from './helpers/fake-worker.ts'

const BOSS: Definitions = { agents: { boss: { runs: 'claude', model: 'haiku' } } }
const lead = (answer: string, ...calls: LeadCall[]): FakeStep => ({ lead: { answer, calls } })
const leadNode = (id: string, steps: FakeStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'lead', agent: 'boss', brief: `Lead ${id}.\n${fakePlan(steps)}`, ...extra })
const work = (id: string, extra: object = {}) =>
  ({ id, kind: 'work' as const, agent: 'claude', brief: `Do ${id}.\n${fakePlan([{ write: { [`${id}.txt`]: id }, result: { status: 'done', summary: `wrote ${id}` } }])}`, ...extra })

async function run(nodes: NodeSpec[], extra: Partial<SupervisorOptions> = {}, defs: Definitions = BOSS, created: object = {}) {
  const workspace = gitWorkspace('sous-harness-lead-')
  const runDir = join(workspace, 'run')
  mkdirSync(runDir)
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test goal', workspace, graph: { goal: 'test goal', ...defs, nodes }, ...created })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  log.close()
  const sessions = join(workspace, 'sessions')
  const specs: TurnSpec[] = []
  const fake = fakeAdapter(sessions)
  const getAdapter = () => ({ ...fake, start: (s: TurnSpec) => (specs.push(s), fake.start(s)), resume: (s: TurnSpec & { sessionId: string }) => (specs.push(s), fake.resume(s)) })
  const outcome = await runSupervisor({ workspace, runDir, getAdapter, graceMs: 300, ...extra })
  const events = readEvents(runDir)
  return { runDir, outcome, events, state: fold(events), specs, sessions }
}

const calls = (events: Event[], node = 'lead') => events.flatMap((e) => (e.type === 'lead.call' && e.node === node ? [e] : []))
const prompts = (sessions: string, events: Event[], node = 'lead'): string[] => {
  const session = fold(events).nodes.get(node)!.turns[0].sessionId!
  return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts
}

test('a lead on a harness splits into work and a check, its calls applied after each turn, and completes', async () => {
  const { outcome, events, state, specs, sessions, runDir } = await run([leadNode('lead', [
    lead('Split in two.', { tool: 'note', text: 'Use plain text.' }, { tool: 'spawn', children: [work('a'), { id: 'c', kind: 'check', command: 'test -f a.txt', needs: ['a'] }] }),
    lead('Waiting for the check.'),
    lead('All done.', { tool: 'complete', summary: 'a.txt is written and checked' }),
  ])])
  assert.equal(outcome, 'completed', JSON.stringify(state.nodes.get('lead')))
  assert.equal(state.summary, 'a.txt is written and checked')
  assert.deepEqual(calls(events).map((e) => [e.callId, e.call.tool, e.ok]), [['t1.0', 'note', true], ['t1.1', 'spawn', true], ['t3.0', 'complete', true]])
  // The calls follow the turn that made them, and the lead answers its brief only after they were applied.
  const types = events.filter((e) => 'node' in e && e.node === 'lead').map((e) => e.type)
  assert.deepEqual(types.slice(0, 7), ['lead.delivered', 'turn.started', 'turn.session', 'turn.ended', 'lead.call', 'lead.call', 'lead.turn'])
  const leadSpecs = specs.filter((s) => s.nodeId === 'lead')
  assert.ok(leadSpecs.every((s) => s.lead?.system.includes('You act only through the calls') && s.env === undefined && s.model === 'haiku'))
  assert.equal(leadSpecs[0].cwd, join(runDir, 'integration'), 'a lead reads the results worktree')
  // Its next turn starts with the results of the last turn's calls, then what was delivered.
  const second = prompts(sessions, events)[1]
  assert.match(second, /^Results of the calls of your last turn, in order:\n1\. note: noted\n2\. spawn: spawned a, c; their outcomes will be delivered to you\n\nChild a completed: wrote a/)
  assert.equal(state.nodes.get('lead')!.notes[0], 'Use plain text.')
  assert.ok(state.nodes.get('a')!.turns[0].harness === 'claude')
  checkAtif(JSON.parse(exportAtif(runDir, (_, raw) => fakeAdapter(sessions).parse(raw))))
})

test('a refused call stops the rest of its turn; with no child working the lead is reminded with the results, and fails after two reminders', async () => {
  const ok = await run([leadNode('lead', [
    lead('Tidy up.', { tool: 'cancel', node: 'ghost' }, { tool: 'note', text: 'never noted' }),
    lead('Done.', { tool: 'complete', summary: 'nothing to do' }),
  ])])
  assert.equal(ok.outcome, 'completed')
  assert.deepEqual(calls(ok.events).map((e) => [e.callId, e.ok]), [['t1.0', false], ['t2.0', true]])
  assert.deepEqual(ok.state.nodes.get('lead')!.notes, [])
  const second = prompts(ok.sessions, ok.events)[1]
  assert.match(second, /1\. cancel: refused: ghost is not a running or pending child of lead\n2\. note: not applied, since an earlier call was refused/)
  assert.match(second, /Reminder 1 of 2: a call of your last turn was refused/)

  // Calls that keep being refused, with accepted notes and sends between them, do not reset the bound.
  const refusedAgain = (i: number) => lead(`Try ${i}.`, i % 2 ? { tool: 'note', text: `n${i}` } : { tool: 'send', to: 'person', body: `m${i}`, mode: 'queue' }, { tool: 'cancel', node: 'ghost' })
  const stuck = await run([leadNode('lead', Array.from({ length: 12 }, (_, i) => refusedAgain(i)))])
  assert.equal(stuck.outcome, 'failed')
  assert.equal(stuck.state.nodes.get('lead')!.reason, 'idle after 2 reminders; cancel was refused: ghost is not a running or pending child of lead')
  assert.deepEqual(calls(stuck.events).map((e) => [e.callId, e.ok]), [['t1.0', true], ['t1.1', false], ['t2.0', true], ['t2.1', false], ['t3.0', true], ['t3.1', false]])
})

// A child that works for a while, so the lead's turns meanwhile can be counted.
const slow = (id: string) => ({ id, kind: 'work' as const, agent: 'claude', brief: `Do ${id}.\n${fakePlan([{ sleepMs: 1500, write: { [`${id}.txt`]: id }, result: { status: 'done', summary: `wrote ${id}` } }])}` })
const leadTurns = (events: Event[]) => events.filter((e) => e.type === 'turn.started' && e.node === 'lead')
const endOf = (events: Event[], node: string) => events.find((e) => e.type === 'turn.ended' && e.node === node)!.seq

test('a refused call while a child works waits for the next delivery: an accepted call before it gives the lead no turn', async () => {
  const again = Array.from({ length: 20 }, (_, i) => lead(`Waiting ${i}.`, { tool: 'note', text: `n${i}` }, { tool: 'complete', summary: 'done' }))
  const { outcome, events, state, sessions } = await run([leadNode('lead', [lead('Split.', { tool: 'spawn', children: [slow('a')] }, { tool: 'complete', summary: 'early' }), ...again])])
  assert.equal(outcome, 'completed', JSON.stringify(state.nodes.get('lead')))
  assert.equal(leadTurns(events).filter((e) => e.seq < endOf(events, 'a')).length, 1, 'no lead turn while a worked')
  assert.equal(leadTurns(events).length, 2)
  assert.equal(state.nodes.get('a')!.status, 'completed')
  // The turn after the child's outcome is told what was refused.
  assert.match(prompts(sessions, events)[1], /^Results of the calls of your last turn, in order:\n1\. spawn: spawned a[^\n]*\n2\. complete: refused: [^\n]+\n\nChild a completed: wrote a/)
})

test("a harness lead's early complete, repeated, does not fail it or its working child", async () => {
  const again = Array.from({ length: 20 }, () => lead('Done?', { tool: 'complete', summary: 'done' }))
  const { outcome, events, state } = await run([leadNode('lead', [lead('Split.', { tool: 'spawn', children: [slow('a')] }, { tool: 'complete', summary: 'early' }), ...again])])
  assert.equal(outcome, 'completed', JSON.stringify(state.nodes.get('lead')))
  assert.deepEqual([state.nodes.get('a')!.status, state.nodes.get('a')!.summary], ['completed', 'wrote a'])
  assert.equal(leadTurns(events).length, 2)
})

test('a lead on a harness with nothing to do is reminded, then fails as idle, as a lead runner\'s lead does', async () => {
  const { outcome, state, events } = await run([leadNode('lead', [lead('Hmm.'), lead('Still thinking.'), lead('Nothing.')])])
  assert.equal(outcome, 'failed')
  assert.equal(state.nodes.get('lead')!.reason, 'idle after 2 reminders')
  assert.equal(events.filter((e) => e.type === 'turn.started').length, 3)
})

test('a turn without a lead result is resumed with a note that nothing was applied; a second miss fails the lead', async () => {
  const once = await run([leadNode('lead', [{ say: 'I forgot the result.' }, lead('Done.', { tool: 'complete', summary: 'done late' })])])
  assert.equal(once.outcome, 'completed')
  assert.match(prompts(once.sessions, once.events)[1], /^Your turn 1 ended before its result: none of its calls were applied\. Continue from here\.\n\nYou are lead lead,/m)
  const twice = await run([leadNode('lead', [{ say: 'no result' }, { say: 'no result again' }])])
  assert.equal(twice.outcome, 'failed')
  assert.match(twice.state.nodes.get('lead')!.reason!, /^turn 2 ended without a lead result, as did the one before/)
})

test('after a cut turn, the results shown are labelled with the turn that applied them', async () => {
  const { outcome, events, sessions } = await run([leadNode('lead', [
    lead('Note it.', { tool: 'note', text: 'kept' }), { say: 'I forgot the result.' }, lead('Done.', { tool: 'complete', summary: 'done' }),
  ])])
  assert.equal(outcome, 'completed')
  const third = prompts(sessions, events)[2]
  assert.match(third, /^Your turn 2 ended before its result: none of its calls were applied\. Continue from here\.\n\nResults of the calls of your turn 1, the last one applied, in order:\n1\. note: noted\n/)
  assert.doesNotMatch(third, /your last turn/)
})

test("an urgent message stops a harness lead's turn, whose calls are never applied; it resumes with the message", async () => {
  const sub = { id: 'sub', kind: 'lead' as const, agent: 'boss', brief: `Lead sub.\n${fakePlan([
    { sleepMs: 20_000, lead: { answer: 'too late', calls: [{ tool: 'spawn', children: [work('late')] }] } },
    lead('Stopped.', { tool: 'complete', summary: 'stopped as told' }),
  ])}` }
  // The parent runs on the lead runner: it spawns the sub-lead on the harness and a quick worker, then interrupts the
  // sub-lead once the worker's outcome arrives.
  const parent: NodeSpec = { id: 'top', kind: 'lead', brief: `Top.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [sub, work('quick')] }] },
    { calls: [{ tool: 'send', to: 'sub', body: 'Stop now and complete.', mode: 'interrupt' }] },
    { calls: [{ tool: 'complete', summary: 'top done' }] },
    { calls: [{ tool: 'complete', summary: 'top done' }] },
  ])}` }
  const { outcome, events, state, sessions } = await run([parent], { createLeadRunner: fakeLeadRunner })
  assert.equal(outcome, 'completed', JSON.stringify([...state.nodes.values()].map((n) => [n.spec.id, n.status, n.reason])))
  assert.ok(events.some((e) => e.type === 'turn.interrupted' && e.node === 'sub' && e.turn === 1))
  assert.deepEqual(calls(events, 'sub').map((e) => e.callId), ['t2.0'], 'the interrupted turn applied nothing')
  assert.equal(state.nodes.has('late'), false)
  assert.match(prompts(sessions, events, 'sub')[1], /Your turn 1 ended before its result[\s\S]*Message from top:\nStop now and complete\./)
})

test("a harness lead's turn cost counts toward the budget: the run stops before its calls are applied", async () => {
  const { outcome, events, state } = await run(
    [leadNode('lead', [{ lead: { answer: 'split', calls: [{ tool: 'spawn', children: [work('a')] }] }, usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, sessionCostUsd: 0.5 } }])],
    {}, BOSS, { maxCost: 0.4 })
  assert.equal(outcome, 'budget')
  assert.equal(state.spent.costUsd, 0.5)
  assert.ok(events.some((e) => e.type === 'budget.reached'))
  assert.deepEqual(calls(events), [], 'applied by the resumed run, not this one')
})

test('the built-in lead runs on the recorded harness when no lead provider had a credential, on its recorded model', async () => {
  const goal = leadNode('lead', [lead('Done.', { tool: 'complete', summary: 'ran on the harness' })], { agent: undefined })
  const { outcome, events, specs } = await run([goal], { unavailable: { commands: [], leadProviders: ['ollama-cloud', 'anthropic', 'openai', 'openai-codex'], leadRuns: 'claude', leadModel: 'haiku' } }, {})
  assert.equal(outcome, 'completed')
  const started = events.find((e) => e.type === 'turn.started' && e.node === 'lead')
  assert.ok(started?.type === 'turn.started' && started.harness === 'claude' && started.agent === 'lead' && started.model === 'haiku')
  assert.ok(specs[0].lead)
})
