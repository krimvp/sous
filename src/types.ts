// Shared contracts between the supervisor, the worker adapters and the trace exporters.
// See docs/design.md. Changing a type here changes a boundary: update every side in the same change.

export type HarnessName = 'claude' | 'codex' | 'pi'

export type NodeKind = 'work' | 'check' | 'lead' | 'review' | 'gate'

export interface NodeSpec {
  id: string
  kind: NodeKind
  /** Parent node ID; absent for top-level nodes of a graph file (children of the implicit root). */
  parent?: string
  /** Sibling node IDs that must complete before this node starts. */
  needs?: string[]
  /** What the agent should do (work, review, lead). */
  brief?: string
  /** Shell command for `check` nodes, or a node's acceptance check run after a `done` result. */
  command?: string
  /** Acceptance criteria shown to the agent in its brief. */
  acceptance?: string[]
  harness?: HarnessName
  model?: string
  /** Promise that the node changes no files; such nodes may run concurrently. Default false. */
  readOnly?: boolean
}

/** A graph file for `murm run`. Top-level nodes are children of the implicit root. */
export interface GraphFile {
  goal: string
  /** Defaults for nodes that do not set them. */
  harness?: HarnessName
  model?: string
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
  /** True when the end-of-turn marker was seen (Claude `result`, Codex `turn.completed`, Pi `agent_end`). */
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
}

export interface RunningTurn {
  /** Leader of the turn's own process group: signal `-pid` to stop the whole turn. */
  pid: number
  /** Resolves once the session ID is known (immediately for Claude and Pi). */
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

// ---- Leads (v1) ------------------------------------------------------------------------------

/** A child a lead asks for. Its id is unique in the run; its parent is the calling lead. */
export interface ChildSpec {
  id: string
  kind: 'work' | 'check' | 'lead'
  brief?: string
  command?: string
  acceptance?: string[]
  /** Earlier siblings (children of the same lead) that must complete first. */
  needs?: string[]
  harness?: HarnessName
  /** For work nodes the harness's model; for leads `provider/model`. */
  model?: string
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

/** What the supervisor offers the lead runner. */
export interface LeadHost {
  /** Apply one tool call of lead `node` and return the text the model sees. Idempotent per `callId`:
   * a repeated callId returns the first result unchanged and applies nothing. */
  act(node: string, callId: string, call: LeadCall): string
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

/** Default lead model when neither the node nor the run sets one. */
export const DEFAULT_LEAD_MODEL = 'ollama-cloud/deepseek-v4.1-flash'

// ---- Event log -------------------------------------------------------------------------------

export type EventBody =
  | { type: 'run.created'; goal: string; workspace: string; graph?: GraphFile }
  | { type: 'node.added'; node: NodeSpec; by: string }
  | { type: 'turn.started'; node: string; turn: number; mode: 'start' | 'resume'; harness?: HarnessName; pid: number; outFile: string; errFile: string; prompt?: string }
  | { type: 'turn.session'; node: string; turn: number; sessionId: string }
  | { type: 'turn.interrupted'; node: string; turn: number; reason: string; signal: NodeJS.Signals }
  | { type: 'turn.ended'; node: string; turn: number; exitCode: number | null; signal: NodeJS.Signals | null; result?: TurnResult; usage?: Usage; error?: string }
  | { type: 'check.ended'; node: string; command: string; exitCode: number | null; output: string }
  | { type: 'node.completed'; node: string; summary: string }
  | { type: 'node.failed'; node: string; reason: string }
  | { type: 'message'; from: string; to: string; body: string; mode: 'queue' | 'interrupt' }
  /** Text delivered to a lead (its brief, a child's outcome, a message). */
  | { type: 'lead.delivered'; node: string; requestId: string; text: string; mode: 'queue' | 'interrupt' }
  /** One lead tool call. Its effects (children, message, note, cancel, completion, escalation) follow from this
   * one event in the fold, so a call applies atomically. `ok: false` means policy refused it and nothing changed. */
  | { type: 'lead.call'; node: string; callId: string; call: LeadCall; ok: boolean; result: string }
  /** A lead answered a delivery and is idle again. */
  | { type: 'lead.turn'; node: string; requestId: string; status: 'done' | 'unanswered'; text: string; model: string; usage?: Usage }
  /** A node and its whole subtree are cancelled (by a lead or by the person). */
  | { type: 'node.cancelled'; node: string; by: string }
  | { type: 'run.completed'; summary: string }
  | { type: 'run.failed'; reason: string }

/** One line of runs/<id>/events.jsonl. `seq` starts at 1 and has no gaps. */
export type Event = EventBody & { seq: number; at: string }

/** The implicit root node's ID. */
export const ROOT = 'root'

/** Message address of the person running Murmuration: the parent of top-level nodes. */
export const PERSON = 'person'
