// The event log: every event of a run, one line each of runs/<id>/events.jsonl.
import type { Definitions, GraphFile } from './agents.ts'
import type { ChildSpec, LeadCall, LeadRead } from './leads.ts'
import type { NodeSpec } from './nodes.ts'
import type { HarnessName, TurnResult, Usage } from './workers.ts'

/** How a run keeps its results, decided once when it is created. `git`: the workspace is in a git work tree; work nodes
 * get worktrees and are merged into branch `sous/<run>`. `folder`: no git; each work node writes in its own folder and its
 * files are collected into `<runDir>/output/`. */
export type RunMode = 'git' | 'folder'

export type EventBody =
  /** `maxDepth`: how deep leads may nest in this run (`sous run --max-depth`); absent means DEFAULT_MAX_LEAD_DEPTH.
   * `definitions`: a goal run's agents file (`sous run --agents`); a graph run's definitions are in its `graph`.
   * `approveSplits`: the person approves each split the splitter proposes before its lead receives it.
   * `mode`: decided when the run is created, so a resumed run keeps it; absent (older logs) means `git`.
   * `leadModel`: the model of lead agents that name none, chosen from the credentials present when the run was created
   * (see Agents in the design); a resumed run keeps it. Absent when no lead provider had one, or in older logs. */
  | { type: 'run.created'; goal: string; workspace: string; graph?: GraphFile; definitions?: Definitions; maxDepth?: number; approveSplits?: boolean; mode?: RunMode; leadModel?: string }
  | { type: 'node.added'; node: NodeSpec; by: string }
  /** `startTime`: the leader's start time (procStartTime in run/log.ts), so a reused pid is not mistaken for it.
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
