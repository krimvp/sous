// The worker adapters' contract: one turn of a CLI harness, how it starts, and what is parsed from its output.

/** Every CLI harness sous has an adapter for. Each must pass the conformance suite (test/conformance*.test.ts). */
export const HARNESSES = ['claude', 'codex', 'pi', 'droid'] as const
export type HarnessName = (typeof HARNESSES)[number]

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
