// The lead runner's contract: what a lead asks for, and what the supervisor and the lead runner offer each other.
import type { AgentRuntime } from './agents.ts'
import type { Roles } from './nodes.ts'
import type { Usage } from './workers.ts'

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
