import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startUi } from '../src/ui/index.ts'
import type { Event, EventBody, ParsedTurn } from '../src/contracts/index.ts'
import { sous } from './fixtures/sous-proc.ts'

// The lead fixture (see trace-atif.test.ts): `lead` spawns `impl` (work, completes after one Claude turn) and `docs`
// (lead, spawns `readme`); the person interrupts the lead, which cancels docs and completes the run.
const RUN = '20261011T110000Z-0001'

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sous-ui-'))
  cpSync(join(import.meta.dirname, 'fixtures', 'lead-run'), join(ws, '.sous', 'runs', RUN), { recursive: true })
  return ws
}

async function ui() {
  const ws = workspace()
  const parsed: string[] = []
  const server = await startUi(ws, (_, raw): ParsedTurn => {
    const turn = JSON.parse(raw) as ParsedTurn
    parsed.push(turn.sessionId ?? '')
    return turn
  })
  const url = new URL(server.url)
  const get = async (path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams({ ...params, token: url.searchParams.get('token')! })
    return fetch(`${url.origin}${path}?${q}`)
  }
  return { ws, server, url, parsed, get }
}

test('sous ui refuses requests without its token or from another host name', async (t) => {
  const { server, url } = await ui()
  t.after(() => server.close())
  assert.equal((await fetch(`${url.origin}/api/runs`)).status, 403)
  assert.equal((await fetch(`${url.origin}/api/runs?token=nope`)).status, 403)
  // A DNS name rebound to 127.0.0.1 still sends its own name as Host.
  const status = await new Promise<number>((resolve, reject) => {
    request(`${url.origin}/api/runs${url.search}`, { headers: { host: `evil.example:${url.port}` } }, (res) => resolve(res.statusCode!))
      .on('error', reject).end()
  })
  assert.equal(status, 403)
  assert.equal(url.hostname, '127.0.0.1')
})

test('sous ui lists runs and shows a run tree from the log alone, then one node with its parsed turns', async (t) => {
  const { server, parsed, get } = await ui()
  t.after(() => server.close())

  const { runs } = await (await get('/api/runs')).json()
  assert.deepEqual(runs.map((r: any) => [r.id, r.status, r.goal, r.nodes, r.depth]), [[RUN, 'completed', 'Add greet() with user docs', 4, 3]])
  // Lead turns (1200+90, 800+60, 1500+40, 1600+30) and impl's worker turn (3000+200).
  assert.equal(runs[0].tokens.input + runs[0].tokens.output, 8520)

  const run = await (await get('/api/run', { run: RUN })).json()
  const node = (id: string) => run.nodes.find((n: any) => n.id === id)
  assert.deepEqual(run.nodes.map((n: any) => [n.id, n.parent ?? null, n.status]), [
    ['lead', null, 'completed'], ['impl', 'lead', 'completed'], ['docs', 'lead', 'failed'], ['readme', 'docs', 'failed'],
  ])
  assert.equal(node('docs').refused, 1)
  assert.equal(node('docs').outcome, 'cancelled by lead')
  assert.deepEqual(node('impl').checks.map((c: any) => c.exitCode), [0])
  assert.deepEqual(node('impl').spans.map((s: any) => [s.kind, s.outcome]), [['turn', 'done']])
  assert.deepEqual(node('readme').spans.map((s: any) => [s.kind, s.outcome]), [['turn', 'interrupted']])
  // The lead is busy from a delivery until it answered every queued one; the person's interrupt joins the stretch.
  assert.deepEqual(node('lead').spans.map((s: any) => [s.label, s.end]), [
    ['lead:brief', '2026-10-11T11:00:04.000Z'], ['evt-17, evt-19, evt-21', '2026-10-11T11:00:22.000Z'],
  ])
  assert.deepEqual(parsed, [], 'the tree reads no turn file')

  const impl = await (await get('/api/node', { run: RUN, node: 'impl' })).json()
  assert.deepEqual(parsed, ['6a0c1f7e-3b8e-4c55-9d0b-0b9d8f1d2e01'], 'only the opened node is parsed')
  assert.equal(impl.turns[0].result.summary, 'Added greet.js')
  assert.deepEqual(impl.turns[0].items.map((i: any) => i.kind), ['message', 'tool_call', 'tool_result', 'message'])
  assert.match(impl.turns[0].items[1].arguments, /"file_path": "greet.js"/)
  assert.ok(impl.events.some((e: any) => e.type === 'check.ended'))

  const lead = await (await get('/api/node', { run: RUN, node: 'lead' })).json()
  assert.deepEqual(lead.notes, ['greet.js is an ES module.'])
  assert.deepEqual(lead.events.filter((e: any) => e.type === 'lead.call').map((e: any) => e.call.tool), ['spawn', 'note', 'cancel', 'complete'])

  assert.equal((await get('/api/node', { run: RUN, node: 'nope' })).status, 404)
  assert.equal((await get('/api/run', { run: '../../etc' })).status, 404)
})

test('sous ui streams a change when the run log grows', { timeout: 10_000 }, async (t) => {
  const { ws, server, get } = await ui()
  const res = await get('/api/stream')
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  t.after(async () => {
    await reader.cancel()
    await server.close()
  })
  const next = async () => {
    let text = ''
    while (!text.includes('\n\n')) text += (await reader.read()).value
    return JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')))
  }
  const first = await next()
  const log = join(ws, '.sous', 'runs', RUN, 'events.jsonl')
  assert.deepEqual(first[RUN], [readFileSync(log).length, false])
  appendFileSync(log, JSON.stringify({ seq: 30, at: '2026-10-11T11:00:23.000Z', type: 'run.resumed' }) + '\n')
  const second = await next()
  assert.ok(second[RUN][0] > first[RUN][0])
  // A lock whose supervisor is alive makes the run live; one left by a killed supervisor does not.
  const lock = join(ws, '.sous', 'runs', RUN, 'lock')
  writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n')
  assert.equal((await next())[RUN][1], true)
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1 }) + '\n')
  assert.equal((await next())[RUN][1], false)
})

test("sous ui shows a running run's running turn with when its output last grew", async (t) => {
  const { ws, server, get } = await ui()
  t.after(() => server.close())
  const id = '20261013T090000Z-0002'
  const dir = join(ws, '.sous', 'runs', id)
  mkdirSync(join(dir, 'nodes', 'w'), { recursive: true })
  const out = join(dir, 'nodes', 'w', 'turn-1.jsonl')
  writeFileSync(out, '{"type":"session"}\n')
  writeFileSync(join(dir, 'events.jsonl'), [
    { seq: 1, at: '2026-10-13T09:00:00.000Z', type: 'run.created', goal: 'g', workspace: ws },
    { seq: 2, at: '2026-10-13T09:00:00.000Z', type: 'node.added', node: { id: 'w', kind: 'work', brief: 'b' }, by: 'graph' },
    { seq: 3, at: '2026-10-13T09:00:01.000Z', type: 'turn.started', node: 'w', turn: 1, mode: 'start', harness: 'claude', pid: 1, outFile: out, errFile: `${out}.err` },
  ].map((e) => JSON.stringify(e) + '\n').join(''))
  const live = async () => (await (await get('/api/run', { run: id })).json()).nodes[0].turn
  assert.equal(await live(), undefined, 'a stopped run has no running turn')
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.pid }) + '\n')
  assert.deepEqual(await live(), { number: 1, startedAt: '2026-10-13T09:00:01.000Z', outputAt: statSync(out).mtime.toISOString() })
})

test('sous ui shows a node from one reading of a log that grows while it answers', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'sous-ui-'))
  const dir = join(ws, '.sous', 'runs', RUN)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'turn-1.jsonl')
  writeFileSync(out, '{}\n')
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, [
    { seq: 1, at: '2026-10-13T09:00:00.000Z', type: 'run.created', goal: 'g', workspace: ws },
    { seq: 2, at: '2026-10-13T09:00:00.000Z', type: 'node.added', node: { id: 'w', kind: 'work', brief: 'b' }, by: 'graph' },
    { seq: 3, at: '2026-10-13T09:00:01.000Z', type: 'turn.started', node: 'w', turn: 1, mode: 'start', harness: 'claude', pid: 1, outFile: out, errFile: `${out}.err` },
  ].map((e) => JSON.stringify(e) + '\n').join(''))
  // The supervisor fails the node while the UI reads the node's turn file.
  let grown = false
  const server = await startUi(ws, (): ParsedTurn => {
    if (!grown) appendFileSync(log, JSON.stringify({ seq: 4, at: '2026-10-13T09:00:02.000Z', type: 'node.failed', node: 'w', reason: 'stopped' }) + '\n')
    grown = true
    return { items: [], ended: false }
  })
  t.after(() => server.close())
  const url = new URL(server.url)
  const node = async () => {
    const w = await (await fetch(`${url.origin}/api/node?${new URLSearchParams({ run: RUN, node: 'w', token: url.searchParams.get('token')! })}`)).json()
    return [w.status, w.outcome ?? null, w.events.length]
  }
  assert.deepEqual(await node(), ['running', null, 1], 'the status comes from the same events as the rest')
  assert.deepEqual(await node(), ['failed', 'stopped', 2])
})

test('sous ui caps the long texts of a node it sends', async (t) => {
  const { ws, server, get } = await ui()
  t.after(() => server.close())
  const log = join(ws, '.sous', 'runs', RUN, 'events.jsonl')
  appendFileSync(log, [
    { seq: 30, at: '2026-10-11T11:00:23.000Z', type: 'check.ended', node: 'impl', command: 'node test.js', exitCode: 1, output: 'x'.repeat(50_000) },
    { seq: 31, at: '2026-10-11T11:00:24.000Z', type: 'lead.call', node: 'lead', callId: 'call_9', ok: true, result: 'Noted.', call: { tool: 'note', text: 'y'.repeat(30_000) } },
  ].map((e) => JSON.stringify(e) + '\n').join(''))
  const impl = await (await get('/api/node', { run: RUN, node: 'impl' })).json()
  assert.equal(impl.events.at(-1).output, `${'x'.repeat(20_000)}\n… 30000 more characters`)
  const lead = await (await get('/api/node', { run: RUN, node: 'lead' })).json()
  assert.equal(lead.notes.at(-1), `${'y'.repeat(20_000)}\n… 10000 more characters`)
  assert.equal(lead.events.at(-1).call.text, lead.notes.at(-1))
})

test('sous ui prints an address that serves the page', async (t) => {
  const ws = workspace()
  const proc = sous(['ui', '--workspace', ws], tmpdir(), join(ws, 'sessions'))
  t.after(() => proc.child.kill())
  let url: string | undefined
  for (let i = 0; i < 100 && !url; i++) {
    url = proc.output().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/)?.[0]
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(url, proc.output())
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>sous<\/title>/)
})

test('sous ui names the output folder as a folder-mode run\'s result', async (t) => {
  const { ws, server, get } = await ui()
  t.after(() => server.close())
  const log = join(ws, '.sous', 'runs', RUN, 'events.jsonl')
  const lines = readFileSync(log, 'utf8').split('\n')
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), mode: 'folder' })
  writeFileSync(log, lines.join('\n'))
  const run = await (await get('/api/run', { run: RUN })).json()
  assert.equal(run.result, join(ws, '.sous', 'runs', RUN, 'output'))
})

test('sous ui shows what waits for the person (a question, a gate, a split) and the merge spans', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'sous-ui-'))
  const runDir = join(ws, '.sous', 'runs', RUN)
  mkdirSync(runDir, { recursive: true })
  const at = (s: number) => `2026-10-11T11:00:${String(s).padStart(2, '0')}.000Z`
  const bodies: EventBody[] = [
    { type: 'run.created', goal: 'Waiting on a person', workspace: '/tmp/demo' },
    { type: 'node.added', node: { id: 'asker', kind: 'work', brief: 'Pick a fruit.' }, by: 'person' },
    { type: 'message', from: 'asker', to: 'person', body: 'Which fruit?', mode: 'queue' },
    { type: 'node.added', node: { id: 'ship', kind: 'gate', brief: 'Ship it?' }, by: 'person' },
    { type: 'message', from: 'ship', to: 'person', body: 'Approve: Ship it?', mode: 'queue' },
    { type: 'node.added', node: { id: 'big', kind: 'lead', brief: 'Build the thing.', agent: 'splitter' }, by: 'person' },
    { type: 'split.requested', node: 'big', agent: 'splitter' },
    { type: 'split.proposed', node: 'big', parts: [{ id: 'a', kind: 'work', brief: 'Part a.' }], summary: 'One part.' },
    { type: 'message', from: 'big', to: 'person', body: 'Approve this split?', mode: 'queue' },
    // Three merges: one done, one failed, one still queued.
    ...['m-done', 'm-failed', 'm-queued'].flatMap((id): EventBody[] => [{ type: 'node.added', node: { id, kind: 'work', brief: id }, by: 'person' }, { type: 'merge.queued', node: id, branch: `sous/${id}` }]),
    { type: 'merge.done', node: 'm-done', commit: 'abc123', by: 'supervisor', files: ['a.txt'] },
    { type: 'merge.failed', node: 'm-failed', reason: 'the check failed after the merge' },
  ]
  const log: Event[] = bodies.map((e, i) => ({ seq: i + 1, at: at(i), ...e }))
  writeFileSync(join(runDir, 'events.jsonl'), log.map((e) => JSON.stringify(e) + '\n').join(''))
  const server = await startUi(ws, (): ParsedTurn => ({ items: [], ended: false }))
  t.after(() => server.close())
  const url = new URL(server.url)
  const get = (path: string, params: Record<string, string>) => fetch(`${url.origin}${path}?${new URLSearchParams({ ...params, token: url.searchParams.get('token')! })}`)

  const { runs } = await (await get('/api/runs', {})).json()
  assert.deepEqual(runs.map((r: any) => [r.status, r.waiting]), [['stopped', 3]])
  const run = await (await get('/api/run', { run: RUN })).json()
  assert.deepEqual(run.questions, [
    { from: 'asker', body: 'Which fruit?', kind: 'question' },
    { from: 'ship', body: 'Approve: Ship it?', kind: 'gate' },
    { from: 'big', body: 'Approve this split?', kind: 'split' },
  ])
  const node = (id: string) => run.nodes.find((n: any) => n.id === id)
  const merge = (id: string) => node(id).spans.map((s: any) => [s.kind, s.outcome ?? null, s.end ?? null])
  assert.deepEqual(merge('m-done'), [['merge', 'done', at(15)]])
  assert.deepEqual(merge('m-failed'), [['merge', 'failed', at(16)]])
  assert.deepEqual(merge('m-queued'), [['merge', null, null]], 'a merge in the queue is still going')
  assert.deepEqual([node('m-done').status, node('m-done').merged, node('m-failed').status, node('m-failed').outcome, node('m-queued').status],
    ['completed', true, 'failed', 'merge failed: the check failed after the merge', 'merging'])
})
