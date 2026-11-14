import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateGraph } from '../src/definitions/index.ts'
import { HARNESSES } from '../src/contracts/index.ts'

const work = (id: string, needs?: string[]) => ({ id, kind: 'work', brief: `do ${id}`, needs })

test('nodes and the graph name built-in or defined agents; an unknown or unfit agent is rejected', () => {
  const graph = validateGraph({
    goal: 'g', agent: 'reviewer', agents: { reviewer: { runs: 'codex', instructions: 'Be strict.' } },
    nodes: [work('a'), { ...work('b', ['a']), agent: 'pi', model: 'm' }, { id: 'l', kind: 'lead', brief: 'lead', agent: 'lead' }],
  })
  assert.deepEqual(graph.nodes.map((n) => [n.agent, n.model]), [[undefined, undefined], ['pi', 'm'], ['lead', undefined]])
  const rejects = (raw: object, error: RegExp) => assert.throws(() => validateGraph(raw), error)
  rejects({ goal: 'g', agents: { r: { runs: 'pi' } }, nodes: [{ ...work('a'), agent: 'gpt' }] }, new RegExp(`node a: unknown agent gpt \\(known: ${HARNESSES.join(', ')}, lead, r\\)`))
  rejects({ goal: 'g', agent: 'nobody', nodes: [work('a')] }, /graph: unknown agent nobody/)
  rejects({ goal: 'g', nodes: [{ ...work('a'), agent: 'lead' }] }, /node a: agent lead runs lead; a work node needs a worker agent/)
  rejects({ goal: 'g', nodes: [{ id: 'l', kind: 'lead', brief: 'b', agent: 'pi' }] }, /node l: agent pi runs pi; a lead needs an agent that runs lead/)
  rejects({ goal: 'g', nodes: [{ id: 't', kind: 'check', command: 'true', agent: 'pi' }] }, /node t: check nodes have no agent/)
  rejects({ goal: 'g', agents: { x: { runs: 'gpt' } }, nodes: [work('a')] }, new RegExp(`agent x: runs must be one of ${HARNESSES.join(', ')}, lead`))
  rejects({ goal: 'g', model: 'm', nodes: [work('a')] }, /graph: unknown field model/)
  rejects({ goal: 'g', nodes: [{ ...work('a'), harness: 'pi' }] }, /node a: unknown field harness/)
  rejects({ goal: 'g', nodes: [{ ...work('a'), standing: true }] }, /node a: unknown field standing/)
  rejects({ goal: 'g', nodes: [work('integrator')] }, /node integrator: id integrator is reserved/)
  rejects({ goal: 'g', nodes: [work('splitter')] }, /node splitter: id splitter is reserved/)
  rejects({ goal: 'g', agents: { splitter: { runs: 'lead' } }, nodes: [work('a')] }, new RegExp(`agent splitter: the splitter runs a CLI harness \\(${HARNESSES.join(', ')}\\), not lead`))
})

test('a lead may name agents for roles in its subtree; roles are checked at load', () => {
  const agents = { planner: { runs: 'claude', instructions: 'Split by module.' }, boss: { runs: 'lead' } }
  const lead = (roles: unknown, kind = 'lead') => ({ id: 'l', kind, brief: 'b', roles })
  assert.deepEqual(validateGraph({ goal: 'g', agents, nodes: [lead({ splitter: 'planner' })] }).nodes[0].roles, { splitter: 'planner' })
  assert.ok(validateGraph({ goal: 'g', nodes: [lead({ splitter: 'codex' })] }), 'a built-in may fill a role')
  const rejects = (node: object, error: RegExp) => assert.throws(() => validateGraph({ goal: 'g', agents, nodes: [node] }), error)
  rejects(lead({ splitter: 'planner' }, 'work'), /node l: only leads have roles/)
  rejects(lead({ reviewer: 'planner' }), /node l: unknown role reviewer \(known: splitter\)/)
  rejects(lead({ splitter: 'nobody' }), /node l: roles\.splitter: nobody is not an agent of the graph or a built-in/)
  rejects(lead({ splitter: 'boss' }), /node l: roles\.splitter: agent boss runs lead; a splitter runs a CLI harness/)
  rejects(lead('planner'), /node l: roles must be an object of agent names by role/)
  rejects(lead({ splitter: 'integrator' }), /node l: roles\.splitter: the integrator cannot fill a role/)
  assert.throws(() => validateGraph({ goal: 'g', agents: { 'p.lock': { runs: 'claude' } }, nodes: [lead({ splitter: 'p.lock' })] }),
    /node l: roles\.splitter: an agent in a role needs a name of letters, digits, _ and - \(it names a node and a branch\)/)
  rejects(work('splitter.planner'), /node splitter\.planner: id splitter\.planner is reserved/)
})

test('models lists are checked at load: strings, and provider/model names for pi and lead', () => {
  const models = { claude: ['haiku'], codex: ['gpt-5.5'], pi: ['ollama-cloud/glm-5.2'], lead: ['ollama-cloud/deepseek-v4.1-flash'] }
  assert.deepEqual(validateGraph({ goal: 'g', models, nodes: [work('a')] }).models, models)
  const rejects = (models: object, error: RegExp) => assert.throws(() => validateGraph({ goal: 'g', models, nodes: [work('a')] }), error)
  rejects({ pi: ['glm-5.2'] }, /graph: models\.pi must be an array of provider\/model names/)
  rejects({ lead: 'ollama-cloud/x' }, /graph: models\.lead must be an array of provider\/model names/)
  rejects({ claude: [3] }, /graph: models\.claude must be an array of model names/)
  rejects({ gpt: ['x'] }, /graph: models: unknown field gpt/)
})

test('rejects a cycle in needs and names the nodes', () => {
  const graph = { goal: 'g', nodes: [work('a', ['c']), work('b', ['a']), work('c', ['b'])] }
  assert.throws(() => validateGraph(graph), /node a: needs form a cycle: a -> c -> b -> a/)
})

test('rejects needs on an unknown node', () => {
  const graph = { goal: 'g', nodes: [work('a', ['missing'])] }
  assert.throws(() => validateGraph(graph), /node a: needs unknown node missing/)
})

test('rejects a check without a command and a work node without a brief', () => {
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 't', kind: 'check' }] }), /node t: check nodes need a command/)
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 'w', kind: 'work' }] }), /node w: work nodes need a brief/)
})

test('rejects a command on a lead: deterministic gates are check nodes', () => {
  const graph = { goal: 'g', nodes: [{ id: 'l', kind: 'lead', brief: 'lead it', command: 'true' }] }
  assert.throws(() => validateGraph(graph), /node l: leads have no command; add a check node for a deterministic gate/)
})

test('a gate needs a brief for the person and takes no command or agent', () => {
  const graph = validateGraph({ goal: 'g', nodes: [{ id: 'ok', kind: 'gate', brief: 'Ship it?' }] })
  assert.deepEqual(graph.nodes, [{ id: 'ok', kind: 'gate', brief: 'Ship it?' }])
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 'ok', kind: 'gate' }] }), /node ok: gate nodes need a brief/)
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 'ok', kind: 'gate', brief: 'b', command: 'true' }] }), /node ok: gates have no command/)
})

test('check and gate nodes take no model, as lead children do', () => {
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 't', kind: 'check', command: 'true', model: 'm' }] }), /node t: check nodes have no model/)
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 'ok', kind: 'gate', brief: 'Ship it?', model: 'm' }] }), /node ok: gate nodes have no model/)
})

test('ids and agent names are described in words, and an agent name must be a valid id', () => {
  const rule = /letters, digits, _ and - \(and \. after the first character\)/
  assert.throws(() => validateGraph({ goal: 'g', nodes: [work('a b')] }), (err: Error) => rule.test(err.message) && !err.message.includes('^['))
  for (const name of ['', 'my agent', '.hidden', 'a/b']) {
    assert.throws(() => validateGraph({ goal: 'g', agents: { [name]: { runs: 'claude' } }, nodes: [work('a')] }),
      (err: Error) => err.message.startsWith(`graph: agent name ${JSON.stringify(name)} must be `) && rule.test(err.message) && !err.message.includes('^['), name)
  }
  assert.ok(validateGraph({ goal: 'g', agents: { 'my-agent_2': { runs: 'claude' }, 'v1.2': { runs: 'pi' } }, nodes: [work('a')] }))
})

test('a needs entry that is not a node id is named', () => {
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ ...work('a'), needs: ['b', 3] }, work('b')] }), /node a: needs must be an array of node ids, not 3/)
})
