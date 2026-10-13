import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { main } from '../src/cli.ts'
import { readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { gitWorkspace } from './fixtures/git-repo.ts'
import { fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRecords, fakeLeadRunner } from './fixtures/fake-lead.ts'
import { fakeBin, sous, runDirOf, waitFor } from './fixtures/sous-proc.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'
import { HARNESSES } from '../src/types.ts'

function setup(steps: FakeStep[]) {
  const workspace = gitWorkspace('sous-cli-')
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

test('sous run completes a work then check graph and sous status shows it', async () => {
  const { workspace, graph, sessions } = setup([{ write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello.txt' } }])
  const run = sous(['run', graph], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /turn.ended +write turn 1 done: wrote hello.txt/)
  assert.match(run.output(), /run.completed +2 nodes completed/)
  const runDir = runDirOf(workspace)!
  assert.match(runDir, /\/\d{8}T\d{6}Z-[0-9a-f]{4}$/)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).goal, 'write a greeting')
  assert.equal(existsSync(join(runDir, 'lock')), false)

  const status = sous(['status', '--workspace', workspace], tmpdir(), sessions)
  assert.equal(await status.exit, 0)
  const id = runDir.split('/').at(-1)
  assert.match(run.output(), new RegExp(`^result: branch sous/${id}$`, 'm'))
  assert.match(status.output(), new RegExp(`^run ${id} completed: write a greeting\n  result: branch sous/${id}\n  write completed on claude turns 1: wrote hello.txt\n  test completed`))
})

test('sous run checks the agents on PATH: a node without an agent falls back to the first available worker', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a file',
    nodes: [
      { id: 'any', kind: 'work', brief: `Write a.\n${fakePlan([{ write: { 'a.txt': 'a' }, result: { status: 'done', summary: 'wrote a' } }])}` },
    ],
  }))
  // Only codex, pi and git are on PATH: no claude or droid, and no other directory.
  const run = sous(['run', graph], workspace, join(workspace, 'sessions'), fakeBin(['codex', 'pi']))
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /^agents: codex, pi, lead \(ollama-cloud\/deepseek-v4.1-flash\); not available: claude \(claude not found\), droid \(droid not found\)$/m)
  const state = fold(readEvents(runDirOf(workspace)!))
  assert.deepEqual([state.nodes.get('any')!.status, state.nodes.get('any')!.turns[0].agent], ['completed', 'codex'])
  assert.match(run.output(), /turn.started +any turn 1 start on codex pid/)
})

test('sous run refuses a graph whose node names an unavailable agent, or defaults to one, before the run exists', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const graph = join(workspace, 'graph.json')
  const sessions = join(workspace, 'sessions')
  const write = (raw: object) => writeFileSync(graph, JSON.stringify(raw))
  const brief = `Do it.\n${fakePlan([{ result: { status: 'done', summary: 'done' } }])}`
  write({
    goal: 'review', agents: { reviewer: { runs: 'codex' } },
    nodes: [{ id: 'write', kind: 'work', brief }, { id: 'review', kind: 'work', agent: 'reviewer', needs: ['write'], brief }, { id: 'ship', kind: 'gate', needs: ['write'], brief: 'Ship?' }],
  })
  const named = sous(['run', graph], workspace, sessions, fakeBin(['claude']))
  assert.equal(await named.exit, 1, named.output())
  assert.match(named.output(), /^sous: node review: agent reviewer is not available \(codex not found\): install codex or change the agent$/m)
  assert.doesNotMatch(named.output(), /^run /m)
  assert.equal(runDirOf(workspace), undefined, 'no run was created')

  write({ goal: 'g', agent: 'droid', nodes: [{ id: 'a', kind: 'work', brief }, { id: 'b', kind: 'work', agent: 'claude', brief }, { id: 't', kind: 'check', command: 'true' }] })
  const defaulted = sous(['run', graph], workspace, sessions, fakeBin(['claude']))
  assert.equal(await defaulted.exit, 1, defaulted.output())
  assert.match(defaulted.output(), /^sous: node a: agent droid is not available \(droid not found\): install droid or change the agent$/m)
  assert.doesNotMatch(defaulted.output(), /node b/)

  write({ goal: 'g', nodes: [{ id: 'a', kind: 'work', brief }, { id: 'b', kind: 'work', brief }] })
  const none = sous(['run', graph], workspace, sessions, fakeBin([]))
  assert.equal(await none.exit, 1, none.output())
  assert.match(none.output(), /^sous: node a: no worker agent is available \(not found: claude, codex, pi, droid\): install one or name an agent\nnode b: no worker agent/m)
  assert.equal(runDirOf(workspace), undefined)

  // A goal run is not refused for what its lead may decide at runtime.
  const goal = sous(['run', `Do it.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'done' }] }])}`], workspace, sessions, fakeBin([]))
  assert.equal(await goal.exit, 0, goal.output())
})

test('sous run refuses an argument that looks like a missing file instead of running it as a goal', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const sessions = join(workspace, 'sessions')
  for (const arg of ['missing.json', 'graphs/missing', './missing']) {
    const run = sous(['run', arg], workspace, sessions)
    assert.equal(await run.exit, 1, run.output())
    assert.match(run.output(), new RegExp(`^sous: no such file: ${arg.replace(/[./]/g, '\\$&')}; if it is a goal, write it as a sentence$`, 'm'))
  }
  mkdirSync(join(workspace, 'graphs'))
  const directory = sous(['run', 'graphs/'], workspace, sessions)
  assert.equal(await directory.exit, 1, directory.output())
  assert.match(directory.output(), /^sous: not a file: graphs\/; /m)
  assert.equal(runDirOf(workspace), undefined, 'no run was created')
  // Words are a goal, whatever characters they hold, and so is a URL.
  const url = sous(['run', `https://example.com/issues/86\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'done' }] }])}`], workspace, sessions)
  assert.equal(await url.exit, 0, url.output())
  const goal = sous(['run', `fix the CI/CD pipeline or config.json\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'done' }] }])}`], workspace, sessions)
  assert.equal(await goal.exit, 0, goal.output())
})

test("a graph that shadows a built-in with a lead agent: a work node's default skips it for the next worker agent", async () => {
  const workspace = gitWorkspace('sous-cli-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a', agents: { claude: { runs: 'lead' } },
    nodes: [{ id: 'w', kind: 'work', brief: `Write a.\n${fakePlan([{ result: { status: 'done', summary: 'wrote a' } }])}` }],
  }))
  const run = sous(['run', graph], workspace, join(workspace, 'sessions'))
  assert.equal(await run.exit, 0, run.output())
  assert.equal(fold(readEvents(runDirOf(workspace)!)).nodes.get('w')!.turns[0].agent, 'codex')
})

test("a lead whose node model is on another provider runs when that provider, not the default one, has a credential", async () => {
  const workspace = gitWorkspace('sous-cli-')
  const graph = join(workspace, 'graph.json')
  const brief = `Plan.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'planned' }] }])}`
  writeFileSync(graph, JSON.stringify({ goal: 'plan', nodes: [{ id: 'planner', kind: 'lead', model: 'openai-codex/gpt-5.5', brief }] }))
  const code = await main(['run', graph, '--workspace', workspace], {
    getAdapter: () => { throw new Error('no workers in this run') },
    createLeadRunner: fakeLeadRunner,
    leadCredential: async (provider) => (provider === 'openai-codex' ? 'Pi login' : undefined),
  })
  assert.equal(code, 0)
  assert.equal(fold(readEvents(runDirOf(workspace)!)).nodes.get('planner')!.summary, 'planned')
})

test('SIGINT stops the running turn group, a SIGTERM-ignoring grandchild included, and leaves the run resumable', async () => {
  const { workspace, graph, sessions } = setup([{ spawnSleeper: 'ignore-term', sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])
  const run = sous(['run', graph], workspace, sessions)
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
  assert.match(run.output(), /continue with: sous resume /)
})

test('a second SIGINT while stopping kills a group that ignores SIGTERM at once', async () => {
  const { workspace, graph, sessions } = setup([{ spawnSleeper: 'ignore-term', sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])
  const run = sous(['run', graph], workspace, sessions)
  let grandchild: number | undefined
  for (let i = 0; i < 100 && grandchild === undefined; i++) {
    await sleep(100)
    const file = existsSync(sessions) && readdirSync(sessions).find((f) => f.endsWith('.grandchild'))
    if (file) grandchild = Number(readFileSync(join(sessions, file), 'utf8'))
  }
  assert.ok(grandchild, 'the worker started its grandchild')
  run.child.kill('SIGINT')
  await sleep(300)
  const started = Date.now()
  run.child.kill('SIGINT')
  assert.equal(await run.exit, 1, run.output())
  assert.ok(Date.now() - started < 3000, 'the second SIGINT did not wait for the 5 s grace')
  assert.throws(() => process.kill(grandchild!, 0), /ESRCH/)
  assert.match(run.output(), /continue with: sous resume /)
})

test('an error inside the supervisor stops its workers and prints the resume hint; sous resume then finishes the run', async () => {
  const { workspace, graph, sessions } = setup([
    { sleepMs: 60_000, result: { status: 'done', summary: 'late' } },
    { write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello after resume' } },
  ])
  const run = sous(['run', graph], workspace, sessions)
  const started = await waitFor(workspace, (e) => e.type === 'turn.started' && e.node === 'write')
  const pid = started.type === 'turn.started' ? started.pid : 0
  // Once the worker has its prompt (its session file exists), the person removes the run's commands directory: the
  // main loop's next poll of it throws.
  const session = await waitFor(workspace, (e) => e.type === 'turn.session' && e.node === 'write')
  const file = join(sessions, `${session.type === 'turn.session' ? session.sessionId : ''}.json`)
  for (let i = 0; i < 200 && !existsSync(file); i++) await sleep(25)
  rmSync(join(runDirOf(workspace)!, 'commands'), { recursive: true })
  assert.equal(await run.exit, 1, run.output())
  assert.match(run.output(), /^sous: ENOENT: no such file or directory, scandir .*commands/m)
  assert.match(run.output(), /^stopped; continue with: sous resume /m)
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the worker was stopped')
  const events = readEvents(runDirOf(workspace)!)
  assert.deepEqual(events.map((e) => e.type).slice(-2), ['turn.interrupted', 'turn.ended'])
  assert.equal(existsSync(join(runDirOf(workspace)!, 'lock')), false)

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  const state = fold(readEvents(runDirOf(workspace)!))
  assert.equal(state.status, 'completed')
  assert.deepEqual(state.nodes.get('write')!.turns.map((t) => [t.recovery ?? false, t.result?.summary]), [[false, undefined], [true, 'wrote hello after resume']])
})

test('sous cancel from another terminal cancels a subtree, stops its worker and cancels its lead', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const sessions = join(workspace, 'sessions')
  const worker = { id: 'w', kind: 'work' as const, brief: `Wait.\n${fakePlan([{ sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])}` }
  const sub = { id: 'sub', kind: 'lead' as const, brief: `Run w.\n${fakeLeadPlan([{ calls: [{ tool: 'spawn', children: [worker] }] }])}` }
  const goal = `Ship it.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [sub] }] },
    { calls: [{ tool: 'complete', summary: 'shipped without sub' }] },
  ])}`
  const run = sous(['run', goal], workspace, sessions)
  const started = await waitFor(workspace, (e) => e.type === 'turn.started' && e.node === 'w')
  const cancel = sous(['cancel', 'sub'], workspace, sessions)
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

test('sous answer delivers to a lead that asked the person, and sous status lists the question; a stray directory is no run', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const sessions = join(workspace, 'sessions')
  const goal = `Pick a database.\n${fakeLeadPlan([
    { calls: [{ tool: 'escalate', question: 'Which database?' }] },
    { calls: [{ tool: 'complete', summary: 'picked' }] },
  ])}`
  const run = sous(['run', goal], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'lead.turn')
  assert.match(run.output(), /Question from lead:\nWhich database\?\nAnswer with: sous answer lead/)
  // An agent may leave a directory beside the runs (a real splitter did); it sorts after them but is not the latest run.
  const stray = join(workspace, '.sous', 'runs', 'splits')
  mkdirSync(stray)

  const status = sous(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /\n  lead waiting\nquestions for you \(sous answer <node> "<answer>"\):\n  lead: Which database\?\n$/)

  const answer = sous(['answer', 'lead', 'Postgres.'], workspace, sessions)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await run.exit, 0, run.output())
  rmSync(stray, { recursive: true })
  const events = readEvents(runDirOf(workspace)!)
  const message = events.find((e) => e.type === 'message')!
  assert.deepEqual(message.type === 'message' && [message.from, message.to, message.body], ['person', 'lead', 'Postgres.'])
  const last = events.findLast((e) => e.type === 'lead.delivered')!
  assert.deepEqual(last.type === 'lead.delivered' && [last.requestId, last.text], [`evt-${message.seq}`, 'Message from person:\nPostgres.'])
})

test('sous run --agents gives a goal run its agents and models, recorded in run.created; with a graph file it is an error', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const sessions = join(workspace, 'sessions')
  const file = join(workspace, 'agents.json')
  const definitions = { agents: { hr: { runs: 'claude', instructions: 'Be kind.' } }, models: { claude: ['haiku'] } }
  writeFileSync(file, JSON.stringify(definitions))
  const brief = `Hire.\n${fakePlan([{ result: { status: 'done', summary: 'hired' } }])}`
  const goal = `Hire someone.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [{ id: 'hire', kind: 'work', brief, agent: 'hr', model: 'haiku' }] }] },
    { calls: [{ tool: 'complete', summary: 'hired' }] },
  ])}`
  const run = sous(['run', goal, '--agents', file], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), new RegExp(`^agents: ${HARNESSES.join(', ')}, lead \\(ollama-cloud/deepseek-v4.1-flash\\), hr$`, 'm'))
  const runDir = runDirOf(workspace)!
  const events = readEvents(runDir)
  const created = events[0]
  assert.deepEqual(created.type === 'run.created' && [created.definitions, created.graph], [definitions, undefined])
  const brief0 = events.find((e) => e.type === 'lead.delivered')!
  assert.match(brief0.type === 'lead.delivered' ? brief0.text : '', new RegExp(`for work children ${HARNESSES.join(', ')}, hr \\(runs claude\\)[\\s\\S]*on these runtimes: claude \\(models haiku\\)`))
  const hire = fold(events).nodes.get('hire')!
  assert.equal(hire.turns[0].agent, 'hr')
  const prompt = JSON.parse(readFileSync(join(sessions, `${hire.turns[0].sessionId}.json`), 'utf8')).prompts[0]
  assert.match(prompt, /Your standing instructions:\nBe kind\./)
  const status = sous(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /\n    hire completed on hr turns 1: hired\n/)

  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'g', nodes: [{ id: 'a', kind: 'work', brief: 'a' }] }))
  const both = sous(['run', graph, '--agents', file], workspace, sessions)
  assert.equal(await both.exit, 1)
  assert.match(both.output(), /sous: --agents is for goal runs: put agents in the graph file/)
  writeFileSync(file, JSON.stringify({ ...definitions, nodes: [] }))
  const bad = sous(['run', 'g', '--agents', file], workspace, sessions)
  assert.equal(await bad.exit, 1)
  assert.match(bad.output(), /sous: agents file: unknown field nodes/)
})

test('a lead that names no model gets the first lead provider with a credential, printed on the agents line', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const goal = `Plan.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'planned' }] }])}`
  const log = mock.method(console, 'log', () => {})
  try {
    const code = await main(['run', goal, '--workspace', workspace], {
      getAdapter: () => { throw new Error('no workers in this run') }, createLeadRunner: fakeLeadRunner,
      leadCredential: async (provider) => (provider === 'openai' ? 'OPENAI_API_KEY' : undefined),
    })
    assert.equal(code, 0)
    const lines = log.mock.calls.map((c) => c.arguments.join(' '))
    assert.ok(lines.some((line) => /^agents: .*\blead \(openai\/gpt-6-luna\)(;|$)/.test(line)), lines.join('\n'))
  } finally {
    log.mock.restore()
  }
  const runDir = runDirOf(workspace)!
  const delivered = fakeLeadRecords(runDir).find((r) => r.op === 'deliver')!
  assert.equal(delivered.op === 'deliver' && delivered.model, 'openai/gpt-6-luna')
  assert.equal(fold(readEvents(runDir)).nodes.get('lead')!.summary, 'planned')
})

test('a resumed run keeps the lead model chosen when it was created, for leads resolved later too', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const sessions = join(workspace, 'sessions')
  const sub = { id: 'sub', kind: 'lead' as const, brief: `Finish.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'sub done' }] }])}` }
  const goal = `Plan.\n${fakeLeadPlan([
    { calls: [{ tool: 'escalate', question: 'Go on?' }] },
    { calls: [{ tool: 'spawn', children: [sub] }] },
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ])}`
  // Created when only OpenAI has a credential; resumed when every provider has one.
  process.env.FAKE_LEAD_CREDENTIALS = 'openai'
  const run = sous(['run', goal], workspace, sessions)
  delete process.env.FAKE_LEAD_CREDENTIALS
  await waitFor(workspace, (e) => e.type === 'lead.turn')
  run.child.kill('SIGINT')
  assert.equal(await run.exit, 1, run.output())
  assert.match(run.output(), /^agents: .*\blead \(openai\/gpt-6-luna\)(;|$)/m)
  const runDir = runDirOf(workspace)!
  const created = readEvents(runDir)[0]
  assert.equal(created.type === 'run.created' && created.leadModel, 'openai/gpt-6-luna')

  const resumed = sous(['resume'], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'run.resumed')
  const answer = sous(['answer', 'lead', 'Yes.'], workspace, sessions)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.match(resumed.output(), /^agents: .*\blead \(openai\/gpt-6-luna\)(;|$)/m)
  const delivered = fakeLeadRecords(runDir).filter((r) => r.op === 'deliver' && r.node === 'sub')
  assert.deepEqual(delivered.map((r) => r.op === 'deliver' && r.model), ['openai/gpt-6-luna'])
  assert.equal(fold(readEvents(runDir)).summary, 'all done')
})

test('sous run refuses a graph lead node or a goal when the lead has no credential, before the run exists', async () => {
  const workspace = gitWorkspace('sous-cli-')
  const graph = join(workspace, 'graph.json')
  const brief = `Plan.\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'planned' }] }])}`
  writeFileSync(graph, JSON.stringify({ goal: 'plan', nodes: [{ id: 'planner', kind: 'lead', brief }] }))
  const refused = async (arg: string) => {
    const error = mock.method(console, 'error', () => {})
    const log = mock.method(console, 'log', () => {})
    try {
      const code = await main(['run', arg, '--workspace', workspace], {
        getAdapter: () => { throw new Error('no workers in this run') }, createLeadRunner: fakeLeadRunner, leadCredential: async () => undefined,
      })
      return { code, error: error.mock.calls.map((c) => c.arguments.join(' ')).join('\n') }
    } finally {
      error.mock.restore()
      log.mock.restore()
    }
  }
  for (const arg of [graph, brief]) {
    const { code, error } = await refused(arg)
    assert.equal(code, 1)
    assert.match(error, /^sous: node (planner|lead): agent lead is not available \(no lead provider has a credential\): set OLLAMA_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY, or log in with Pi \(run pi\), or name a lead model \(--agents, or the node's model\)$/)
    assert.equal(runDirOf(workspace), undefined, 'no run was created')
  }
})
