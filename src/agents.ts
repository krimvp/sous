// Agents: who does a node. Names resolve against the run's definitions (its graph's or agents file's, and those
// leads derived), then the built-ins. Defaults come
// from availability, which the CLI checks once when a run starts or resumes.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { BUILTIN_AGENTS, DEFAULT_LEAD_MODEL, INTEGRATOR, INTEGRATOR_AGENT_PREFERENCE, WORKER_AGENT_PREFERENCE } from './types.ts'
import type { AgentRuntime, AgentSpec, Definitions, DerivedAgent, HarnessName, NodeSpec } from './types.ts'

/** An agent resolved for one node: the node's model, if it sets one, replaces the agent's. */
export interface Agent {
  name: string
  runs: AgentRuntime
  model?: string
  instructions?: string
}

/** What was missing when the run started or resumed: harness commands not on PATH, and lead providers without a
 * Pi login credential. Only the providers a run's graph names (and the default lead model's) are checked; a lead child
 * on another provider fails in the lead runner if it has no credential. */
export interface Unavailable {
  commands: string[]
  leadProviders: string[]
}

type Agents = Pick<Definitions, 'agents'> | undefined
type Defaults = Definitions | undefined

const HARNESSES: HarnessName[] = ['claude', 'codex', 'pi']
const own = (record: object | undefined, key: string) => record !== undefined && Object.hasOwn(record, key)
const providerOf = (model: string | undefined) => (model ?? DEFAULT_LEAD_MODEL).split('/')[0]

/** The definition of agent `name`: the graph's, else the built-in one. */
export function agentSpec(graph: Agents, name: string): AgentSpec | undefined {
  if (own(graph?.agents, name)) return graph!.agents![name]
  return own(BUILTIN_AGENTS, name) ? BUILTIN_AGENTS[name] : undefined
}

/** Every agent name the graph can use: the built-ins and its own. */
export function agentNames(graph: Agents): string[] {
  return [...new Set([...Object.keys(BUILTIN_AGENTS), ...Object.keys(graph?.agents ?? {})])]
}

/** The agent `d` derives from its base: the base's runtime, the new model or the base's, and the base's instructions
 * followed by the new ones. The caller has checked that the base exists. */
export function derive(graph: Agents, d: DerivedAgent): AgentSpec {
  const base = agentSpec(graph, d.from)!
  const model = d.model ?? base.model
  const instructions = [base.instructions?.trim(), d.instructions?.trim()].filter(Boolean).join('\n\n')
  return { runs: base.runs, ...(model === undefined ? {} : { model }), ...(instructions ? { instructions } : {}) }
}

/** Why a lead may not choose `model` for an agent that runs `runs`, if it may not. */
export function modelError(graph: Defaults, runs: AgentRuntime, model: string): string | undefined {
  const allowed = graph?.models?.[runs] ?? []
  if (!allowed.length) return `leads may not choose a model for ${runs} agents (none allowed)`
  return allowed.includes(model) ? undefined : `model ${model} is not allowed for ${runs} agents (allowed: ${allowed.join(', ')})`
}

/** Check which harness commands are on PATH, and which lead providers the graph names have a credential. */
export async function checkAgents(graph: (Pick<Definitions, 'agents'> & { nodes?: NodeSpec[] }) | undefined, hasLeadCredential: (provider: string) => Promise<boolean>): Promise<Unavailable> {
  const leads = agentNames(graph).map((name) => agentSpec(graph, name)!).filter((spec) => spec.runs === 'lead')
  const models = [...leads.map((spec) => spec.model), ...(graph?.nodes ?? []).filter((n) => n.kind === 'lead').map((n) => n.model)]
  const leadProviders: string[] = []
  for (const provider of new Set([DEFAULT_LEAD_MODEL, ...models].map(providerOf))) {
    if (!(await hasLeadCredential(provider))) leadProviders.push(provider)
  }
  return { commands: HARNESSES.filter((command) => !onPath(command)), leadProviders }
}

/** Why an agent that runs `runs` on `model` cannot run, if it cannot. */
export function whyUnavailable(runs: AgentRuntime, model: string | undefined, unavailable: Unavailable): string | undefined {
  if (runs !== 'lead') return unavailable.commands.includes(runs) ? `${runs} not found` : undefined
  const provider = providerOf(model)
  return unavailable.leadProviders.includes(provider) ? `no Pi login credential for ${provider}` : undefined
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

/** Whether agent `name` runs a CLI harness that is available: what a default worker or the integrator must be. */
function availableWorker(graph: Agents, name: string, unavailable: Unavailable): boolean {
  const spec = agentSpec(graph, name)
  return spec !== undefined && spec.runs !== 'lead' && !whyUnavailable(spec.runs, spec.model, unavailable)
}

/** The agent for work nodes that name none: the graph's `agent`, else the first available preferred worker. */
export function defaultWorker(graph: Defaults, unavailable: Unavailable): string | undefined {
  return graph?.agent ?? WORKER_AGENT_PREFERENCE.find((name) => availableWorker(graph, name, unavailable))
}

/** The integrator's agent: the graph's `integrator` agent unless it runs lead, else the first available preferred
 * worker. */
export function integratorAgent(graph: Agents, unavailable: Unavailable): string | undefined {
  if (own(graph?.agents, INTEGRATOR) && graph!.agents![INTEGRATOR].runs !== 'lead') return INTEGRATOR
  return INTEGRATOR_AGENT_PREFERENCE.find((name) => availableWorker(graph, name, unavailable))
}

/** The available agents a lead's children may name, by the kind of node they can do, the runtime of each, and the
 * models a lead may choose. */
export function childAgents(graph: Defaults, unavailable: Unavailable) {
  const specs = agentNames(graph).map((name) => [name, agentSpec(graph, name)!] as const)
    .filter(([, spec]) => !whyUnavailable(spec.runs, spec.model, unavailable))
  const names = (lead: boolean) => specs.filter(([, spec]) => (spec.runs === 'lead') === lead).map(([name]) => name)
  const runs = Object.fromEntries(specs.map(([name, spec]) => [name, spec.runs]))
  return { work: names(false), lead: names(true), defaultWork: defaultWorker(graph, unavailable), runs, models: graph?.models ?? {} }
}

/** The agent that does `node`: the one it names, else the default for its kind. Throws a reason the node fails with
 * when that agent is unknown, cannot do this kind of node, or is not available with the node's model. */
export function agentFor(graph: Defaults, node: Pick<NodeSpec, 'kind' | 'agent' | 'model'>, unavailable: Unavailable): Agent {
  const name = node.agent ?? (node.kind === 'lead' ? 'lead' : defaultWorker(graph, unavailable))
  if (name === undefined) throw new Error(`no worker agent is available (not found: ${unavailable.commands.join(', ')})`)
  const spec = agentSpec(graph, name)
  if (!spec) throw new Error(`unknown agent ${name}`)
  if ((spec.runs === 'lead') !== (node.kind === 'lead')) throw new Error(`agent ${name} runs ${spec.runs} and cannot do a ${node.kind} node`)
  const model = node.model ?? spec.model
  const why = whyUnavailable(spec.runs, model, unavailable)
  if (why) throw new Error(`agent ${name} is not available (${why})`)
  return { name, runs: spec.runs, ...(model === undefined ? {} : { model }), ...(spec.instructions ? { instructions: spec.instructions } : {}) }
}
