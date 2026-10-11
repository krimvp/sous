// A lead conversation whose only tool is `spawn`, on JSONL storage.
// usage: node lead.ts <storageDir> <faux|real|ollama:<model>> <run|resume> [crashAt]
//   real: openai-codex/gpt-5.5; ollama:<model>: an Ollama Cloud model, e.g. ollama:glm-5.3
//   run: submits the goal; with crashAt=N the process SIGKILLs itself inside the Nth spawn, after its effect
//   resume: reopens the storage, resumes unfinished work, and waits for the same submission (same requestId)
// Effects go to <storageDir>/spawns.jsonl, keyed by the tool call ID so a replayed call is recognised.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { envApiKeyAuth, Type } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, section } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'

const [dir, mode, phase, crashAtArg] = process.argv.slice(2)
const crashAt = Number(crashAtArg ?? 0)
const context = BACKGROUND_CONTEXT
const spawnsFile = join(dir, 'spawns.jsonl')
const spawned = () => existsSync(spawnsFile)
  ? readFileSync(spawnsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []

// Credentials are read-only: if the login needs a refresh, fail rather than rotate Pi's refresh token.
const auth = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8'))
const known = ['openai-codex', 'ollama-cloud'].filter((id) => auth[id])
const credentials = {
  async read(id: string) { return known.includes(id) ? auth[id] : undefined },
  async list() { return known.map((providerId) => ({ providerId, type: auth[providerId].type })) },
  async modify(): Promise<never> { throw new Error('read-only credentials: run `pi` once to refresh the login') },
  async delete(): Promise<never> { throw new Error('read-only credentials') },
}
const models = createModels({ credentials })
let model = { provider: 'openai-codex', modelId: 'gpt-5.5' }
if (mode === 'faux') {
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  model = { provider: 'faux', modelId: 'faux-1' }
  const call = (id: string) => fauxAssistantMessage([fauxToolCall('spawn', { id, brief: `work for ${id}` }, { id: `call-${id}` })], { stopReason: 'toolUse' })
  const done = fauxAssistantMessage([fauxText('DONE a b c')])
  // On resume only the requests after the last committed answer are made.
  faux.setResponses(phase === 'run' ? [call('a'), call('b'), call('c'), done] : [call('c'), done])
} else if (mode.startsWith('ollama:')) {
  // Ollama Cloud speaks the OpenAI completions API; pi-ai has no built-in provider for it.
  const modelId = mode.slice('ollama:'.length)
  const baseUrl = 'https://ollama.com/v1'
  models.setProvider(createProvider({
    id: 'ollama-cloud',
    baseUrl,
    auth: { apiKey: envApiKeyAuth('Ollama API key', ['OLLAMA_API_KEY']) },
    models: [{
      id: modelId, name: modelId, api: 'openai-completions', baseUrl, provider: 'ollama-cloud', type: 'chat',
      reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072, maxTokens: 32768,
    }],
    api: openAICompletionsApi(),
  }))
  model = { provider: 'ollama-cloud', modelId }
} else {
  models.setProvider(openaiCodexProvider())
}

let calls = 0
const spawnTool = defineTool({
  name: 'spawn',
  description: 'Create one child node that a worker agent will do. Call once per child.',
  parameters: Type.Object({ id: Type.String({ description: 'short unique child id' }), brief: Type.String() }),
  replay: 'safe',
  execute: async (args, api) => {
    calls++
    // A replayed call must return exactly what the original returned: a different text ("already exists")
    // made gpt-5.5 conclude the spawn had failed and stop early.
    const replayed = spawned().find((s) => s.callId === api.callId)
    if (replayed) return { content: [{ type: 'text', text: `child ${replayed.id} created` }] }
    appendFileSync(spawnsFile, JSON.stringify({ callId: api.callId, id: args.id, pid: process.pid }) + '\n', { flush: true })
    if (crashAt && spawned().length === crashAt) process.kill(process.pid, 'SIGKILL') // effect done, result not committed
    return { content: [{ type: 'text', text: `child ${args.id} created` }] }
  },
})
const registry = createRegistry()
registry.install(defineExtension({
  name: 'orchestration',
  tools: [spawnTool],
  sections: [section('role', () => 'You are a lead. You cannot do work yourself; you only create children with the spawn tool.', { tag: false })],
}))

const storage = await openNodeJsonlStorage(dir, context, { fsync: true })
const harness = await Harness.open(storage, { models, registry }, context)
const root = await harness.root(context, { agent: { model } })
if (phase === 'resume') harness.resume()
const goal = 'Goal: write a short README for a todo app. Split it into exactly 3 children (ids a, b, c) by calling spawn three times, one call per response, then reply with DONE and the ids.'
const submission = await root.submit({ type: 'input', content: goal, requestId: 'goal-1' }, context)
const settled = await submission.wait(context)
let answer = ''
if (settled.status === 'done' && settled.type === 'input') {
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
  const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined
  answer = (message?.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
}
console.log(JSON.stringify({ phase, submission: submission.id, status: settled.status, spawnCallsThisProcess: calls, answer }))
const closing = Date.now()
await harness.close(context)
console.log(`close took ${Date.now() - closing} ms`)
// pi-ai's openai-codex provider keeps a connection open for about 5 minutes after close (see results), so a
// one-shot process exits explicitly. A long-running supervisor is unaffected.
console.log(`still active after close: ${process.getActiveResourcesInfo().join(', ')}`)
process.exit(0)
