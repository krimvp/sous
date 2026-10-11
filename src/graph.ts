// Load and validate a graph file for `murm run`.
import { readFileSync } from 'node:fs'
import { ROOT } from './types.ts'
import type { GraphFile, HarnessName, NodeSpec } from './types.ts'

const HARNESSES: HarnessName[] = ['claude', 'codex', 'pi']
const GRAPH_KEYS = ['goal', 'harness', 'model', 'nodes']
const NODE_KEYS = ['id', 'kind', 'parent', 'needs', 'brief', 'command', 'acceptance', 'harness', 'model', 'readOnly']
// IDs name directories under nodes/, so keep them to safe file-name characters.
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function loadGraph(path: string): GraphFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read graph ${path}: ${(err as Error).message}`)
  }
  return validateGraph(raw)
}

/** Validate a parsed graph file and return it with the file's harness and model applied to work nodes. */
export function validateGraph(raw: unknown): GraphFile {
  if (!isObject(raw)) throw new Error('graph: must be a JSON object')
  unknownKeys(raw, GRAPH_KEYS, 'graph')
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) throw new Error('graph: goal must be a non-empty string')
  if (raw.harness !== undefined && !HARNESSES.includes(raw.harness as HarnessName)) {
    throw new Error(`graph: harness must be one of ${HARNESSES.join(', ')}`)
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') throw new Error('graph: model must be a string')
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('graph: nodes must be a non-empty array')
  const graph = raw as unknown as GraphFile

  const ids = new Set<string>()
  const nodes = (raw.nodes as unknown[]).map((node, i): NodeSpec => {
    const where = isObject(node) && typeof node.id === 'string' ? `node ${node.id}` : `node #${i + 1}`
    if (!isObject(node)) throw new Error(`${where}: must be an object`)
    unknownKeys(node, NODE_KEYS, where)
    if (typeof node.id !== 'string' || !ID.test(node.id)) throw new Error(`${where}: id must match ${ID}`)
    if (node.id === ROOT) throw new Error(`${where}: id ${ROOT} is reserved`)
    if (ids.has(node.id)) throw new Error(`${where}: duplicate id`)
    ids.add(node.id)
    if (node.parent !== undefined) throw new Error(`${where}: parent is not supported in graph files (v0 graphs are flat)`)
    if (node.kind !== 'work' && node.kind !== 'check') throw new Error(`${where}: kind must be work or check in v0`)
    if (node.needs !== undefined && !(Array.isArray(node.needs) && node.needs.every((n) => typeof n === 'string'))) {
      throw new Error(`${where}: needs must be an array of node ids`)
    }
    if (node.acceptance !== undefined && !(Array.isArray(node.acceptance) && node.acceptance.every((a) => typeof a === 'string'))) {
      throw new Error(`${where}: acceptance must be an array of strings`)
    }
    for (const key of ['brief', 'command', 'model'] as const) {
      if (node[key] !== undefined && typeof node[key] !== 'string') throw new Error(`${where}: ${key} must be a string`)
    }
    if (node.readOnly !== undefined && typeof node.readOnly !== 'boolean') throw new Error(`${where}: readOnly must be a boolean`)
    if (node.harness !== undefined && !HARNESSES.includes(node.harness)) throw new Error(`${where}: harness must be one of ${HARNESSES.join(', ')}`)
    if (node.kind === 'check') {
      if (!node.command?.trim()) throw new Error(`${where}: check nodes need a command`)
      return node as NodeSpec
    }
    if (!node.brief?.trim()) throw new Error(`${where}: work nodes need a brief`)
    const harness: HarnessName | undefined = node.harness ?? graph.harness
    if (!harness) throw new Error(`${where}: no harness (set harness on the node or the graph)`)
    const model = node.model ?? graph.model
    return { ...node, harness, ...(model === undefined ? {} : { model }) } as NodeSpec
  })

  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (!byId.has(need)) throw new Error(`node ${node.id}: needs unknown node ${need}`)
      if (need === node.id) throw new Error(`node ${node.id}: needs itself`)
    }
  }
  const cycle = findCycle(nodes, byId)
  if (cycle) throw new Error(`node ${cycle[0]}: needs form a cycle: ${cycle.join(' -> ')}`)

  return { ...graph, nodes }
}

function findCycle(nodes: NodeSpec[], byId: Map<string, NodeSpec>): string[] | undefined {
  const done = new Set<string>()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (done.has(id)) return undefined
    const at = path.indexOf(id)
    if (at >= 0) return [...path.slice(at), id]
    path.push(id)
    for (const need of byId.get(id)?.needs ?? []) {
      const cycle = visit(need)
      if (cycle) return cycle
    }
    path.pop()
    done.add(id)
    return undefined
  }
  for (const node of nodes) {
    const cycle = visit(node.id)
    if (cycle) return cycle
  }
  return undefined
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (extra.length) throw new Error(`${where}: unknown field ${extra.join(', ')}`)
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
