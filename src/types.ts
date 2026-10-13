// Shared contracts between the supervisor, the worker adapters and the trace exporters.
// See docs/design.md. Changing a type here changes a boundary: update every side in the same change.

/** Every CLI harness sous has an adapter for. Each must pass the conformance suite (test/conformance*.test.ts). */
export const HARNESSES = ['claude', 'codex', 'pi', 'droid'] as const
export type HarnessName = (typeof HARNESSES)[number]

export type NodeKind = 'work' | 'check' | 'lead' | 'review' | 'gate'

export interface NodeSpec {
  id: string
  kind: NodeKind
  /** Parent node ID; absent for top-level nodes of a graph file (children of the implicit root). */
  parent?: string
  /** Sibling node IDs that must complete before this node starts. */
  needs?: string[]
  /** What the agent should do (work, review, lead), or what the person approves (gate). */
  brief?: string
  /** Shell command for `check` nodes, or a node's acceptance check run after a `done` result. */
  command?: string
  /** Acceptance criteria shown to the agent in its brief. */
  acceptance?: string[]
  /** Name of the agent that does this node: a built-in (`claude`, `codex`, `pi`, `droid`, `lead`) or one the graph
   * defines. Default: the first available worker agent; for leads, `lead`. */
  agent?: string
  /** Overrides the agent's model for this node. */
  model?: string
  /** Leads: the agents that fill roles for this lead and its subtree (see Roles). */
  roles?: Roles
  /** A standing node is an independent agent of the run (the integrator): it takes requests through its
   * inbox, goes idle between them, and never completes on its own. Internal; not allowed in graph files. */
  standing?: boolean
}

/** How an agent runs: a CLI harness, or an in-process durable lead. */
export type AgentRuntime = HarnessName | 'lead'

/** An agent: the unit that does work. The harness is only how it runs. */
export interface AgentSpec {
  runs: AgentRuntime
  /** For CLI harnesses the harness's model name; for leads `provider/model`. */
  model?: string
  /** Standing instructions added to every brief this agent receives. */
  instructions?: string
}

/** Agents that exist without being defined. */
export const BUILTIN_AGENTS: Readonly<Record<string, AgentSpec>> = Object.fromEntries(
  [...HARNESSES, 'lead' as const].map((runs) => [runs, { runs }]),
)

/** When nothing names an agent, the first available one in these lists is used. A graph that defines an
 * agent named `integrator` overrides the integrator choice. */
export const WORKER_AGENT_PREFERENCE = ['claude', 'codex', 'pi', 'droid'] as const
export const INTEGRATOR_AGENT_PREFERENCE = ['codex', 'claude', 'pi', 'droid'] as const

/** Node ID and agent name reserved for the run's integrator. */
export const INTEGRATOR = 'integrator'

/** Roles: agents that serve every lead of a subtree instead of doing a node. A lead's agent for a role is the nearest
 * `roles` entry from the lead up through its ancestors, else the run's agent named after the role, if it defines one.
 * Each agent in a role runs as a standing node (see `roleNode`). `splitter`: proposes how each lead splits its task
 * before the lead receives its brief. */
export const ROLES = ['splitter'] as const
export type Role = (typeof ROLES)[number]
export type Roles = Partial<Record<Role, string>>

export const SPLITTER: Role = 'splitter'

/** The standing node of `agent` in `role`: the role's name for the agent named after it, else `<role>.<agent>`. IDs
 * equal to a role, or starting with `<role>.`, are reserved. */
export const roleNode = (role: Role, agent: string) => (agent === role ? role : `${role}.${agent}`)

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

/** The structured result every worker turn must end with. */
export interface TurnResult {
  status: 'done' | 'blocked' | 'needs_input'
  summary: string
  question?: string
  note_for_parent?: string
}

/** JSON Schema of TurnResult, passed to harnesses that support structured output. */
export const TURN_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'needs_input'] },
    summary: { type: 'string' },
    question: { type: 'string' },
    note_for_parent: { type: 'string' },
  },
} as const

export interface Usage {
  /** Prompt tokens including cached tokens (ATIF convention). */
  inputTokens: number
  outputTokens: number
  /** Cached prompt tokens read, a subset of inputTokens. */
  cachedTokens: number
  /** Tokens written to the provider's prompt cache, when reported. */
  cacheWriteTokens?: number
  costUsd?: number
}

/** Harness-neutral items parsed from one turn's raw output; the exporters' only view of a worker. */
export type TraceItem =
  | { kind: 'message'; role: 'assistant' | 'user' | 'system'; text: string; reasoning?: string; model?: string; at?: string }
  | { kind: 'tool_call'; id: string; name: string; arguments: unknown; at?: string }
  | { kind: 'tool_result'; callId: string; content: string; isError?: boolean; at?: string }

export interface ParsedTurn {
  sessionId?: string
  model?: string
  items: TraceItem[]
  /** Present when the harness reached its end-of-turn marker with a parsable result. */
  result?: TurnResult
  /** True when the end-of-turn marker was seen (Claude `result`, Codex `turn.completed`, Pi `agent_end`, Droid `completion`). */
  ended: boolean
  usage?: Usage
}

export interface TurnSpec {
  nodeId: string
  turn: number
  /** Working directory for the agent. */
  cwd: string
  /** Full prompt for this turn: the brief on start, the delivered messages on resume. */
  prompt: string
  /** Raw stdout goes here (JSON lines); the adapter creates the file. */
  outFile: string
  errFile: string
  model?: string
  /** Required for resume; for start, adapters that accept a preset session ID use it if given. */
  sessionId?: string
  /** Set for a worker of the tree: `SOUS_RUN_DIR`, `SOUS_NODE` and `SOUS_TURN`, its identity for `sous send` and
   * `sous receive`. Adapters add it to
   * the agent's environment and, where the harness takes MCP servers, give it sous's server (src/mcp.ts) with it.
   * Every adapter loads no other MCP server, so what a worker says to others goes through sous. */
  env?: Record<string, string>
}

export interface RunningTurn {
  /** Leader of the turn's own process group: signal `-pid` to stop the whole turn. */
  pid: number
  /** Resolves once the session ID is known (immediately for Claude and Pi; a resumed Droid turn reports a new one). */
  sessionId: Promise<string>
  /** Resolves when the process exits. The turn's outcome is read from outFile with `parse`. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface WorkerAdapter {
  name: HarnessName
  start(spec: TurnSpec): RunningTurn
  resume(spec: TurnSpec & { sessionId: string }): RunningTurn
  /** Parse the raw contents of a turn's outFile. Must tolerate a truncated final line. */
  parse(raw: string): ParsedTurn
}

// ---- Leads -----------------------------------------------------------------------------------

/** A child a lead asks for. Its id is unique in the run; its parent is the calling lead. */
export interface ChildSpec {
  id: string
  kind: 'work' | 'check' | 'lead' | 'gate'
  /** What to do (work, lead), or what the person approves (gate). */
  brief?: string
  command?: string
  acceptance?: string[]
  /** Earlier siblings (children of the same lead) that must complete first. */
  needs?: string[]
  /** Agent name, as for nodes, or a new agent defined for this child. */
  agent?: string | NewAgent
  /** Lead children: agents for roles in its subtree, each one the run's definitions (graph or agents file) define. */
  roles?: Roles
  /** Overrides the model of the agent the child names (a string `agent`), from the run's `models` for that agent's
   * runtime. Not allowed without a named agent; a new agent carries its own model. */
  model?: string
}

/** A new agent a lead defines when it spawns a child: it runs on `runs`, a runtime with a list in the run's `models`,
 * on `model` from that list (default: its first entry), with exactly `instructions`. Once the spawn is accepted,
 * `name` (new in the run) is an agent every later spawn in the run may name. */
export interface NewAgent {
  name: string
  runs: AgentRuntime
  model?: string
  instructions?: string
}

/** One orchestration tool call made by a lead. These are a lead's only tools. */
export type LeadCall =
  | { tool: 'spawn'; children: ChildSpec[] }
  | { tool: 'send'; to: string; body: string; mode: 'queue' | 'interrupt' }
  | { tool: 'note'; text: string }
  | { tool: 'cancel'; node: string }
  | { tool: 'complete'; summary: string }
  | { tool: 'fail'; reason: string }
  | { tool: 'escalate'; question: string }

/** A lead's read-only look at the run's files: the workspace and the results so far. Paths are relative; in folder mode
 * they start with `workspace/` or `results/`. Reads change nothing and are recorded as `lead.read`. */
export type LeadRead =
  | { tool: 'list_files'; path?: string }
  | { tool: 'read_file'; path: string; offset?: number }

/** How a run keeps its results, decided once when it is created. `git`: the workspace is in a git work tree; work nodes
 * get worktrees and are merged into branch `sous/<run>`. `folder`: no git; each work node writes in its own folder and its
 * files are collected into `<runDir>/output/`. */
export type RunMode = 'git' | 'folder'

/** What the supervisor offers the lead runner. */
export interface LeadHost {
  /** Apply one tool call of lead `node` and return the text the model sees. Idempotent per `callId`:
   * a repeated callId returns the first result unchanged and applies nothing. */
  act(node: string, callId: string, call: LeadCall): string
  /** Lead `node` lists or reads files; returns the text the model sees. Read-only, so a replayed call simply reads again. */
  read(node: string, callId: string, call: LeadRead): string
  /** Lead `node` finished answering a delivery and is idle. */
  settled(node: string, turn: { requestId: string; status: 'done' | 'unanswered'; text: string; model: string; usage?: Usage }): void
}

/** Runs leads as durable conversations (pi-durable), one storage per lead under `<runDir>/leads/<node>/`. */
export interface LeadRunner {
  /** Deliver text to lead `node`, creating its conversation on first use. Idempotent per `requestId`.
   * `queue` is answered after the current run; `interrupt` steers the running one. Resolves once admitted. */
  deliver(node: string, text: string, opts: { requestId: string; mode: 'queue' | 'interrupt'; model?: string }): Promise<void>
  /** Stop lead `node`: withdraw its queued deliveries and abort its running work. Resolves once it is idle;
   * later deliveries to it are ignored. A no-op for a lead that was never started. */
  cancel(node: string): Promise<void>
  /** Resume unfinished lead work after a restart (pi-durable resume). */
  resume(): Promise<void>
  close(): Promise<void>
}

export type CreateLeadRunner = (opts: { runDir: string; host: LeadHost }) => LeadRunner

/** How deep leads may nest (a top-level lead is depth 1) unless the run sets `--max-depth`. */
export const DEFAULT_MAX_LEAD_DEPTH = 3

/** The lead providers sous knows: each one's default model, and what a person does to give sous a credential for it
 * (every message about a lead that cannot run says so). Credentials are read as `src/lead/providers.ts` says. */
export const LEAD_PROVIDERS: readonly { id: string; model: string; credential: string }[] = [
  { id: 'ollama-cloud', model: 'deepseek-v4.1-flash', credential: 'set OLLAMA_API_KEY or log in with Pi (run pi)' },
  { id: 'openai-codex', model: 'gpt-5.5', credential: 'log in with Pi (run pi) using ChatGPT' },
]

/** Default lead model when neither the node nor the run sets one: the first lead provider's. */
export const DEFAULT_LEAD_MODEL = `${LEAD_PROVIDERS[0].id}/${LEAD_PROVIDERS[0].model}`

/** What gets a credential for lead provider `provider`: its entry's, or, for a provider sous has no entry for, the
 * Pi login that every provider may be logged in to. */
export const leadCredentialFix = (provider: string) =>
  LEAD_PROVIDERS.find((p) => p.id === provider)?.credential ?? 'log in with Pi (run pi)'

// ---- Event log -------------------------------------------------------------------------------

export type EventBody =
  /** `maxDepth`: how deep leads may nest in this run (`sous run --max-depth`); absent means DEFAULT_MAX_LEAD_DEPTH.
   * `definitions`: a goal run's agents file (`sous run --agents`); a graph run's definitions are in its `graph`.
   * `approveSplits`: the person approves each split the splitter proposes before its lead receives it.
   * `mode`: decided when the run is created, so a resumed run keeps it; absent (older logs) means `git`. */
  | { type: 'run.created'; goal: string; workspace: string; graph?: GraphFile; definitions?: Definitions; maxDepth?: number; approveSplits?: boolean; mode?: RunMode }
  | { type: 'node.added'; node: NodeSpec; by: string }
  /** `startTime`: the leader's start time (field 22 of /proc/<pid>/stat), so a reused pid is not mistaken for it.
   * `recovery`: the turn continues (or restarts) one that a supervisor stop cut short. */
  | { type: 'turn.started'; node: string; turn: number; mode: 'start' | 'resume'; harness?: HarnessName; agent?: string; pid: number; startTime?: string; outFile: string; errFile: string; prompt?: string; recovery?: boolean }
  | { type: 'turn.session'; node: string; turn: number; sessionId: string }
  | { type: 'turn.interrupted'; node: string; turn: number; reason: string; signal: NodeJS.Signals }
  | { type: 'turn.ended'; node: string; turn: number; exitCode: number | null; signal: NodeJS.Signals | null; result?: TurnResult; usage?: Usage; error?: string }
  | { type: 'check.ended'; node: string; command: string; exitCode: number | null; output: string }
  /** `command`: on events a person command produced, the name of its command file (see `sous answer`). */
  | { type: 'node.completed'; node: string; summary: string; command?: string }
  | { type: 'node.failed'; node: string; reason: string }
  /** `sent`: a worker's `send` to a sibling or its lead while it works, which expects no answer; its lead gets a copy
   * of one to a sibling. */
  | { type: 'message'; from: string; to: string; body: string; mode: 'queue' | 'interrupt'; command?: string; sent?: true }
  /** Worker `node` read its messages up to seq `upTo` during its turn `turn` (`receive`). They count as read once that
   * turn ends with a result; a turn cut short gets them again when it resumes. Ignored once a later turn started. */
  | { type: 'inbox.read'; node: string; turn: number; upTo: number; command?: string }
  /** Text delivered to a lead (its brief, a child's outcome, a message). */
  | { type: 'lead.delivered'; node: string; requestId: string; text: string; mode: 'queue' | 'interrupt' }
  /** One lead tool call. Its effects (children, message, note, cancel, completion, escalation) follow from this
   * one event in the fold, so a call applies atomically. `ok: false` means policy refused it and nothing changed. */
  | { type: 'lead.call'; node: string; callId: string; call: LeadCall; ok: boolean; result: string }
  /** A lead listed or read files: what it looked at (`path`, as the lead gave it; absent for the top level) and how many
   * bytes of text it got back, or why the read was refused. The text itself is not recorded. */
  | { type: 'lead.read'; node: string; callId: string; tool: LeadRead['tool']; path?: string; offset?: number; bytes: number; refused?: string }
  /** A lead answered a delivery and is idle again. */
  | { type: 'lead.turn'; node: string; requestId: string; status: 'done' | 'unanswered'; text: string; model: string; usage?: Usage }
  /** A node and its whole subtree are cancelled (by a lead or by the person). */
  | { type: 'node.cancelled'; node: string; by: string; command?: string }
  /** `sous resume` took over a run whose supervisor had stopped. */
  | { type: 'run.resumed' }
  /** The run's integration branch and worktree, created before the first work or check node starts. */
  | { type: 'integration.created'; branch: string; path: string; base: string }
  /** A node's own worktree and branch, created from the integration branch at `base` (a commit). */
  | { type: 'worktree.created'; node: string; branch: string; path: string; base: string }
  /** A finished node joined the merge queue: its branch (git mode), or its folder's files (folder mode, no branch). */
  | { type: 'merge.queued'; node: string; branch?: string }
  /** A queued node got messages before its merge started: it leaves the queue, and its worker resumes with them. */
  | { type: 'merge.withdrawn'; node: string }
  /** The merge needs the integrator: it conflicted (`files`, left in progress in the integration worktree), or the
   * node's check failed after a clean merge (the merge commit stays). `onto`: the integration commit before the
   * merge, where a failed merge leaves the branch. */
  | { type: 'merge.conflict'; node: string; reason: string; files: string[]; onto: string }
  /** The node's work is in the results: on the integration branch at `commit` (git mode), or collected into the output
   * folder (folder mode, no commit). `nothing` when it changed no file. `files`: the files it produced, relative to the
   * results (git mode: changed by its commits; folder mode: as collected). `renamed` (folder mode): files kept under a new
   * name, `<name>.<node>.<ext>`, because the results already held a different file at that path, by original path. */
  | { type: 'merge.done'; node: string; commit?: string; by: 'supervisor' | 'integrator' | 'nothing'; files?: string[]; renamed?: Record<string, string> }
  /** The integrator could not merge it; the node fails and its parent is told. */
  | { type: 'merge.failed'; node: string; reason: string }
  /** Lead `node` is ready and has a splitter, `agent`: it waits for a proposed split before its brief. */
  | { type: 'split.requested'; node: string; agent: string }
  /** The splitter's proposal for lead `node`, valid as a spawn when it was made; the lead's brief carries it. */
  | { type: 'split.proposed'; node: string; parts: ChildSpec[]; summary: string }
  /** No valid proposal for lead `node`; it splits its task on its own. */
  | { type: 'split.failed'; node: string; reason: string }
  | { type: 'run.completed'; summary: string }
  | { type: 'run.failed'; reason: string }

/** One line of runs/<id>/events.jsonl. `seq` starts at 1 and has no gaps. */
export type Event = EventBody & { seq: number; at: string }

/** The implicit root node's ID. */
export const ROOT = 'root'

/** Message address of the person running sous: the parent of top-level nodes. */
export const PERSON = 'person'
