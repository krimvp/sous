// The lead runner's contract: what a lead asks for, and what the supervisor and the lead runner offer each other.
import type { AgentRuntime } from './agents.ts'
import type { Roles } from './nodes.ts'
import type { Usage } from './workers.ts'

/** How many children a lead may spawn over its lifetime. */
export const MAX_CHILDREN = 12

/** The most entries one `list_files` answer lists. */
export const MAX_ENTRIES = 200

/** The most bytes of a file one `read_file` answer holds; an offset reads on. */
export const MAX_READ = 32 * 1024

/** The kinds of child a lead may spawn. */
export const CHILD_KINDS = ['work', 'check', 'lead', 'gate'] as const
export type ChildKind = (typeof CHILD_KINDS)[number]

/** A child a lead asks for. Its id is unique in the run; its parent is the calling lead. */
export interface ChildSpec {
  id: string
  kind: ChildKind
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

// The rules every lead gets in its role, on either runtime: the lead runner's system prompt (src/lead/tools.ts) and the
// role of a lead on a CLI harness (HARNESS_LEAD_ROLE, src/prompts/lead.ts). Here because neither module may import the
// other, and both must say the limits the policy enforces.
export const LEAD_SPLIT_RULE = '- Split your goal into children with spawn. Give each a self-contained brief and acceptance criteria; use a check child for anything a command can verify.'
export const LEAD_RULES: readonly string[] = [
  '- Complete only when your own goal is met, not merely because every child finished. Fail when it cannot be met.',
  '- Answer your children\'s questions; escalate the ones you cannot answer.',
  `- Limits: at most ${MAX_CHILDREN} children over your lifetime; leads nest no deeper than your brief says; needs name earlier siblings only; send only to your children, your parent, or "person" if you are top-level; cancel only your children; complete and fail are refused while a child is pending or running.`,
]

/** How a lead turn on a CLI harness ends: its short answer and the calls it makes, which the supervisor applies in order
 * after the turn, through the same policy as a lead runner's tool calls (`lead.call`, call IDs `t<turn>.<index>`). */
export interface LeadResult {
  answer: string
  calls: LeadCall[]
}

const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) }) as const
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description }) as const
const call = <T extends LeadCall['tool']>(tool: T, properties: Record<string, object>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, required: ['tool', ...required], properties: { tool: { type: 'string', enum: [tool] }, ...properties } }) as const

/** JSON Schema of LeadResult: one object per LeadCall variant, the fields of the lead tools (src/lead/tools.ts).
 * Harnesses with a structured-output flag get it as is (Codex: in its strict form, see the adapter); the others are told
 * the shape. The supervisor checks every call again (`lead.call`). */
export const LEAD_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'calls'],
  properties: {
    answer: str('A short answer that ends your turn: what you did and what you wait for'),
    calls: {
      type: 'array',
      description: 'Your calls, applied in order after your turn; empty when nothing is to be done now',
      items: {
        anyOf: [
          call('spawn', {
            children: {
              type: 'array', minItems: 1, items: {
                type: 'object', additionalProperties: false, required: ['id', 'kind'],
                properties: {
                  id: str('Unique id for the child in the whole run, e.g. "api-tests"'),
                  kind: { type: 'string', enum: CHILD_KINDS },
                  brief: str('What to do, self-contained (work, lead), or what the person approves (gate)'),
                  command: str('Shell command; exit code 0 passes (check)'),
                  acceptance: strings('Criteria the result must meet'),
                  needs: strings('Ids of earlier siblings that must complete first'),
                  agent: {
                    anyOf: [
                      str('An agent your brief lists'),
                      {
                        type: 'object', additionalProperties: false, required: ['name', 'runs'],
                        properties: { name: str(), runs: str('A runtime your brief lets you define agents on'), model: str(), instructions: str() },
                      },
                    ],
                  },
                  model: str("Overrides the model of the agent the child names; only a model your brief lists for that agent's runtime"),
                  roles: { type: 'object', additionalProperties: false, properties: { splitter: str('An agent your brief lists for roles') } },
                },
              },
            },
          }, ['children']),
          call('send', { to: str('A child id, your parent, or "person" if you are a top-level lead'), body: str(), mode: { type: 'string', enum: ['queue', 'interrupt'] } }, ['to', 'body', 'mode']),
          call('note', { text: str() }, ['text']),
          call('cancel', { node: str('A child id') }, ['node']),
          call('complete', { summary: str() }, ['summary']),
          call('fail', { reason: str() }, ['reason']),
          call('escalate', { question: str() }, ['question']),
        ],
      },
    },
  },
} as const

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
