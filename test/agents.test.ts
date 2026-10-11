import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAgents, integratorAgent } from '../src/agents.ts'
import { fakeBin } from './fixtures/murm-proc.ts'

test('the integrator is the graph\'s integrator agent, else the first available of codex, claude, pi', () => {
  const none = { codex: 'codex not found', claude: 'claude not found', pi: 'pi not found' }
  assert.equal(integratorAgent({ agents: { integrator: { runs: 'pi', instructions: 'Merge carefully.' } } }, none), 'integrator')
  assert.equal(integratorAgent(undefined, {}), 'codex')
  assert.equal(integratorAgent({ agents: { reviewer: { runs: 'codex' } } }, { codex: 'codex not found' }), 'claude')
  assert.equal(integratorAgent(undefined, { codex: 'codex not found', claude: 'claude not found' }), 'pi')
  assert.equal(integratorAgent(undefined, none), undefined)
})

test('an agent is available when its command is on PATH, or for a lead when its provider has a credential', async () => {
  const path = process.env.PATH
  process.env.PATH = fakeBin(['pi'])
  try {
    const graph = { agents: { planner: { runs: 'lead' as const, model: 'openai-codex/gpt-5.5' }, quick: { runs: 'pi' as const } } }
    const unavailable = await checkAgents(graph, async (provider) => provider === 'ollama-cloud')
    assert.deepEqual(unavailable, { claude: 'claude not found', codex: 'codex not found', planner: 'no Pi login credential for openai-codex' })
  } finally {
    process.env.PATH = path
  }
})
