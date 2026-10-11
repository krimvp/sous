import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateGraph } from '../src/graph.ts'

const work = (id: string, needs?: string[]) => ({ id, kind: 'work', brief: `do ${id}`, needs })

test('applies the file harness and model to work nodes', () => {
  const graph = validateGraph({
    goal: 'g', harness: 'codex', model: 'm',
    nodes: [work('a'), { ...work('b', ['a']), harness: 'pi' }, { id: 'c', kind: 'check', command: 'true', needs: ['b'] }],
  })
  assert.deepEqual(graph.nodes.map((n) => [n.harness, n.model]), [['codex', 'm'], ['pi', 'm'], [undefined, undefined]])
})

test('rejects a cycle in needs and names the nodes', () => {
  const graph = { goal: 'g', harness: 'claude', nodes: [work('a', ['c']), work('b', ['a']), work('c', ['b'])] }
  assert.throws(() => validateGraph(graph), /node a: needs form a cycle: a -> c -> b -> a/)
})

test('rejects needs on an unknown node', () => {
  const graph = { goal: 'g', harness: 'claude', nodes: [work('a', ['missing'])] }
  assert.throws(() => validateGraph(graph), /node a: needs unknown node missing/)
})

test('rejects a check without a command and a work node without a brief', () => {
  assert.throws(() => validateGraph({ goal: 'g', nodes: [{ id: 't', kind: 'check' }] }), /node t: check nodes need a command/)
  assert.throws(() => validateGraph({ goal: 'g', harness: 'pi', nodes: [{ id: 'w', kind: 'work' }] }), /node w: work nodes need a brief/)
})

test('rejects a command on a lead: deterministic gates are check nodes', () => {
  const graph = { goal: 'g', nodes: [{ id: 'l', kind: 'lead', brief: 'lead it', command: 'true' }] }
  assert.throws(() => validateGraph(graph), /node l: leads have no command; add a check node for a deterministic gate/)
})
