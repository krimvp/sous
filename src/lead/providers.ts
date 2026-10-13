// Model access for leads: Ollama Cloud, Anthropic, OpenAI and the ChatGPT login (openai-codex), with credentials
// from the environment (OLLAMA_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY; pi-ai reads them) or from the user's Pi
// login. sous never refreshes or writes the login: a refresh rotates the refresh token Pi itself uses. An expired
// login is refreshed by running `pi` once.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { envApiKeyAuth } from '@earendil-works/pi-ai'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { ModelRef } from '@earendil-works/pi-durable'
import { leadCredentialFix } from '../types.ts'

const AUTH_FILE = join(homedir(), '.pi/agent/auth.json')
const OLLAMA = 'ollama-cloud'
const OLLAMA_URL = 'https://ollama.com/v1'

/** The Pi login's credentials, read at each use. An OAuth token past its `expires` is left out: pi-ai stores `expires`
 * five minutes before the token's real end and refreshes a token from then on, which sous cannot, so an expired login
 * is invisible and a key in the environment is used instead. A file that is not an object of credentials by provider
 * counts as empty, and `problem` says so. */
function login(): { credentials: Record<string, Credential>; problem?: string } {
  if (!existsSync(AUTH_FILE)) return { credentials: {} }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch {
    return { credentials: {}, problem: `${AUTH_FILE} is not valid JSON; the Pi login is ignored (run pi to log in again)` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { credentials: {}, problem: `${AUTH_FILE} is not an object of credentials by provider; the Pi login is ignored (run pi to log in again)` }
  }
  const live = Object.entries(raw as Record<string, Credential>)
    .filter(([, c]) => typeof c === 'object' && c !== null && (c.type !== 'oauth' || (typeof c.expires === 'number' && Date.now() < c.expires)))
  return { credentials: Object.fromEntries(live) }
}

/** What is wrong with the Pi login file, if anything; its credentials are then ignored. */
export const loginProblem = (): string | undefined => login().problem

/** The lead providers, reading credentials from the environment and the Pi login at each use. */
export function loginModels(): MutableModels {
  const auth = () => login().credentials
  const credentials: CredentialStore = {
    async read(id) { return auth()[id] },
    async list() { return Object.entries(auth()).map(([providerId, c]) => ({ providerId, type: c.type })) },
    async modify() { throw new Error('read-only credentials: run `pi` once to refresh the login') },
    async delete() { throw new Error('read-only credentials') },
  }
  const models = createModels({ credentials })
  models.setProvider(ollamaCloud([]))
  models.setProvider(anthropicProvider())
  models.setProvider(openaiProvider())
  models.setProvider(openaiCodexProvider())
  return models
}

// Ollama Cloud speaks the OpenAI completions API; pi-ai has no built-in provider for it, and its model list is
// whatever the leads ask for.
function ollamaCloud(ids: string[]) {
  return createProvider({
    id: OLLAMA,
    baseUrl: OLLAMA_URL,
    auth: { apiKey: envApiKeyAuth('Ollama API key', ['OLLAMA_API_KEY']) },
    models: ids.map((id) => ({
      id, name: id, api: 'openai-completions', baseUrl: OLLAMA_URL, provider: OLLAMA, type: 'chat' as const,
      reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072, maxTokens: 32768,
    })),
    api: openAICompletionsApi(),
  })
}

/** Where lead provider `provider` has a credential, if it has one: the environment variable, or `Pi login`. Never the
 * credential itself. */
export async function leadCredential(provider: string): Promise<string | undefined> {
  const models = loginModels()
  if (!models.getProvider(provider)) return undefined
  const auth = await models.checkAuth(provider).catch(() => undefined)
  if (!auth) return undefined
  return auth.source === undefined || auth.source === 'OAuth' || auth.source === 'stored credential' ? 'Pi login' : auth.source
}

/** Resolve `provider/model` to a model the lead can use, or throw a clear error. */
export async function resolveModel(models: MutableModels, ref: string): Promise<ModelRef> {
  const slash = ref.indexOf('/')
  const provider = ref.slice(0, slash)
  const modelId = ref.slice(slash + 1)
  if (slash <= 0 || !modelId) throw new Error(`lead model "${ref}" is not provider/model`)
  if (!models.getProvider(provider)) {
    const known = models.getProviders().map((p) => p.id).join(', ')
    throw new Error(`unknown lead provider "${provider}" in "${ref}" (known: ${known})`)
  }
  if (provider === OLLAMA && !models.getModel(OLLAMA, modelId)) {
    models.setProvider(ollamaCloud([...models.getModels(OLLAMA).map((m) => m.id), modelId]))
  }
  if (!models.getModel(provider, modelId)) throw new Error(`unknown lead model "${ref}"`)
  if (!(await models.checkAuth(provider))) throw new Error(`no credential for lead provider "${provider}": ${leadCredentialFix(provider)}`)
  return { provider, modelId }
}

export const modelName = (m: ModelRef) => `${m.provider}/${m.modelId}`
