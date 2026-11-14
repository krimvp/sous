import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAgents, integratorAgent } from '../src/definitions/index.ts'
import { fakeBin } from './helpers/sous-proc.ts'

test('the integrator is the graph\'s integrator agent, else the first available of codex, claude, pi, droid', () => {
  const missing = (...commands: string[]) => ({ commands, leadProviders: [] })
  const none = missing('codex', 'claude', 'pi', 'droid')
  assert.equal(integratorAgent({ agents: { integrator: { runs: 'pi', instructions: 'Merge carefully.' } } }, none), 'integrator')
  assert.equal(integratorAgent(undefined, missing()), 'codex')
  assert.equal(integratorAgent({ agents: { reviewer: { runs: 'codex' } } }, missing('codex')), 'claude')
  assert.equal(integratorAgent(undefined, missing('codex', 'claude')), 'pi')
  assert.equal(integratorAgent(undefined, missing('codex', 'claude', 'pi')), 'droid')
  assert.equal(integratorAgent(undefined, none), undefined)
})

test('the integrator pick skips an agent that runs lead, even a defined integrator', () => {
  const nothing = { commands: [], leadProviders: [] }
  assert.equal(integratorAgent({ agents: { codex: { runs: 'lead' } } }, nothing), 'claude')
  assert.equal(integratorAgent({ agents: { integrator: { runs: 'lead' } } }, nothing), 'codex')
})

test('checkAgents finds the commands missing from PATH and the lead providers, known or named by the graph, without a credential', async () => {
  const path = process.env.PATH
  process.env.PATH = fakeBin(['pi'])
  try {
    const graph = {
      agents: { planner: { runs: 'lead' as const, model: 'openai-codex/gpt-5.5' }, quick: { runs: 'pi' as const } },
      nodes: [{ id: 'l', kind: 'lead' as const, brief: 'b', model: 'other/m' }],
    }
    const unavailable = await checkAgents(graph, async (provider) => (provider === 'ollama-cloud' ? 'OLLAMA_API_KEY' : undefined))
    assert.deepEqual(unavailable, { commands: ['claude', 'codex', 'droid'], leadProviders: ['anthropic', 'openai', 'openai-codex', 'other'], leadModel: 'ollama-cloud/deepseek-v4.1-flash', workerModels: { claude: 'haiku' } })
    // A resumed run keeps the models recorded for it, whatever has a credential now.
    const resumed = await checkAgents(graph, async () => 'fake', { leadModel: 'openai/gpt-6-luna', workerModels: {} })
    assert.deepEqual(resumed, { commands: ['claude', 'codex', 'droid'], leadProviders: [], leadModel: 'openai/gpt-6-luna', workerModels: {} })
  } finally {
    process.env.PATH = path
  }
})
