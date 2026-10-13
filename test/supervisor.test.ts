import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog, readEvents } from '../src/log.ts'
import { HARNESSES } from '../src/types.ts'
import type { EventBody, TurnSpec } from '../src/types.ts'
import { fold } from '../src/state.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { SupervisorOptions } from '../src/supervisor.ts'
import type { Definitions, Event, HarnessName, LeadHost, NodeSpec } from '../src/types.ts'
import { exportAtif } from '../src/trace/atif.ts'
import { checkAtif } from './atif-checker.ts'
import { gitWorkspace } from './fixtures/git-repo.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRecords, fakeLeadRunner } from './fixtures/fake-lead.ts'
import type { FakeLeadStep } from './fixtures/fake-lead.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })

/** Runs `nodes` as a graph with the definitions `defs`. `started` lists the harness and model of every turn started. */
async function runGraph(nodes: NodeSpec[], graceMs?: number, extra: Partial<SupervisorOptions> = {}, more: EventBody[] = [], defs?: Definitions, maxDepth?: number) {
  const workspace = gitWorkspace('sous-ws-')
  const runDir = join(workspace, 'run')
  mkdirSync(runDir)
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test goal', workspace, ...(defs ? { graph: { goal: 'test goal', ...defs, nodes } } : {}), ...(maxDepth ? { maxDepth } : {}) })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  for (const body of more) log.append(body)
  log.close()
  const sessions = join(workspace, 'sessions')
  const started: [HarnessName, string | undefined][] = []
  const getAdapter = (runs: HarnessName) => {
    const fake = fakeAdapter(sessions)
    return { ...fake, start: (spec: TurnSpec) => (started.push([runs, spec.model]), fake.start(spec)) }
  }
  const outcome = await runSupervisor({ workspace, runDir, getAdapter, graceMs, ...extra })
  const events = readEvents(runDir)
  return { workspace, runDir, outcome, events, state: fold(events), sessions, started }
}

const work = (id: string, steps: FakeStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id, kind: 'work', agent: 'claude', brief: `Do ${id}.\n${fakePlan(steps)}`, ...extra })

const promptOf = (sessions: string, node: { turns: { sessionId?: string }[] }, turn = 0): string =>
  JSON.parse(readFileSync(join(sessions, `${node.turns[0].sessionId}.json`), 'utf8')).prompts[turn]

test('a work node merges, then a check node checks the merged result, and the run completes', async () => {
  const { runDir, outcome, events, state } = await runGraph([
    work('build', [{ write: { 'out.txt': 'hello\n' }, result: done('wrote out.txt') }]),
    { id: 'verify', kind: 'check', command: 'grep -q hello out.txt && echo verified', needs: ['build'] },
  ])
  assert.equal(outcome, 'completed')
  assert.equal(readFileSync(join(runDir, 'integration', 'out.txt'), 'utf8'), 'hello\n')
  assert.deepEqual(events.map((e) => e.type), [
    'run.created', 'node.added', 'node.added', 'integration.created', 'worktree.created',
    'turn.started', 'turn.session', 'turn.ended', 'merge.queued', 'merge.done',
    'check.ended', 'node.completed', 'run.completed',
  ])
  assert.equal(state.nodes.get('build')?.summary, 'wrote out.txt')
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
    work('a', [{}, {}]),
    work('b', [{ result: done('b') }], { needs: ['a'] }),
    { id: 'c', kind: 'check', command: 'true', needs: ['b'] },
    work('d', [{ result: done('d') }]),
  ])
  assert.equal(outcome, 'failed')
  assert.equal(state.nodes.get('a')?.reason, 'turn 2 ended without a structured result')
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

test("a graph agent's instructions reach its worker's brief, it runs on its harness, and a node's model overrides the agent's", async () => {
  const reviewer = { runs: 'codex' as const, model: 'gpt-5', instructions: 'Review only; change nothing.' }
  const { outcome, state, sessions, started } = await runGraph([
    work('a', [{ result: done('a') }], { agent: 'reviewer' }),
    work('b', [{ result: done('b') }], { agent: 'reviewer', model: 'gpt-5-mini' }),
    work('c', [{ result: done('c') }], { agent: 'claude' }),
  ], undefined, {}, [], { agents: { reviewer } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(started, [['codex', 'gpt-5'], ['codex', 'gpt-5-mini'], ['claude', undefined]])
  assert.deepEqual(['a', 'b', 'c'].map((id) => state.nodes.get(id)!.turns[0].agent), ['reviewer', 'reviewer', 'claude'])
  assert.match(promptOf(sessions, state.nodes.get('a')!), /Your standing instructions:\nReview only; change nothing\.\n\nYour task \(node a\)/)
  assert.doesNotMatch(promptOf(sessions, state.nodes.get('c')!), /standing instructions/)
})

test('a node whose agent is not available fails with the reason; a node without an agent takes the next available one', async () => {
  const { outcome, state, started } = await runGraph([
    work('a', [{ result: done('a') }], { agent: 'claude' }),
    work('b', [{ result: done('b') }], { agent: undefined }),
  ], undefined, { unavailable: { commands: ['claude'], leadProviders: [] } })
  assert.equal(outcome, 'failed')
  assert.equal(state.nodes.get('a')!.reason, 'agent claude is not available (claude not found)')
  assert.equal(state.nodes.get('a')!.turns.length, 0)
  assert.deepEqual([state.nodes.get('b')!.status, state.nodes.get('b')!.turns[0].agent, started], ['completed', 'codex', [['codex', undefined]]])
})

const grandchildOf = (sessions: string) =>
  Number(readFileSync(join(sessions, readdirSync(sessions).find((f) => f.endsWith('.grandchild'))!), 'utf8'))

test('processes a worker leaves behind are stopped before its turn counts as ended', async () => {
  const { outcome, sessions } = await runGraph([work('bg', [{ spawnSleeper: true, result: done('ok') }])])
  assert.equal(outcome, 'completed')
  assert.throws(() => process.kill(grandchildOf(sessions), 0), /ESRCH/)
})

test('a check that leaves a background process behind ends when its command exits, and the leftover is stopped', async () => {
  const started = Date.now()
  const { outcome, state } = await runGraph([{ id: 'c', kind: 'check', command: 'sleep 20 & echo $!; echo check passed' }])
  assert.equal(outcome, 'completed')
  assert.ok(Date.now() - started < 10_000, 'the check ended when its command exited, not when the sleep did')
  const [pid, text] = state.nodes.get('c')!.checks[0].output.split('\n')
  assert.equal(text, 'check passed')
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/)
})

test('a group that ignores SIGTERM is killed before the supervisor finishes', async () => {
  const { outcome, sessions } = await runGraph([work('stubborn', [{ spawnSleeper: 'ignore-term', result: done('ok'), lingerMs: 60_000 }])], 200)
  assert.equal(outcome, 'completed')
  assert.throws(() => process.kill(grandchildOf(sessions), 0), /ESRCH/)
})

// ---- Leads ----------------------------------------------------------------------------------

const lead = (steps: FakeLeadStep[], extra: Partial<NodeSpec> = {}): NodeSpec =>
  ({ id: 'lead', kind: 'lead', brief: `Lead the test goal.\n${fakeLeadPlan(steps)}`, ...extra })

/** Runs one top-level lead with the scripted fake lead runner; `onHost` gets the host and every event. */
async function runLead(steps: FakeLeadStep[], onEvent?: (e: Event, host: LeadHost) => void, more: EventBody[] = [], maxDepth?: number) {
  let host: LeadHost
  return runGraph([lead(steps)], undefined, {
    createLeadRunner: (o) => ((host = o.host), fakeLeadRunner(o)),
    onEvent: onEvent && ((e) => onEvent(e, host)),
  }, more, undefined, maxDepth)
}

const delivered = (events: Event[], node = 'lead') =>
  events.flatMap((e) => (e.type === 'lead.delivered' && e.node === node ? [e] : []))
const calls = (events: Event[]) => events.flatMap((e) => (e.type === 'lead.call' ? [e] : []))

test('a lead spawns two workers, gets both outcomes, completes, and the run completes', async () => {
  const { outcome, events, state, sessions, runDir } = await runLead([
    { calls: [
      { tool: 'note', text: 'Use tabs.' },
      { tool: 'spawn', children: [
        { id: 'a', kind: 'work', brief: `Write a.\n${fakePlan([{ write: { 'a.txt': 'a' }, result: done('wrote a') }])}` },
        { id: 'b', kind: 'work', brief: `Write b.\n${fakePlan([{ write: { 'b.txt': 'b' }, result: done('wrote b') }])}`, needs: ['a'] },
      ] },
    ] },
    {},
    { calls: [{ tool: 'complete', summary: 'a and b written' }] },
  ])
  assert.equal(outcome, 'completed')
  assert.equal(state.summary, 'a and b written')
  assert.deepEqual([...state.nodes.values()].map((n) => [n.spec.id, n.spec.parent, n.turns[0]?.agent, n.status]), [
    ['lead', undefined, undefined, 'completed'], ['a', 'lead', 'claude', 'completed'], ['b', 'lead', 'claude', 'completed'],
  ])
  const ended = (id: string) => events.find((e) => e.type === 'merge.done' && e.node === id)!.seq
  assert.deepEqual(delivered(events).map((d) => [d.requestId, d.text.split('\n')[0]]), [
    ['lead:brief', 'You are lead lead, one part of a larger goal.'],
    [`evt-${ended('a')}`, 'Child a completed: wrote a'],
    [`evt-${ended('b')}`, 'Child b completed: wrote b'],
  ])
  const prompt = JSON.parse(readFileSync(join(sessions, `${state.nodes.get('a')!.turns[0].sessionId}.json`), 'utf8')).prompts[0]
  assert.match(prompt, /Notes from your leads:\n- Use tabs\./)
  assert.deepEqual(fakeLeadRecords(runDir).filter((r) => r.op !== 'act').map((r) => r.op), [
    'deliver', 'settled', 'deliver', 'settled', 'deliver', 'settled', 'close',
  ])
})

test('a lead spawns a child by agent name: a defined agent does it, an unknown agent is refused', async () => {
  const { outcome, events, state, sessions, started } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'x', kind: 'work', brief: 'x', agent: 'gpt' }] },
      { tool: 'spawn', children: [{ id: 'r', kind: 'work', brief: `Review.\n${fakePlan([{ result: done('reviewed') }])}`, agent: 'reviewer' }] },
    ] },
    { calls: [{ tool: 'complete', summary: 'reviewed' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { agents: { reviewer: { runs: 'pi', instructions: 'Only review.' } } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).map((c) => c.result), [
    `refused: child x: unknown agent gpt (known: ${HARNESSES.join(', ')}, lead, reviewer)`,
    'spawned r; their outcomes will be delivered to you',
    'completed',
  ])
  assert.deepEqual([started, state.nodes.get('r')!.turns[0].agent], [[['pi', undefined]], 'reviewer'])
  assert.match(promptOf(sessions, state.nodes.get('r')!), /Your standing instructions:\nOnly review\./)
  assert.match(delivered(events)[0].text, new RegExp(`Agents a child may name: for work children ${HARNESSES.join(', ')}, reviewer \\(runs pi\\) \\(default claude\\); for lead children lead`))
})

test('a lead defines hr on claude: its workers get its instructions and the default model, a later spawn names it', async () => {
  const task = (id: string) => `Do ${id}.\n${fakePlan([{ result: done(id) }])}`
  const { outcome, events, state, sessions, started, runDir } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'a', kind: 'work', brief: task('a'), agent: { name: 'hr', runs: 'claude', instructions: 'Ask about people.' } }] },
      { tool: 'spawn', children: [{ id: 'dup', kind: 'work', brief: 'x', agent: { name: 'hr', runs: 'claude' } }] },
      { tool: 'spawn', children: [{ id: 'p', kind: 'work', brief: 'x', agent: { name: 'piper', runs: 'pi' } }] },
      { tool: 'spawn', children: [{ id: 'b', kind: 'work', brief: task('b'), agent: 'hr' }] },
    ] },
    {},
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { models: { claude: ['haiku', 'sonnet'] } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).map((c) => c.result), [
    'spawned a; their outcomes will be delivered to you',
    'refused: child dup: agent hr already exists: name it, or define one with a new name',
    'refused: child p: leads may not define agents on pi: the run lists no pi models',
    'spawned b; their outcomes will be delivered to you',
    'completed',
  ])
  assert.deepEqual(started, [['claude', 'haiku'], ['claude', 'haiku']])
  for (const id of ['a', 'b']) {
    assert.equal(state.nodes.get(id)!.turns[0].agent, 'hr')
    assert.match(promptOf(sessions, state.nodes.get(id)!), /Your standing instructions:\nAsk about people\.\n\nYour task/)
  }
  // The trace names the lead's agent and stays valid ATIF.
  const doc = JSON.parse(exportAtif(runDir, (_h, raw) => fakeAdapter(sessions).parse(raw)))
  assert.deepEqual(checkAtif(doc), [])
  const top = doc.subagent_trajectories[0]
  assert.deepEqual(top.subagent_trajectories.map((t: { agent: { name: string } }) => t.agent.name), ['hr', 'hr'])
})

test('a lead may define an agent named __proto__ and name it later', async () => {
  const task = (id: string) => `Do ${id}.\n${fakePlan([{ result: done(id) }])}`
  const { outcome, state, sessions } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'a', kind: 'work', brief: task('a'), agent: { name: '__proto__', runs: 'claude', instructions: 'Odd name.' } }] },
      { tool: 'spawn', children: [{ id: 'b', kind: 'work', brief: task('b'), agent: '__proto__' }] },
    ] },
    {},
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { models: { claude: ['haiku'] } })
  assert.equal(outcome, 'completed')
  for (const id of ['a', 'b']) {
    assert.equal(state.nodes.get(id)!.turns[0].agent, '__proto__')
    assert.match(promptOf(sessions, state.nodes.get(id)!), /Your standing instructions:\nOdd name\./)
  }
})

test('models leads choose are limited by runtime, and a child model needs a named agent', async () => {
  const task = (id: string) => `Do ${id}.\n${fakePlan([{ result: done(id) }])}`
  const { outcome, events, state, started } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'x', kind: 'work', brief: 'x', agent: { name: 'fast', runs: 'claude', model: 'opus' } }] },
      { tool: 'spawn', children: [{ id: 'y', kind: 'work', brief: 'y', agent: 'pi', model: 'ollama-cloud/glm-5.2' }] },
      { tool: 'spawn', children: [{ id: 'z', kind: 'work', brief: 'z', model: 'haiku' }] },
      { tool: 'spawn', children: [{ id: 'w', kind: 'work', brief: 'w', agent: { name: 'fast', runs: 'claude' }, model: 'haiku' }] },
      { tool: 'spawn', children: [
        { id: 'a', kind: 'work', brief: task('a'), agent: { name: 'fast', runs: 'claude', model: 'haiku' } },
        { id: 'b', kind: 'work', brief: task('b'), agent: 'claude', model: 'haiku' },
      ] },
    ] },
    {},
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { models: { claude: ['haiku'] } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).filter((c) => !c.ok).map((c) => c.result), [
    'refused: child x: model opus is not allowed for claude agents (allowed: haiku)',
    'refused: child y: leads may not choose a model for pi agents (none allowed)',
    'refused: child z: a model needs a named agent: name the agent it applies to',
    'refused: child w: set the model of a new agent in it, as agent.model',
  ])
  assert.deepEqual(started.sort(), [['claude', 'haiku'], ['claude', 'haiku']])
  assert.equal(state.nodes.get('a')!.turns[0].agent, 'fast')
  assert.match(delivered(events)[0].text, /You may define a new agent for a work or lead child with agent \{name, runs, model\?, instructions\?\}, on these runtimes: claude \(models haiku\)\./)
})

test('a lead child may run on an agent a lead defines on lead; a worker runtime cannot do a lead child', async () => {
  const sub = `Plan.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'planned' }] }])}`
  const { outcome, events, state, runDir } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'bad', kind: 'lead', brief: 'x', agent: { name: 'boss', runs: 'claude' } }] },
      { tool: 'spawn', children: [{ id: 'sub', kind: 'lead', brief: sub, agent: { name: 'planner', runs: 'lead', instructions: 'Plan in two steps.' } }] },
    ] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { models: { claude: ['haiku'], lead: ['other/planner-model'] } })
  assert.equal(outcome, 'completed')
  assert.equal(calls(events)[0].result, 'refused: child bad: a lead needs an agent that runs lead')
  assert.equal(state.nodes.get('sub')!.summary, 'planned')
  const brief = delivered(events, 'sub')[0].text
  assert.match(brief, /Your standing instructions:\nPlan in two steps\./)
  assert.match(brief, /for lead children lead, planner \(runs lead\)/)
  assert.deepEqual(fakeLeadRecords(runDir).find((r) => r.op === 'deliver' && r.node === 'sub'), { op: 'deliver', node: 'sub', requestId: 'sub:brief', mode: 'queue', model: 'other/planner-model' })
})

test('policy refuses a lead with a command, a fourth lead level, completing with a running child and sending to a non-child', async () => {
  const leaf = fakeLeadPlan([{ calls: [
    { tool: 'spawn', children: [{ id: 'l4', kind: 'lead', brief: 'too deep' }] },
    { tool: 'complete', summary: 'l3 done' },
  ] }])
  const mid = fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [{ id: 'l3', kind: 'lead', brief: `Third level.\n${leaf}` }] }] },
    { calls: [{ tool: 'complete', summary: 'l2 done' }] },
  ])
  const { outcome, events, state } = await runGraph([lead([
    { calls: [
      { tool: 'spawn', children: [{ id: 'l2', kind: 'lead', brief: `Second level.\n${mid}`, agent: 'lead', model: 'other/model' }] },
      { tool: 'spawn', children: [{ id: 'gate', kind: 'lead', brief: 'Gate.', command: 'true' }] },
      { tool: 'complete', summary: 'too early' },
    ] },
    { calls: [{ tool: 'send', to: 'l3', body: 'hi', mode: 'queue' }, { tool: 'complete', summary: 'all done' }] },
  ])], undefined, { createLeadRunner: fakeLeadRunner }, [], { models: { lead: ['other/model'] } })
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).filter((c) => !c.ok).map((c) => [c.node, c.call.tool, c.result]), [
    ['lead', 'spawn', 'refused: child gate: leads have no command; spawn a check child for a deterministic gate'],
    ['lead', 'complete', 'refused: children still pending or running: l2'],
    ['l3', 'spawn', 'refused: child l4: leads may nest at most 3 deep'],
    ['lead', 'send', 'refused: lead may send only to its children or to person'],
  ])
  assert.equal(state.nodes.has('l4'), false)
  assert.equal(state.nodes.get('l3')!.spec.model, 'other/model')
})

test('a run with --max-depth 4 lets leads nest four deep and tells each lead its depth', async () => {
  // Each level spawns one lead child, then completes; level 4 tries a fifth level, which is refused.
  const level = (n: number): string => fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [{ id: `l${n + 1}`, kind: 'lead', brief: n < 4 ? `Level ${n + 1}.\n${level(n + 1)}` : 'too deep' }] }] },
    ...(n < 4 ? [{ calls: [{ tool: 'complete' as const, summary: `l${n} done` }] }] : [{ calls: [{ tool: 'complete' as const, summary: 'l4 done' }] }]),
  ])
  const { outcome, events, state } = await runLead([
    { calls: [{ tool: 'spawn', children: [{ id: 'l2', kind: 'lead', brief: `Level 2.\n${level(2)}` }] }] },
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ], undefined, [], 4)
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).filter((c) => !c.ok).map((c) => [c.node, c.result]), [['l4', 'refused: child l5: leads may nest at most 4 deep']])
  assert.deepEqual(['l2', 'l3', 'l4'].map((id) => state.nodes.get(id)?.status), ['completed', 'completed', 'completed'])
  assert.match(delivered(events, 'l3')[0].text, /You are a lead at depth 3; leads may nest 4 deep/)
  assert.match(delivered(events, 'l4')[0].text, /You are a lead at depth 4, the deepest allowed: spawn no lead children\./)
})

test('a repeated callId returns the recorded result and applies nothing', async () => {
  const spawnA = { tool: 'spawn' as const, children: [{ id: 'a', kind: 'work' as const, brief: `a\n${fakePlan([{ result: done('a') }])}` }] }
  const spawnB = { tool: 'spawn' as const, children: [{ id: 'b', kind: 'work' as const, brief: 'b' }] }
  const { outcome, events, state, runDir } = await runLead([
    { calls: [{ ...spawnA, callId: 'c1' }, { ...spawnB, callId: 'c1' }] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])
  assert.equal(outcome, 'completed')
  assert.equal(calls(events).filter((c) => c.callId === 'c1').length, 1)
  assert.equal(state.nodes.has('b'), false)
  const results = fakeLeadRecords(runDir).flatMap((r) => (r.op === 'act' && r.callId === 'c1' ? [r.result] : []))
  assert.deepEqual(results, ['spawned a; their outcomes will be delivered to you', 'spawned a; their outcomes will be delivered to you'])
})

test("a worker's question reaches its lead and the lead's answer resumes the same session", async () => {
  const { outcome, events, state, sessions } = await runLead([
    { calls: [{ tool: 'spawn', children: [{ id: 'w', kind: 'work', brief: `Paint.\n${fakePlan([
      { result: { status: 'needs_input', summary: 'need a colour', question: 'Which colour?' } },
      { result: done('painted blue') },
    ])}` }] }] },
    { calls: [{ tool: 'send', to: 'w', body: 'Blue.', mode: 'queue' }] },
    { calls: [{ tool: 'complete', summary: 'painted' }] },
  ])
  assert.equal(outcome, 'completed')
  assert.match(delivered(events)[1].text, /^Child w is waiting for your answer:\nWhich colour\?/)
  const w = state.nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => t.mode), ['start', 'resume'])
  assert.equal(w.turns[0].sessionId, w.turns[1].sessionId)
  const session = JSON.parse(readFileSync(join(sessions, `${w.turns[0].sessionId}.json`), 'utf8'))
  assert.match(session.prompts[1], /Message from lead:\nBlue\./)
  assert.equal(w.summary, 'painted blue')
})

test('an interrupt send stops a running worker and resumes it with the message', async () => {
  const started = Date.now()
  const { outcome, state, sessions } = await runLead([
    { calls: [{ tool: 'spawn', children: [{ id: 'w', kind: 'work', brief: `Slow.\n${fakePlan([
      { sleepMs: 60_000, result: done('slow') }, { result: done('redirected') },
    ])}` }] }] },
    { calls: [{ tool: 'complete', summary: 'ok' }] },
  ], (e, host) => {
    if (e.type === 'turn.started' && e.node === 'w' && e.turn === 1) {
      setTimeout(() => host.act('lead', 'int', { tool: 'send', to: 'w', body: 'Change of plan.', mode: 'interrupt' }), 100)
    }
  })
  assert.equal(outcome, 'completed')
  assert.ok(Date.now() - started < 20_000)
  const w = state.nodes.get('w')!
  assert.deepEqual(w.turns[0].interrupted, { reason: 'message from lead', signal: 'SIGTERM' })
  assert.deepEqual(w.turns.map((t) => [t.mode, t.result?.summary]), [['start', undefined], ['resume', 'redirected']])
  const session = JSON.parse(readFileSync(join(sessions, `${w.turns[0].sessionId}.json`), 'utf8'))
  assert.match(session.prompts[1], /Message from lead:\nChange of plan\./)
})

test('an idle lead gets two reminders and then fails', async () => {
  const { outcome, events, state } = await runLead([{}, {}, {}])
  assert.equal(outcome, 'failed')
  const turns = events.filter((e) => e.type === 'lead.turn').map((e) => `evt-${e.seq}`)
  assert.deepEqual(delivered(events).map((d) => d.requestId), ['lead:brief', turns[0], turns[1]])
  assert.match(delivered(events)[2].text, /^Reminder 2 of 2/)
  assert.equal(state.nodes.get('lead')!.reason, 'idle after 2 reminders')
})

test('a lead may not complete while a message for it waits; the message is delivered next', async () => {
  // A runner that lets the lead answer its brief at once, before the waiting message is delivered.
  const { outcome, events } = await runGraph([lead([{}, { calls: [{ tool: 'complete', summary: 'done with the extra requirement' }] }])], undefined, {
    createLeadRunner: (o) => {
      const runner = fakeLeadRunner(o)
      return { ...runner, deliver(node, text, opts) {
        if (opts.requestId === 'lead:brief') o.host.act(node, 'early', { tool: 'complete', summary: 'too early' })
        return runner.deliver(node, text, opts)
      } }
    },
  }, [{ type: 'message', from: 'person', to: 'lead', body: 'Also add tests.', mode: 'queue' }])
  assert.equal(outcome, 'completed')
  assert.deepEqual(calls(events).map((c) => [c.ok, c.result]), [
    [false, 'refused: messages for lead are waiting and will be delivered next'],
    [true, 'completed'],
  ])
  assert.equal(delivered(events)[1].text, 'Message from person:\nAlso add tests.')
})

test("an interrupt send during a worker's acceptance check stops the check and resumes the worker", async () => {
  const started = Date.now()
  const { outcome, state, sessions } = await runLead([
    { calls: [{ tool: 'spawn', children: [{
      id: 'w', kind: 'work', command: 'test -f redirected.txt || { touch check-started; sleep 30; }',
      brief: `Work.\n${fakePlan([{ result: done('first') }, { write: { 'redirected.txt': 'x' }, result: done('redirected') }])}`,
    }] }] },
    { calls: [{ tool: 'complete', summary: 'ok' }] },
  ], (e, host) => {
    if (e.type !== 'turn.started' || e.node !== 'w' || e.turn !== 1) return
    const marker = join(e.outFile, '../../../worktrees/w/check-started') // <workspace>/run/nodes/w/turn-1.jsonl
    const poll = setInterval(() => {
      if (!existsSync(marker)) return
      clearInterval(poll)
      host.act('lead', 'int', { tool: 'send', to: 'w', body: 'Change of plan.', mode: 'interrupt' })
    }, 20)
  })
  assert.equal(outcome, 'completed')
  assert.ok(Date.now() - started < 15_000)
  const w = state.nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => [t.mode, t.check?.exitCode]), [['start', null], ['resume', 0]])
  assert.match(w.turns[0].check!.output, /interrupted: message from lead/)
  const session = JSON.parse(readFileSync(join(sessions, `${w.turns[0].sessionId}.json`), 'utf8'))
  assert.match(session.prompts[1], /^Message from lead:\nChange of plan\./)
})

test('a second settled for a delivery already answered is ignored', async () => {
  // The lead runner may report a delivery twice after a crash; the second report must change nothing.
  const { outcome, events } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [{ id: 'a', kind: 'work', brief: `a\n${fakePlan([{ result: done('a') }])}` }] }] },
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, {
    createLeadRunner: (o) => fakeLeadRunner({ ...o, host: { ...o.host, settled(node, turn) {
      o.host.settled(node, turn)
      o.host.settled(node, { ...turn, text: 'reported again' })
    } } }),
  })
  assert.equal(outcome, 'completed')
  const turns = events.flatMap((e) => (e.type === 'lead.turn' ? [e.requestId] : []))
  assert.deepEqual(turns, [...new Set(turns)])
  assert.equal(turns.length, 2)
})

test('a lead that answers an earlier delivery while a later one waits is not idle and gets no reminder', async () => {
  let held: (() => void) | undefined
  let deliveries = 0
  const { outcome, events } = await runGraph([lead([
    { calls: [{ tool: 'spawn', children: [
      { id: 'a', kind: 'work', brief: `a\n${fakePlan([{ result: done('a') }])}` },
      { id: 'b', kind: 'work', brief: `b\n${fakePlan([{ result: done('b') }])}`, needs: ['a'] },
    ] }] },
    {},
    { calls: [{ tool: 'complete', summary: 'done' }] },
  ])], undefined, {
    createLeadRunner: (o) => {
      // The answer to a's outcome is reported only after b's outcome was delivered, which the lead takes a while to answer.
      const runner = fakeLeadRunner({ ...o, host: { ...o.host, settled(node, turn) {
        if (deliveries === 2) held = () => o.host.settled(node, turn)
        else o.host.settled(node, turn)
      } } })
      return { ...runner, deliver(node, text, opts) {
        if (++deliveries !== 3) return runner.deliver(node, text, opts)
        held!()
        return new Promise((r) => setTimeout(r, 300)).then(() => runner.deliver(node, text, opts))
      } }
    },
  })
  assert.equal(outcome, 'completed')
  assert.deepEqual(delivered(events).map((d) => d.text.split(' ')[0]), ['You', 'Child', 'Child'])
})
