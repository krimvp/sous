// Agents and their definitions: what does a node's work, and the lead providers sous knows.
import { HARNESSES, LEAD_HARNESSES } from './workers.ts'
import type { HarnessName } from './workers.ts'
import type { NodeSpec } from './nodes.ts'

/** Every runtime an agent can run on: a CLI harness, or an in-process durable lead. */
export const RUNTIMES = [...HARNESSES, 'lead'] as const
export type AgentRuntime = (typeof RUNTIMES)[number]

/** An agent: the unit that does work. The harness is only how it runs. */
export interface AgentSpec {
  runs: AgentRuntime
  /** For CLI harnesses the harness's model name (`default`: the harness's own default, see HARNESS_DEFAULT_MODEL;
   * absent: DEFAULT_WORKER_MODELS for a work node); for leads `provider/model`. */
  model?: string
  /** Standing instructions added to every brief this agent receives. */
  instructions?: string
}

/** Agents that exist without being defined. */
export const BUILTIN_AGENTS: Readonly<Record<string, AgentSpec>> = Object.fromEntries(
  RUNTIMES.map((runs) => [runs, { runs }]),
)

/** When nothing names an agent, the first available one in these lists is used. A graph that defines an
 * agent named `integrator` overrides the integrator choice. */
export const WORKER_AGENT_PREFERENCE = ['claude', 'codex', 'pi', 'droid'] as const
export const INTEGRATOR_AGENT_PREFERENCE = ['codex', 'claude', 'pi', 'droid'] as const

/** The model a work node of the tree runs on when its agent, its node and its lead name none: a small, inexpensive model
 * of the harness, where the repository has evidence the name is valid there (Claude Code: `haiku`, the model it is
 * certified on, test/conformance/harnesses.ts). A harness without an entry runs on its own default: Codex's, Pi's and
 * Droid's depend on the person's login or settings (Pi's and Droid's on the providers they set up), and sous knows no
 * model name valid for every setup. Standing nodes (the integrator, a splitter) do judgment-heavy work for the whole run
 * and keep the harness's default. `run.created.workerModels` records the table a run started with. */
export const DEFAULT_WORKER_MODELS: Readonly<Partial<Record<HarnessName, string>>> = { claude: 'haiku' }

/** As an agent's or a node's `model` on a CLI harness: pass no model, so the harness runs on its own default (the
 * behaviour before DEFAULT_WORKER_MODELS). */
export const HARNESS_DEFAULT_MODEL = 'default'


/** The runtimes leads may define agents on, and the models they may choose there (the first is the default): for a
 * new agent, or as a `ChildSpec.model` override of a named agent. A runtime without a list gets no agent defined and
 * no model chosen by a lead. Models the person sets (agent definitions, node models) are not limited. Lists for `pi`
 * and `lead` hold `provider/model` names. */
export type ModelLimits = Partial<Record<AgentRuntime, string[]>>

/** The agent definitions of a run: from its graph file, or from `sous run --agents <file>` for a goal run. */
export interface Definitions {
  /** Default agent for work nodes that do not name one. */
  agent?: string
  /** Agents defined by name. A name may shadow a built-in. */
  agents?: Record<string, AgentSpec>
  models?: ModelLimits
}

/** A graph file for `sous run`. Top-level nodes are children of the implicit root. */
export interface GraphFile extends Definitions {
  goal: string
  nodes: NodeSpec[]
}

/** The lead providers sous knows, in the order a lead that names no model gets one: the first provider with a
 * credential, on its default model here (current and inexpensive; an agent's or a node's `model` overrides it).
 * `credential` is what a person does to give sous one (every message about a lead that cannot run says so).
 * Credentials are read as `src/lead/providers.ts` says: the environment variable named here, or the Pi login. */
export const LEAD_PROVIDERS: readonly { id: string; model: string; credential: string }[] = [
  { id: 'ollama-cloud', model: 'deepseek-v4.1-flash', credential: 'set OLLAMA_API_KEY' },
  { id: 'anthropic', model: 'claude-haiku-5-5', credential: 'set ANTHROPIC_API_KEY, or run pi, then /login' },
  { id: 'openai', model: 'gpt-6-luna', credential: 'set OPENAI_API_KEY, or run pi, then /login' },
  { id: 'openai-codex', model: 'gpt-5.5', credential: 'run pi, then /login with ChatGPT' },
]

/** What lets a lead run when none can: a credential for some lead provider, or a lead-certified harness (LEAD_HARNESSES)
 * on PATH, logged in. */
export const ANY_LEAD_CREDENTIAL_FIX = `set OLLAMA_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY, or run pi, then /login, or install ${LEAD_HARNESSES.join(' or ')} and log in`

/** The lead model when nothing names one and availability was not consulted: the first lead provider's. */
export const DEFAULT_LEAD_MODEL = `${LEAD_PROVIDERS[0].id}/${LEAD_PROVIDERS[0].model}`

/** What gets a credential for lead provider `provider`: its entry's, or, for a provider sous has no entry for, the
 * Pi login that every provider may be logged in to. */
export const leadCredentialFix = (provider: string) =>
  LEAD_PROVIDERS.find((p) => p.id === provider)?.credential ?? 'run pi, then /login'
