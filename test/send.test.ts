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
/** The shell command a fake worker runs to send, as the brief tells a real one. */
const send = (to: string, text: string) => `"${process.execPath}" "${CLI}" send ${to} '${text}'`
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
  assert.ok(brief.includes(`else run ${process.execPath} ${CLI} send <to> "<text>"`))
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
  for (const body of more) log.append(body)
  log.close()
  return runDir
}

const commands = (runDir: string) =>
  readdirSync(join(runDir, 'commands')).map((f) => JSON.parse(readFileSync(join(runDir, 'commands', f), 'utf8')))

test('sous send checks whom a worker may tell, and hands a message to the supervisor as a command', () => {
  const runDir = runWithTree()
  const sous = (to: string, text: string, env: Record<string, string> = { SOUS_RUN_DIR: runDir, SOUS_NODE: 'a' }) => {
    const r = spawnSync(process.execPath, [CLI, 'send', to, text], { encoding: 'utf8', env: { ...process.env, SOUS_RUN_DIR: '', SOUS_NODE: '', ...env } })
    return [r.status, (r.stdout + r.stderr).trim()]
  }
  assert.deepEqual(sous('c', 'hi'), [1, 'not sent: c is not your lead or a sibling; you may send to L, b'])
  assert.deepEqual(sous('a', 'hi'), [1, 'not sent: you cannot send to yourself'])
  assert.deepEqual(sous('k', 'hi'), [1, 'not sent: k is a check and takes no messages'])
  assert.deepEqual(sous('b2', 'hi'), [1, 'not sent: b2 is done and waits to merge; tell your lead if its work must change'])
  assert.deepEqual(sous('b', ' '), [1, 'not sent: the message must be non-empty text'])
  assert.deepEqual(sous('b', 'hi', { SOUS_RUN_DIR: runDir, SOUS_NODE: 'L' }), [1, 'not sent: L is not a worker of the tree, so it cannot send'])
  assert.deepEqual(sous('b', 'hi', {}), [1, 'sous: sous send is for a worker inside a run: SOUS_RUN_DIR and SOUS_NODE are not set'])
  assert.deepEqual(sous('b', 'The API is greet(name).'), [0, 'sent to b; it reads it when its current turn ends, and nobody answers within yours'])
  assert.deepEqual(commands(runDir), [{ type: 'send', from: 'a', to: 'b', text: 'The API is greet(name).' }])

  const sent = (n: number): EventBody[] => Array.from({ length: n }, () => ({ type: 'message', from: 'a', to: 'L', body: 'x', mode: 'queue', sent: true }))
  const full = runWithTree(sent(5))
  assert.deepEqual(sous('L', 'one more', { SOUS_RUN_DIR: full, SOUS_NODE: 'a' }), [1, 'not sent: a already sent the 5 messages a worker may send'])
})

test("sous's MCP server offers send to a worker's lead and siblings, and writes the same command", async () => {
  const runDir = runWithTree()
  const server = spawn(process.execPath, [MCP], { env: { ...process.env, SOUS_RUN_DIR: runDir, SOUS_NODE: 'a' }, stdio: ['pipe', 'pipe', 'inherit'] })
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
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ['send'])
    assert.match(tools[0].description, /^Tell your lead L or your siblings b something they must know while you work/)
    assert.deepEqual((await call(3, 'tools/call', { name: 'send', arguments: { to: 'c', body: 'hi' } })).result, {
      content: [{ type: 'text', text: 'not sent: c is not your lead or a sibling; you may send to L, b' }], isError: true,
    })
    assert.equal((await call(4, 'tools/call', { name: 'send', arguments: { to: 'L', body: 'Interface settled.' } })).result.isError, false)
    assert.deepEqual(commands(runDir), [{ type: 'send', from: 'a', to: 'L', text: 'Interface settled.' }])
    assert.equal((await call(5, 'resources/list')).error.code, -32601)
  } finally {
    server.kill()
  }
})

test('the MCP server refuses to start without a worker identity', () => {
  const r = spawnSync(process.execPath, [MCP], { encoding: 'utf8', env: { ...process.env, SOUS_RUN_DIR: '', SOUS_NODE: '' }, input: '' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /SOUS_RUN_DIR and SOUS_NODE must be set/)
})

