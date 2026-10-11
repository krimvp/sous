// The supervisor: the only writer of a run's state. Starts every process, runs leads through the lead
// runner, routes messages and records every outcome.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { agentFor, childAgents, defineAgent, integratorAgent, registry } from './agents.ts'
import type { Agent, Unavailable } from './agents.ts'
import {
  composeBrief, fixPrompt, idleReminder, inboxPrompt, INTEGRATOR_BRIEF, integratorPrompt, leadBrief, leadMessageText, mergeRequest, outcomeText,
  recoveryPrompt, resultReminder,
} from './brief.ts'
import { collect, listFiles, readText } from './files.ts'
import type { Root } from './files.ts'
import {
  abortMerge, changedFiles, commitAll, createIntegration, createNodeWorktree, ensureRepo, hasChanges, hasUncommitted, head, merge, mergedOnto,
  mergeInProgress, resetTo, withConflictMarkers,
} from './git.ts'
import { childError } from './graph.ts'
import { openLog, procStartTime } from './log.ts'
import { ancestors, callKey, childrenOf, fold, isFinal } from './state.ts'
import type { CheckState, InboxMessage, NodeState, RunState, TurnState } from './state.ts'
import { DEFAULT_LEAD_MODEL, INTEGRATOR, PERSON } from './types.ts'
import type { CreateLeadRunner, Event, HarnessName, LeadCall, LeadHost, NodeSpec, TurnResult, WorkerAdapter } from './types.ts'

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
  /** `sous resume`: take over a stopped supervisor's lock and recover its unfinished turns and lead deliveries. */
  resume?: boolean
  /** What was missing when the run started or resumed (`checkAgents`); default: nothing. */
  unavailable?: Unavailable
}

export type SupervisorOutcome = 'completed' | 'failed' | 'interrupted'

const MAX_CONCURRENT = 4
const MAX_FIX_ROUNDS = 2
const OUTPUT_TAIL = 4096
const MAX_CHILDREN = 12
const MAX_REMINDERS = 2
/** Times a supervisor stop may cut a node's turn short before the node fails. */
const MAX_RECOVERIES = 3
/** How often `<runDir>/commands/` is checked for `sous answer`, `sous approve` and `sous cancel`. */
const POLL_MS = 200
/** Sender of the integrator's requests. */
const SUPERVISOR = 'supervisor'

/** A command file written by `sous answer`, `sous approve` or `sous cancel`. */
export type PersonCommand = { type: 'answer'; node: string; text: string } | { type: 'approve' | 'cancel'; node: string }

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
async function stopGroup(pid: number, graceMs: number): Promise<void> {
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

const notesFor = (state: RunState, id: string) => ancestors(state, id).flatMap((a) => a.notes)

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
        const why = childError(c, (id) => state.nodes.has(id) || siblings.includes(id), siblings, agents)
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

function accepted(call: LeadCall, parent: string): string {
  switch (call.tool) {
    case 'spawn': return `spawned ${call.children.map((c) => c.id).join(', ')}; their outcomes will be delivered to you`
    case 'send': return `sent to ${call.to}`
    case 'note': return 'noted'
    case 'cancel': return `cancelled ${call.node} and its subtree`
    case 'complete': return 'completed'
    case 'fail': return 'failed'
    case 'escalate': return `asked ${parent}; the answer will be delivered to you`
  }
}

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorOutcome> {
  const { workspace, runDir, getAdapter } = opts
  const runId = basename(runDir)
  const unavailable = opts.unavailable ?? { commands: [], leadProviders: [] }
  const graceMs = opts.graceMs ?? 5000
  const log = openLog(runDir, opts.onEvent, { takeOver: opts.resume })
  if (opts.resume) {
    const { status } = fold(log.events)
    if (status !== 'running') {
      log.close()
      throw new Error(`the run already ${status}; a finished run is not resumed`)
    }
    log.append({ type: 'run.resumed' })
  }
  const commandsDir = join(runDir, 'commands')
  mkdirSync(commandsDir, { recursive: true })
  // Folder mode (no git): each work node writes in its own folder, collected into the output folder when it is done.
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

  const stop = () => {
    if (stopping) return
    stopping = true
    for (const [pid, g] of groups) {
      if (g.turn !== undefined) {
        log.append({ type: 'turn.interrupted', node: g.node, turn: g.turn, reason: 'supervisor stopped', signal: 'SIGTERM' })
      }
      void terminate(pid)
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
      const result = why ? `refused: ${why}` : accepted(call, state.nodes.get(node)!.spec.parent ?? PERSON)
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

  const deliver = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt') => {
    log.append({ type: 'lead.delivered', node: lead.spec.id, requestId, text, mode })
    send(lead, agent, requestId, text, mode)
  }
  /** Hand a recorded delivery to the runner; a repeated requestId is ignored there. */
  const send = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt') => {
    const node = lead.spec.id
    runner!.deliver(node, text, { requestId, mode, model: agent.model ?? DEFAULT_LEAD_MODEL }).catch((err) => {
      if (closed || isFinal(nodeNow(node))) return
      abandon(current(), node, `lead runner: ${(err as Error).message}`)
      wakeUp()
    })
  }

  /** Brief, messages, child outcomes and idle reminders for one lead. */
  const routeLead = (state: RunState, lead: NodeState) => {
    const id = lead.spec.id
    if (isFinal(lead) || lead.status === 'pending') return
    if (!runner) return fail(id, 'no lead runner is configured')
    const agent = agentOf(state, lead)
    if (typeof agent === 'string') return abandon(state, id, agent)
    if (lead.status === 'ready') {
      const depth = { at: ancestors(state, id).length + 1, max: state.maxDepth }
      const brief = leadBrief(state.goal, lead.spec, notesFor(state, id), childAgents(state.agents, unavailable), depth, agent.instructions, state.mode)
      return deliver(lead, agent, `${id}:brief`, brief, 'queue')
    }
    const children = childrenOf(state, id)
    const items = lead.inbox.map((m) => ({
      seq: m.seq, mode: m.mode, text: leadMessageText(m, state.nodes.get(m.from)?.spec.parent === id),
    }))
    for (const c of children) {
      if (isFinal(c) && c.cancelledBy !== id) items.push({ seq: c.endSeq!, mode: 'queue', text: outcomeText(c) })
    }
    const fresh = items.filter((i) => !lead.delivered.includes(`evt-${i.seq}`)).sort((a, b) => a.seq - b.seq)
    for (const i of fresh) deliver(lead, agent, `evt-${i.seq}`, i.text, i.mode)
    if (fresh.length || !lead.idle || lead.escalated) return
    // A waiting child with messages is about to resume, and a gate waits for the person, so both still count as working.
    const waiting = children.filter((c) => c.status === 'waiting' && !c.inbox.length && c.spec.kind !== 'gate').map((c) => c.spec.id)
    if (children.some((c) => !isFinal(c) && !waiting.includes(c.spec.id))) return
    if (lead.reminders >= MAX_REMINDERS) return abandon(state, id, `idle after ${MAX_REMINDERS} reminders`)
    deliver(lead, agent, `evt-${lead.lastTurn}`, idleReminder(id, lead.reminders + 1, MAX_REMINDERS, waiting), 'queue')
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
    const node = typeof cmd?.node === 'string' ? current().nodes.get(cmd.node) : undefined
    if (!node || isFinal(node)) return
    const gate = node.spec.kind === 'gate'
    if (cmd!.type === 'answer' && !gate && typeof cmd!.text === 'string' && cmd!.text.trim()) {
      log.append({ type: 'message', from: PERSON, to: cmd!.node, body: cmd!.text, mode: 'queue', command })
    } else if (cmd!.type === 'approve' && gate && node.status === 'waiting') {
      log.append({ type: 'node.completed', node: cmd!.node, summary: 'approved by person', command })
    } else if (cmd!.type === 'cancel') {
      log.append({ type: 'node.cancelled', node: cmd!.node, by: PERSON, command })
    }
  }

  // ---- Workers and checks ---------------------------------------------------------------------

  /** Run a shell command in its own process group; returns its exit code and the tail of its output. */
  const runCommand = (node: string, command: string, cwd: string) =>
    new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let tail = Buffer.alloc(0)
      const keep = (chunk: Buffer) => {
        tail = Buffer.concat([tail, chunk])
        if (tail.length > OUTPUT_TAIL) tail = tail.subarray(tail.length - OUTPUT_TAIL)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      if (child.pid) groups.set(child.pid, { node })
      const finish = async (exitCode: number | null) => {
        let output = tail.toString('utf8')
        if (child.pid) {
          groups.delete(child.pid)
          await terminate(child.pid) // background processes the command left behind
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
      child.on('close', (code) => finish(code))
    })

  const check = async (node: string, command: string, cwd: string) => {
    const r = await runCommand(node, command, cwd)
    if (!stopping) log.append({ type: 'check.ended', node, command, ...r })
    return r
  }

  const runTurn = async (spec: NodeSpec, agent: Agent, turn: number, prompt: string, cwd: string, sessionId?: string, recovery = false) => {
    const adapter = getAdapter(agent.runs as HarnessName)
    const dir = join(runDir, 'nodes', spec.id)
    mkdirSync(dir, { recursive: true })
    const turnSpec = {
      nodeId: spec.id, turn, cwd, prompt,
      outFile: join(dir, `turn-${turn}.jsonl`), errFile: join(dir, `turn-${turn}.err`),
      model: agent.model, sessionId,
    }
    const mode = sessionId ? 'resume' : 'start'
    const running = sessionId ? adapter.resume({ ...turnSpec, sessionId }) : adapter.start(turnSpec)
    const { pid } = running
    log.append({
      type: 'turn.started', node: spec.id, turn, mode, harness: adapter.name, agent: agent.name, pid, startTime: procStartTime(pid),
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
    let size = -1
    let grace: NodeJS.Timeout | undefined
    const watch = setInterval(() => {
      try {
        const now = statSync(turnSpec.outFile).size
        if (now === size) return
        size = now
        if (adapter.parse(readFileSync(turnSpec.outFile, 'utf8')).ended) {
          clearInterval(watch)
          grace = setTimeout(() => void terminate(pid), graceMs)
        }
      } catch {}
    }, Math.min(1000, graceMs))

    const exit = await running.exit
    ended = true
    clearInterval(watch)
    clearTimeout(grace)
    groups.delete(pid)
    await terminate(pid) // the leader is gone; stop anything it left running in its group

    let result: TurnResult | undefined
    let error: string | undefined
    let usage
    try {
      const parsed = adapter.parse(readFileSync(turnSpec.outFile, 'utf8'))
      if (parsed.sessionId && !session) {
        session = parsed.sessionId
        log.append({ type: 'turn.session', node: spec.id, turn, sessionId: session })
      }
      result = parsed.result
      usage = parsed.usage
      if (!parsed.ended) error = 'no end-of-turn marker in the output'
      else if (!result) error = 'no parsable structured result'
    } catch (err) {
      error = `cannot read turn output: ${(err as Error).message}`
    }
    log.append({ type: 'turn.ended', node: spec.id, turn, exitCode: exit.code, signal: exit.signal, result, usage, error })
    return { result, sessionId: session }
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
    if (folder) mkdirSync(cwd, { recursive: true })
    else {
      const tree = createNodeWorktree(workspace, runId, runDir, spec.id, head(integrationTree().path))
      if (tree.base) log.append({ type: 'worktree.created', node: spec.id, branch: tree.branch, path: tree.path, base: tree.base })
      ;({ path: cwd, branch } = tree)
    }
    const folders = folder ? { workspace, output: resultsDir() } : undefined
    const brief = () => composeBrief(state.goal, spec, cwd, notesFor(state, spec.id), node.inbox, instructions, folders)
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
      let t: { result?: TurnResult; sessionId?: string; check?: CheckState }
      if (recorded) t = recorded
      else if (typeof agent === 'string') return fail(spec.id, agent)
      else t = await runTurn(spec, agent, turn, prompt, cwd, sessionId, recovery)
      recorded = undefined
      recovery = false
      if (stopping || isFinal(nodeNow(spec.id))) return
      sessionId = t.sessionId ?? sessionId
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
        if (reminded) return fail(spec.id, `turn ${turn} ended without a structured result`)
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
      commitAll(cwd, `${spec.id}: ${t.result.summary}`)
      return void log.append({ type: 'merge.queued', node: spec.id, branch })
    }
  }

  const runCheckNode = async (spec: NodeSpec) => {
    // After a restart, a check whose outcome was recorded settles from it (a check node runs its command once).
    const c = nodeNow(spec.id).checks.at(-1) ?? await check(spec.id, spec.command!, resultsDir())
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

  /** Folder mode: add a finished node's files to the output folder. Collecting again after a crash changes nothing. */
  const collectFiles = (spec: NodeSpec) => {
    try {
      const { files, renamed } = collect(nodeFolder(spec.id), resultsDir(), spec.id)
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
    if (folder) return collectFiles(spec)
    const { conflict } = n.merge!
    const branch = n.merge!.branch!
    const { path } = integrationTree()
    let onto = conflict?.onto
    try {
      if (conflict) return await integrate(spec, conflict.onto)
      // A merge a stopped supervisor left in progress never reached the integrator: start it again.
      if (mergeInProgress(path)) abortMerge(path)
      let commit = head(path)
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
        if (c.exitCode !== 0) {
          log.append({ type: 'merge.conflict', node: spec.id, reason: `check failed after the merge (exit ${c.exitCode})`, files: [], onto })
          return await integrate(spec, onto)
        }
      }
      log.append({ type: 'merge.done', node: spec.id, commit, by: 'supervisor', files: changedFiles(path, onto, branch) })
    } catch (err) {
      if (stopping || isFinal(nodeNow(spec.id))) return
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
        result = (await runTurn(ig.spec, agent, ig.turns.length + 1, prompt, path, sessionId, !!recorded)).result
        if (stopping) return
        if (nodeNow(INTEGRATOR).inbox.length) continue // messages that arrived meanwhile come first
      }
      if (result && result.status !== 'done') {
        return mergeFailed(id, `the integrator is ${result.status}: ${result.question ?? result.summary}`, onto)
      }
      let why = !result ? 'your last turn ended without the required structured result'
        : mergeInProgress(path) ? 'the merge is still in progress: resolve every conflict and commit the merge'
        : hasUncommitted(path) ? 'changes to tracked files are not committed'
        : hasChanges(path, nodeBranch) ? `branch ${nodeBranch} is not merged`
        : undefined
      const marked = why ? [] : withConflictMarkers(path, conflict!.files)
      if (marked.length) why = `conflict markers remain in ${marked.join(', ')}`
      if (!why && spec.command) {
        const c = await check(id, spec.command, path)
        if (stopping) return
        if (c.exitCode !== 0) why = `its check still fails (exit code ${c.exitCode}):\n${c.output.trimEnd()}`
      }
      if (isFinal(nodeNow(id))) continue
      if (!why) return void log.append({ type: 'merge.done', node: id, commit: head(path), by: 'integrator', files: changedFiles(path, onto, nodeBranch) })
      if (requests() > 1) return mergeFailed(id, `not verified after a retry: ${why.split('\n')[0]}`, onto)
      request(`Node ${id} is not merged yet: ${why}\n\nFix it and commit, then report done again.`)
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
    let parsed = read()
    if (turnAlive(t)) {
      if (!parsed?.result) log.append({ type: 'turn.interrupted', node: spec.id, turn: t.number, reason: 'still running when the run was resumed', signal: 'SIGTERM' })
      await terminate(t.pid)
      parsed = read()
    }
    if (parsed?.sessionId && !t.sessionId) log.append({ type: 'turn.session', node: spec.id, turn: t.number, sessionId: parsed.sessionId })
    const error = !parsed?.ended ? 'the supervisor stopped during this turn' : parsed.result ? undefined : 'no parsable structured result'
    log.append({ type: 'turn.ended', node: spec.id, turn: t.number, exitCode: null, signal: null, result: parsed?.result, usage: parsed?.usage, error })
  }

  const recover = async () => {
    for (const n of current().nodes.values()) {
      for (const t of n.turns) if (!t.ended) await closeTurn(n.spec, t)
    }
    const state = current()
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
  const tasks = () => [...[...inFlight.values()].map((f) => f.done), ...(merging ? [merging] : [])]

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    if (opts.resume) await recover()
    for (;;) {
      const before = log.events.length
      const changed = () => log.events.length !== before
      if (!stopping) readCommands()
      const state = current()
      if (state.status !== 'running') return state.status
      if (stopping) {
        if (!tasks().length) return 'interrupted'
        await Promise.race(tasks())
        continue
      }
      const nodes = [...state.nodes.values()]

      // Stop the work of finished (cancelled or abandoned) nodes; interrupt workers that have an urgent message.
      for (const [pid, g] of groups) {
        const n = state.nodes.get(g.node)!
        const urgent = n.inbox.find((m) => m.mode === 'interrupt')
        if (!isFinal(n) && !urgent) continue
        if (g.turn === undefined && !isFinal(n)) {
          // The worker's acceptance check: stop it, and the worker resumes with the message.
          if (!interruptedChecks.has(pid)) interruptedChecks.set(pid, `message from ${urgent!.from}`)
          void terminate(pid)
          continue
        }
        const t = n.turns.find((t) => t.number === g.turn)
        if (t && !t.interrupted && !t.ended) {
          const reason = isFinal(n) ? n.reason ?? 'node finished' : `message from ${urgent!.from}`
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
        else log.append({ type: 'run.completed', summary: top.length === 1 ? top[0].summary! : `${top.length} nodes completed` })
        continue
      }

      for (const n of nodes) if (n.spec.kind === 'lead') routeLead(state, n)
      // A ready gate asks the person for approval and waits for `sous approve` or `sous cancel`.
      for (const n of nodes) {
        if (n.spec.kind === 'gate' && n.status === 'ready') log.append({ type: 'message', from: n.spec.id, to: PERSON, body: n.spec.brief ?? '', mode: 'queue' })
      }
      if (changed()) continue

      const checking = () => [...inFlight.values()].some((f) => f.spec.kind === 'check')
      if (!merging && !checking() && nodes.some((n) => n.status === 'merging')) {
        merging = mergeNext().finally(() => (merging = undefined))
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
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    closed = true // the run is over: later tool calls and turns of a closing runner are not recorded
    try {
      await runner?.close()
    } finally {
      log.close()
    }
  }
}
