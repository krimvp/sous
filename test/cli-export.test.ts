// `sous export otlp` as a person runs it: a real run, then its trace posted to a local HTTP server that stands in for
// Langfuse. (An unreachable host is in cli-usage.test.ts; the trace itself is in trace-otlp.test.ts.)

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fakePlan } from './helpers/fake-adapter.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { runDirOf, sous } from './helpers/sous-proc.ts'

/** A workspace with one finished run (a worker that writes a file), and the sessions directory sous used. */
async function finishedRun() {
  const workspace = gitWorkspace('sous-export-')
  const sessions = join(workspace, 'sessions')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a greeting', agent: 'claude',
    nodes: [{ id: 'write', kind: 'work', brief: `Write hello.txt.\n${fakePlan([{ write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello.txt' } }])}` }],
  }))
  const run = sous(['run', graph], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  return { workspace, sessions, runId: basename(runDirOf(workspace)!) }
}

/** `sous export otlp` with the Langfuse variables set to `env`; the process reads them as a person's shell gives them. */
async function exportOtlp(workspace: string, sessions: string, env: Record<string, string>, args: string[] = []) {
  const names = ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]))
  for (const k of names) delete process.env[k]
  Object.assign(process.env, env)
  try {
    const exported = sous(['export', 'otlp', ...args], workspace, sessions)
    return { code: await exported.exit, output: exported.output() }
  } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

/** A local server that records the requests it gets and answers each with `status`. */
async function langfuse(status: number, reply: string) {
  const received: { method?: string; url?: string; authorization?: string; body: any }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body && JSON.parse(body) })
      res.writeHead(status).end(reply)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise((done) => server.close(done)) }
}

test("sous export otlp posts the newest run's trace with the person's keys and prints the trace id", async (t) => {
  const { workspace, sessions } = await finishedRun()
  const server = await langfuse(207, '{}')
  t.after(server.close)
  const { code, output } = await exportOtlp(workspace, sessions, { LANGFUSE_HOST: `${server.host}/`, LANGFUSE_PUBLIC_KEY: 'pk-cli', LANGFUSE_SECRET_KEY: 'sk-cli' })
  assert.equal(code, 0, output)
  assert.match(output, /^trace [0-9a-f]{32}\n$/)
  assert.equal(server.received.length, 1)
  const [request] = server.received
  assert.deepEqual([request!.method, request!.url], ['POST', '/api/public/otel/v1/traces'])
  assert.equal(request!.authorization, `Basic ${Buffer.from('pk-cli:sk-cli').toString('base64')}`)
  const spans: { traceId: string; name: string }[] = request!.body.resourceSpans[0].scopeSpans[0].spans
  assert.ok(spans.length > 1)
  assert.ok(spans.every((s) => s.traceId === output.trim().slice('trace '.length)))
  assert.ok(spans.some((s) => s.name.includes('write')), 'the worker node is in the trace')
})

test('sous export otlp names what is missing, and what Langfuse said when it refused', async (t) => {
  const { workspace, sessions, runId } = await finishedRun()
  const missing = await exportOtlp(workspace, sessions, { LANGFUSE_HOST: 'http://127.0.0.1:9' })
  assert.equal(missing.code, 1)
  assert.match(missing.output, /^sous: set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to export to Langfuse$/m)

  const server = await langfuse(401, 'bad keys')
  t.after(server.close)
  const refused = await exportOtlp(workspace, sessions, { LANGFUSE_HOST: server.host, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'wrong' }, [runId])
  assert.equal(refused.code, 1)
  assert.match(refused.output, /^sous: Langfuse OTLP export failed: 401 [^:]*: bad keys$/m)

  const unknown = await exportOtlp(workspace, sessions, { LANGFUSE_HOST: server.host, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }, ['nope'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.output, /^sous: no run nope in .*runs$/m)
  assert.equal(server.received.length, 1, 'only the first request reached the server')
})
