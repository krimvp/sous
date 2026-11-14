// What `sous status --json` and `sous wait --json` print: a run's status from the fold of its log, and why `sous wait`
// returned, with its exit codes.
import type { RunMode } from './events.ts'
import type { NodeKind } from './nodes.ts'

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
  /** The run's tokens so far and the cost its harnesses reported, absent when no turn recorded usage and the run has no
   * budget. `costUsd` sums the turns that reported a cost; `unpriced` counts those that reported none, so a partial sum is
   * not taken for the price. `maxCostUsd`: the run's budget (`--max-cost`), which bounds only `costUsd`. */
  usage?: { input: number; output: number; cached: number; costUsd?: number; unpriced: number; maxCostUsd?: number }
  /** The run stopped at its budget (`budget.reached`, or a log whose reported cost is at its budget): it is `stopped`,
   * and `resume` names a higher `--max-cost`. */
  budget?: { spentUsd: number; maxCostUsd: number }
  /** Every node, depth first: each node is followed by its subtree. */
  nodes: StatusNode[]
  waiting: StatusAsk[]
  /** The latest three person commands the supervisor did not apply, latest last. */
  refused: { at: string; reason: string }[]
  /** How to continue a stopped run: `sous resume <id>`, with `--max-cost <more>` for a run stopped at its budget. */
  resume?: string
  /** For a finished git-mode run, what the person may do next, while it still applies: `next: sous diff, then git merge
   * sous/<id>, then sous clean`. */
  next?: string
  /** When this was read. */
  at: string
}

/** Why `sous wait` returned, and its exit code. `completed`: the run completed and no top-level node completed over a
 * failed check. `failed`: the run failed, or completed with failed checks. `waiting`: something waits for the person
 * that no command sent for it answers yet (`StatusAsk.sent`). `stopped`: the run is not over and its supervisor is gone,
 * also when it stopped at its cost budget (`RunStatus.budget` says so, and `resume` how to raise it).
 * `timeout`: none of these within `--timeout`. */
export const WAIT_EXIT_CODES = { completed: 0, failed: 3, waiting: 4, stopped: 5, timeout: 6 } as const
export type WaitReason = keyof typeof WAIT_EXIT_CODES

/** `sous wait --json`: the run's status when `wait` returned, and why it returned. */
export type RunWait = RunStatus & { wait: WaitReason }
