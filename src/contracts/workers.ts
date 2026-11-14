// The worker adapters' contract: one turn of a CLI harness, how it starts, and what is parsed from its output.
import type { LeadResult } from './leads.ts'

/** Every CLI harness sous has an adapter for. Each must pass the conformance suite (test/conformance*.test.ts). */
export const HARNESSES = ['claude', 'codex', 'pi', 'droid'] as const
export type HarnessName = (typeof HARNESSES)[number]

/** The harnesses certified to run leads, in the order a lead that names no model falls back to them when no lead
 * provider has a credential (see Lead runner in the design). A harness joins this list in the change that commits its
 * passing lead certification (`SOUS_HARNESS=<name> npm run certify`, whose certified.json lists the lead tests as
 * passed); the free conformance suite checks that every harness here has that evidence. */
export const LEAD_HARNESSES: readonly HarnessName[] = ['claude']

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
  /** A lead turn's result (`TurnSpec.lead`), present like `result`: at the end marker, when it parses. */
  lead?: LeadResult
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
  /** Set for a lead turn on a CLI harness (an adapter with `lead`): the turn is read only (the harness offers only its
   * read tools, or runs in a read-only sandbox, as far as it allows: see the design's isolation table), loads no MCP
   * server, and ends with a LeadResult instead of a TurnResult (`ParsedTurn.lead`). Lead turns get no `env`. */
  lead?: LeadTurnSpec
}

export interface LeadTurnSpec {
  /** The lead's role: the harness's system prompt where the harness can replace it, else put before the first prompt. */
  system: string
  /** Directories the lead may read besides `cwd` (folder mode: what its `workspace` and `results` links point to). */
  readable?: string[]
}

/** The supervisor's environment without any SOUS_* variable, for what it starts (turns, checks): an identity comes from
 * a turn alone, so an outer run's (sous running inside a sous worker) never reaches them. */
export function withoutIdentity(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SOUS_')))
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
  /** The adapter can run lead turns (`TurnSpec.lead`). A harness leads in a run only once it is in LEAD_HARNESSES. */
  lead?: true
  start(spec: TurnSpec): RunningTurn
  resume(spec: TurnSpec & { sessionId: string }): RunningTurn
  /** Parse the raw contents of a turn's outFile. Must tolerate a truncated final line. */
  parse(raw: string): ParsedTurn
}
