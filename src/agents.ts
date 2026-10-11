// Agents: who does a node. Names resolve against the graph's definitions, then the built-ins. Defaults come
// from availability, which the CLI checks once when a run starts or resumes.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { BUILTIN_AGENTS, DEFAULT_LEAD_MODEL, INTEGRATOR, INTEGRATOR_AGENT_PREFERENCE, WORKER_AGENT_PREFERENCE } from './types.ts'
import type { AgentRuntime, AgentSpec, GraphFile, NodeSpec } from './types.ts'

/** An agent resolved for one node: the node's model, if it sets one, replaces the agent's. */
export interface Agent {
  name: string
  runs: AgentRuntime
  model?: string
  instructions?: string
}

/** Why each agent of a run is not available, by agent name. An available agent has no entry. */
export type Unavailable = Record<string, string>

type Agents = Pick<GraphFile, 'agents'> | undefined

const own = (record: object | undefined, key: string) => record !== undefined && Object.hasOwn(record, key)

/** The definition of agent `name`: the graph's, else the built-in one. */
export function agentSpec(graph: Agents, name: string): AgentSpec | undefined {
  if (own(graph?.agents, name)) return graph!.agents![name]
  return own(BUILTIN_AGENTS, name) ? BUILTIN_AGENTS[name] : undefined
}

/** Every agent name the graph can use: the built-ins and its own. */
export function agentNames(graph: Agents): string[] {
  return [...new Set([...Object.keys(BUILTIN_AGENTS), ...Object.keys(graph?.agents ?? {})])]
}

/** Check every agent the graph can use: a CLI agent needs its command on PATH, a lead agent a credential for its
 * model's provider. */
export async function checkAgents(graph: Agents, hasLeadCredential: (provider: string) => Promise<boolean>): Promise<Unavailable> {
  const unavailable: Unavailable = {}
  for (const name of agentNames(graph)) {
    const spec = agentSpec(graph, name)!
    if (spec.runs === 'lead') {
      const provider = (spec.model ?? DEFAULT_LEAD_MODEL).split('/')[0]
      if (!(await hasLeadCredential(provider))) unavailable[name] = `no Pi login credential for ${provider}`
    } else if (!onPath(spec.runs)) unavailable[name] = `${spec.runs} not found`
  }
  return unavailable
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false
    try {
      accessSync(join(dir, command), constants.X_OK)
      return statSync(join(dir, command)).isFile()
    } catch {
      return false
    }
  })
}

/** The agent for work nodes that name none: the graph's `agent`, else the first available preferred one. */
export function defaultWorker(graph: Pick<GraphFile, 'agents' | 'agent'> | undefined, unavailable: Unavailable): string | undefined {
  return graph?.agent ?? WORKER_AGENT_PREFERENCE.find((name) => !unavailable[name])
}

/** The integrator's agent: the graph's `integrator` agent, else the first available preferred one. */
export function integratorAgent(graph: Agents, unavailable: Unavailable): string | undefined {
  return own(graph?.agents, INTEGRATOR) ? INTEGRATOR : INTEGRATOR_AGENT_PREFERENCE.find((name) => !unavailable[name])
}

/** The available agents a lead's children may name, by the kind of node they can do. */
export function childAgents(graph: Pick<GraphFile, 'agents' | 'agent'> | undefined, unavailable: Unavailable) {
  const names = agentNames(graph).filter((name) => !unavailable[name])
  const runsLead = (name: string) => agentSpec(graph, name)!.runs === 'lead'
  return { work: names.filter((n) => !runsLead(n)), lead: names.filter(runsLead), defaultWork: defaultWorker(graph, unavailable) }
}

/** The agent that does `node`: the one it names, else the default for its kind. Throws a reason the node fails with
 * when that agent is unknown, cannot do this kind of node, or is not available. */
export function agentFor(graph: Pick<GraphFile, 'agents' | 'agent'> | undefined, node: Pick<NodeSpec, 'kind' | 'agent' | 'model'>, unavailable: Unavailable): Agent {
  const name = node.agent ?? (node.kind === 'lead' ? 'lead' : defaultWorker(graph, unavailable))
  if (name === undefined) {
    throw new Error(`no worker agent is available (${WORKER_AGENT_PREFERENCE.map((n) => unavailable[n]).join(', ')})`)
  }
  const spec = agentSpec(graph, name)
  if (!spec) throw new Error(`unknown agent ${name}`)
  if ((spec.runs === 'lead') !== (node.kind === 'lead')) throw new Error(`agent ${name} runs ${spec.runs} and cannot do a ${node.kind} node`)
  if (unavailable[name]) throw new Error(`agent ${name} is not available (${unavailable[name]})`)
  const model = node.model ?? spec.model
  return { name, runs: spec.runs, ...(model === undefined ? {} : { model }), ...(spec.instructions ? { instructions: spec.instructions } : {}) }
}
