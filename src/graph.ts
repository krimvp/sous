// Load and validate a graph file for `murm run`.
import { readFileSync } from 'node:fs'
import { agentNames, agentSpec } from './agents.ts'
import { INTEGRATOR, PERSON, ROOT } from './types.ts'
import type { AgentRuntime, ChildSpec, GraphFile, NodeSpec } from './types.ts'

const RUNTIMES: AgentRuntime[] = ['claude', 'codex', 'pi', 'lead']
const KINDS: string[] = ['work', 'check', 'lead', 'gate']
const GRAPH_KEYS = ['goal', 'agent', 'agents', 'nodes']
const AGENT_KEYS = ['runs', 'model', 'instructions']
const NODE_KEYS = ['id', 'kind', 'parent', 'needs', 'brief', 'command', 'acceptance', 'agent', 'model']
const RESERVED = [ROOT, PERSON, INTEGRATOR]
// IDs name directories under nodes/, so keep them to safe file-name characters.
export const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function loadGraph(path: string): GraphFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read graph ${path}: ${(err as Error).message}`)
  }
  return validateGraph(raw)
}

/** Validate a parsed graph file. */
export function validateGraph(raw: unknown): GraphFile {
  if (!isObject(raw)) throw new Error('graph: must be a JSON object')
  unknownKeys(raw, GRAPH_KEYS, 'graph')
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) throw new Error('graph: goal must be a non-empty string')
  if (raw.agents !== undefined) {
    if (!isObject(raw.agents)) throw new Error('graph: agents must be an object of agents by name')
    for (const [name, agent] of Object.entries(raw.agents)) {
      const where = `agent ${name}`
      if (!isObject(agent)) throw new Error(`${where}: must be an object`)
      unknownKeys(agent, AGENT_KEYS, where)
      if (!RUNTIMES.includes(agent.runs)) throw new Error(`${where}: runs must be one of ${RUNTIMES.join(', ')}`)
      for (const key of ['model', 'instructions'] as const) {
        if (agent[key] !== undefined && typeof agent[key] !== 'string') throw new Error(`${where}: ${key} must be a string`)
      }
    }
  }
  const graph = raw as unknown as GraphFile
  const graphAgent = agentError(graph, 'work', raw.agent)
  if (graphAgent) throw new Error(`graph: ${graphAgent}`)
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('graph: nodes must be a non-empty array')

  const ids = new Set<string>()
  const nodes = (raw.nodes as unknown[]).map((node, i): NodeSpec => {
    const where = isObject(node) && typeof node.id === 'string' ? `node ${node.id}` : `node #${i + 1}`
    if (!isObject(node)) throw new Error(`${where}: must be an object`)
    unknownKeys(node, NODE_KEYS, where)
    if (typeof node.id !== 'string' || !ID.test(node.id)) throw new Error(`${where}: id must match ${ID}`)
    if (RESERVED.includes(node.id)) throw new Error(`${where}: id ${node.id} is reserved`)
    if (ids.has(node.id)) throw new Error(`${where}: duplicate id`)
    ids.add(node.id)
    if (node.parent !== undefined) throw new Error(`${where}: parent is not supported in graph files (v0 graphs are flat)`)
    if (!KINDS.includes(node.kind)) throw new Error(`${where}: kind must be work, check, lead or gate`)
    if (node.needs !== undefined && !(Array.isArray(node.needs) && node.needs.every((n) => typeof n === 'string'))) {
      throw new Error(`${where}: needs must be an array of node ids`)
    }
    if (node.acceptance !== undefined && !(Array.isArray(node.acceptance) && node.acceptance.every((a) => typeof a === 'string'))) {
      throw new Error(`${where}: acceptance must be an array of strings`)
    }
    for (const key of ['brief', 'command', 'model'] as const) {
      if (node[key] !== undefined && typeof node[key] !== 'string') throw new Error(`${where}: ${key} must be a string`)
    }
    const agent = agentError(graph, node.kind, node.agent)
    if (agent) throw new Error(`${where}: ${agent}`)
    if (node.kind === 'lead' && node.command !== undefined) throw new Error(`${where}: leads have no command; add a check node for a deterministic gate`)
    if (node.kind === 'gate' && node.command !== undefined) throw new Error(`${where}: gates have no command; the person approves them`)
    if (node.kind === 'check' ? !node.command?.trim() : !node.brief?.trim()) {
      throw new Error(`${where}: ${node.kind} nodes need a ${node.kind === 'check' ? 'command' : 'brief'}`)
    }
    return node as NodeSpec
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

/** Why a node of `kind` may not name `agent`, if it may not. A work node needs a worker agent, a lead a lead agent. */
export function agentError(graph: Pick<GraphFile, 'agents'> | undefined, kind: string, agent: unknown): string | undefined {
  if (agent === undefined) return undefined
  if (kind === 'check' || kind === 'gate') return `${kind} nodes have no agent`
  if (typeof agent !== 'string') return 'agent must be a string'
  const spec = agentSpec(graph, agent)
  if (!spec) return `unknown agent ${agent} (known: ${agentNames(graph).join(', ')})`
  if (kind === 'lead' && spec.runs !== 'lead') return `agent ${agent} runs ${spec.runs}; a lead needs an agent that runs lead`
  if (kind !== 'lead' && spec.runs === 'lead') return `agent ${agent} runs lead; a ${kind} node needs a worker agent`
  return undefined
}

/** Why a lead's child spec is invalid, if it is. `siblings` are the IDs it may name in `needs`. */
export function childError(c: ChildSpec, used: (id: string) => boolean, siblings: string[], graph?: Pick<GraphFile, 'agents'>): string | undefined {
  if (!isObject(c)) return 'must be an object'
  if (typeof c.id !== 'string' || !ID.test(c.id) || RESERVED.includes(c.id)) return `id must match ${ID} and not be ${RESERVED.join(', ')}`
  if (used(c.id)) return 'id is already used'
  if (!KINDS.includes(c.kind)) return 'kind must be work, check, lead or gate'
  if (c.kind === 'lead' && c.command !== undefined) return 'leads have no command; spawn a check child for a deterministic gate'
  if (c.kind === 'gate' && c.command !== undefined) return 'gates have no command; the person approves them'
  if (c.kind === 'check' ? !isText(c.command) : !isText(c.brief)) return c.kind === 'check' ? 'a check needs a command' : `a ${c.kind} needs a brief`
  const agent = agentError(graph, c.kind, c.agent)
  if (agent) return agent
  for (const key of ['brief', 'command', 'model'] as const) if (c[key] !== undefined && typeof c[key] !== 'string') return `${key} must be a string`
  if (c.acceptance !== undefined && !(Array.isArray(c.acceptance) && c.acceptance.every((a) => typeof a === 'string'))) return 'acceptance must be an array of strings'
  if (c.needs !== undefined && !(Array.isArray(c.needs) && c.needs.every((n) => siblings.includes(n)))) return 'needs may name only earlier siblings'
  return undefined
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
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
