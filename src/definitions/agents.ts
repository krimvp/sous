// Agents: who does a node. Names resolve against the run's definitions (its graph's or agents file's, and those
// leads defined), then the built-ins. Defaults come from availability, which the CLI checks once when a run starts
// or resumes.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { ANY_LEAD_CREDENTIAL_FIX, BUILTIN_AGENTS, HARNESSES, INTEGRATOR, INTEGRATOR_AGENT_PREFERENCE, LEAD_PROVIDERS, leadCredentialFix, ROLES, WORKER_AGENT_PREFERENCE } from '../contracts/index.ts'
import type { AgentRuntime, AgentSpec, Definitions, NewAgent, NodeSpec } from '../contracts/index.ts'

/** An agent resolved for one node: the node's model, if it sets one, replaces the agent's. */
export interface Agent {
  name: string
  runs: AgentRuntime
  model?: string
  instructions?: string
}

/** What was missing when the run started or resumed: harness commands not on PATH, and lead providers without a
 * credential. Only the providers sous knows (`LEAD_PROVIDERS`) and those a run's graph names are checked; a lead child
 * on another provider fails in the lead runner if it has no credential. */
export interface Unavailable {
  commands: string[]
  leadProviders: string[]
  /** The model of lead agents that name none: the one recorded for the run, else the first lead provider with a
   * credential; absent when there is neither (`defaultLeadModel`). */
  leadModel?: string
}

type AgentDefs = Pick<Definitions, 'agents'> | undefined
type Defs = Definitions | undefined

/** Every runtime an agent can run on. */
export const RUNTIMES: readonly AgentRuntime[] = [...HARNESSES, 'lead']
const own = (record: object | undefined, key: string) => record !== undefined && Object.hasOwn(record, key)
const providerOf = (model: string) => model.split('/')[0]

/** The model of a lead that names none: the run's, when `unavailable` carries one, else the first lead provider, in
 * `LEAD_PROVIDERS` order, with a credential. */
export function defaultLeadModel(unavailable: Unavailable): string | undefined {
  if (unavailable.leadModel !== undefined) return unavailable.leadModel
  const p = LEAD_PROVIDERS.find((p) => !unavailable.leadProviders.includes(p.id))
  return p && `${p.id}/${p.model}`
}

/** The definition of agent `name`: the run's, else the built-in one. */
export function agentSpec(defs: AgentDefs, name: string): AgentSpec | undefined {
  if (own(defs?.agents, name)) return defs!.agents![name]
  return own(BUILTIN_AGENTS, name) ? BUILTIN_AGENTS[name] : undefined
}

/** Every agent name the run can use: the built-ins and those it defines. */
export function agentNames(defs: AgentDefs): string[] {
  return [...new Set([...Object.keys(BUILTIN_AGENTS), ...Object.keys(defs?.agents ?? {})])]
}

/** The agents worth listing when a run starts: all of them when a lead may pick any (a goal run, or a graph with a lead
 * node), else those the graph's work nodes will use and, with more than one work node, whoever resolves merge conflicts. */
export function startAgents(graph: (Definitions & { nodes?: NodeSpec[] }) | undefined, unavailable: Unavailable): string[] {
  const nodes = graph?.nodes ?? []
  if (!nodes.length || nodes.some((n) => n.kind === 'lead')) return agentNames(graph)
  const work = nodes.filter((n) => n.kind !== 'check' && n.kind !== 'gate')
  const used = new Set(work.map((n) => {
    try {
      return agentFor(graph, n, unavailable).name
    } catch {
      return n.agent
    }
  }))
  if (work.length > 1) {
    if (defines(graph, INTEGRATOR)) used.add(INTEGRATOR)
    // With no integrator available, list the candidates so that what is missing shows.
    const integrator = integratorAgent(graph, unavailable)
    for (const name of integrator ? [integrator] : INTEGRATOR_AGENT_PREFERENCE) used.add(name)
  }
  return agentNames(graph).filter((name) => used.has(name))
}

/** The agent a lead defines with `d`: on `d.runs`, with `d.model` or the first model the run lists for that runtime,
 * and only `d`'s instructions. The caller has checked that the runtime has a list. */
export function defineAgent(defs: Defs, d: NewAgent): AgentSpec {
  const model = d.model ?? defs!.models![d.runs]![0]
  return { runs: d.runs, model, ...(d.instructions?.trim() ? { instructions: d.instructions } : {}) }
}

/** A copy of `agents` as a dictionary without a prototype, so that every valid id, `__proto__` included, is an
 * ordinary key. */
export function registry(agents?: Record<string, AgentSpec>): Record<string, AgentSpec> {
  return Object.assign(Object.create(null), agents)
}

/** Why a lead may not choose `model` for an agent that runs `runs`, if it may not. */
export function modelError(defs: Defs, runs: AgentRuntime, model: string): string | undefined {
  const allowed = defs?.models?.[runs] ?? []
  if (!allowed.length) return `leads may not choose a model for ${runs} agents (none allowed)`
  return allowed.includes(model) ? undefined : `model ${model} is not allowed for ${runs} agents (allowed: ${allowed.join(', ')})`
}

/** Check which harness commands are on PATH, and which lead providers the run's agents and lead nodes name have a
 * credential (`leadCredential` says where one is, or that none is). `leadModel` is the model recorded for the run's
 * lead agents without one (a resumed run), kept even when its provider has no credential now: such a lead is then
 * unavailable rather than moved to another provider. */
export async function checkAgents(graph: (Pick<Definitions, 'agents'> & { nodes?: NodeSpec[] }) | undefined, leadCredential: (provider: string) => Promise<string | undefined>, leadModel?: string): Promise<Unavailable> {
  const leads = agentNames(graph).map((name) => agentSpec(graph, name)!).filter((spec) => spec.runs === 'lead')
  const models = [...leads.map((spec) => spec.model), ...(graph?.nodes ?? []).filter((n) => n.kind === 'lead').map((n) => n.model)]
  const leadProviders: string[] = []
  for (const provider of new Set([...LEAD_PROVIDERS.map((p) => p.id), ...models.filter((m) => m !== undefined).map(providerOf)])) {
    if ((await leadCredential(provider)) === undefined) leadProviders.push(provider)
  }
  const unavailable: Unavailable = { commands: HARNESSES.filter((command) => !onPath(command)), leadProviders }
  const model = leadModel ?? defaultLeadModel(unavailable)
  return model === undefined ? unavailable : { ...unavailable, leadModel: model }
}

/** Why an agent that runs `runs` on `model` (for a lead without one: on the default) cannot run, if it cannot. */
export function whyUnavailable(runs: AgentRuntime, model: string | undefined, unavailable: Unavailable): string | undefined {
  if (runs !== 'lead') return unavailable.commands.includes(runs) ? `${runs} not found` : undefined
  const chosen = model ?? defaultLeadModel(unavailable)
  if (chosen === undefined) return 'no lead provider has a credential'
  const provider = providerOf(chosen)
  return unavailable.leadProviders.includes(provider) ? `no credential for ${provider}` : undefined
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
function availableWorker(defs: AgentDefs, name: string, unavailable: Unavailable): boolean {
  const spec = agentSpec(defs, name)
  return spec !== undefined && spec.runs !== 'lead' && !whyUnavailable(spec.runs, spec.model, unavailable)
}

/** The agent for work nodes that name none: the run's default `agent`, else the first available preferred worker. */
function defaultWorker(defs: Defs, unavailable: Unavailable): string | undefined {
  return defs?.agent ?? WORKER_AGENT_PREFERENCE.find((name) => availableWorker(defs, name, unavailable))
}

/** The integrator's agent: the run's `integrator` agent unless it runs lead, else the first available preferred
 * worker. */
export function integratorAgent(defs: AgentDefs, unavailable: Unavailable): string | undefined {
  if (own(defs?.agents, INTEGRATOR) && defs!.agents![INTEGRATOR].runs !== 'lead') return INTEGRATOR
  return INTEGRATOR_AGENT_PREFERENCE.find((name) => availableWorker(defs, name, unavailable))
}

/** Whether `defs` define an agent named `name` (built-ins do not count). */
export function defines(defs: AgentDefs, name: string): boolean {
  return own(defs?.agents, name)
}

/** The agents a lead may give a role in a child's subtree: those the person defined (graph or agents file) on a CLI
 * harness, available, named as role agents must be, and not the integrator. */
export function roleChoices(person: AgentDefs, unavailable: Unavailable): string[] {
  return Object.keys(person?.agents ?? {}).filter((name) => {
    const spec = person!.agents![name]
    return name !== INTEGRATOR && /^[A-Za-z0-9_-]+$/.test(name) && spec.runs !== 'lead' && !whyUnavailable(spec.runs, spec.model, unavailable)
  })
}

/** The available agents a lead's children may name, by the kind of node they can do, the runtime of each, and the
 * models a lead may choose. Agents named after a role are not among them: their instructions are for the role. */
export function childAgents(defs: Defs, unavailable: Unavailable) {
  const specs = agentNames(defs).filter((name) => !(ROLES as readonly string[]).includes(name)).map((name) => [name, agentSpec(defs, name)!] as const)
    .filter(([, spec]) => !whyUnavailable(spec.runs, spec.model, unavailable))
  const names = (lead: boolean) => specs.filter(([, spec]) => (spec.runs === 'lead') === lead).map(([name]) => name)
  const runs = Object.fromEntries(specs.map(([name, spec]) => [name, spec.runs]))
  return { work: names(false), lead: names(true), defaultWork: defaultWorker(defs, unavailable), runs, models: defs?.models ?? {} }
}

/** What stops the agents of `graph`'s nodes from running, one line per node, so that a run is refused before it starts:
 * whatever `agentFor` cannot resolve for a node with the run's availability. Only what is known up front: the children
 * a lead will spawn are decided at runtime. */
export function unusableNodeAgents(graph: Definitions & { nodes: NodeSpec[] }, unavailable: Unavailable): string[] {
  const problems: string[] = []
  for (const node of graph.nodes) {
    if (node.kind === 'check' || node.kind === 'gate') continue
    try {
      agentFor(graph, node, unavailable)
    } catch (err) {
      const fix = (err as { fix?: string }).fix
      problems.push(`node ${node.id}: ${(err as Error).message}${fix ? `: ${fix}` : ''}`)
    }
  }
  return problems
}

/** The agent that does `node`: the one it names, else the default for its kind; a lead's model is the node's, else the
 * agent's, else the default lead model. Throws a reason the node fails with when that agent is unknown, cannot do this
 * kind of node, or is not available with that model; when what is missing can be fixed, the error's `fix` says how. */
export function agentFor(defs: Defs, node: Pick<NodeSpec, 'kind' | 'agent' | 'model'>, unavailable: Unavailable): Agent {
  const name = node.agent ?? (node.kind === 'lead' ? 'lead' : defaultWorker(defs, unavailable))
  if (name === undefined) throw Object.assign(new Error(`no worker agent is available (not found: ${unavailable.commands.join(', ')})`), { fix: 'install one or name an agent' })
  const spec = agentSpec(defs, name)
  if (!spec) throw new Error(`unknown agent ${name}`)
  if ((spec.runs === 'lead') !== (node.kind === 'lead')) throw new Error(`agent ${name} runs ${spec.runs} and cannot do a ${node.kind} node`)
  const named = node.model ?? spec.model
  const model = named ?? (spec.runs === 'lead' ? defaultLeadModel(unavailable) : undefined)
  const why = whyUnavailable(spec.runs, named, unavailable)
  if (why) {
    const fix = spec.runs !== 'lead' ? `install ${spec.runs} or change the agent`
      : model === undefined ? `${ANY_LEAD_CREDENTIAL_FIX}, or name a lead model (--agents, or the node's model)`
      : `${leadCredentialFix(providerOf(model))}, or name another lead model (--agents, or the node's model)`
    throw Object.assign(new Error(`agent ${name} is not available (${why})`), { fix })
  }
  return { name, runs: spec.runs, ...(model === undefined ? {} : { model }), ...(spec.instructions ? { instructions: spec.instructions } : {}) }
}
