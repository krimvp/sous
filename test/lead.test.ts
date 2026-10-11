// The lead runner on pi-ai's faux provider, with a fake LeadHost that records what the lead does.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { contentText } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import { openLeadRunner } from '../src/lead/runner.ts'
import type { LeadCall, LeadHost } from '../src/types.ts'

const fixture = join(import.meta.dirname, 'fixtures', 'lead-proc.ts')

function fauxModels() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models, model: `${faux.provider.id}/${faux.getModel().id}` }
}

const toolCall = (tool: LeadCall['tool'], args: Parameters<typeof fauxToolCall>[1], id: string) =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: 'toolUse' })

function fakeHost() {
  const calls: { node: string; callId: string; call: LeadCall }[] = []
  const settled: { node: string; turn: Parameters<LeadHost['settled']>[1] }[] = []
  const host: LeadHost = {
    act(node, callId, call) {
      calls.push({ node, callId, call })
      return `${call.tool} ok`
    },
    settled(node, turn) { settled.push({ node, turn }) },
  }
  return { host, calls, settled }
}

async function until(done: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tempRunDir = () => mkdtempSync(join(tmpdir(), 'murm-lead-'))

test('a delivery makes the lead spawn then complete, and its answer is reported once', async () => {
  const { faux, models, model } = fauxModels()
  const child = { id: 'a', kind: 'work', brief: 'Write a.txt.', acceptance: ['a.txt exists'] }
  faux.setResponses([
    toolCall('spawn', { children: [child] }, 'call-1'),
    toolCall('complete', { summary: 'a.txt is written' }, 'call-2'),
    fauxAssistantMessage([fauxText('Completed.')]),
  ])
  const runDir = tempRunDir()
  const { host, calls, settled } = fakeHost()
  const runner = openLeadRunner({ runDir, host, models })
  const brief = { requestId: 'lead:brief', mode: 'queue' as const, model }
  await runner.deliver('lead', 'Goal: write a.txt.', brief)
  await until(() => settled.length === 1)
  await runner.deliver('lead', 'Goal: write a.txt.', brief) // a redelivery of a reported request does nothing
  await new Promise((r) => setTimeout(r, 100))
  await runner.close()

  assert.deepEqual(calls, [
    { node: 'lead', callId: 'call-1', call: { tool: 'spawn', children: [child] } },
    { node: 'lead', callId: 'call-2', call: { tool: 'complete', summary: 'a.txt is written' } },
  ])
  assert.equal(faux.state.callCount, 3)
  assert.equal(settled.length, 1)
  const { usage, ...turn } = settled[0].turn
  assert.deepEqual({ node: settled[0].node, ...turn }, { node: 'lead', requestId: 'lead:brief', status: 'done', text: 'Completed.', model })

  // The reported usage is this run's three responses, which here are all the conversation's spend.
  const storage = await openNodeJsonlStorage(join(runDir, 'leads', 'lead'), BACKGROUND_CONTEXT)
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
  const total = (await harness.usage(BACKGROUND_CONTEXT)).models[model]
  await harness.close(BACKGROUND_CONTEXT)
  assert.ok(total.output > 0)
  assert.deepEqual(usage, {
    inputTokens: total.input + total.cacheRead + total.cacheWrite,
    outputTokens: total.output,
    cachedTokens: total.cacheRead,
    cacheWriteTokens: total.cacheWrite,
  })
})

test('an interrupt delivery steers the running lead within the same run', async () => {
  const { faux, models, model } = fauxModels()
  let started!: () => void
  let release!: () => void
  const running = new Promise<void>((r) => { started = r })
  const gate = new Promise<void>((r) => { release = r })
  let secondRequest: string[] = []
  faux.setResponses([
    async () => {
      started()
      await gate
      return toolCall('note', { text: 'plan A chosen' }, 'call-1')
    },
    (context) => {
      secondRequest = context.messages.flatMap((m) => (m.role === 'user' ? [contentText(m.content)] : []))
      return fauxAssistantMessage([fauxText('Switched to plan B.')])
    },
  ])
  const { host, settled } = fakeHost()
  const runner = openLeadRunner({ runDir: tempRunDir(), host, models })
  await runner.deliver('lead', 'Goal: pick a plan.', { requestId: 'lead:brief', mode: 'queue', model })
  await running
  await runner.deliver('lead', 'Use plan B instead.', { requestId: 'evt-7', mode: 'interrupt' })
  release()
  await until(() => settled.length === 2)
  await runner.close()

  assert.deepEqual(secondRequest, ['Goal: pick a plan.', 'Use plan B instead.'])
  assert.equal(faux.state.callCount, 2)
  // Both deliveries are answered by the same run's answer; each is reported once, with its own part of the usage.
  assert.deepEqual(settled.map((s) => [s.turn.requestId, s.turn.status, s.turn.text]).sort(), [
    ['evt-7', 'done', 'Switched to plan B.'],
    ['lead:brief', 'done', 'Switched to plan B.'],
  ])
  const [brief, steer] = ['lead:brief', 'evt-7'].map((id) => settled.find((s) => s.turn.requestId === id)!.turn.usage!)
  assert.ok(brief.outputTokens > 0 && steer.outputTokens > 0)
})

test('a delivery queued behind a failed run still runs and settles', async () => {
  const { faux, models, model } = fauxModels()
  let started!: () => void
  let release!: () => void
  const running = new Promise<void>((r) => { started = r })
  const gate = new Promise<void>((r) => { release = r })
  faux.setResponses([
    async () => {
      started()
      await gate
      return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'invalid request: bad tool schema' })
    },
    fauxAssistantMessage([fauxText('Child a noted.')]),
  ])
  const { host, settled } = fakeHost()
  const runner = openLeadRunner({ runDir: tempRunDir(), host, models })
  await runner.deliver('lead', 'Goal: wait for a.', { requestId: 'lead:brief', mode: 'queue', model })
  await running
  await runner.deliver('lead', 'Child a completed.', { requestId: 'evt-3', mode: 'queue' })
  release()
  await until(() => settled.length === 2)
  await runner.close()

  assert.deepEqual(settled.map((s) => [s.turn.requestId, s.turn.status, s.turn.text]), [
    ['lead:brief', 'unanswered', 'model_error: invalid request: bad tool schema'],
    ['evt-3', 'done', 'Child a noted.'],
  ])
})

test('cancel stops a running lead and later deliveries are ignored', async () => {
  const { faux, models, model } = fauxModels()
  let started!: () => void
  const running = new Promise<void>((r) => { started = r })
  let aborted = false
  faux.setResponses([
    async (_context, options) => {
      started()
      await new Promise((r) => options?.signal?.addEventListener('abort', r))
      aborted = true
      return fauxAssistantMessage([fauxText('too late')])
    },
  ])
  const runDir = tempRunDir()
  const { host, calls, settled } = fakeHost()
  const runner = openLeadRunner({ runDir, host, models })
  await runner.cancel('never-started')
  assert.equal(existsSync(join(runDir, 'leads', 'never-started')), false)

  await runner.deliver('lead', 'Goal: wait.', { requestId: 'lead:brief', mode: 'queue', model })
  await running
  await runner.cancel('lead')
  assert.equal(aborted, true)
  await runner.deliver('lead', 'Child a completed.', { requestId: 'evt-9', mode: 'queue' })
  await new Promise((r) => setTimeout(r, 200))
  await runner.close()

  assert.equal(faux.state.callCount, 1)
  assert.deepEqual(calls, [])
  assert.deepEqual(settled, [])
})

test('a delivery still being admitted when cancel resolves never runs', async () => {
  const { faux, models, model } = fauxModels()
  faux.setResponses([toolCall('note', { text: 'effect after cancel' }, 'late-call'), fauxAssistantMessage([fauxText('Done')])])
  // Hold the delivery in its credential check while the lead is cancelled.
  let checking!: () => void
  let release!: () => void
  const inCheck = new Promise<void>((r) => { checking = r })
  const gate = new Promise<void>((r) => { release = r })
  const checkAuth = models.checkAuth.bind(models)
  models.checkAuth = async (...args) => { checking(); await gate; return checkAuth(...args) }
  const { host, calls, settled } = fakeHost()
  const runner = openLeadRunner({ runDir: tempRunDir(), host, models })
  const delivery = runner.deliver('lead', 'Goal: note something.', { requestId: 'lead:brief', mode: 'queue', model })
  await inCheck
  const cancelled = runner.cancel('lead')
  await Promise.race([cancelled, new Promise((r) => setTimeout(r, 200))]) // cancel may wait for the admission
  release()
  await cancelled
  await delivery
  await new Promise((r) => setTimeout(r, 300))
  await runner.close()

  assert.equal(faux.state.callCount, 0)
  assert.deepEqual(calls, [])
  assert.deepEqual(settled, [])
})

test('an unknown provider or a missing credential fails the delivery with a clear error', () => {
  // A child process with an empty home directory, so the Pi login has no credentials.
  const home = mkdtempSync(join(tmpdir(), 'murm-home-'))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.OLLAMA_API_KEY
  const res = spawnSync(process.execPath, [fixture, tempRunDir(), 'models'], { encoding: 'utf8', env })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), [
    'unknown lead provider "nope" in "nope/x" (known: ollama-cloud, openai-codex)',
    `no credential for lead provider "ollama-cloud" in ${home}/.pi/agent/auth.json: log in with \`pi\``,
  ])
})

test('after a SIGKILL inside a tool call, resume replays it with the same call ID and reports once', () => {
  const runDir = tempRunDir()
  const run = (phase: string) => spawnSync(process.execPath, [fixture, runDir, phase], { encoding: 'utf8', timeout: 30_000 })
  const killed = run('crash')
  assert.equal(killed.signal, 'SIGKILL', killed.stderr)
  const resumed = run('resume')
  assert.equal(resumed.status, 0, resumed.stderr)
  const again = run('again') // a later restart finds nothing left to report
  assert.equal(again.status, 0, again.stderr)

  const lines = (f: string) => readFileSync(join(runDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const calls = lines('calls.jsonl')
  assert.deepEqual(calls.map((c) => [c.phase, c.callId, c.call.tool]), [
    ['crash', 'call-a', 'spawn'],
    ['crash', 'call-b', 'spawn'],
    ['resume', 'call-b', 'spawn'],
    ['resume', 'call-done', 'complete'],
  ])
  const settled = lines('settled.jsonl')
  assert.deepEqual(settled.map((s) => [s.phase, s.node, s.turn.requestId, s.turn.status, s.turn.text]), [
    ['resume', 'lead', 'lead:brief', 'done', 'Both children spawned; complete.'],
  ])
})
