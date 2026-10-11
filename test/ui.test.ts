import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startUi } from '../src/ui.ts'
import type { ParsedTurn } from '../src/types.ts'
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

test('sous ui caps the long texts of a node it sends', async (t) => {
  const { ws, server, get } = await ui()
  t.after(() => server.close())
  const log = join(ws, '.sous', 'runs', RUN, 'events.jsonl')
  appendFileSync(log, JSON.stringify({ seq: 30, at: '2026-10-11T11:00:23.000Z', type: 'check.ended', node: 'impl', command: 'node test.js', exitCode: 1, output: 'x'.repeat(50_000) }) + '\n')
  const impl = await (await get('/api/node', { run: RUN, node: 'impl' })).json()
  assert.equal(impl.events.at(-1).output.length, 20_000)
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
