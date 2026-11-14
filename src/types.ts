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
  /** The turn's cost in US dollars, when the harness reports one. */
  costUsd?: number
  /** The cost of the whole session so far, for a harness that reports a running total instead of the turn's cost
   * (Claude Code's `total_cost_usd` includes the session's earlier turns). An adapter sets this or `costUsd`, not both;
   * `viewRun` gives such a turn the `costUsd` the session total grew by since the session's previous turn. */
  sessionCostUsd?: number
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

/** What gets a credential for some lead provider: the fix when none has one. */
export const ANY_LEAD_CREDENTIAL_FIX = 'set OLLAMA_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY, or run pi, then /login'

/** The lead model when nothing names one and availability was not consulted: the first lead provider's. */
export const DEFAULT_LEAD_MODEL = `${LEAD_PROVIDERS[0].id}/${LEAD_PROVIDERS[0].model}`

/** What gets a credential for lead provider `provider`: its entry's, or, for a provider sous has no entry for, the
 * Pi login that every provider may be logged in to. */
export const leadCredentialFix = (provider: string) =>
  LEAD_PROVIDERS.find((p) => p.id === provider)?.credential ?? 'run pi, then /login'

// ---- Event log -------------------------------------------------------------------------------

export type EventBody =
  /** `maxDepth`: how deep leads may nest in this run (`sous run --max-depth`); absent means DEFAULT_MAX_LEAD_DEPTH.
   * `definitions`: a goal run's agents file (`sous run --agents`); a graph run's definitions are in its `graph`.
   * `approveSplits`: the person approves each split the splitter proposes before its lead receives it.
   * `mode`: decided when the run is created, so a resumed run keeps it; absent (older logs) means `git`.
   * `leadModel`: the model of lead agents that name none, chosen from the credentials present when the run was created
   * (see Agents in the design); a resumed run keeps it. Absent when no lead provider had one, or in older logs. */
  | { type: 'run.created'; goal: string; workspace: string; graph?: GraphFile; definitions?: Definitions; maxDepth?: number; approveSplits?: boolean; mode?: RunMode; leadModel?: string }
  | { type: 'node.added'; node: NodeSpec; by: string }
  /** `startTime`: the leader's start time (field 22 of /proc/<pid>/stat), so a reused pid is not mistaken for it.
   * `recovery`: the turn continues (or restarts) one that a supervisor stop cut short. */
  | { type: 'turn.started'; node: string; turn: number; mode: 'start' | 'resume'; harness?: HarnessName; agent?: string; pid: number; startTime?: string; outFile: string; errFile: string; prompt?: string; recovery?: boolean }
  | { type: 'turn.session'; node: string; turn: number; sessionId: string }
  | { type: 'turn.interrupted'; node: string; turn: number; reason: string; signal: NodeJS.Signals }
  /** A warning, recorded once per turn: the turn's output file has not grown since `since` (its start, or its last
   * output) for the supervisor's stall time. The turn keeps running; nothing in the run's state changes. */
  | { type: 'turn.stalled'; node: string; turn: number; since: string }
  /** `error`: why the turn has no result. Without an end-of-turn marker after a non-zero exit, it ends with the last
   * lines of the turn's stderr and the path of its `.err` file. */
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
  /** The supervisor did not apply command file `command` (`sous answer`, `approve` or `cancel`): it was no valid command,
   * named no node of the run, or no longer applied when read (the node finished, a gate was not waiting), or never does
   * (an answer to a check or a gate, a cancel of a standing node). `reason` names the command and why. */
  | { type: 'command.refused'; command: string; reason: string }
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

// ---- Status --------------------------------------------------------------------------------------

/** A node's status in the fold. `waiting`: a worker that asked its parent and waits for a message, a lead waiting on
 * its escalation or on the person's approval of its split, or a gate waiting for the person's approval. `merging`: a
 * finished work node in the merge queue. `idle`: a standing node between requests. */
export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'merging' | 'idle' | 'completed' | 'failed'

/** A run as `sous status`, `sous runs` and `sous ui` call it: `stopped` is a run that is not over whose supervisor is
 * gone (Ctrl-C, a crash, a kill), so `sous resume` continues it. */
export type RunLiveness = 'running' | 'stopped' | 'completed' | 'failed'

/** One node in `sous status --json`. */
export interface StatusNode {
  id: string
  kind: NodeKind
  /** Absent for top-level nodes and standing nodes. */
  parent?: string
  status: NodeStatus
  /** The integrator or a splitter. */
  standing?: true
  /** The agent of its latest turn, else the one its spec names. */
  agent?: string
  turns: number
  /** Its failure reason, its completion summary (naming the failed checks a lead completed over), its last turn's result
   * summary, or a check node's last output line; the text `sous status` shows after the colon, uncut. */
  summary?: string
  /** Leads that completed over failed check children: those checks. */
  failedChecks?: string[]
  /** Its turn that runs now, while the run is `running`: since when, and its output file's last change (absent before
   * its first output). Ages are in whole seconds at `RunStatus.at`. */
  turn?: { number: number; startedAt: string; ageSeconds: number; lastOutputAt?: string; lastOutputAgeSeconds?: number }
}

/** Something that waits for the person: a question (a message to `person` from a worker or a lead), a gate's approval,
 * or a proposed split's approval (`--approve-splits`). */
export interface StatusAsk {
  kind: 'question' | 'gate' | 'split'
  node: string
  /** What it asks, in full. */
  text: string
  /** Seq of the event that asked: a later ask from the same node has a higher one. */
  seq: number
  /** The commands that answer it, as sous prints them (naming the run when the workspace has several): a question's
   * `answer`; a gate's `approve` and `reject` (`sous cancel`); a split's `approve` and `answer` (with changes).
   * `<answer>` and `<changes>` are placeholders. */
  commands: { answer?: string; approve?: string; reject?: string }
  /** A command for this node (or a cancel of one of its ancestors) is in the run's `commands/`, not yet applied by the
   * supervisor: it has been answered, and `sous wait` does not stop for it. */
  sent?: true
}

/** `sous status --json`: the run's state from the fold of its log, the structure `sous status` prints as text. */
export interface RunStatus {
  id: string
  state: RunLiveness
  goal: string
  mode: RunMode
  /** `run.completed`'s summary. */
  summary?: string
  /** `run.failed`'s reason. */
  reason?: string
  /** Where the results are: the run's branch (git mode, once created) or its output folder (folder mode, once it exists). */
  result?: { branch: string; deleted?: true } | { folder: string }
  /** The run's tokens so far and the cost its harnesses reported, absent when no turn recorded usage. `costUsd` sums the
   * turns that reported a cost; `unpriced` counts those that reported none, so a partial sum is not taken for the price. */
  usage?: { input: number; output: number; cached: number; costUsd?: number; unpriced: number }
  /** Every node, depth first: each node is followed by its subtree. */
  nodes: StatusNode[]
  waiting: StatusAsk[]
  /** The latest three person commands the supervisor did not apply, latest last. */
  refused: { at: string; reason: string }[]
  /** How to continue a stopped run: `sous resume <id>`. */
  resume?: string
  /** For a finished git-mode run, what the person may do next, while it still applies: `next: sous diff, then git merge
   * sous/<id>, then sous clean`. */
  next?: string
  /** When this was read. */
  at: string
}

/** Why `sous wait` returned, and its exit code. `completed`: the run completed and no top-level node completed over a
 * failed check. `failed`: the run failed, or completed with failed checks. `waiting`: something waits for the person
 * that no command sent for it answers yet (`StatusAsk.sent`). `stopped`: the run is not over and its supervisor is gone.
 * `timeout`: none of these within `--timeout`. */
export const WAIT_EXIT_CODES = { completed: 0, failed: 3, waiting: 4, stopped: 5, timeout: 6 } as const
export type WaitReason = keyof typeof WAIT_EXIT_CODES

/** `sous wait --json`: the run's status when `wait` returned, and why it returned. */
export type RunWait = RunStatus & { wait: WaitReason }
