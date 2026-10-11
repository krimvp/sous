// The supervisor: the only writer of a run's state. Starts every process, runs leads through the lead
// runner, routes messages and records every outcome.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { composeBrief, fixPrompt, idleReminder, inboxPrompt, leadBrief, leadMessageText, outcomeText, resultReminder } from './brief.ts'
import { childError } from './graph.ts'
import { openLog } from './log.ts'
import { ancestors, callKey, childrenOf, fold, isFinal } from './state.ts'
import type { NodeState, RunState } from './state.ts'
import { DEFAULT_LEAD_MODEL, PERSON } from './types.ts'
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
}

export type SupervisorOutcome = 'completed' | 'failed' | 'interrupted'

const MAX_CONCURRENT = 4
const MAX_FIX_ROUNDS = 2
const OUTPUT_TAIL = 4096
const MAX_LEAD_DEPTH = 3
const MAX_CHILDREN = 12
const MAX_REMINDERS = 2
/** How often `<runDir>/commands/` is checked for `murm answer` and `murm cancel`. */
const POLL_MS = 200

/** A command file written by `murm answer` or `murm cancel`. */
export type PersonCommand = { type: 'answer'; node: string; text: string } | { type: 'cancel'; node: string }

/** Signal a turn's whole process group. Ignores a group that is already gone. */
export function interrupt(pid: number, signal: NodeJS.Signals): void {
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
      for (const c of call.children) {
        const why = childError(c, (id) => state.nodes.has(id) || siblings.includes(id), siblings)
          ?? (c.kind === 'lead' && ancestors(state, node).length + 2 > MAX_LEAD_DEPTH ? `leads may nest at most ${MAX_LEAD_DEPTH} deep` : undefined)
        if (why) return `child ${String(c?.id)}: ${why}`
        siblings.push(c.id)
      }
      return undefined
    }
    case 'send': {
      if (call.to !== parent && !children.some((c) => c.spec.id === call.to)) return `${node} may send only to its children or to ${parent}`
      const target = state.nodes.get(call.to)
      if (isFinal(target)) return `${call.to} is already ${target!.status}`
      if (target?.spec.kind === 'check') return `${call.to} is a check and takes no messages`
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
  const graceMs = opts.graceMs ?? 5000
  const log = openLog(runDir, opts.onEvent)
  const commandsDir = join(runDir, 'commands')
  mkdirSync(commandsDir, { recursive: true })
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

  const deliver = (lead: NodeState, requestId: string, text: string, mode: 'queue' | 'interrupt') => {
    const node = lead.spec.id
    log.append({ type: 'lead.delivered', node, requestId, text, mode })
    runner!.deliver(node, text, { requestId, mode, model: lead.spec.model ?? DEFAULT_LEAD_MODEL }).catch((err) => {
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
    if (lead.status === 'ready') return deliver(lead, `${id}:brief`, leadBrief(state.goal, lead.spec, notesFor(state, id)), 'queue')
    const children = childrenOf(state, id)
    const items = lead.inbox.map((m) => ({
      seq: m.seq, mode: m.mode, text: leadMessageText(m, state.nodes.get(m.from)?.spec.parent === id),
    }))
    for (const c of children) {
      if (isFinal(c) && c.cancelledBy !== id) items.push({ seq: c.endSeq!, mode: 'queue', text: outcomeText(c) })
    }
    const fresh = items.filter((i) => !lead.delivered.includes(`evt-${i.seq}`)).sort((a, b) => a.seq - b.seq)
    for (const i of fresh) deliver(lead, `evt-${i.seq}`, i.text, i.mode)
    if (fresh.length || !lead.idle || lead.escalated) return
    // A waiting child with messages is about to resume, so it still counts as working.
    const waiting = children.filter((c) => c.status === 'waiting' && !c.inbox.length).map((c) => c.spec.id)
    if (children.some((c) => !isFinal(c) && !waiting.includes(c.spec.id))) return
    if (lead.reminders >= MAX_REMINDERS) return abandon(state, id, `idle after ${MAX_REMINDERS} reminders`)
    deliver(lead, `evt-${lead.lastTurn}`, idleReminder(id, lead.reminders + 1, MAX_REMINDERS, waiting), 'queue')
  }

  // ---- Person commands ------------------------------------------------------------------------

  const readCommands = () => {
    for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(commandsDir, file)
      let cmd: PersonCommand | undefined
      try {
        cmd = JSON.parse(readFileSync(path, 'utf8'))
      } catch {}
      rmSync(path, { force: true })
      const node = typeof cmd?.node === 'string' ? current().nodes.get(cmd.node) : undefined
      if (!node || isFinal(node)) continue
      if (cmd!.type === 'answer' && typeof cmd!.text === 'string' && cmd!.text.trim()) {
        log.append({ type: 'message', from: PERSON, to: cmd!.node, body: cmd!.text, mode: 'queue' })
      } else if (cmd!.type === 'cancel') {
        log.append({ type: 'node.cancelled', node: cmd!.node, by: PERSON })
      }
    }
  }

  // ---- Workers and checks ---------------------------------------------------------------------

  /** Run a shell command in its own process group; returns its exit code and the tail of its output. */
  const runCommand = (node: string, command: string) =>
    new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn('sh', ['-c', command], { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

  const check = async (node: string, command: string) => {
    const r = await runCommand(node, command)
    if (!stopping) log.append({ type: 'check.ended', node, command, ...r })
    return r
  }

  const runTurn = async (spec: NodeSpec, turn: number, prompt: string, sessionId?: string) => {
    const adapter = getAdapter(spec.harness!)
    const dir = join(runDir, 'nodes', spec.id)
    mkdirSync(dir, { recursive: true })
    const turnSpec = {
      nodeId: spec.id, turn, cwd: workspace, prompt,
      outFile: join(dir, `turn-${turn}.jsonl`), errFile: join(dir, `turn-${turn}.err`),
      model: spec.model, sessionId,
    }
    const mode = sessionId ? 'resume' : 'start'
    const running = sessionId ? adapter.resume({ ...turnSpec, sessionId }) : adapter.start(turnSpec)
    const { pid } = running
    log.append({ type: 'turn.started', node: spec.id, turn, mode, harness: adapter.name, pid, outFile: turnSpec.outFile, errFile: turnSpec.errFile, prompt })
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

  /** Turns of a work node until it completes, fails, or waits for a message. Messages that arrive
   * meanwhile are delivered by resuming the session; a `done` counts only with an empty inbox. */
  const runWork = async (spec: NodeSpec) => {
    const state = current()
    const node = state.nodes.get(spec.id)!
    let sessionId = node.turns.findLast((t) => t.sessionId)?.sessionId
    let prompt = node.turns.length ? inboxPrompt(node.inbox) : composeBrief(state.goal, spec, workspace, notesFor(state, spec.id), node.inbox)
    let fixRounds = 0
    let reminded = false
    for (let turn = node.turns.length + 1; ; turn++) {
      const t = await runTurn(spec, turn, prompt, sessionId)
      if (stopping || isFinal(nodeNow(spec.id))) return
      sessionId = t.sessionId ?? sessionId
      if (t.result && t.result.status !== 'done') {
        log.append({ type: 'message', from: spec.id, to: spec.parent ?? PERSON, body: t.result.question ?? t.result.summary, mode: 'queue' })
      }
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
        const c = await check(spec.id, spec.command)
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
      return complete(spec.id, t.result.summary)
    }
  }

  const runCheckNode = async (spec: NodeSpec) => {
    const c = await check(spec.id, spec.command!)
    if (stopping || isFinal(nodeNow(spec.id))) return
    if (c.exitCode === 0) complete(spec.id, 'check passed')
    else fail(spec.id, `check exited ${c.exitCode}`)
  }

  // ---- Main loop ------------------------------------------------------------------------------

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    for (;;) {
      const before = log.events.length
      const changed = () => log.events.length !== before
      if (!stopping) readCommands()
      const state = current()
      if (state.status !== 'running') return state.status
      if (stopping) {
        if (!inFlight.size) return 'interrupted'
        await Promise.race([...inFlight.values()].map((f) => f.done))
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

      const top = childrenOf(state, undefined)
      if (!inFlight.size && top.every(isFinal)) {
        const failed = top.filter((n) => n.status === 'failed').map((n) => n.spec.id)
        if (failed.length) log.append({ type: 'run.failed', reason: `failed nodes: ${failed.join(', ')}` })
        else log.append({ type: 'run.completed', summary: top.length === 1 ? top[0].summary! : `${top.length} nodes completed` })
        continue
      }

      for (const n of nodes) if (n.spec.kind === 'lead') routeLead(state, n)
      if (changed()) continue

      for (const n of nodes) {
        if (n.spec.kind === 'lead' || inFlight.has(n.spec.id) || inFlight.size >= MAX_CONCURRENT) continue
        if (n.status !== 'ready' && !(n.status === 'waiting' && n.inbox.length)) continue
        const writing = !n.spec.readOnly
        if (writing && [...inFlight.values()].some((f) => !f.spec.readOnly)) continue
        const spec = n.spec
        const done = (spec.kind === 'check' ? runCheckNode(spec) : runWork(spec))
          .catch((err) => { if (!stopping) fail(spec.id, `supervisor error: ${(err as Error).message}`) })
          .finally(() => inFlight.delete(spec.id))
        inFlight.set(spec.id, { spec, done })
      }
      if (changed()) continue
      const live = nodes.filter((n) => !isFinal(n))
      if (!inFlight.size && !live.some((n) => n.status === 'waiting' || (n.spec.kind === 'lead' && n.status === 'running'))) {
        log.append({ type: 'run.failed', reason: 'no node can start' })
        continue
      }
      const woken = new Promise<void>((resolve) => (wakeUp = resolve))
      await Promise.race([...[...inFlight.values()].map((f) => f.done), woken, sleep(POLL_MS)])
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
