// The supervisor: the only writer of a run's state. Starts every process, runs leads through the lead runner or as
// turns of a CLI harness, routes messages and records every outcome.
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { agentFor, childAgents, defineAgent, integratorAgent, registry, roleChoices } from './agents.ts'
import type { Agent, Unavailable } from './agents.ts'
import {
  composeBrief, fixPrompt, HARNESS_LEAD_ROLE, idleReminder, inboxPrompt, INTEGRATOR_BRIEF, integratorPrompt, leadBrief, leadMessageText, leadTurnPrompt,
  mergeRequest, outcomeText, recoveryPrompt, REFUSED_CALL, resultReminder, retryPrompt, splitApproval, splitRequest, SPLITTER_BRIEF, splitterPrompt,
} from './brief.ts'
import { collect, linkedFolder, listFiles, readText } from './files.ts'
import type { Root } from './files.ts'
import {
  changedFiles, commitAll, createIntegration, createNodeWorktree, currentBranch, ensureRepo, hasChanges, head, merge, mergedOnto, mergeInProgress,
  resetTo, uncommitted, withConflictMarkers,
} from './git.ts'
import { childError } from './graph.ts'
import { openLog, procStartTime } from './log.ts'
import { MAX_SENDS, MAX_WAIT_SECONDS, sendRefusal, sendTargets, withoutIdentity } from './send.ts'
import { ancestors, awaitsSplitApproval, budgetRefusal, callKey, childrenOf, completedText, failedChecks, fold, isFinal, overBudget, roleAgent } from './state.ts'
import type { CheckState, InboxMessage, NodeState, RunState, TurnState } from './state.ts'
import { INTEGRATOR, PERSON, roleNode, SPLITTER } from './types.ts'
import type { ChildSpec, CreateLeadRunner, Event, HarnessName, LeadCall, LeadHost, LeadResult, LeadTurnSpec, NodeSpec, ParsedTurn, TurnResult, TurnSpec, WorkerAdapter } from './types.ts'

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
  /** `sous resume --max-cost`: the run's budget from here on, recorded in `run.resumed`. */
  maxCost?: number
}

/** `budget`: the run stopped at its cost budget (`budget.reached`), not over; `interrupted`: stopped otherwise. */
export type SupervisorOutcome = 'completed' | 'failed' | 'interrupted' | 'budget'

const MAX_CONCURRENT = 4
const MAX_FIX_ROUNDS = 2
const OUTPUT_TAIL = 4096
const MAX_CHILDREN = 12
const MAX_REMINDERS = 2
/** A turn whose output has not grown for this long is reported once with `turn.stalled`; it keeps running. */
const STALL_MS = 10 * 60_000
/** How much of a failed turn's stderr goes into its error: the last non-empty lines, at most this many characters. */
const STDERR_LINES = 5
const STDERR_CHARS = 600
/** Times a supervisor stop may cut a node's turn short before the node fails. */
const MAX_RECOVERIES = 3
/** How often `<runDir>/commands/` is checked for `sous answer`, `sous approve` and `sous cancel`. */
const POLL_MS = 200
/** Sender of the integrator's and the splitter's requests. */
const SUPERVISOR = 'supervisor'
/** The body of the message `sous approve <lead>` sends to a lead whose split waits for approval. */
const SPLIT_APPROVED = 'The person approved the proposed split.'

/** A command file written by `sous answer`, `sous approve` or `sous cancel`, or by a worker's `send`. */
export type PersonCommand =
  | { type: 'answer'; node: string; text: string }
  | { type: 'approve' | 'cancel'; node: string }
  | { type: 'send'; from: string; to: string; text: string }
  | { type: 'receive'; node: string; turn: number; upTo: number }

/** Why a person's answer, approval or cancel does not apply to the run as it is, if it does not: `sous answer`,
 * `approve` and `cancel` check it before they write the command file, and the supervisor again when it reads it, as the
 * run may have moved on since (or the file came from elsewhere). A standing node (the integrator, a splitter) is not
 * cancelled: the run would lose it for good. Cancelling the node it works for stops that work. */
export function commandRefusal(state: RunState, cmd: Exclude<PersonCommand, { type: 'send' | 'receive' }>): string | undefined {
  const node = typeof cmd.node === 'string' ? state.nodes.get(cmd.node) : undefined
  if (!node) return `no node ${cmd.node}`
  const { id, kind, standing } = node.spec
  if (isFinal(node)) return `node ${id} is already ${node.status}`
  if (cmd.type === 'answer') {
    if (kind === 'gate') return `node ${id} is a gate: approve it with sous approve, or reject it with sous cancel`
    if (kind === 'check') return `node ${id} is a check, which reads no messages`
    if (typeof cmd.text !== 'string' || !cmd.text.trim()) return 'the answer is empty'
  } else if (cmd.type === 'approve') {
    if (kind === 'gate' && node.status !== 'waiting') return `gate ${id} is not waiting for approval yet`
    if (kind !== 'gate' && !awaitsSplitApproval(node)) return kind === 'lead' ? `lead ${id} has no proposed split waiting for approval` : `node ${id} is not a gate or a lead`
  } else if (standing) {
    const serving = [...state.nodes.values()].filter((n) => !isFinal(n) &&
      (id === INTEGRATOR ? n.merge?.conflict : n.split?.status === 'requested' && roleNode(SPLITTER, n.split.agent) === id)).map((n) => n.spec.id)
    return `${id} serves the whole run and is not cancelled; to stop its work, cancel the node it works for${serving.length ? ` (${serving.join(', ')})` : ''}`
  }
}

/** Signal a turn's whole process group. Ignores a group that is already gone. */
function interrupt(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether a turn's process group, started by an earlier supervisor, still runs. A pid whose start time differs was
 * reused by another process; a turn recorded without a start time is never signalled. */
function turnAlive(t: TurnState): boolean {
  if (t.startTime === undefined) return false
  const now = procStartTime(t.pid)
  if (now !== undefined) return now === t.startTime
  return groupExists(t.pid) // the leader is gone: its pid is not reused while members of its group remain
}

/** SIGTERM the group, SIGKILL it after the grace, and resolve once it is gone (or shortly after SIGKILL). */
export async function stopGroup(pid: number, graceMs: number): Promise<void> {
  interrupt(pid, 'SIGTERM')
  let deadline = Date.now() + graceMs
  let killed = false
  while (groupExists(pid)) {
    if (Date.now() >= deadline) {
      if (killed) return
      interrupt(pid, 'SIGKILL')
      killed = true
      deadline = Date.now() + 2000
    }
    await sleep(20)
  }
}

/** The last non-empty lines of a turn's stderr file (only its last OUTPUT_TAIL bytes are read), or '' without any. */
function stderrTail(file: string): string {
  let text = ''
  try {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, OUTPUT_TAIL))
      readSync(fd, buf, 0, buf.length, size - buf.length)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {}
  const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-STDERR_LINES).join('\n')
  return tail.length > STDERR_CHARS ? `…${tail.slice(-STDERR_CHARS)}` : tail
}

/** A turn that exited non-zero, on its own, without its end-of-turn marker: its exit code and the end of its stderr.
 * `quiet`: it produced no output (no message or tool call), so resuming it would fail the same way. */
interface Exited {
  code: number
  stderr: string
  quiet: boolean
}

const exitedText = (turn: number, e: Exited) => `turn ${turn} exited ${e.code} with no output; ${e.stderr}`

const notesFor = (state: RunState, id: string) => ancestors(state, id).flatMap((a) => a.notes)

const depthOf = (state: RunState, id: string) => ({ at: ancestors(state, id).length + 1, max: state.maxDepth })

/** The parts in a proposal file, or why there are none. */
function readProposal(file: string): ChildSpec[] | string {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? `no proposal was written to ${file}` : `${file} is not valid JSON: ${(err as Error).message}`
  }
  const parts = (raw as { parts?: unknown })?.parts
  return Array.isArray(parts) ? parts : `${file} must hold a JSON object {"parts": [...]}`
}

/** Why lead `node` may not make `call` now, if it may not. */
function refusal(state: RunState, node: string, call: LeadCall): string | undefined {
  const lead = state.nodes.get(node)
  if (lead?.spec.kind !== 'lead') return `${node} is not a lead`
  if (isFinal(lead)) return `${node} is already ${lead.status}`
  const children = childrenOf(state, node)
  const parent = lead.spec.parent ?? PERSON
  const live = children.filter((c) => !isFinal(c)).map((c) => c.spec.id)
  const text = (value: unknown, what: string) => (typeof value === 'string' && value.trim() ? undefined : `${what} must be a non-empty string`)
  switch (call?.tool) {
    case 'spawn': {
      if (!Array.isArray(call.children) || !call.children.length) return 'spawn needs at least one child'
      if (children.length + call.children.length > MAX_CHILDREN) {
        return `a lead may have at most ${MAX_CHILDREN} children over its lifetime; ${node} has ${children.length}`
      }
      const siblings = children.map((c) => c.spec.id)
      // The run's agents with those defined by earlier children of this call, as the fold will have them.
      const agents = { ...state.agents, agents: registry(state.agents.agents) }
      for (const c of call.children) {
        const why = childError(c, (id) => state.nodes.has(id) || siblings.includes(id), siblings, agents, state.definitions)
          ?? (c.kind === 'lead' && ancestors(state, node).length + 2 > state.maxDepth ? `leads may nest at most ${state.maxDepth} deep` : undefined)
        if (why) return `child ${String(c?.id)}: ${why}`
        if (typeof c.agent === 'object') agents.agents[c.agent.name] = defineAgent(agents, c.agent)
        siblings.push(c.id)
      }
      return undefined
    }
    case 'send': {
      if (call.to !== parent && !children.some((c) => c.spec.id === call.to)) return `${node} may send only to its children or to ${parent}`
      const target = state.nodes.get(call.to)
      if (isFinal(target)) return `${call.to} is already ${target!.status}`
      if (target?.spec.kind === 'check') return `${call.to} is a check and takes no messages`
      if (target?.spec.kind === 'gate') return `${call.to} is a gate and takes no messages; the person approves it`
      if (call.mode !== 'queue' && call.mode !== 'interrupt') return 'mode must be queue or interrupt'
      return text(call.body, 'body')
    }
    case 'note':
      return text(call.text, 'text')
    case 'cancel':
      if (!live.includes(call.node)) return `${call.node} is not a running or pending child of ${node}`
      return undefined
    case 'complete':
    case 'fail':
      if (live.length) return `children still pending or running: ${live.join(', ')}`
      if (lead.inbox.length) return `messages for ${node} are waiting and will be delivered next`
      return call.tool === 'complete' ? text(call.summary, 'summary') : text(call.reason, 'reason')
    case 'escalate':
      return text(call.question, 'question')
    default:
      return `unknown tool ${String((call as { tool?: unknown })?.tool)}`
  }
}

function accepted(state: RunState, node: string, call: LeadCall, parent: string): string {
  switch (call.tool) {
    case 'spawn': return `spawned ${call.children.map((c) => c.id).join(', ')}; their outcomes will be delivered to you`
    case 'send': return `sent to ${call.to}`
    case 'note': return 'noted'
    case 'cancel': return `cancelled ${call.node} and its subtree`
    case 'complete': {
      const failed = failedChecks(state, node)
      return failed.length ? `completed with failed checks: ${failed.join(', ')}` : 'completed'
    }
    case 'fail': return 'failed'
    case 'escalate': return `asked ${parent}; the answer will be delivered to you`
  }
}

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorOutcome> {
  const { workspace, runDir, getAdapter } = opts
  const runId = basename(runDir)
  const unavailable = opts.unavailable ?? { commands: [], leadProviders: [] }
  const graceMs = opts.graceMs ?? 5000
  const stallMs = opts.stallMs ?? STALL_MS
  const log = openLog(runDir, opts.onEvent, { takeOver: opts.resume })
  if (opts.resume) {
    const state = fold(log.events)
    if (state.status !== 'running') {
      log.close()
      throw new Error(`the run already ${state.status}; a finished run is not resumed`)
    }
    // A run stopped at its budget continues only with a higher one (checked by `sous resume` too).
    const limit = opts.maxCost ?? state.maxCost
    if (limit !== undefined && state.spent.costUsd >= limit) {
      log.close()
      throw new Error(budgetRefusal(runId, state.spent.costUsd, limit))
    }
    log.append({ type: 'run.resumed', ...(opts.maxCost !== undefined ? { maxCost: opts.maxCost } : {}) })
  }
  const commandsDir = join(runDir, 'commands')
  mkdirSync(commandsDir, { recursive: true })
  // Folder mode (no git): each work node writes in its own folder, collected into the output folder when it is done;
  // work and check nodes run in folders of their own with the links workspace/ and results/.
  const folder = fold(log.events).mode === 'folder'
  const output = join(runDir, 'output')
  const nodeFolder = (id: string) => join(runDir, 'work', id)
  let closed = false
  const inFlight = new Map<string, { spec: NodeSpec; done: Promise<void> }>()
  // Live process groups, so a stop request can reach them; `turn` is absent for shell checks.
  const groups = new Map<number, { node: string; turn?: number }>()
  // Acceptance checks stopped because their worker got an urgent message, with the reason.
  const interruptedChecks = new Map<number, string>()
  let stopping = false
  // Every group the supervisor stops is awaited until it is gone, so no process outlives its turn or check.
  const terminations = new Map<number, Promise<void>>()
  const terminate = (pid: number) => {
    let done = terminations.get(pid)
    if (!done) {
      done = stopGroup(pid, graceMs).finally(() => terminations.delete(pid))
      terminations.set(pid, done)
    }
    return done
  }
  let wakeUp = () => {}
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

  // Set when the cost reported reached the run's budget: the run stops as on a supervisor stop.
  let budgetStop = false
  const stop = (reason = 'supervisor stopped') => {
    if (stopping) return
    stopping = true
    // Every group is stopped whatever the log does: it may be what failed (a full disk, a throwing onEvent), and then
    // the interruptions go unrecorded.
    let recording = true
    for (const [pid, g] of groups) {
      void terminate(pid)
      if (g.turn === undefined || !recording) continue
      try {
        log.append({ type: 'turn.interrupted', node: g.node, turn: g.turn, reason, signal: 'SIGTERM' })
      } catch {
        recording = false
      }
    }
  }
  /** Once the cost the run's turns reported reaches its budget: record it and stop, so no new turn starts and the running
   * ones are stopped as on Ctrl-C (their sessions resume). Called whenever a turn's cost is recorded (a worker's
   * `turn.ended`, a lead's `lead.turn`) and on every pass of the loop. A cost is known only when a turn ends, so the
   * turns in flight may spend past the budget; turns that report no cost are not counted. */
  const checkBudget = () => {
    if (stopping) return
    const state = current()
    if (!overBudget(state)) return
    log.append({ type: 'budget.reached', spentUsd: state.spent.costUsd, maxCostUsd: state.maxCost! })
    budgetStop = true
    stop('the run reached its cost budget')
  }

  /** Ctrl-C (or SIGTERM) stops the run; a second one while it stops kills every group still being stopped. */
  const onSignal = () => {
    if (!stopping) return stop()
    for (const pid of new Set([...groups.keys(), ...terminations.keys()])) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {} // gone already, or not ours any more
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

  // ---- Leads ----------------------------------------------------------------------------------

  const host: LeadHost = {
    act(node, callId, call) {
      if (closed) return 'refused: the run is over'
      const state = current()
      const recorded = state.calls.get(callKey(node, callId))
      if (recorded !== undefined) return recorded
      const why = refusal(state, node, call)
      const result = why ? `refused: ${why}` : accepted(state, node, call, state.nodes.get(node)!.spec.parent ?? PERSON)
      log.append({ type: 'lead.call', node, callId, call, ok: !why, result })
      wakeUp()
      return result
    },
    read(node, callId, call) {
      if (closed) return 'refused: the run is over'
      let text: string
      let bytes = 0
      let refused: string | undefined
      try {
        const roots: Root[] = folder ? [{ name: 'workspace', path: workspace }, { name: 'results', path: resultsDir() }] : [{ path: resultsDir() }]
        if (call.tool === 'list_files') bytes = Buffer.byteLength(text = listFiles(roots, call.path))
        else if (call.tool === 'read_file') ({ text, bytes } = readText(roots, call.path, call.offset ?? 0))
        else throw new Error(`unknown tool ${String((call as { tool?: unknown })?.tool)}`)
      } catch (err) {
        refused = (err as Error).message
        text = `refused: ${refused}`
      }
      const { tool, path } = call
      const offset = call.tool === 'read_file' ? call.offset : undefined
      log.append({ type: 'lead.read', node, callId, tool, ...(path !== undefined ? { path } : {}), ...(offset ? { offset } : {}), bytes, ...(refused ? { refused } : {}) })
      return text
    },
    settled(node, turn) {
      const { requestId, status, text, model, usage } = turn
      // After a crash the runner may report a delivery a second time; the first report stands.
      if (closed || log.events.some((e) => e.type === 'lead.turn' && e.node === node && e.requestId === requestId)) return
      log.append({ type: 'lead.turn', node, requestId, status, text, model, ...(usage ? { usage } : {}) })
      checkBudget()
      wakeUp()
    },
  }
  const runner = opts.createLeadRunner?.({ runDir, host })
  const runnerCancelled = new Set<string>()

  // Leads failed with their lead (abandoned), stopped through the runner like cancelled ones.
  const abandoned = new Set<string>()
  /** A lead that cannot go on: fail it and everything below it that has not finished. */
  const abandon = (state: RunState, lead: string, reason: string) => {
    fail(lead, reason)
    for (const n of state.nodes.values()) {
      if (isFinal(n) || !ancestors(state, n.spec.id).some((a) => a.spec.id === lead)) continue
      if (n.spec.kind === 'lead') abandoned.add(n.spec.id)
      fail(n.spec.id, `lead ${lead} failed`)
    }
  }

  const deliver = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt', carries: string[] = []) => {
    log.append({ type: 'lead.delivered', node: lead.spec.id, requestId, text, mode, ...(carries.length ? { carries } : {}) })
    send(lead, agent, requestId, text, mode)
  }
  /** Hand a recorded delivery to the runner; a repeated requestId is ignored there. A lead on a CLI harness gets it in its
   * next turn (`driveLead`); an urgent one stops its running turn first (the main loop, as for a worker). */
  const send = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt') => {
    if (agent.runs !== 'lead') return wakeUp()
    const node = lead.spec.id
    runner!.deliver(node, text, { requestId, mode, model: agent.model }).catch((err) => {
      if (closed || isFinal(nodeNow(node))) return
      abandon(current(), node, `lead runner: ${(err as Error).message}`)
      wakeUp()
    })
  }

  /** Brief, messages, child outcomes and idle reminders for one lead. */
  const routeLead = (state: RunState, lead: NodeState) => {
    const id = lead.spec.id
    if (isFinal(lead) || lead.status === 'pending') return
    const agent = agentOf(state, lead)
    if (typeof agent === 'string') return abandon(state, id, agent)
    const onHarness = agent.runs !== 'lead'
    if (!onHarness && !runner) return fail(id, 'no lead runner is configured')
    if (!lead.delivered.length) {
      // With a splitter, the brief waits for its proposal, and with --approve-splits for the person's answer to it.
      const splitter = roleAgent(state, id, SPLITTER)
      if (splitter !== undefined) {
        const { split } = lead
        if (!split) return void log.append({ type: 'split.requested', node: id, agent: splitter })
        if (split.status === 'requested') return
        const answered = lead.inbox.some((m) => m.from === PERSON && m.seq > split.endSeq!)
        if (state.approveSplits && split.status === 'proposed' && !answered) {
          if (lead.status !== 'waiting') log.append({ type: 'message', from: id, to: PERSON, body: splitApproval(id, split.parts!, split.summary!), mode: 'queue' })
          return
        }
      }
      const roles = { splitter, choices: roleChoices(state.definitions, unavailable) }
      const brief = leadBrief(state.goal, lead.spec, notesFor(state, id), childAgents(state.agents, unavailable), depthOf(state, id), agent.instructions, lead.split, roles, state.mode, onHarness)
      return deliver(lead, agent, `${id}:brief`, brief, 'queue')
    }
    const children = childrenOf(state, id)
    // `info`: a worker's `send` (to this lead, or a copy of one to a sibling), which needs no answer.
    const items = lead.inbox.map((m) => ({
      seq: m.seq, mode: m.mode, info: m.sent === true, text: leadMessageText(m, state.nodes.get(m.from)?.spec.parent === id),
    }))
    for (const c of children) {
      if (isFinal(c) && c.cancelledBy !== id) items.push({ seq: c.endSeq!, mode: 'queue', info: false, text: outcomeText(c) })
    }
    // A lead on a harness learns its calls' results in its next turn; a refused call needs that turn now.
    const refused = onHarness ? refusedCall(id) : undefined
    if (refused !== undefined) items.push({ seq: refused, mode: 'queue', info: false, text: REFUSED_CALL })
    const taken = (seq: number) => lead.delivered.includes(`evt-${seq}`) || lead.carried.includes(`evt-${seq}`)
    const fresh = items.filter((i) => !taken(i.seq)).sort((a, b) => a.seq - b.seq)
    // A waiting child with messages is about to resume, and one whose open question is to the person (a gate, a lead
    // whose split awaits approval) waits for them, not for this lead, so both still count as working.
    const asksPerson = (c: NodeState) => state.questions.some((q) => q.from === c.spec.id)
    const waiting = children.filter((c) => c.status === 'waiting' && !c.inbox.length && !asksPerson(c)).map((c) => c.spec.id)
    const working = children.some((c) => !isFinal(c) && !waiting.includes(c.spec.id))
    // Everything waiting goes in one delivery, in order: at once when urgent; else once the lead has answered what it
    // has, and only for an item that needs it or when no child is working (nothing else would come), so a message
    // that needs no answer rides along with the next one that does instead of being a lead turn of its own.
    if (fresh.length) {
      const urgent = fresh.some((i) => i.mode === 'interrupt')
      if (!urgent && !(lead.idle && (!working || fresh.some((i) => !i.info)))) return
      const ids = fresh.map((i) => `evt-${i.seq}`)
      return deliver(lead, agent, ids.at(-1)!, fresh.map((i) => i.text).join('\n\n'), urgent ? 'interrupt' : 'queue', ids.slice(0, -1))
    }
    if (!lead.idle || lead.escalated || working) return
    // Where an idle lead would be reminded, one whose last delivery the runner could not get answered (a model error,
    // an expired login) gets one retry instead; then it fails with the reason. A working child's outcome gives it a
    // fresh delivery first.
    if (lead.unanswered) {
      if (lead.unanswered.retried) return abandon(state, id, `unanswered after a retry: ${lead.unanswered.reason}`)
      return deliver(lead, agent, `evt-${lead.lastTurn}`, retryPrompt(lead.unanswered.reason), 'queue')
    }
    if (lead.reminders >= MAX_REMINDERS) return abandon(state, id, `idle after ${MAX_REMINDERS} reminders`)
    deliver(lead, agent, `evt-${lead.lastTurn}`, idleReminder(id, lead.reminders + 1, MAX_REMINDERS, waiting), 'queue')
  }

  // ---- Leads on a CLI harness -------------------------------------------------------------------
  // A lead whose agent runs a lead-certified harness runs as turns of that harness, one per delivery (or per coalesced
  // delivery), each ending with a LeadResult. Its calls are applied after `turn.ended`, in order, through `host.act`
  // with call IDs `t<turn>.<index>`, so a recorded call is never applied twice; the first refused call stops the rest.
  // Only an uninterrupted turn's recorded result has effects: a turn stopped or cut short applied nothing.

  const leadCallId = (turn: number, index: number) => `t${turn}.${index}`
  /** The last turn of a lead on a harness whose calls count: it ended with a lead result and was not interrupted. */
  const appliedTurn = (lead: NodeState) => lead.turns.findLast((t) => t.lead && !t.interrupted)
  const startSeq = (node: string, turn: number) => log.events.find((e) => e.type === 'turn.started' && e.node === node && e.turn === turn)!.seq

  /** The results of the calls of lead `id`'s last applied turn, and the calls not applied after a refused one. */
  const callResults = (state: RunState, id: string) => {
    const t = appliedTurn(state.nodes.get(id)!)
    const results: { call: LeadCall; result: string }[] = []
    for (const [i, call] of (t?.lead!.calls ?? []).entries()) {
      const result = state.calls.get(callKey(id, leadCallId(t!.number, i)))
      if (result === undefined) return { results, skipped: t!.lead!.calls.slice(i) }
      results.push({ call, result })
    }
    return { results, skipped: [] }
  }

  /** The seq of the refused call of lead `id`'s last applied turn, if one was refused: it needs a turn of its own. */
  const refusedCall = (id: string): number | undefined => {
    const t = appliedTurn(nodeNow(id))
    if (!t) return undefined
    return log.events.find((e) => e.type === 'lead.call' && e.node === id && !e.ok && e.callId.startsWith(`t${t.number}.`))?.seq
  }

  /** Apply the calls of turn `t`, then settle the deliveries its prompt carried (`covered`), whose answer it was. */
  const settleLead = (id: string, t: TurnState, agent: Agent, covered: string[]) => {
    const { answer, calls } = t.lead!
    for (const [i, call] of calls.entries()) {
      if (host.act(id, leadCallId(t.number, i), call).startsWith('refused:')) break
    }
    for (const requestId of covered) host.settled(id, { requestId, status: 'done', text: answer, model: agent.model ?? `${agent.runs} default` })
    // Two turns in a row whose first call was refused applied nothing: the lead is stuck.
    const state = current()
    const lead = state.nodes.get(id)!
    const firstRefused = (turn: TurnState) => turn.lead!.calls.length > 0 && state.calls.get(callKey(id, leadCallId(turn.number, 0)))?.startsWith('refused:')
    const acted = lead.turns.filter((turn) => turn.lead && !turn.interrupted && turn.lead.calls.length)
    if (!isFinal(lead) && acted.length >= 2 && acted.slice(-2).every(firstRefused) && acted.at(-1)!.number === t.number) {
      abandon(state, id, 'two turns in a row had their first call refused')
    }
  }

  /** Turns of lead `id` on its harness while deliveries wait for an answer: a recorded result is settled first (a turn
   * that ended while the supervisor was down, or a stop between two of its calls), then each turn carries the results of
   * the last turn's calls and every delivery not yet answered. A turn cut short (interrupted, stopped, or without a
   * result) applied nothing, and the next one says so; a second turn without a result, or one that exits with no
   * output, fails the lead. */
  const driveLead = async (id: string) => {
    let missed = 0
    let first = true
    for (;;) {
      if (stopping) return
      const state = current()
      const lead = state.nodes.get(id)!
      if (isFinal(lead)) return
      const agent = agentOf(state, lead)
      if (typeof agent === 'string') return abandon(state, id, agent)
      const answered = new Set(log.events.flatMap((e) => (e.type === 'lead.turn' && e.node === id ? [e.requestId] : [])))
      const pending = log.events.flatMap((e) => (e.type === 'lead.delivered' && e.node === id && !answered.has(e.requestId) ? [e] : []))
      const last = lead.turns.at(-1)
      const applied = appliedTurn(lead)
      if (applied && applied === last) {
        const since = startSeq(id, applied.number)
        const covered = pending.filter((d) => d.seq < since).map((d) => d.requestId)
        if (covered.length) {
          settleLead(id, applied, agent, covered)
          wakeUp()
          continue
        }
      }
      if (!pending.length) return
      const cut = last && last !== applied ? last.number : undefined
      const recovery = first && cut !== undefined
      first = false
      if (recovery && lead.turns.filter((t) => t.recovery).length >= MAX_RECOVERIES) {
        return abandon(state, id, `a supervisor stop cut its turn short after ${MAX_RECOVERIES} recoveries`)
      }
      const { results, skipped } = callResults(state, id)
      const prompt = leadTurnPrompt(pending.map((d) => d.text), results, skipped, cut)
      const out = resultsDir()
      const cwd = folder ? linkedFolder(nodeFolder(id), workspace, out) : out
      const sessionId = lead.turns.findLast((t) => t.sessionId)?.sessionId
      const number = lead.turns.length + 1
      const t = await runTurn(lead.spec, agent, number, prompt, cwd, sessionId, recovery,
        { system: HARNESS_LEAD_ROLE, ...(folder ? { readable: [workspace, out] } : {}) })
      if (stopping || isFinal(nodeNow(id))) return
      if (t.exited?.quiet) return abandon(current(), id, exitedText(number, t.exited))
      if (t.lead || nodeNow(id).turns.find((x) => x.number === number)?.interrupted) continue
      if (++missed === 2) return abandon(current(), id, `turn ${number} ended without a lead result, as did the one before${t.exited ? `; ${t.exited.stderr}` : ''}`)
    }
  }

  // ---- Person commands ------------------------------------------------------------------------

  // A command's effect is appended with the command file's name before the file is removed, so a crash in between
  // neither loses the command nor applies it twice.
  const readCommands = () => {
    for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(commandsDir, file)
      if (!log.events.some((e) => 'command' in e && e.command === file)) apply(path, file)
      rmSync(path, { force: true })
    }
  }
  const apply = (path: string, command: string) => {
    let cmd: PersonCommand | undefined
    try {
      cmd = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
    if (cmd?.type === 'send') {
      // Checked again now: the run may have moved on since the worker sent it. A refusal reaches the sender instead.
      const why = sendRefusal(current(), cmd.from, cmd.to, cmd.text)
      if (!why) return void log.append({ type: 'message', from: cmd.from, to: cmd.to, body: cmd.text, mode: 'queue', command, sent: true })
      // A sender waiting to merge is not told: the message would take it out of the merge queue.
      const sender = current().nodes.get(cmd.from)
      if (sender?.spec.kind === 'work' && !isFinal(sender) && sender.status !== 'merging') {
        log.append({ type: 'message', from: SUPERVISOR, to: cmd.from, body: `Your message to ${cmd.to} was not delivered: ${why}`, mode: 'queue', command })
      }
      return
    }
    if (cmd?.type === 'receive') {
      const n = current().nodes.get(cmd.node)
      // Only the node's current turn reads: a process left over from an earlier turn takes nothing.
      if (n?.spec.kind === 'work' && !n.spec.standing && !isFinal(n) && Number.isInteger(cmd.upTo) && n.turns.at(-1)?.number === cmd.turn) {
        log.append({ type: 'inbox.read', node: cmd.node, turn: cmd.turn, upTo: cmd.upTo, command })
      }
      return
    }
    // A command that does not apply is recorded, so the person sees it was not delivered.
    if (cmd?.type !== 'answer' && cmd?.type !== 'approve' && cmd?.type !== 'cancel') {
      return void log.append({ type: 'command.refused', command, reason: `${command} is not a valid command` })
    }
    const why = commandRefusal(current(), cmd)
    if (why) return void log.append({ type: 'command.refused', command, reason: `sous ${cmd.type} ${cmd.node}: ${why}` })
    if (cmd.type === 'answer') {
      log.append({ type: 'message', from: PERSON, to: cmd.node, body: cmd.text, mode: 'queue', command })
    } else if (cmd.type === 'approve' && current().nodes.get(cmd.node)!.spec.kind === 'gate') {
      log.append({ type: 'node.completed', node: cmd.node, summary: 'approved by person', command })
    } else if (cmd.type === 'approve') {
      log.append({ type: 'message', from: PERSON, to: cmd.node, body: SPLIT_APPROVED, mode: 'queue', command })
    } else {
      log.append({ type: 'node.cancelled', node: cmd.node, by: PERSON, command })
    }
  }

  // ---- Workers and checks ---------------------------------------------------------------------

  /** Run a shell command in its own process group; returns its exit code and the tail of its output. The command's
   * exit ends the check: what it left running in its group is stopped, and the pipes are read until they close
   * (or, held open by a process that escaped the group, until the grace is over). */
  const runCommand = (node: string, command: string, cwd: string) =>
    new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: withoutIdentity() })
      let tail = Buffer.alloc(0)
      const keep = (chunk: Buffer) => {
        tail = Buffer.concat([tail, chunk])
        if (tail.length > OUTPUT_TAIL) tail = tail.subarray(tail.length - OUTPUT_TAIL)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      if (child.pid) groups.set(child.pid, { node })
      const closed = new Promise<void>((done) => child.on('close', () => done()))
      let finished = false
      const finish = async (exitCode: number | null) => {
        if (finished) return
        finished = true
        if (child.pid) {
          groups.delete(child.pid)
          await terminate(child.pid) // background processes the command left behind
        }
        let grace: NodeJS.Timeout | undefined
        await Promise.race([closed, new Promise<void>((done) => (grace = setTimeout(done, graceMs)))])
        clearTimeout(grace)
        child.stdout.destroy()
        child.stderr.destroy()
        let output = tail.toString('utf8')
        if (child.pid) {
          const why = interruptedChecks.get(child.pid)
          interruptedChecks.delete(child.pid)
          if (why) output += `${output && !output.endsWith('\n') ? '\n' : ''}interrupted: ${why}\n`
        }
        resolve({ exitCode, output })
      }
      child.on('error', (err) => {
        keep(Buffer.from(String(err)))
        finish(null)
      })
      child.on('exit', (code) => finish(code))
    })

  const check = async (node: string, command: string, cwd: string) => {
    const r = await runCommand(node, command, cwd)
    if (!stopping) log.append({ type: 'check.ended', node, command, ...r })
    return r
  }

  const runTurn = async (spec: NodeSpec, agent: Agent, turn: number, prompt: string, cwd: string, sessionId?: string, recovery = false, lead?: LeadTurnSpec) => {
    const adapter = getAdapter(agent.runs as HarnessName)
    if (lead && !adapter.lead) throw new Error(`${adapter.name} has no lead mode`)
    const dir = join(runDir, 'nodes', spec.id)
    mkdirSync(dir, { recursive: true })
    const turnSpec: TurnSpec = {
      nodeId: spec.id, turn, cwd, prompt,
      outFile: join(dir, `turn-${turn}.jsonl`), errFile: join(dir, `turn-${turn}.err`),
      model: agent.model, sessionId,
      // A worker of the tree may message others while it works (`sous send`, or sous's MCP tool); a lead acts only
      // through its result.
      ...(lead ? { lead } : spec.standing ? {} : { env: { SOUS_RUN_DIR: resolve(runDir), SOUS_NODE: spec.id, SOUS_TURN: String(turn) } }),
    }
    const mode = sessionId ? 'resume' : 'start'
    const running = sessionId ? adapter.resume({ ...turnSpec, sessionId }) : adapter.start(turnSpec)
    const { pid } = running
    log.append({
      type: 'turn.started', node: spec.id, turn, mode, harness: adapter.name, agent: agent.name, ...(agent.model !== undefined ? { model: agent.model } : {}),
      pid, startTime: procStartTime(pid),
      outFile: turnSpec.outFile, errFile: turnSpec.errFile, prompt, ...(recovery ? { recovery } : {}),
    })
    groups.set(pid, { node: spec.id, turn })
    let ended = false
    let session: string | undefined
    const recordSession = (id: string) => {
      if (ended || session === id) return
      session = id
      log.append({ type: 'turn.session', node: spec.id, turn, sessionId: id })
    }
    running.sessionId.then(recordSession, () => {})

    // A harness may keep running after its end-of-turn marker (spike: Claude with a background
    // command). Watch the output and stop the group once the turn has ended and the grace is over.
    // Output that stops growing for stallMs is reported once (`turn.stalled`); the turn keeps running.
    let size = 0
    let grewAt = Date.now()
    let stalled = false
    let grace: NodeJS.Timeout | undefined
    const watch = setInterval(() => {
      try {
        const now = statSync(turnSpec.outFile).size
        if (now === size) {
          if (!stalled && !ended && !stopping && Date.now() - grewAt >= stallMs) {
            stalled = true
            log.append({ type: 'turn.stalled', node: spec.id, turn, since: new Date(grewAt).toISOString() })
          }
          return
        }
        size = now
        grewAt = Date.now()
        if (adapter.parse(readFileSync(turnSpec.outFile, 'utf8')).ended) {
          clearInterval(watch)
          grace = setTimeout(() => void terminate(pid), graceMs)
        }
      } catch {}
    }, Math.min(1000, graceMs, stallMs))

    const exit = await running.exit
    ended = true
    clearInterval(watch)
    clearTimeout(grace)
    groups.delete(pid)
    await terminate(pid) // the leader is gone; stop anything it left running in its group

    let result: TurnResult | undefined
    let leadResult: LeadResult | undefined
    let error: string | undefined
    let usage
    let parsed: ParsedTurn | undefined
    try {
      parsed = adapter.parse(readFileSync(turnSpec.outFile, 'utf8'))
      if (parsed.sessionId && !session) {
        session = parsed.sessionId
        log.append({ type: 'turn.session', node: spec.id, turn, sessionId: session })
      }
      // A lead turn ends with a lead result, any other turn with a worker's.
      if (lead) leadResult = parsed.lead
      else result = parsed.result
      usage = parsed.usage
      if (!parsed.ended) error = 'no end-of-turn marker in the output'
      else if (!result && !leadResult) error = lead ? 'no parsable lead result' : 'no parsable structured result'
    } catch (err) {
      error = `cannot read turn output: ${(err as Error).message}`
    }
    // A harness that exits non-zero before its end-of-turn marker, on its own, says why on stderr (a logged-out CLI, a
    // refused option); with no output at all, another turn would fail the same way.
    let exited: Exited | undefined
    const interrupted = nodeNow(spec.id).turns.find((t) => t.number === turn)?.interrupted
    if (!parsed?.ended && exit.code && !interrupted) {
      const tail = stderrTail(turnSpec.errFile)
      const stderr = tail ? `stderr: ${tail} (${turnSpec.errFile})` : `nothing on stderr (${turnSpec.errFile})`
      exited = { code: exit.code, stderr, quiet: !parsed?.items.length }
      error = `${error}; ${stderr}`
    }
    log.append({ type: 'turn.ended', node: spec.id, turn, exitCode: exit.code, signal: exit.signal, result, ...(leadResult ? { lead: leadResult } : {}), usage, error })
    // Before the caller can start another turn of this node.
    checkBudget()
    return { result, lead: leadResult, sessionId: session, exited }
  }

  /** A worker's question (its `needs_input` or `blocked` result) goes to its parent. */
  const ask = (spec: NodeSpec, result: TurnResult) =>
    log.append({ type: 'message', from: spec.id, to: spec.parent ?? PERSON, body: result.question ?? result.summary, mode: 'queue' })

  /** Turns of a work node, in its own worktree or folder, until it is queued for merging, fails, or waits for a message.
   * Messages that arrive meanwhile are delivered by resuming the session; a `done` counts only with an empty inbox.
   * A node still `running` after a restart continues from its last turn: a `done` is checked, and a turn
   * without a result is resumed with a recovery note (or started again from the brief without a session). */
  const runWork = async (spec: NodeSpec) => {
    const state = current()
    const node = state.nodes.get(spec.id)!
    // A recorded result settles without the agent; only a new turn needs it to be available.
    const agent = agentOf(state, node)
    let sessionId = node.turns.findLast((t) => t.sessionId)?.sessionId
    const instructions = typeof agent === 'string' ? undefined : agent.instructions
    let cwd = nodeFolder(spec.id)
    let branch: string | undefined
    if (folder) linkedFolder(cwd, workspace, resultsDir())
    else {
      const tree = createNodeWorktree(workspace, runId, runDir, spec.id, head(integrationTree().path))
      if (tree.base) log.append({ type: 'worktree.created', node: spec.id, branch: tree.branch, path: tree.path, base: tree.base })
      ;({ path: cwd, branch } = tree)
    }
    const folders = folder ? { workspace, output: resultsDir() } : undefined
    const contacts = spec.standing ? undefined : { ...sendTargets(state, spec.id), max: MAX_SENDS, maxWait: MAX_WAIT_SECONDS }
    const brief = () => composeBrief(state.goal, spec, cwd, notesFor(state, spec.id), node.inbox, instructions, contacts, folders, branch)
    let prompt = node.turns.length ? inboxPrompt(node.inbox) : brief()
    let recovery = false
    let recorded: { result?: TurnResult; sessionId?: string; check?: CheckState } | undefined
    const last = node.turns.at(-1)
    if (node.status === 'running' && last) {
      if (last.result) recorded = { result: last.result, sessionId, check: last.check }
      else {
        const recoveries = node.turns.filter((t) => t.recovery).length
        if (recoveries >= MAX_RECOVERIES) return fail(spec.id, `a supervisor stop cut its turn short after ${MAX_RECOVERIES} recoveries`)
        recovery = true
        prompt = sessionId ? recoveryPrompt(node.inbox) : brief()
      }
    }
    let fixRounds = 0
    let reminded = false
    for (;;) {
      const turn = nodeNow(spec.id).turns.length + (recorded ? 0 : 1)
      let t: { result?: TurnResult; sessionId?: string; check?: CheckState; exited?: Exited }
      if (recorded) t = recorded
      else if (typeof agent === 'string') return fail(spec.id, agent)
      else t = await runTurn(spec, agent, turn, prompt, cwd, sessionId, recovery)
      // Messages the worker read during the turn must not resume it: take its last commands before looking at its inbox.
      if (!stopping) readCommands()
      recorded = undefined
      recovery = false
      if (stopping || isFinal(nodeNow(spec.id))) return
      sessionId = t.sessionId ?? sessionId
      if (t.exited?.quiet) return fail(spec.id, exitedText(turn, t.exited))
      if (t.result && t.result.status !== 'done') ask(spec, t.result)
      let inbox = nodeNow(spec.id).inbox
      if (inbox.length || t.result?.status !== 'done') {
        if (!sessionId) return fail(spec.id, `turn ${turn} cannot be resumed: the session is unknown`)
        if (inbox.length) {
          prompt = inboxPrompt(inbox)
          continue
        }
      }
      if (!t.result) {
        if (reminded) return fail(spec.id, `turn ${turn} ended without a structured result${t.exited ? `; ${t.exited.stderr}` : ''}`)
        reminded = true
        prompt = resultReminder()
        continue
      }
      if (t.result.status !== 'done') return // waits for a message to resume it
      if (spec.command) {
        const c = t.check ?? await check(spec.id, spec.command, cwd)
        if (stopping || isFinal(nodeNow(spec.id))) return
        // Messages that arrived during the check come first (an urgent one stopped the check); no fix round is spent.
        inbox = nodeNow(spec.id).inbox
        if (inbox.length) {
          prompt = inboxPrompt(inbox)
          continue
        }
        if (c.exitCode !== 0) {
          if (fixRounds === MAX_FIX_ROUNDS) {
            return fail(spec.id, `acceptance check still fails after ${MAX_FIX_ROUNDS} fix rounds (exit ${c.exitCode})`)
          }
          fixRounds++
          prompt = fixPrompt(spec.command, c.exitCode, c.output)
          continue
        }
      }
      if (folder) return void log.append({ type: 'merge.queued', node: spec.id })
      // The worker must leave its worktree on its branch: what is committed elsewhere would never be merged.
      const on = currentBranch(cwd)
      if (on !== branch) {
        return fail(spec.id, `the worker left branch ${branch}: its worktree ${cwd} is on ${on ? `branch ${on}` : 'a detached HEAD'}, so its work is not committed or merged`)
      }
      commitAll(cwd, `${spec.id}: ${t.result.summary}`)
      return void log.append({ type: 'merge.queued', node: spec.id, branch })
    }
  }

  const runCheckNode = async (spec: NodeSpec) => {
    // After a restart, a check whose outcome was recorded settles from it (a check node runs its command once).
    // Folder mode: a check runs in its own folder, where workspace/ and results/ are links, as they are for workers.
    const cwd = () => (folder ? linkedFolder(nodeFolder(spec.id), workspace, resultsDir()) : resultsDir())
    const c = nodeNow(spec.id).checks.at(-1) ?? await check(spec.id, spec.command!, cwd())
    if (stopping || isFinal(nodeNow(spec.id))) return
    if (c.exitCode === 0) complete(spec.id, 'check passed')
    else fail(spec.id, `check exited ${c.exitCode}`)
  }

  // ---- Merging --------------------------------------------------------------------------------

  /** Drop the node's merge from the integration branch and fail the node; its parent hears of it. */
  const mergeFailed = (id: string, reason: string, onto?: string) => {
    if (onto) resetTo(integrationTree().path, onto)
    log.append({ type: 'merge.failed', node: id, reason })
  }

  /** Folder mode: add a finished node's files to the output folder. Collecting again after a crash changes nothing.
   * Messages that arrived while it waited come first, as in git mode: it leaves the queue and its worker resumes. */
  const collectFiles = (n: NodeState) => {
    const { spec } = n
    if (n.inbox.length) return void log.append({ type: 'merge.withdrawn', node: spec.id })
    try {
      const { files, renamed } = collect(nodeFolder(spec.id), resultsDir(), spec.id, runDir)
      log.append({ type: 'merge.done', node: spec.id, by: files.length ? 'supervisor' : 'nothing', files, ...(Object.keys(renamed).length ? { renamed } : {}) })
    } catch (err) {
      if (!stopping && !isFinal(nodeNow(spec.id))) log.append({ type: 'merge.failed', node: spec.id, reason: `supervisor error: ${(err as Error).message}` })
    }
  }

  /** Merge (or, in folder mode, collect) the first node of the queue into the results: one at a time, in queue order. */
  const mergeNext = async () => {
    const n = [...current().nodes.values()].filter((n) => n.status === 'merging').sort((a, b) => a.merge!.queued - b.merge!.queued)[0]
    if (!n) return
    const { spec } = n
    if (folder) return collectFiles(n)
    const { conflict } = n.merge!
    const branch = n.merge!.branch!
    let onto = conflict?.onto
    try {
      const { path } = integrationTree()
      if (conflict) return await integrate(spec, conflict.onto)
      // A clean tree at its head: a merge a stopped supervisor left in progress never reached the integrator, so it
      // starts again, and what the last check run here left behind (changed or new files) would refuse this merge.
      let commit = head(path)
      resetTo(path, commit)
      onto = mergedOnto(path, branch) // the merge finished before the stop
      // Messages that arrived while it waited come first: it leaves the queue and its worker resumes with them.
      if (onto === undefined && n.inbox.length) return void log.append({ type: 'merge.withdrawn', node: spec.id })
      if (onto === undefined) {
        if (!hasChanges(path, branch)) return void log.append({ type: 'merge.done', node: spec.id, commit, by: 'nothing', files: [] })
        onto = commit
        const r = merge(path, branch, `sous: merge ${spec.id}`)
        if (!r.ok) {
          log.append({ type: 'merge.conflict', node: spec.id, reason: `conflict in ${r.files.join(', ')}`, files: r.files, onto })
          return await integrate(spec, onto)
        }
        commit = r.commit
      }
      if (spec.command) {
        const c = await check(spec.id, spec.command, path)
        if (stopping) return
        // Cancelled meanwhile: its merge leaves the integration branch, as when the integrator works on it.
        if (isFinal(nodeNow(spec.id))) return resetTo(path, onto)
        resetTo(path, commit) // what the check left behind is not part of the merge
        if (c.exitCode !== 0) {
          log.append({ type: 'merge.conflict', node: spec.id, reason: `check failed after the merge (exit ${c.exitCode})`, files: [], onto })
          return await integrate(spec, onto)
        }
      }
      log.append({ type: 'merge.done', node: spec.id, commit, by: 'supervisor', files: changedFiles(path, onto, branch) })
    } catch (err) {
      if (stopping) return
      if (isFinal(nodeNow(spec.id))) {
        // Cancelled meanwhile: what of its merge reached the integration branch leaves it, as on the paths above.
        try {
          if (onto) resetTo(integrationTree().path, onto)
        } catch {}
        return
      }
      try {
        mergeFailed(spec.id, `supervisor error: ${(err as Error).message}`, onto)
      } catch {
        log.append({ type: 'merge.failed', node: spec.id, reason: `supervisor error: ${(err as Error).message}` })
      }
    }
  }

  /** The integrator's request for the node's merge, from its recorded conflict (and the check after a clean merge). */
  const requestFor = (state: RunState, id: string) => {
    const n = state.nodes.get(id)!
    const merged = [...state.nodes.values()].filter((m) => m.status === 'completed' && m.merge).sort((a, b) => a.endSeq! - b.endSeq!).map((m) => m.spec)
    const files = n.merge!.conflict!.files
    return mergeRequest(n.spec, n.merge!.branch!, integrationTree().branch, files, merged, files.length ? undefined : n.turns.at(-1)?.check)
  }

  /** Hand the node's merge to the integrator and verify its answer: no merge in progress, nothing left uncommitted, and
   * the node's check passes. One retry; then, or when the integrator is blocked, the merge fails. */
  const integrate = async (spec: NodeSpec, onto: string) => {
    const id = spec.id
    const { path, branch } = integrationTree()
    const { conflict } = nodeNow(id).merge!
    const nodeBranch = nodeNow(id).merge!.branch!
    if (!current().nodes.has(INTEGRATOR)) {
      const agent = integratorAgent(current().agents, unavailable)
      if (!agent) return mergeFailed(id, 'no agent is available for the integrator', onto)
      log.append({ type: 'node.added', node: { id: INTEGRATOR, kind: 'work', standing: true, agent, brief: INTEGRATOR_BRIEF }, by: SUPERVISOR })
    }
    const since = conflict!.seq
    const requests = () => log.events.filter((e) => e.seq > since && e.type === 'message' && e.from === SUPERVISOR && e.to === INTEGRATOR).length
    const request = (body: string) => log.append({ type: 'message', from: SUPERVISOR, to: INTEGRATOR, body, mode: 'queue' })
    if (!requests()) request(requestFor(current(), id))
    // After a restart, the integrator's last turn may have answered (or been cut short) already.
    let first = true
    for (;;) {
      if (stopping) return
      if (isFinal(nodeNow(id))) return resetTo(path, onto) // cancelled meanwhile
      const state = current()
      const ig = state.nodes.get(INTEGRATOR)!
      if (isFinal(ig)) return mergeFailed(id, `the integrator ${ig.status}`, onto)
      const last = ig.turns.at(-1)
      const recorded = first && !ig.inbox.length && last?.ended
      first = false
      let result = recorded ? last.result : undefined
      if (!result) {
        const agent = agentOf(state, ig)
        if (typeof agent === 'string') return mergeFailed(id, agent, onto)
        const sessionId = ig.turns.findLast((t) => t.sessionId)?.sessionId
        const inbox: InboxMessage[] = ig.inbox.length ? ig.inbox : [{ seq: 0, from: SUPERVISOR, body: requestFor(state, id), mode: 'queue' }]
        const prompt = !sessionId ? integratorPrompt(state.goal, ig.spec, path, branch, inbox, agent.instructions)
          : recorded ? recoveryPrompt(ig.inbox) : inboxPrompt(ig.inbox)
        const t = await runTurn(ig.spec, agent, ig.turns.length + 1, prompt, path, sessionId, !!recorded)
        if (stopping) return
        // A node cancelled meanwhile is handled at the top of the loop.
        if (t.exited?.quiet && !isFinal(nodeNow(id))) return mergeFailed(id, `the integrator's ${exitedText(ig.turns.length + 1, t.exited)}`, onto)
        result = t.result
        if (nodeNow(INTEGRATOR).inbox.length) continue // messages that arrived meanwhile come first
      }
      if (result && result.status !== 'done') {
        return mergeFailed(id, `the integrator is ${result.status}: ${result.question ?? result.summary}`, onto)
      }
      const left = result && !mergeInProgress(path) ? uncommitted(path) : []
      let why = !result ? 'your last turn ended without the required structured result'
        : mergeInProgress(path) ? 'the merge is still in progress: resolve every conflict and commit the merge'
        : left.length ? `uncommitted changes remain in ${left.slice(0, 5).join(', ')}${left.length > 5 ? ` and ${left.length - 5} more` : ''}: `
          + 'commit what belongs to the merge and delete the rest'
        : hasChanges(path, nodeBranch) ? `branch ${nodeBranch} is not merged`
        : undefined
      const marked = why ? [] : withConflictMarkers(path, conflict!.files)
      if (marked.length) why = `conflict markers remain in ${marked.join(', ')}`
      if (!why && spec.command) {
        const c = await check(id, spec.command, path)
        if (stopping) return
        resetTo(path, head(path)) // what the check left behind is not part of the merge
        if (c.exitCode !== 0) why = `its check still fails (exit code ${c.exitCode}):\n${c.output.trimEnd()}`
      }
      if (isFinal(nodeNow(id))) continue
      if (!why) return void log.append({ type: 'merge.done', node: id, commit: head(path), by: 'integrator', files: changedFiles(path, onto, nodeBranch) })
      if (requests() > 1) return mergeFailed(id, `not verified after a retry: ${why.split('\n')[0]}`, onto)
      request(`Node ${id} is not merged yet: ${why}\n\nFix it and commit, then report done again.`)
    }
  }

  // ---- Splitting ------------------------------------------------------------------------------

  // By splitter node, the lead whose split its running turn works on: the turn stops when that lead finishes.
  const splitFor = new Map<string, string>()

  /** Ask splitter `agent` for its first requested split and record its proposal once it is valid as a spawn of the lead.
   * Each splitter agent is its own standing node with its own worktree, reset to the integration branch before each
   * request (folder mode: its own folder, linking the workspace and the results), so what it reads is current and
   * nothing it writes reaches the run. One retry for an invalid proposal;
   * then, or when the splitter is blocked or cannot run, the split fails and the lead splits on its own. */
  const splitNext = async (agent: string) => {
    const lead = [...current().nodes.values()].filter((n) => n.split?.status === 'requested' && n.split.agent === agent)
      .sort((a, b) => a.split!.seq - b.split!.seq)[0]
    if (!lead) return
    const id = lead.spec.id
    const failed = (reason: string) => void log.append({ type: 'split.failed', node: id, reason })
    try {
      await split(id, agent, roleNode(SPLITTER, agent), failed)
    } catch (err) {
      if (!stopping) failed(`supervisor error: ${(err as Error).message}`)
    }
  }

  const split = async (id: string, agent: string, node: string, failed: (reason: string) => void) => {
    if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
    let results: string
    try {
      results = resultsDir()
    } catch (err) {
      return failed((err as Error).message)
    }
    if (!current().nodes.has(node)) {
      log.append({ type: 'node.added', node: { id: node, kind: 'work', standing: true, agent, brief: SPLITTER_BRIEF }, by: SUPERVISOR })
    }
    const file = join(runDir, 'splits', `${id}.json`)
    // Git mode: its own worktree, reset to the integration branch for each request. Folder mode: its own folder with the
    // links workspace/ and results/, which always show the current results.
    let cwd = nodeFolder(node)
    if (folder) linkedFolder(cwd, workspace, results)
    else {
      const tree = createNodeWorktree(workspace, runId, runDir, node, head(results))
      if (tree.base) log.append({ type: 'worktree.created', node, branch: tree.branch, path: tree.path, base: tree.base })
      cwd = tree.path
    }
    // A splitter takes its splits one at a time in request order, so this one's messages are those after it was requested
    // and after every other split of this splitter settled: a lead requested while an earlier split ran must not count
    // that split's messages.
    const before = current()
    const since = Math.max(before.nodes.get(id)!.split!.seq,
      ...[...before.nodes.values()].flatMap((n) => (n.split?.agent === agent ? n.split.endSeq ?? [] : [])))
    const ours = (): InboxMessage[] => log.events.flatMap((e) =>
      e.seq > since && e.type === 'message' && e.from === SUPERVISOR && e.to === node ? [{ seq: e.seq, from: e.from, body: e.body, mode: e.mode }] : [])
    const requests = () => ours().length
    const request = (body: string) => log.append({ type: 'message', from: SUPERVISOR, to: node, body, mode: 'queue' })
    mkdirSync(join(runDir, 'splits'), { recursive: true })
    if (!requests()) {
      const commit = folder ? undefined : head(results)
      if (commit) resetTo(cwd, commit)
      rmSync(file, { force: true })
      const state = current()
      const used = [...state.nodes.values()].filter((n) => !n.spec.standing).map((n) => n.spec.id)
      request(splitRequest(state.nodes.get(id)!.spec, notesFor(state, id), childAgents(state.agents, unavailable), depthOf(state, id),
        { cwd, commit, file, used, maxParts: MAX_CHILDREN - childrenOf(state, id).length, roleChoices: roleChoices(state.definitions, unavailable) }))
    }
    // After a restart, the splitter's last turn may have answered (or been cut short) already.
    let first = true
    for (;;) {
      if (stopping) return
      const state = current()
      const sp = state.nodes.get(node)!
      if (isFinal(sp)) return failed(`splitter ${node} ${sp.status}`)
      const last = sp.turns.at(-1)
      const recorded = first && !sp.inbox.length && last?.ended
      first = false
      let result = recorded ? last.result : undefined
      if (!result) {
        const runs = agentOf(state, sp)
        if (typeof runs === 'string') return failed(runs)
        const sessionId = sp.turns.findLast((t) => t.sessionId)?.sessionId
        // A turn cut short may have stopped before the splitter read its prompt: a recovery turn repeats this split's
        // messages, and so does a first prompt whose request a cut-short turn already took from the inbox.
        const inbox = recorded || !sp.inbox.length ? ours() : sp.inbox
        const prompt = !sessionId ? splitterPrompt(state.goal, sp.spec, inbox, runs.instructions, state.mode)
          : recorded ? recoveryPrompt(inbox) : inboxPrompt(inbox)
        splitFor.set(node, id)
        let t
        try {
          t = await runTurn(sp.spec, runs, sp.turns.length + 1, prompt, cwd, sessionId, !!recorded)
        } finally {
          splitFor.delete(node)
        }
        if (stopping) return
        if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
        if (t.exited?.quiet) return failed(`the splitter's ${exitedText(sp.turns.length + 1, t.exited)}`)
        result = t.result
        if (nodeNow(node).inbox.length) continue // messages that arrived meanwhile come first
      }
      if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
      if (result && result.status !== 'done') return failed(`the splitter is ${result.status}: ${result.question ?? result.summary}`)
      const parts = result ? readProposal(file) : 'your last turn ended without the required structured result'
      const why = typeof parts === 'string' ? parts : refusal(current(), id, { tool: 'spawn', children: parts })
      if (!why) return void log.append({ type: 'split.proposed', node: id, parts: parts as ChildSpec[], summary: result!.summary })
      if (requests() > 1) return failed(`no valid proposal after a retry: ${why}`)
      request(`Your proposal for lead ${id} is not valid: ${why}\n\nWrite a corrected proposal to ${file}, then report done again.`)
    }
  }

  // ---- Recovery (sous resume) -----------------------------------------------------------------

  /** Close a turn the last supervisor left without `turn.ended`: record its result if its output has one; stop its
   * group if it still runs. A node left without a result is then resumed by `runWork`. */
  const closeTurn = async (spec: NodeSpec, t: TurnState) => {
    const adapter = getAdapter(t.harness!) // every turn records the harness it ran on
    const read = () => {
      try {
        return adapter.parse(readFileSync(t.outFile, 'utf8'))
      } catch {
        return undefined
      }
    }
    // A lead's turn (a lead on a CLI harness) ends with a lead result, any other turn with a worker's.
    const leadTurn = spec.kind === 'lead'
    const outcome = (p: ParsedTurn | undefined) => (leadTurn ? { lead: p?.lead } : { result: p?.result })
    let parsed = read()
    if (turnAlive(t)) {
      if (!outcome(parsed).result && !outcome(parsed).lead) log.append({ type: 'turn.interrupted', node: spec.id, turn: t.number, reason: 'still running when the run was resumed', signal: 'SIGTERM' })
      await terminate(t.pid)
      parsed = read()
    }
    if (parsed?.sessionId && !t.sessionId) log.append({ type: 'turn.session', node: spec.id, turn: t.number, sessionId: parsed.sessionId })
    const { result, lead } = outcome(parsed)
    const error = !parsed?.ended ? 'the supervisor stopped during this turn' : result || lead ? undefined : 'no parsable structured result'
    log.append({ type: 'turn.ended', node: spec.id, turn: t.number, exitCode: null, signal: null, result, ...(lead ? { lead } : {}), usage: parsed?.usage, error })
  }

  const recover = async () => {
    for (const n of current().nodes.values()) {
      for (const t of n.turns) if (!t.ended) await closeTurn(n.spec, t)
    }
    // A turn that ended while the supervisor was down may have reached the budget: then nothing runs, the lead runner's
    // unfinished work included, and the run stops again.
    checkBudget()
    if (stopping) return
    const state = current()
    // A node cancelled while its merge ran, when the supervisor stopped before it reset the integration branch: its merge
    // (clean, or committed by the integrator) is still on the branch, and nothing merged after it. Reset it now, once:
    // after the reset its branch is no longer part of the integration branch. A merge done after it ended means its
    // merge was reset then; that later merge may carry its commits (a worktree cut while they were on the branch).
    for (const n of state.nodes.values()) {
      const m = n.merge
      if (folder || !isFinal(n) || !m?.branch || log.events.some((e) => (e.type === 'merge.done' || e.type === 'merge.failed') && e.node === n.spec.id)) continue
      if (log.events.some((e) => e.type === 'merge.done' && e.seq > n.endSeq!)) continue
      const { path } = integrationTree()
      const onto = mergedOnto(path, m.branch) ?? (m.conflict && !hasChanges(path, m.branch) ? m.conflict.onto : undefined)
      if (onto) resetTo(path, onto)
    }
    for (const n of state.nodes.values()) {
      // A worker's question recorded as its result but not yet sent to its parent.
      const last = n.turns.at(-1)
      if (isFinal(n) || n.spec.standing || !last?.result || last.result.status === 'done') continue
      const end = log.events.findLastIndex((e) => e.type === 'turn.ended' && e.node === n.spec.id && e.turn === last.number)
      if (!log.events.slice(end).some((e) => e.type === 'message' && e.from === n.spec.id)) ask(n.spec, last.result)
    }
    if (!runner) return
    await runner.resume()
    const answered = new Set(log.events.flatMap((e) => (e.type === 'lead.turn' ? [callKey(e.node, e.requestId)] : [])))
    for (const e of [...log.events]) {
      if (e.type !== 'lead.delivered' || answered.has(callKey(e.node, e.requestId))) continue
      const lead = state.nodes.get(e.node)
      const agent = lead && !isFinal(lead) ? agentOf(state, lead) : undefined
      // A lead whose agent is no longer available is failed by routeLead.
      if (agent !== undefined && typeof agent !== 'string') send(lead!, agent, e.requestId, e.text, e.mode)
    }
  }

  // ---- Main loop ------------------------------------------------------------------------------

  // The merge (or collection) in progress, if any. It and check nodes take turns in the results.
  let merging: Promise<void> | undefined
  // The split in progress of each splitter agent: a splitter takes one request at a time, splitters run in parallel.
  const splitting = new Map<string, Promise<void>>()
  // The turns of each lead on a CLI harness.
  const leadTurns = new Map<string, Promise<void>>()
  const tasks = () => [...[...inFlight.values()].map((f) => f.done), ...(merging ? [merging] : []), ...splitting.values(), ...leadTurns.values()]

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let failed: unknown
  try {
    if (opts.resume) await recover()
    for (;;) {
      const before = log.events.length
      const changed = () => log.events.length !== before
      if (!stopping) readCommands()
      const state = current()
      if (state.status !== 'running') return state.status
      checkBudget()
      if (stopping) {
        if (!tasks().length) return budgetStop ? 'budget' : 'interrupted'
        await Promise.race(tasks())
        continue
      }
      const nodes = [...state.nodes.values()]

      // Stop the work of finished (cancelled or abandoned) nodes; interrupt workers that have an urgent message.
      for (const [pid, g] of groups) {
        const n = state.nodes.get(g.node)!
        // An urgent message the worker already read during its turn does not stop it.
        const urgent = n.inbox.find((m) => m.mode === 'interrupt' && m.seq > (n.read?.upTo ?? 0))
        const serving = splitFor.get(g.node)
        const orphaned = serving !== undefined && isFinal(state.nodes.get(serving)) ? serving : undefined
        if (!isFinal(n) && !urgent && !orphaned) continue
        if (g.turn === undefined && !isFinal(n)) {
          // The worker's acceptance check: stop it, and the worker resumes with the message.
          if (!interruptedChecks.has(pid)) interruptedChecks.set(pid, `message from ${urgent!.from}`)
          void terminate(pid)
          continue
        }
        const t = n.turns.find((t) => t.number === g.turn)
        if (t && !t.interrupted && !t.ended) {
          const reason = isFinal(n) ? n.reason ?? 'node finished' : orphaned ? `${orphaned} finished before its split` : `message from ${urgent!.from}`
          log.append({ type: 'turn.interrupted', node: g.node, turn: g.turn!, reason, signal: 'SIGTERM' })
        }
        if (isFinal(n) || (t && !t.interrupted)) void terminate(pid)
      }
      for (const n of nodes) {
        const id = n.spec.id
        if (n.spec.kind !== 'lead' || !(n.cancelledBy || abandoned.has(id)) || runnerCancelled.has(id)) continue
        runnerCancelled.add(id)
        runner?.cancel(id).catch(() => {})
      }
      if (changed()) continue

      const blocked = nodes.find((n) => (n.status === 'pending' || n.status === 'ready') &&
        n.spec.needs?.some((id) => state.nodes.get(id)?.status === 'failed'))
      if (blocked) {
        const failed = blocked.spec.needs!.find((id) => state.nodes.get(id)?.status === 'failed')
        fail(blocked.spec.id, `needs ${failed}, which failed`)
        continue
      }

      // A standing node (the integrator) never completes, so it does not count toward the run's completion.
      const top = childrenOf(state, undefined).filter((n) => !n.spec.standing)
      if (!tasks().length && top.every(isFinal)) {
        const failed = top.filter((n) => n.status === 'failed').map((n) => n.spec.id)
        if (failed.length) log.append({ type: 'run.failed', reason: `failed nodes: ${failed.join(', ')}` })
        else {
          const flagged = top.filter((n) => n.failedChecks?.length).map((n) => `${n.spec.id} completed with failed checks: ${n.failedChecks!.join(', ')}`)
          log.append({ type: 'run.completed', summary: top.length === 1 ? completedText(top[0]) : [`${top.length} nodes completed`, ...flagged].join('; ') })
        }
        continue
      }

      for (const n of nodes) if (n.spec.kind === 'lead') routeLead(state, n)
      // A lead on a CLI harness with deliveries to answer (or a recorded result to settle) gets its turns.
      for (const n of nodes) {
        const id = n.spec.id
        if (n.spec.kind !== 'lead' || isFinal(n) || !n.delivered.length || n.idle || leadTurns.has(id)) continue
        const agent = agentOf(state, n)
        if (typeof agent === 'string' || agent.runs === 'lead') continue
        leadTurns.set(id, driveLead(id)
          .catch((err) => { if (!stopping && !isFinal(nodeNow(id))) abandon(current(), id, `supervisor error: ${(err as Error).message}`) })
          .finally(() => leadTurns.delete(id)))
      }
      // A ready gate asks the person for approval and waits for `sous approve` or `sous cancel`.
      for (const n of nodes) {
        if (n.spec.kind === 'gate' && n.status === 'ready') log.append({ type: 'message', from: n.spec.id, to: PERSON, body: n.spec.brief ?? '', mode: 'queue' })
      }
      if (changed()) continue

      const checking = () => [...inFlight.values()].some((f) => f.spec.kind === 'check')
      if (!merging && !checking() && nodes.some((n) => n.status === 'merging')) {
        merging = mergeNext().finally(() => (merging = undefined))
      }
      for (const agent of new Set(nodes.flatMap((n) => (n.split?.status === 'requested' ? [n.split.agent] : [])))) {
        if (!splitting.has(agent)) splitting.set(agent, splitNext(agent).finally(() => splitting.delete(agent)))
      }
      for (const n of nodes) {
        if (n.spec.kind === 'lead' || n.spec.kind === 'gate' || n.spec.standing || inFlight.has(n.spec.id) || inFlight.size >= MAX_CONCURRENT) continue
        // `running` with nothing in flight: the node was running when the last supervisor stopped.
        if (n.status !== 'ready' && n.status !== 'running' && !(n.status === 'waiting' && n.inbox.length)) continue
        // A check runs in the results, so not while a merge changes them.
        if (n.spec.kind === 'check' && merging) continue
        try {
          resultsDir()
        } catch (err) {
          log.append({ type: 'run.failed', reason: (err as Error).message })
          break
        }
        const spec = n.spec
        const done = (spec.kind === 'check' ? runCheckNode(spec) : runWork(spec))
          .catch((err) => { if (!stopping) fail(spec.id, `supervisor error: ${(err as Error).message}`) })
          .finally(() => inFlight.delete(spec.id))
        inFlight.set(spec.id, { spec, done })
      }
      if (changed()) continue
      const live = nodes.filter((n) => !isFinal(n))
      if (!tasks().length && !live.some((n) => n.status === 'waiting' || (n.spec.kind === 'lead' && n.status === 'running'))) {
        log.append({ type: 'run.failed', reason: 'no node can start' })
        continue
      }
      const woken = new Promise<void>((resolve) => (wakeUp = resolve))
      await Promise.race([...tasks(), woken, sleep(POLL_MS)])
    }
  } catch (err) {
    failed = err
    throw err
  } finally {
    // An error above leaves turns and checks running: stop them all, and let the turns record their end, before the
    // runner and the log close. Every step runs even when one fails, and the error that ended the run is the one
    // reported: a failure of the clean-up itself surfaces only after a run that ended normally.
    const errors: unknown[] = []
    const attempt = async (step: () => Promise<void> | void) => {
      try {
        await step()
      } catch (err) {
        errors.push(err)
      }
    }
    await attempt(stop)
    await attempt(async () => {
      while (tasks().length) await Promise.allSettled(tasks())
      await Promise.allSettled(terminations.values())
    })
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    closed = true // the run is over: later tool calls and turns of a closing runner are not recorded
    await attempt(() => runner?.close())
    await attempt(() => log.close())
    if (failed === undefined && errors.length) throw errors[0]
  }
}
