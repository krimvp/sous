// The state every part of the supervisor shares, as one object built once per run: the resolved options, the log and
// the state folded from it, completing and failing nodes, the stopping/closed flags, the main loop's wake-up, the live
// process groups, and where the results gather (the integration worktree, or the output folder and node folders).
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CreateLeadRunner, Event, HarnessName, WorkerAdapter } from '../contracts/index.ts'
import { agentFor } from '../definitions/index.ts'
import type { Agent, Unavailable } from '../definitions/index.ts'
import { fold, openLog } from '../run/index.ts'
import type { NodeState, RunState } from '../run/index.ts'
import { createIntegration, currentBranch, ensureRepo } from '../workspace/index.ts'
import { createProcesses } from './processes.ts'
import type { Processes } from './processes.ts'

export interface SupervisorOptions {
  workspace: string
  runDir: string
  getAdapter: (name: HarnessName) => WorkerAdapter
  /** Runs lead nodes. A run with lead nodes and no lead runner fails them. */
  createLeadRunner?: CreateLeadRunner
  onEvent?: (event: Event) => void
  /** How long a turn may keep running after its end-of-turn marker before its group is stopped,
   * and how long a stopped group gets between SIGTERM and SIGKILL. */
  graceMs?: number
  /** How long a turn's output may stop growing before `turn.stalled` warns about it; default STALL_MS. */
  stallMs?: number
  /** `sous resume`: take over a stopped supervisor's lock and recover its unfinished turns and lead deliveries. */
  resume?: boolean
  /** What was missing when the run started or resumed (`checkAgents`); default: nothing. */
  unavailable?: Unavailable
}

/** A turn whose output has not grown for this long is reported once with `turn.stalled`; it keeps running. */
const STALL_MS = 10 * 60_000
/** Sender of the integrator's and the splitter's requests. */
export const SUPERVISOR = 'supervisor'

export type EventLog = ReturnType<typeof openLog>

export interface Context {
  readonly workspace: string
  readonly runDir: string
  readonly runId: string
  readonly getAdapter: (name: HarnessName) => WorkerAdapter
  readonly unavailable: Unavailable
  readonly graceMs: number
  readonly stallMs: number
  readonly log: EventLog
  /** `<runDir>/commands/`, where `sous answer`, `sous approve`, `sous cancel` and workers' messages arrive. */
  readonly commandsDir: string
  /** Folder mode: no git; the results gather in the output folder. */
  readonly folder: boolean
  /** Set once the run stops (Ctrl-C, or the shutdown in `finally`); read it at every await point. */
  stopping: boolean
  /** Set once the run is over: later tool calls and turns of a closing runner are not recorded. */
  closed: boolean
  /** Wakes the main loop from its wait; the main loop replaces it before each wait. */
  wakeUp: () => void
  /** The live process groups of turns and checks. */
  readonly processes: Processes
  readonly current: () => RunState
  readonly nodeNow: (id: string) => NodeState
  readonly agentOf: (state: RunState, node: NodeState) => Agent | string
  readonly complete: (node: string, summary: string) => void
  readonly fail: (node: string, reason: string) => void
  readonly nodeFolder: (id: string) => string
  readonly integrationTree: () => { branch: string; path: string }
  readonly resultsDir: () => string
}

export function createContext(opts: SupervisorOptions, log: EventLog): Context {
  const { workspace, runDir, getAdapter } = opts
  const runId = basename(runDir)
  const unavailable = opts.unavailable ?? { commands: [], leadProviders: [] }
  const graceMs = opts.graceMs ?? 5000
  const stallMs = opts.stallMs ?? STALL_MS
  const commandsDir = join(runDir, 'commands')
  // Folder mode (no git): each work node writes in its own folder, collected into the output folder when it is done;
  // work and check nodes run in folders of their own with the links workspace/ and results/.
  const folder = fold(log.events).mode === 'folder'
  const output = join(runDir, 'output')
  const nodeFolder = (id: string) => join(runDir, 'work', id)
  const current = () => fold(log.events)
  const nodeNow = (id: string) => current().nodes.get(id)!
  /** The agent of a node, or why it has none: a work node keeps the agent of its earlier turns. */
  const agentOf = (state: RunState, node: NodeState): Agent | string => {
    try {
      return agentFor(state.agents, { ...node.spec, agent: node.spec.agent ?? node.turns.findLast((t) => t.agent)?.agent }, unavailable)
    } catch (err) {
      return (err as Error).message
    }
  }

  const complete = (node: string, summary: string) => void log.append({ type: 'node.completed', node, summary })
  const fail = (node: string, reason: string) => void log.append({ type: 'node.failed', node, reason })

  let integration: { branch: string; path: string } | undefined
  /** The run's integration worktree, created (or found again) before the first work or check node runs. */
  const integrationTree = () => {
    if (integration) return integration
    ensureRepo(workspace)
    const tree = createIntegration(workspace, runId, runDir)
    // Merges land on what it has checked out: on another branch, the run's branch would silently never advance.
    const on = currentBranch(tree.path)
    if (on !== tree.branch) throw new Error(`integration worktree ${tree.path} is on ${on ? `branch ${on}` : 'a detached HEAD'}, not ${tree.branch}`)
    if (tree.base) log.append({ type: 'integration.created', branch: tree.branch, path: tree.path, base: tree.base })
    return (integration = tree)
  }
  /** Where the results gather and check nodes run: the integration worktree (git mode) or the output folder (folder
   * mode), created (or found again) before the first work or check node runs. */
  const resultsDir = (): string => {
    if (!folder) return integrationTree().path
    mkdirSync(output, { recursive: true })
    return output
  }

  return {
    workspace, runDir, runId, getAdapter, unavailable, graceMs, stallMs, log, commandsDir, folder,
    stopping: false,
    closed: false,
    wakeUp: () => {},
    processes: createProcesses(graceMs),
    current, nodeNow, agentOf, complete, fail, nodeFolder, integrationTree, resultsDir,
  }
}
