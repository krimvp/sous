// What workers tell each other while they work: `sous send` and sous's MCP server as real processes, and the
// supervisor delivering, copying and refusing messages with fake workers and the scripted fake lead runner.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { openLog, readEvents, writeCommand } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { ChildSpec, Event, EventBody, NodeSpec } from '../src/types.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRunner } from './fixtures/fake-lead.ts'
import type { FakeLeadStep } from './fixtures/fake-lead.ts'
import { gitWorkspace } from './fixtures/git-repo.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const MCP = new URL('../src/mcp.ts', import.meta.url).pathname
const done = (summary: string) => ({ status: 'done' as const, summary })
/** The shell command a fake worker runs to send, quoted as the brief tells a real one. */
const send = (to: string, text: string) => `'${process.execPath}' '${CLI}' send ${to} '${text}'`
const receive = (seconds: number) => `'${process.execPath}' '${CLI}' receive ${seconds}`
const task = (id: string, steps: FakeStep[]): ChildSpec => ({ id, kind: 'work', brief: `Do ${id}.\n${fakePlan(steps)}` })

/** Runs one lead playing `steps` in a git workspace; `onEvent` also gets the run directory. */
async function runLead(steps: FakeLeadStep[], onEvent?: (e: Event, runDir: string) => void) {
  const workspace = gitWorkspace('sous-send-')
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  const lead: NodeSpec = { id: 'lead', kind: 'lead', brief: `Lead the test goal.\n${fakeLeadPlan(steps)}` }
  log.append({ type: 'run.created', goal: 'test goal', workspace })
  log.append({ type: 'node.added', node: lead, by: 'graph' })
  log.close()
  const sessions = join(workspace, 'sessions')
  const adapter = fakeAdapter(sessions)
  const outcome = await runSupervisor({
    workspace, runDir, getAdapter: () => adapter, createLeadRunner: fakeLeadRunner, onEvent: onEvent && ((e) => onEvent(e, runDir)),
  })
  const events = readEvents(runDir)
  const state = fold(events)
  const prompts = (node: string) => {
    const session = state.nodes.get(node)!.turns.findLast((t) => t.sessionId)!.sessionId
    return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts as string[]
  }
  return { outcome, events, state, prompts }
}

const delivered = (events: Event[]) => events.flatMap((e) => (e.type === 'lead.delivered' && e.node === 'lead' ? [e.text] : []))

test('a worker tells a sibling and its lead while it works: the sibling resumes with it, the lead gets it and a copy', async () => {
  const { outcome, events, state, prompts } = await runLead([
    { calls: [{ tool: 'spawn', children: [
      task('a', [{ sh: `${send('b', 'The API is greet(name).')} && ${send('lead', 'I renamed util.js to text.js.')}`, result: done('a done') }]),
      task('b', [{ sleepMs: 2500, result: done('b first') }, { result: done('b used greet') }]),
    ] }] },
    {}, {}, {}, {},
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ])
  assert.equal(outcome, 'completed')
  assert.deepEqual(events.flatMap((e) => (e.type === 'message' && e.sent ? [[e.from, e.to, e.body]] : [])), [
    ['a', 'b', 'The API is greet(name).'], ['a', 'lead', 'I renamed util.js to text.js.'],
  ])
  // b's done waited for the message: it resumed with it.
  assert.deepEqual(state.nodes.get('b')!.turns.map((t) => t.result?.summary), ['b first', 'b used greet'])
  assert.match(prompts('b')[1], /^Message from a:\nThe API is greet\(name\)\./)
  assert.ok(delivered(events).includes('Child a told its sibling b (a copy for you; no answer needed):\nThe API is greet(name).'))
  assert.ok(delivered(events).includes('Child a tells you while it works (no answer needed):\nI renamed util.js to text.js.'))
  // The brief says whom a worker may tell, and how.
  const brief = prompts('a')[0]
  assert.match(brief, /You may send to your lead lead and your siblings b; your lead sees every message\. At most 5/)
  assert.ok(brief.includes(`else run '${process.execPath}' '${CLI}' send <to> '<text>' (single quotes, so the shell leaves the text alone).`))
})

test('a message the run moved past is refused when the supervisor applies it, and its sender is told', async () => {
  const { outcome, prompts } = await runLead([
    { calls: [{ tool: 'spawn', children: [
      task('a', [{ sleepMs: 2000, result: done('a done') }, { result: done('noted') }]),
      task('b', [{ result: done('b done') }]),
    ] }] },
    {}, {}, {},
    { calls: [{ tool: 'complete', summary: 'all done' }] },
  ], (e, runDir) => {
    // As if a sent this just before b merged: the command reaches the supervisor after b completed.
    if (e.type === 'merge.done' && e.node === 'b') writeCommand(runDir, { type: 'send', from: 'a', to: 'b', text: 'Use greet.' })
  })
  assert.equal(outcome, 'completed')
  assert.match(prompts('a')[1], /^Message from supervisor:\nYour message to b was not delivered: b is already completed/)
})

test('the supervisor holds a worker to 5 messages even when it writes more before any is applied', async () => {
  const finish: FakeLeadStep = { calls: [{ tool: 'complete', summary: 'all done' }] }
  const { outcome, events, prompts } = await runLead([
    { calls: [{ tool: 'spawn', children: [task('a', [{ sleepMs: 2000, result: done('a done') }, { result: done('noted') }])] }] },
    ...Array.from({ length: 10 }, () => finish),
  ], (e, runDir) => {
    if (e.type !== 'turn.started' || e.node !== 'a' || e.turn !== 1) return
    for (let i = 1; i <= 6; i++) writeCommand(runDir, { type: 'send', from: 'a', to: 'lead', text: `update ${i}` })
  })
  assert.equal(outcome, 'completed')
  assert.equal(events.filter((e) => e.type === 'message' && e.sent).length, 5)
  assert.match(prompts('a')[1], /Your message to lead was not delivered: a already sent the 5 messages a worker may send/)
})

test('a worker waits within its turn for what its sibling tells it, and is not resumed with it again', async () => {
  const finish: FakeLeadStep = { calls: [{ tool: 'complete', summary: 'all done' }] }
  const { outcome, events, state } = await runLead([
    { calls: [{ tool: 'spawn', children: [
      task('a', [{ sh: `sleep 1 && ${send('b', 'Use greet(name).')}`, result: done('a done') }]),
      // b exits right after reading: the supervisor must take its receive before deciding whether to resume it.
      task('b', [{ sh: `${receive(20)} > got.txt`, result: done('b got it') }]),
    ] }] },
    ...Array.from({ length: 8 }, () => finish),
  ])
  assert.equal(outcome, 'completed')
  assert.equal(readFileSync(join(state.workspace, '.sous', 'runs', 'r1', 'integration', 'got.txt'), 'utf8'), 'Message from a:\nUse greet(name).\n')
  assert.equal(state.nodes.get('b')!.turns.length, 1, 'b was not resumed with the message it read')
  const read = events.find((e) => e.type === 'inbox.read')
  const sent = events.find((e) => e.type === 'message' && e.sent)
  assert.deepEqual(read?.type === 'inbox.read' && [read.node, read.upTo], ['b', sent!.seq])
  assert.ok(delivered(events).includes('Child a told its sibling b (a copy for you; no answer needed):\nUse greet(name).'))
})

// ---- `sous send` and the MCP server against a run's log ------------------------------------------

/** A run with lead L (children a, b, check k, and b2 waiting to merge) and lead M (child c). */
function runWithTree(more: EventBody[] = []): string {
  const runDir = mkdtempSync(join(tmpdir(), 'sous-send-run-'))
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace: runDir })
  const add = (node: NodeSpec) => log.append({ type: 'node.added', node, by: 'graph' })
  add({ id: 'L', kind: 'lead', brief: 'l' })
  add({ id: 'M', kind: 'lead', brief: 'm' })
  for (const [id, kind, parent] of [['a', 'work', 'L'], ['b', 'work', 'L'], ['k', 'check', 'L'], ['b2', 'work', 'L'], ['c', 'work', 'M']] as const) {
    add({ id, kind, parent, ...(kind === 'check' ? { command: 'true' } : { brief: id }) })
  }
  log.append({ type: 'merge.queued', node: 'b2', branch: 'x' })
  log.append({ type: 'turn.started', node: 'a', turn: 1, mode: 'start', pid: 999_999_999, outFile: '/dev/null', errFile: '/dev/null' })
  for (const body of more) log.append(body)
  log.close()
  return runDir
}

const commands = (runDir: string) =>
  readdirSync(join(runDir, 'commands')).map((f) => JSON.parse(readFileSync(join(runDir, 'commands', f), 'utf8')))

test('sous send checks whom a worker may tell, and hands a message to the supervisor as a command', () => {
  const runDir = runWithTree()
  const sous = (to: string, text: string, env: Record<string, string> = { SOUS_RUN_DIR: runDir, SOUS_NODE: 'a', SOUS_TURN: '1' }) => {
    const r = spawnSync(process.execPath, [CLI, 'send', to, text], { encoding: 'utf8', env: { ...process.env, SOUS_RUN_DIR: '', SOUS_NODE: '', SOUS_TURN: '', ...env } })
    return [r.status, (r.stdout + r.stderr).trim()]
  }
  assert.deepEqual(sous('c', 'hi'), [1, 'not sent: c is not your lead or a sibling; you may send to L, b'])
  assert.deepEqual(sous('a', 'hi'), [1, 'not sent: you cannot send to yourself'])
  assert.deepEqual(sous('k', 'hi'), [1, 'not sent: k is a check and takes no messages'])
  assert.deepEqual(sous('b2', 'hi'), [1, 'not sent: b2 is done and waits to merge; tell your lead if its work must change'])
  assert.deepEqual(sous('b', ' '), [1, 'not sent: the message must be non-empty text'])
  assert.deepEqual(sous('b', 'hi', { SOUS_RUN_DIR: runDir, SOUS_NODE: 'L', SOUS_TURN: '1' }), [1, 'not sent: L is not a worker of the tree, so it cannot send'])
  assert.deepEqual(sous('b', 'hi', {}), [1, 'sous: sous send is for a worker inside a run: SOUS_RUN_DIR, SOUS_NODE and SOUS_TURN are not set'])
  assert.deepEqual(sous('b', 'The API is greet(name).'), [0, 'sent to b; it reads it when its current turn ends, and nobody answers within yours'])
  assert.deepEqual(sous('b', '--force is required now'), [0, 'sent to b; it reads it when its current turn ends, and nobody answers within yours'])
  assert.deepEqual(commands(runDir).map((c) => c.text).sort(), ['--force is required now', 'The API is greet(name).'])

  const sent = (n: number): EventBody[] => Array.from({ length: n }, () => ({ type: 'message', from: 'a', to: 'L', body: 'x', mode: 'queue', sent: true }))
  const full = runWithTree(sent(5))
  assert.deepEqual(sous('L', 'one more', { SOUS_RUN_DIR: full, SOUS_NODE: 'a', SOUS_TURN: '1' }), [1, 'not sent: a already sent the 5 messages a worker may send'])
})

test('sous receive returns what waits for a worker once, waits for a message when asked, and is for workers only', () => {
  const runDir = runWithTree([{ type: 'message', from: 'L', to: 'a', body: 'Keep the old API.', mode: 'queue' }])
  const sous = (args: string[], node = 'a', turn = '1') => {
    const r = spawnSync(process.execPath, [CLI, 'receive', ...args], { encoding: 'utf8', env: { ...process.env, SOUS_RUN_DIR: runDir, SOUS_NODE: node, SOUS_TURN: turn } })
    return [r.status, (r.stdout + r.stderr).trim()]
  }
  assert.deepEqual(sous([]), [0, 'Message from L:\nKeep the old API.'])
  const seq = fold(readEvents(runDir)).nodes.get('a')!.inbox[0].seq
  assert.deepEqual(commands(runDir), [{ type: 'receive', node: 'a', turn: 1, upTo: seq }])
  // Taken, though the supervisor has not applied it yet.
  assert.deepEqual(sous([]), [0, 'No messages.'])
  const started = Date.now()
  assert.deepEqual(sous(['1']), [0, 'No messages.'])
  assert.ok(Date.now() - started >= 900, 'it waited for a message')
  assert.deepEqual(sous([], 'L'), [1, 'cannot receive: L is not a worker of the tree'])
  assert.deepEqual(sous([], 'a', '2'), [0, 'No messages.'], 'a turn not recorded yet waits')
  assert.deepEqual(sous([], 'a', '0'), [1, 'cannot receive: turn 0 of a is over'])
  for (const bad of ['-5', '61', '0x10', 'soon']) assert.equal(sous([bad])[0], 2, bad)
})

test('a receive from a turn that is over takes nothing, and messages read in a turn cut short come back', async () => {
  const { outcome, events, prompts } = await runLead([
    { calls: [{ tool: 'spawn', children: [
      task('a', [{ sh: `sleep 1 && ${send('b', 'Use greet(name).')}`, result: done('a done') }]),
      // b reads the message, then its turn ends without a result: it resumes with the message again.
      task('b', [{ sh: `${receive(20)} > got.txt` }, { result: done('b saw it twice') }]),
    ] }] },
    ...Array.from({ length: 8 }, (): FakeLeadStep => ({ calls: [{ tool: 'complete', summary: 'all done' }] })),
  ], (e, runDir) => {
    // A process left over from b's first turn tries to take messages during its second.
    if (e.type === 'turn.started' && e.node === 'b' && e.turn === 2) writeCommand(runDir, { type: 'receive', node: 'b', turn: 1, upTo: 10_000 })
  })
  assert.equal(outcome, 'completed')
  assert.match(prompts('b')[1], /^Message from a:\nUse greet\(name\)\./)
  assert.deepEqual(events.flatMap((e) => (e.type === 'inbox.read' ? [e.turn] : [])), [1])
})

test("sous's MCP server offers send to a worker's lead and siblings, and writes the same command", async () => {
  const runDir = runWithTree()
  const server = spawn(process.execPath, [MCP], { env: { ...process.env, SOUS_RUN_DIR: runDir, SOUS_NODE: 'a', SOUS_TURN: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]()
  const call = async (id: number, method: string, params?: object) => {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return JSON.parse((await lines.next()).value)
  }
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.deepEqual(init.result.capabilities, { tools: {} })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') // no reply
    const { tools } = (await call(2, 'tools/list')).result
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ['send', 'receive'])
    assert.match(tools[0].description, /^Tell your lead L or your siblings b something they must know while you work/)
    assert.deepEqual((await call(3, 'tools/call', { name: 'send', arguments: { to: 'c', body: 'hi' } })).result, {
      content: [{ type: 'text', text: 'not sent: c is not your lead or a sibling; you may send to L, b' }], isError: true,
    })
    assert.equal((await call(4, 'tools/call', { name: 'send', arguments: { to: 'L', body: 'Interface settled.' } })).result.isError, false)
    assert.deepEqual(commands(runDir), [{ type: 'send', from: 'a', to: 'L', text: 'Interface settled.' }])
    assert.deepEqual((await call(7, 'tools/call', { name: 'receive', arguments: { wait_seconds: 0 } })).result, {
      content: [{ type: 'text', text: 'No messages.' }], isError: false,
    })
    assert.equal((await call(5, 'resources/list')).error.code, -32601)
    server.stdin.write('null\n')
    assert.deepEqual(JSON.parse((await lines.next()).value).error, { code: -32600, message: 'invalid request' })
    assert.equal((await call(6, 'ping')).result && 'still serving', 'still serving')
  } finally {
    server.kill()
  }
})

test('the MCP server refuses to start without a worker identity', () => {
  const r = spawnSync(process.execPath, [MCP], { encoding: 'utf8', env: { ...process.env, SOUS_RUN_DIR: '', SOUS_NODE: '', SOUS_TURN: '' }, input: '' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /SOUS_RUN_DIR, SOUS_NODE and SOUS_TURN must be set/)
})

