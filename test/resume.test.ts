// `sous resume` after a SIGKILLed supervisor, and gate nodes, through real `sous` processes and fake workers.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fold, openLog, readEvents } from '../src/run/index.ts'
import type { Event, EventBody, NodeSpec } from '../src/contracts/index.ts'
import { checkAtif } from './helpers/atif-checker.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { fakePlan } from './helpers/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRecords } from './helpers/fake-lead.ts'
import { fakeBin, sous, runDirOf, waitFor } from './helpers/sous-proc.ts'
import type { FakeStep } from './helpers/fake-worker.ts'

const CRASH = new URL('./helpers/crash-supervisor.ts', import.meta.url).pathname
/** A turn that has begun (it said something, so its session can be resumed) and runs until it is stopped. */
const LONG: FakeStep = { say: 'working', sleepMs: 60_000, result: { status: 'done', summary: 'too late' } }

function workspaceWith(nodes: NodeSpec[]) {
  const workspace = gitWorkspace('sous-resume-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'write a greeting', agent: 'claude', nodes }))
  return { workspace, graph, sessions: join(workspace, 'sessions') }
}

const work = (id: string, steps: FakeStep[], needs?: string[]): NodeSpec & { kind: 'work' } =>
  ({ id, kind: 'work', brief: `Do ${id}.\n${fakePlan(steps)}`, ...(needs ? { needs } : {}) })

const started = (node: string, turn: number) => (e: Event) => e.type === 'turn.started' && e.node === node && e.turn === turn
const pidOf = (e: Event) => (e.type === 'turn.started' ? e.pid : 0)
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
/** Prompts a fake worker session received, by node, from the session files. */
const promptsOf = (sessions: string, runDir: string, node: string) => {
  const session = fold(readEvents(runDir)).nodes.get(node)!.turns[0].sessionId!
  return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts as string[]
}

/** Waits until the fake worker of `node` has received its prompt for `turn`. */
async function workerAt(workspace: string, sessions: string, node: string, turn: number) {
  const e = await waitFor(workspace, (e) => e.type === 'turn.session' && e.node === node && e.turn === turn)
  const file = join(sessions, `${e.type === 'turn.session' ? e.sessionId : ''}.json`)
  for (let i = 0; i < 200; i++) {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).prompts.length >= turn) return
    } catch {}
    await sleep(25)
  }
  throw new Error(`the worker of ${node} did not start turn ${turn}`)
}

/** Starts `sous run`, waits until `node`'s first turn runs, and SIGKILLs the supervisor. Returns the run directory. */
async function killDuringTurn(workspace: string, graph: string, sessions: string, node: string) {
  const run = sous(['run', graph], workspace, sessions)
  await workerAt(workspace, sessions, node, 1)
  run.child.kill('SIGKILL')
  await run.exit
  return runDirOf(workspace)!
}

test('after a SIGKILL, only sous resume takes the run over: it stops the orphaned turn, resumes its session and finishes', async () => {
  const { workspace, graph, sessions } = workspaceWith([
    work('a', [{ write: { 'a.txt': 'a\n' }, result: { status: 'done', summary: 'wrote a' } }]),
    work('b', [LONG, { write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello after resume' } }], ['a']),
    { id: 'test', kind: 'check', command: 'grep -q hello hello.txt', needs: ['b'] },
  ])
  const run = sous(['run', graph], workspace, sessions)
  await workerAt(workspace, sessions, 'b', 1)
  const first = await waitFor(workspace, started('b', 1))
  const refused = sous(['resume'], workspace, sessions)
  assert.equal(await refused.exit, 1)
  assert.match(refused.output(), /locked by a live supervisor/)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  assert.ok(existsSync(join(runDir, 'lock')), 'the killed supervisor left its lock')
  assert.ok(!gone(pidOf(first)), 'the turn outlived its supervisor')
  const status = sous(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /^run \S+ stopped: [^]*continue it with: sous resume \S+\n$/)

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.ok(gone(pidOf(first)), 'resume stopped the orphaned turn')
  const events = readEvents(runDir)
  const state = fold(events)
  assert.equal(state.status, 'completed')
  assert.equal(events.filter((e) => e.type === 'run.resumed').length, 1)
  const b = state.nodes.get('b')!
  assert.deepEqual(b.turns.map((t) => [t.mode, t.recovery, t.interrupted?.reason, t.result?.summary]), [
    ['start', undefined, 'still running when the run was resumed', undefined],
    ['resume', true, undefined, 'wrote hello after resume'],
  ])
  assert.equal(b.turns[1].sessionId, b.turns[0].sessionId)
  assert.match(promptsOf(sessions, runDir, 'b')[1], /^You were interrupted: sous stopped while you worked/)
  // The finished node ran once.
  assert.equal(state.nodes.get('a')!.turns.length, 1)
  assert.equal(promptsOf(sessions, runDir, 'a').length, 1)
  assert.equal(existsSync(join(runDir, 'lock')), false)

  // The trace shows the resume and the interruption, and stays valid ATIF.
  assert.equal(await sous(['export', 'atif'], workspace, sessions).exit, 0)
  const doc = JSON.parse(readFileSync(join(runDir, 'trace.atif.json'), 'utf8'))
  assert.deepEqual(checkAtif(doc), [])
  assert.ok(doc.steps.some((s: { source: string; message: string }) => s.source === 'system' && /^Run resumed/.test(s.message)))

  const again = sous(['resume'], workspace, sessions)
  assert.equal(await again.exit, 1)
  assert.match(again.output(), /already completed; a finished run is not resumed/)
})

test('a turn that finished while the supervisor was down is recorded from its output, not run again', async () => {
  const { workspace, graph, sessions } = workspaceWith([
    work('w', [{ sleepMs: 500, write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'finished while down' } }]),
    { id: 'test', kind: 'check', command: 'grep -q hello hello.txt', needs: ['w'] },
  ])
  const runDir = await killDuringTurn(workspace, graph, sessions, 'w')
  const turn = readEvents(runDir).find(started('w', 1))!
  for (let i = 0; i < 100 && !gone(pidOf(turn)); i++) await sleep(50)

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  const events = readEvents(runDir)
  const w = fold(events).nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => [t.result?.summary, t.interrupted]), [['finished while down', undefined]])
  assert.equal(w.status, 'completed')
  assert.equal(promptsOf(sessions, runDir, 'w').length, 1)
})

test('a recorded pid now used by another process is treated as dead: that process is left alone', async (t) => {
  const { workspace, graph, sessions } = workspaceWith([
    work('w', [LONG, { result: { status: 'done', summary: 'redone' } }]),
  ])
  const runDir = await killDuringTurn(workspace, graph, sessions, 'w')
  const turn = readEvents(runDir).find(started('w', 1))!
  process.kill(-pidOf(turn), 'SIGKILL')
  // Another process (its own group leader) now has the recorded pid's place; its start time differs.
  const decoy = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  t.after(() => decoy.kill('SIGKILL'))
  const file = join(runDir, 'events.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  writeFileSync(file, lines.map((l) => (l.includes('"type":"turn.started"') ? l.replace(`"pid":${pidOf(turn)},`, `"pid":${decoy.pid},`) : l)).join('\n'))

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.ok(!gone(decoy.pid!), 'the decoy was not signalled')
  const w = fold(readEvents(runDir)).nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => [t.interrupted, t.error, t.recovery, t.result?.summary]), [
    [undefined, 'the supervisor stopped during this turn', undefined, undefined],
    [undefined, undefined, true, 'redone'],
  ])
})

test('a node whose turn a supervisor stop cuts short after 3 recoveries fails', async () => {
  const { workspace, graph, sessions } = workspaceWith([work('w', [LONG, LONG, LONG, LONG, LONG])])
  const runDir = await killDuringTurn(workspace, graph, sessions, 'w')
  for (let turn = 2; turn <= 4; turn++) {
    const resumed = sous(['resume'], workspace, sessions)
    await workerAt(workspace, sessions, 'w', turn)
    resumed.child.kill('SIGKILL')
    await resumed.exit
  }
  const last = readEvents(runDir).find(started('w', 4))!
  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 1, resumed.output())
  assert.ok(gone(pidOf(last)))
  const state = fold(readEvents(runDir))
  const w = state.nodes.get('w')!
  assert.equal(w.reason, 'a supervisor stop cut its turn short after 3 recoveries')
  assert.deepEqual(w.turns.map((t) => t.recovery ?? false), [false, true, true, true])
  assert.equal(state.status, 'failed')
})

/** A marker for a fake step's `stopEarly`, outside the workspace. */
const earlyMarker = () => join(mkdtempSync(join(tmpdir(), 'sous-early-')), 'stopped')
async function until(file: string) {
  for (let i = 0; i < 400 && !existsSync(file); i++) await sleep(25)
  assert.ok(existsSync(file), `${file} never appeared`)
}
const sessionPrompts = (sessions: string, sessionId: string) => JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), 'utf8')).prompts as string[]

test('a worker killed before its harness saved its session is started again from its brief, in a new session, and completes', async () => {
  const marker = earlyMarker()
  const { workspace, graph, sessions } = workspaceWith([
    work('w', [{ stopEarly: marker, write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello' } }]),
    { id: 'test', kind: 'check', command: 'grep -q hello hello.txt', needs: ['w'] },
  ])
  const run = sous(['run', graph], workspace, sessions)
  await until(marker)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const state = fold(readEvents(runDir))
  assert.equal(state.status, 'completed')
  const [cut, again] = state.nodes.get('w')!.turns
  assert.deepEqual([cut, again].map((t) => [t!.mode, t!.recovery ?? false, t!.result?.summary]), [['start', false, undefined], ['start', true, 'wrote hello']])
  assert.ok(cut!.sessionId && again!.sessionId && again!.sessionId !== cut!.sessionId, 'a new session')
  assert.equal(existsSync(join(sessions, `${cut!.sessionId}.json`)), false, 'the cut session was never saved')
  const prompts = sessionPrompts(sessions, again!.sessionId!)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0]!, /^You are one worker on a larger goal\./)
})

test('a turn cut before it began leaves the session established before it: resume continues that session, with what the cut turn took', async () => {
  const marker = earlyMarker()
  const { workspace, graph, sessions } = workspaceWith([
    work('w', [
      { result: { status: 'needs_input', summary: 'which colour?', question: 'Which colour?' } },
      { stopEarly: marker, write: { 'colour.txt': 'blue\n' }, result: { status: 'done', summary: 'painted' } },
    ]),
  ])
  const run = sous(['run', graph], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'w')
  const answer = sous(['answer', 'w', 'Paint it blue.'], workspace, sessions)
  assert.equal(await answer.exitWithin(), 0, answer.output())
  await until(marker)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const state = fold(readEvents(runDir))
  assert.equal(state.status, 'completed')
  const w = state.nodes.get('w')!
  assert.deepEqual(w.turns.map((t) => [t.mode, t.recovery ?? false, t.result?.summary]), [
    ['start', false, 'which colour?'], ['resume', false, undefined], ['resume', true, 'painted'],
  ])
  assert.equal(new Set(w.turns.map((t) => t.sessionId)).size, 1, 'one session')
  // The session never saw the cut turn's prompt, so the answer comes again with the recovery note.
  const prompts = sessionPrompts(sessions, w.turns[0]!.sessionId!)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /^You were interrupted: sous stopped while you worked[\s\S]*Paint it blue\./)
})

test("a lead's delivery left unanswered by a SIGKILL is delivered again on resume, and the run completes", async () => {
  const { workspace, sessions } = workspaceWith([])
  const goal = `Ship it.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [work('w', [{ result: { status: 'done', summary: 'w done' } }])] }] },
    { sleepMs: 1500, calls: [{ tool: 'complete', summary: 'shipped' }] },
  ])}`
  const outcome = (e: Event) => e.type === 'lead.delivered' && e.requestId.startsWith('evt-')
  const run = sous(['run', goal], workspace, sessions)
  await waitFor(workspace, outcome)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  const { requestId } = readEvents(runDir).find(outcome) as Extract<Event, { type: 'lead.delivered' }>
  assert.ok(!readEvents(runDir).some((e) => e.type === 'lead.turn' && e.requestId === requestId))
  const before = fakeLeadRecords(runDir).length

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exit, 0, resumed.output())
  const events = readEvents(runDir)
  const state = fold(events)
  assert.equal(state.summary, 'shipped')
  assert.equal(state.nodes.get('w')!.turns.length, 1)
  // The resumed supervisor hands the runner the unanswered delivery again, and only that one.
  const delivered = fakeLeadRecords(runDir).slice(before).filter((r) => r.op === 'deliver').map((r) => r.op === 'deliver' && r.requestId)
  assert.deepEqual(delivered, [requestId])
  assert.equal(events.filter((e) => e.type === 'lead.delivered' && e.requestId === requestId).length, 1)
  assert.equal(events.filter((e) => e.type === 'lead.turn' && e.requestId === requestId).length, 1)
})

test("a message held for a lead's next delivery when the supervisor is SIGKILLed is delivered once on resume, with that delivery", async () => {
  const { workspace, sessions } = workspaceWith([])
  const send = `'${process.execPath}' '${new URL('../src/cli.ts', import.meta.url).pathname}' send lead 'I moved util.js.'`
  const goal = `Ship it.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [
      work('a', [{ sh: send, ...LONG }, { result: { status: 'done', summary: 'a done' } }]),
      work('b', [LONG, { result: { status: 'done', summary: 'b done' } }]),
    ] }] },
    {},
    { calls: [{ tool: 'complete', summary: 'shipped' }] },
  ])}`
  const run = sous(['run', goal], workspace, sessions)
  const message = await waitFor(workspace, (e) => e.type === 'message' && e.sent === true)
  await sleep(300) // the supervisor had its chance to deliver it, and held it: both children still work
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  const held = `evt-${message.seq}`
  const carrying = (e: Event) => e.type === 'lead.delivered' && (e.requestId === held || e.carries?.includes(held))
  assert.ok(!readEvents(runDir).some(carrying), 'the message was delivered before the stop')

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const events = readEvents(runDir)
  assert.equal(fold(events).summary, 'shipped')
  const deliveries = events.flatMap((e) => (e.type === 'lead.delivered' ? [e] : []))
  assert.equal(deliveries.filter(carrying).length, 1)
  assert.match(deliveries.find(carrying)!.text, /^Child a tells you while it works \(no answer needed\):\nI moved util\.js\.\n\nChild [ab] completed: [ab] done$/)
  // Brief and two outcomes: the runner got each request once.
  const requests = fakeLeadRecords(runDir).flatMap((r) => (r.op === 'deliver' ? [r.requestId] : []))
  assert.deepEqual(requests, deliveries.map((d) => d.requestId))
  assert.equal(deliveries.length, 3)
})

test('a gate waits for sous approve from another process, then its dependants run', async () => {
  const { workspace, graph, sessions } = workspaceWith([
    { id: 'ship', kind: 'gate', brief: 'Publish the greeting?' },
    work('w', [{ write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'published' } }], ['ship']),
  ])
  const run = sous(['run', graph], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'ship')
  const status = sous(['status'], workspace, sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /\n  ship waiting\n  w pending\napprovals for you \(sous approve <node>, or sous cancel <node> to reject\):\n  ship: Publish the greeting\?\n$/)
  const answer = sous(['answer', 'ship', 'yes'], workspace, sessions)
  assert.equal(await answer.exit, 1)
  assert.match(answer.output(), /ship is a gate: approve it with sous approve/)
  assert.equal(await sous(['approve', 'w'], workspace, sessions).exit, 1)

  const approve = sous(['approve', 'ship'], workspace, sessions)
  assert.equal(await approve.exit, 0, approve.output())
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /Approval requested by ship:\nPublish the greeting\?\nApprove with: sous approve ship, or reject with: sous cancel ship/)
  const state = fold(readEvents(runDirOf(workspace)!))
  assert.deepEqual(['ship', 'w'].map((id) => state.nodes.get(id)!.summary), ['approved by person', 'published'])
})

test("sous cancel rejects a lead's gate child, and the lead hears it", async () => {
  const { workspace, sessions } = workspaceWith([])
  const goal = `Deploy.\n${fakeLeadPlan([
    { calls: [{ tool: 'spawn', children: [{ id: 'ok', kind: 'gate', brief: 'Deploy to production?' }] }] },
    { calls: [{ tool: 'complete', summary: 'not deployed: rejected' }] },
  ])}`
  const run = sous(['run', goal], workspace, sessions)
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'ok')
  const cancel = sous(['cancel', 'ok'], workspace, sessions)
  assert.equal(await cancel.exit, 0, cancel.output())
  assert.equal(await run.exit, 0, run.output())
  const events = readEvents(runDirOf(workspace)!)
  const state = fold(events)
  assert.equal(state.nodes.get('ok')!.reason, 'cancelled by person')
  assert.ok(events.some((e) => e.type === 'lead.delivered' && e.text === 'Child ok failed: cancelled by person'))
  assert.equal(state.summary, 'not deployed: rejected')
})

/** A run directory with these nodes (and events) in <workspace>/.sous/runs/, for `sous resume`. */
function runWith(nodes: NodeSpec[], more: EventBody[] = []) {
  const workspace = gitWorkspace('sous-resume-')
  const runDir = join(workspace, '.sous', 'runs', 'r')
  mkdirSync(join(runDir, 'commands'), { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace })
  for (const node of nodes) log.append({ type: 'node.added', node, by: 'graph' })
  for (const e of more) log.append(e)
  log.close()
  return { workspace, runDir, sessions: join(workspace, 'sessions') }
}

/** Runs a supervisor over the run that SIGKILLs itself at `point`. */
function crash(workspace: string, runDir: string, point: 'event' | 'rm', name: string) {
  const child = spawn(process.execPath, [CRASH, workspace, runDir, point, name], { stdio: 'ignore' })
  return new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_, signal) => resolve(signal)))
}

/** `sous resume`, stopped (SIGINT) if it has not finished within `ms`. */
async function resumeWithin(workspace: string, sessions: string, ms: number) {
  const resumed = sous(['resume'], workspace, sessions)
  const timer = setTimeout(() => resumed.child.kill('SIGINT'), ms)
  const code = await resumed.exit
  clearTimeout(timer)
  return { code, output: resumed.output() }
}

test('a done result recorded before a crash settles the node on resume even when its agent is no longer available', async () => {
  const workspace = gitWorkspace('sous-resume-')
  const runDir = join(workspace, '.sous', 'runs', '20261011T000000Z-0000')
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'test', workspace })
  log.append({ type: 'node.added', by: 'graph', node: { id: 'w', kind: 'work', brief: 'work', agent: 'claude' } })
  log.append({ type: 'turn.started', node: 'w', turn: 1, mode: 'start', harness: 'claude', agent: 'claude', pid: 999_999_999, outFile: join(runDir, 'out'), errFile: join(runDir, 'err') })
  log.append({ type: 'turn.ended', node: 'w', turn: 1, exitCode: 0, signal: null, result: { status: 'done', summary: 'work finished' } })
  log.close()
  const resume = sous(['resume'], workspace, join(workspace, 'sessions'), fakeBin(['codex', 'pi']))
  assert.equal(await resume.exit, 0, resume.output())
  assert.equal(fold(readEvents(runDir)).nodes.get('w')!.summary, 'work finished')
})

test('a check whose outcome was recorded before a crash is settled from it on resume, not run again', async () => {
  const { workspace, runDir, sessions } = runWith([{ id: 'c', kind: 'check', command: 'echo ran >> count; test $(wc -l < count) -eq 1' }])
  assert.equal(await crash(workspace, runDir, 'event', 'check.ended'), 'SIGKILL')
  assert.equal(fold(readEvents(runDir)).nodes.get('c')!.status, 'running')
  const resumed = await resumeWithin(workspace, sessions, 5000)
  assert.equal(resumed.code, 0, resumed.output)
  assert.equal(readFileSync(join(runDir, 'integration', 'count'), 'utf8'), 'ran\n')
  assert.equal(fold(readEvents(runDir)).nodes.get('c')!.summary, 'check passed')
})

test('a person command survives a crash on either side of removing its file, and applies once', async () => {
  const ask: EventBody = { type: 'message', from: 'ok', to: 'person', body: 'Ship?', mode: 'queue' }
  for (const point of ['rm', 'event'] as const) {
    const { workspace, runDir, sessions } = runWith([{ id: 'ok', kind: 'gate', brief: 'Ship?' }], [ask])
    writeFileSync(join(runDir, 'commands', 'approve.json'), JSON.stringify({ type: 'approve', node: 'ok' }))
    assert.equal(await crash(workspace, runDir, point, point === 'rm' ? 'approve.json' : 'node.completed'), 'SIGKILL')
    const resumed = await resumeWithin(workspace, sessions, 3000)
    assert.equal(resumed.code, 0, `${point}: ${resumed.output}`)
    const events = readEvents(runDir)
    assert.equal(events.filter((e) => e.type === 'node.completed').length, 1, point)
    assert.equal(fold(events).nodes.get('ok')!.summary, 'approved by person')
    assert.equal(existsSync(join(runDir, 'commands', 'approve.json')), false)
  }
})
