import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { HarnessName, ParsedTurn } from '../src/types.ts'
import { exportOtlp, postOtlp } from '../src/trace/otlp.ts'

// See trace-atif.test.ts for what the fixture run contains.
const RUN_DIR = join(import.meta.dirname, 'fixtures', 'trace-run')
const parseTurn = (_: HarnessName, raw: string): ParsedTurn => JSON.parse(raw)

interface Received { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

/** A real local HTTP server standing in for Langfuse: records each request and answers with `status`. */
async function fakeLangfuse(status: number, reply: string) {
  const received: Received[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(status, { 'content-type': 'application/json' }).end(reply)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, received, close: () => new Promise((done) => server.close(done)) }
}

type Span = Record<string, any>
const attr = (span: Span, key: string) => {
  const value = span.attributes.find((a: Span) => a.key === key)?.value
  return value && Object.values(value)[0]
}

test('exportOtlp posts one deterministic Langfuse trace with a run → node → turn → generation/tool tree', async (t) => {
  const langfuse = await fakeLangfuse(207, '{}')
  t.after(langfuse.close)
  const env = { LANGFUSE_HOST: `${langfuse.host}/`, LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test' }
  const traceId = await exportOtlp(RUN_DIR, parseTurn, env)
  await exportOtlp(RUN_DIR, parseTurn, env)

  const [first, second] = langfuse.received
  assert.equal(first.method, 'POST')
  assert.equal(first.url, '/api/public/otel/v1/traces')
  assert.equal(first.headers['content-type'], 'application/json')
  assert.equal(first.headers.authorization, `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`)
  assert.equal(first.headers['x-langfuse-ingestion-version'], '4')
  assert.equal(second.body, first.body, 'the export is deterministic')

  const payload = JSON.parse(first.body)
  const spans: Span[] = payload.resourceSpans[0].scopeSpans[0].spans
  assert.match(traceId, /^[0-9a-f]{32}$/)
  for (const span of spans) {
    assert.equal(span.traceId, traceId)
    assert.match(span.spanId, /^[0-9a-f]{16}$/)
    assert.match(span.startTimeUnixNano, /^\d+$/)
    assert.match(span.endTimeUnixNano, /^\d+$/)
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), span.name)
    assert.equal(attr(span, 'session.id'), 'trace-run')
    for (const a of span.attributes) {
      assert.equal(typeof a.key, 'string')
      assert.equal(Object.keys(a.value).length, 1)
      assert.ok(['stringValue', 'intValue', 'doubleValue', 'boolValue'].includes(Object.keys(a.value)[0]))
    }
  }
  assert.equal(new Set(spans.map((s) => s.spanId)).size, spans.length)

  // Render the tree as "type name" lines indented by depth.
  const children = (id?: string) => spans.filter((s) => s.parentSpanId === id)
  const render = (id?: string, depth = 0): string[] => children(id).flatMap((s) => [
    `${'  '.repeat(depth)}${attr(s, 'langfuse.observation.type')} ${s.name}`, ...render(s.spanId, depth + 1),
  ])
  assert.deepEqual(render(), [
    'span murm run trace-run',
    '  agent work impl',
    '    chain turn 1',
    '      generation generation',
    '      tool Write',
    '      tool Bash',
    '      generation generation',
    '    span acceptance check',
    '    chain turn 2',
    '      tool Edit',
    '      generation generation',
    '    span acceptance check',
    '  span check verify',
    '  agent work docs',
    '    chain turn 1',
    '      tool command_execution',
  ])

  const run = spans.find((s) => !s.parentSpanId)!
  assert.equal(run.startTimeUnixNano, (BigInt(Date.parse('2026-10-11T10:00:00.000Z')) * 1_000_000n).toString())
  assert.equal(attr(run, 'langfuse.trace.input'), 'Add a greeting module with a passing test')
  assert.equal(run.status.code, 2)

  const generations = spans.filter((s) => attr(s, 'langfuse.observation.type') === 'generation')
  assert.equal(attr(generations[0], 'gen_ai.request.model'), 'claude-sonnet-4-5')
  assert.equal(attr(generations[0], 'langfuse.observation.usage_details'), undefined)
  assert.deepEqual(JSON.parse(attr(generations[1], 'langfuse.observation.usage_details')), {
    input: 400, output: 310, input_cache_read: 3000, input_cache_creation: 800, total: 4510,
  })
  assert.deepEqual(JSON.parse(attr(generations[1], 'langfuse.observation.cost_details')), { total: 0.0123 })

  const bash = spans.find((s) => s.name === 'Bash')!
  assert.deepEqual(JSON.parse(attr(bash, 'langfuse.observation.input')), { command: 'node test.js' })
  assert.equal(attr(bash, 'langfuse.observation.level'), 'ERROR')

  const docsTurn = children(spans.find((s) => s.name === 'work docs')!.spanId)[0]
  assert.equal(attr(docsTurn, 'langfuse.observation.status_message'), 'no turn result: interrupted')
  assert.equal(attr(spans.find((s) => s.name === 'check verify')!, 'murm.check.exit_code'), '0')
})

test('postOtlp throws with the response body when Langfuse rejects the batch', async (t) => {
  const langfuse = await fakeLangfuse(400, '{"message":"Invalid OTLP payload"}')
  t.after(langfuse.close)
  await assert.rejects(
    postOtlp({ resourceSpans: [] }, { host: langfuse.host, publicKey: 'pk', secretKey: 'sk' }),
    /400.*Invalid OTLP payload/,
  )
})

test('exportOtlp names the missing Langfuse variables', async () => {
  await assert.rejects(exportOtlp(RUN_DIR, parseTurn, {}), /LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/)
})
