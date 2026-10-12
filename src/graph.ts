// Load and validate a graph file or an agents file for `sous run`, and lead children.
import { readFileSync } from 'node:fs'
import { agentNames, agentSpec, modelError, RUNTIMES } from './agents.ts'
import { HARNESSES, INTEGRATOR, PERSON, ROLES, ROOT } from './types.ts'
import type { AgentRuntime, AgentSpec, ChildSpec, Definitions, GraphFile, NodeSpec } from './types.ts'

const KINDS: string[] = ['work', 'check', 'lead', 'gate']
const DEFINITION_KEYS = ['agent', 'agents', 'models']
const GRAPH_KEYS = ['goal', 'nodes', ...DEFINITION_KEYS]
const AGENT_KEYS = ['runs', 'model', 'instructions']
const NEW_AGENT_KEYS = ['name', 'runs', 'model', 'instructions']
// Pi and lead models are named `provider/model`.
const PROVIDER_MODEL = /^[^/\s]+\/\S+$/
const NODE_KEYS = ['id', 'kind', 'parent', 'needs', 'brief', 'command', 'acceptance', 'agent', 'model', 'roles']
const RESERVED: string[] = [ROOT, PERSON, INTEGRATOR, ...ROLES]
// A role's standing nodes are `<role>.<agent>`.
const reserved = (id: string) => RESERVED.includes(id) || ROLES.some((role) => id.startsWith(`${role}.`))
// IDs name directories under nodes/, so keep them to safe file-name characters.
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
// An agent in a role names its standing node and git branch (`sous/<run>.<role>.<agent>`), so no dots.
const ROLE_AGENT = /^[A-Za-z0-9_-]+$/

export function loadGraph(path: string): GraphFile {
  return validateGraph(readJson(path, 'graph'))
}

/** Load an agents file for a goal run (`sous run --agents`): `agent`, `agents` and `models`, as in graph files. */
export function loadDefinitions(path: string): Definitions {
  const raw = readJson(path, 'agents file')
  if (!isObject(raw)) throw new Error('agents file: must be a JSON object')
  unknownKeys(raw, DEFINITION_KEYS, 'agents file')
  validateDefinitions(raw, 'agents file')
  return raw as Definitions
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read ${what} ${path}: ${(err as Error).message}`)
  }
}

/** Validate a parsed graph file. */
export function validateGraph(raw: unknown): GraphFile {
  if (!isObject(raw)) throw new Error('graph: must be a JSON object')
  unknownKeys(raw, GRAPH_KEYS, 'graph')
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) throw new Error('graph: goal must be a non-empty string')
  validateDefinitions(raw, 'graph')
  const graph = raw as unknown as GraphFile
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('graph: nodes must be a non-empty array')

  const ids = new Set<string>()
  const nodes = (raw.nodes as unknown[]).map((node, i): NodeSpec => {
    const where = isObject(node) && typeof node.id === 'string' ? `node ${node.id}` : `node #${i + 1}`
    if (!isObject(node)) throw new Error(`${where}: must be an object`)
    unknownKeys(node, NODE_KEYS, where)
    if (typeof node.id !== 'string' || !ID.test(node.id)) throw new Error(`${where}: id must match ${ID}`)
    if (reserved(node.id)) throw new Error(`${where}: id ${node.id} is reserved`)
    if (ids.has(node.id)) throw new Error(`${where}: duplicate id`)
    ids.add(node.id)
    if (node.parent !== undefined) throw new Error(`${where}: parent is not supported in graph files: their nodes are top-level`)
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
    const agent = agentError(graph, node.kind, node.agent) ?? rolesError(node.kind, node.roles, (name) => agentSpec(graph, name), 'an agent of the graph or a built-in')
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

/** Validate the agent definitions of a graph or agents file: `agents`, the default `agent` and `models`. */
function validateDefinitions(raw: Record<string, any>, what: string): void {
  if (raw.agents !== undefined) {
    if (!isObject(raw.agents)) throw new Error(`${what}: agents must be an object of agents by name`)
    for (const [name, agent] of Object.entries(raw.agents)) {
      const where = `agent ${name}`
      if (!isObject(agent)) throw new Error(`${where}: must be an object`)
      unknownKeys(agent, AGENT_KEYS, where)
      if (!RUNTIMES.includes(agent.runs)) throw new Error(`${where}: runs must be one of ${RUNTIMES.join(', ')}`)
      for (const key of ['model', 'instructions'] as const) {
        if (agent[key] !== undefined && typeof agent[key] !== 'string') throw new Error(`${where}: ${key} must be a string`)
      }
      if ((ROLES as readonly string[]).includes(name) && agent.runs === 'lead') throw new Error(`${where}: the ${name} runs a CLI harness (${HARNESSES.join(', ')}), not lead`)
    }
  }
  if (raw.models !== undefined) {
    if (!isObject(raw.models)) throw new Error(`${what}: models must be an object of model lists by runtime`)
    unknownKeys(raw.models, RUNTIMES, `${what}: models`)
    for (const [runs, list] of Object.entries(raw.models)) {
      const named = runs === 'pi' || runs === 'lead'
      const ok = (m: unknown) => typeof m === 'string' && m.trim() !== '' && (!named || PROVIDER_MODEL.test(m))
      if (!Array.isArray(list) || !list.every(ok)) {
        throw new Error(`${what}: models.${runs} must be an array of ${named ? 'provider/model names' : 'model names'}`)
      }
    }
  }
  const agent = agentError(raw, 'work', raw.agent)
  if (agent) throw new Error(`${what}: ${agent}`)
}

/** Why a node of `kind` may not name `agent`, if it may not. A work node needs a worker agent, a lead a lead agent. */
function agentError(defs: Pick<Definitions, 'agents'> | undefined, kind: string, agent: unknown): string | undefined {
  if (agent === undefined) return undefined
  if (kind === 'check' || kind === 'gate') return `${kind} nodes have no agent`
  if (typeof agent !== 'string') return 'agent must be a string'
  const spec = agentSpec(defs, agent)
  if (!spec) return `unknown agent ${agent} (known: ${agentNames(defs).join(', ')})`
  if (kind === 'lead' && spec.runs !== 'lead') return `agent ${agent} runs ${spec.runs}; a lead needs an agent that runs lead`
  if (kind !== 'lead' && spec.runs === 'lead') return `agent ${agent} runs lead; a ${kind} node needs a worker agent`
  return undefined
}

/** Why a lead of `kind` may not have `roles`, if it may not: each names a role and an agent `lookup` finds that does not
 * run lead. */
function rolesError(kind: string, roles: unknown, lookup: (name: string) => AgentSpec | undefined, known: string): string | undefined {
  if (roles === undefined) return undefined
  if (kind !== 'lead') return 'only leads have roles'
  if (!isObject(roles)) return 'roles must be an object of agent names by role'
  for (const [role, agent] of Object.entries(roles)) {
    if (!(ROLES as readonly string[]).includes(role)) return `unknown role ${role} (known: ${ROLES.join(', ')})`
    if (typeof agent !== 'string') return `roles.${role} must be an agent name`
    if (agent === INTEGRATOR) return `roles.${role}: the integrator cannot fill a role`
    if (!ROLE_AGENT.test(agent)) return `roles.${role}: an agent in a role needs a name of letters, digits, _ and - (it names a node and a branch)`
    const spec = lookup(agent)
    if (!spec) return `roles.${role}: ${agent} is not ${known}`
    if (spec.runs === 'lead') return `roles.${role}: agent ${agent} runs lead; a ${role} runs a CLI harness`
  }
  return undefined
}

/** Why a lead's child spec is invalid, if it is. `siblings` are the IDs it may name in `needs`; `defs` holds the run's
 * agents, those leads defined so far included, and its model lists; `person` the agents the person defined, the only
 * ones a lead may give a role. */
export function childError(c: ChildSpec, used: (id: string) => boolean, siblings: string[], defs?: Definitions, person?: Pick<Definitions, 'agents'>): string | undefined {
  if (!isObject(c)) return 'must be an object'
  if (typeof c.id !== 'string' || !ID.test(c.id) || reserved(c.id)) return `id must match ${ID}, not be ${RESERVED.join(', ')}, nor start with a role and a dot`
  if (used(c.id)) return 'id is already used'
  if (!KINDS.includes(c.kind)) return 'kind must be work, check, lead or gate'
  if (c.kind === 'lead' && c.command !== undefined) return 'leads have no command; spawn a check child for a deterministic gate'
  if (c.kind === 'gate' && c.command !== undefined) return 'gates have no command; the person approves them'
  if (c.kind === 'check' ? !isText(c.command) : !isText(c.brief)) return c.kind === 'check' ? 'a check needs a command' : `a ${c.kind} needs a brief`
  const agent = isObject(c.agent) ? newAgentError(defs, c.kind, c.agent) : agentError(defs, c.kind, c.agent)
  if (agent) return agent
  const roles = rolesError(c.kind, c.roles, (name) => (Object.hasOwn(person?.agents ?? {}, name) ? person!.agents![name] : undefined), 'an agent the run defines')
  if (roles) return roles
  for (const key of ['brief', 'command', 'model'] as const) if (c[key] !== undefined && typeof c[key] !== 'string') return `${key} must be a string`
  const model = childModelError(defs, c)
  if (model) return model
  if (c.acceptance !== undefined && !(Array.isArray(c.acceptance) && c.acceptance.every((a) => typeof a === 'string'))) return 'acceptance must be an array of strings'
  if (c.needs !== undefined && !(Array.isArray(c.needs) && c.needs.every((n) => siblings.includes(n)))) return 'needs may name only earlier siblings'
  return undefined
}

/** Why a child of `kind` may not define the agent `d`, if it may not. */
function newAgentError(defs: Definitions | undefined, kind: string, d: Record<string, any>): string | undefined {
  if (kind === 'check' || kind === 'gate') return `${kind} nodes have no agent`
  const extra = Object.keys(d).filter((k) => !NEW_AGENT_KEYS.includes(k))
  if (extra.length) return `agent: unknown field ${extra.join(', ')}`
  if (typeof d.name !== 'string' || !ID.test(d.name) || RESERVED.includes(d.name)) return `agent.name must match ${ID} and not be ${RESERVED.join(', ')}`
  if (agentSpec(defs, d.name)) return `agent ${d.name} already exists: name it, or define one with a new name`
  if (!RUNTIMES.includes(d.runs)) return `agent.runs must be one of ${RUNTIMES.join(', ')}`
  if (kind === 'lead' && d.runs !== 'lead') return 'a lead needs an agent that runs lead'
  if (kind !== 'lead' && d.runs === 'lead') return `a ${kind} node needs an agent that does not run lead`
  for (const key of ['model', 'instructions'] as const) if (d[key] !== undefined && typeof d[key] !== 'string') return `agent.${key} must be a string`
  if (!defs?.models?.[d.runs as AgentRuntime]?.length) return `leads may not define agents on ${d.runs}: the run lists no ${d.runs} models`
  return d.model === undefined ? undefined : modelError(defs, d.runs, d.model)
}

/** Why a child may not choose `model`, if it may not: only for an agent it names, from the run's list for that agent's
 * runtime. A new agent carries its own model. */
function childModelError(defs: Definitions | undefined, c: ChildSpec): string | undefined {
  if (c.model === undefined) return undefined
  if (c.kind === 'check' || c.kind === 'gate') return `${c.kind} nodes have no model`
  if (isObject(c.agent)) return 'set the model of a new agent in it, as agent.model'
  if (c.agent === undefined) return 'a model needs a named agent: name the agent it applies to'
  return modelError(defs, agentSpec(defs, c.agent)!.runs, c.model)
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

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (extra.length) throw new Error(`${where}: unknown field ${extra.join(', ')}`)
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
