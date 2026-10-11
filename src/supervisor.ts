// The supervisor: the only writer of a run's state. Starts every process and records every outcome.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { composeBrief, fixPrompt, resultReminder } from './brief.ts'
import { openLog } from './log.ts'
import { fold } from './state.ts'
import type { Event, HarnessName, NodeSpec, TurnResult, WorkerAdapter } from './types.ts'

export interface SupervisorOptions {
  workspace: string
  runDir: string
  getAdapter: (name: HarnessName) => WorkerAdapter
  onEvent?: (event: Event) => void
  /** How long a turn may keep running after its end-of-turn marker before its group is stopped,
   * and how long a stopped group gets between SIGTERM and SIGKILL. */
  graceMs?: number
}

export type SupervisorOutcome = 'completed' | 'failed' | 'interrupted'

const MAX_CONCURRENT = 4
const MAX_FIX_ROUNDS = 2
const OUTPUT_TAIL = 4096

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

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorOutcome> {
  const { workspace, runDir, getAdapter } = opts
  const graceMs = opts.graceMs ?? 5000
  const log = openLog(runDir, opts.onEvent)
  const inFlight = new Map<string, { spec: NodeSpec; done: Promise<void> }>()
  // Live process groups, so a stop request can reach them; `turn` is absent for shell checks.
  const groups = new Map<number, { node: string; turn?: number }>()
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
        if (child.pid) {
          groups.delete(child.pid)
          await terminate(child.pid) // background processes the command left behind
        }
        resolve({ exitCode, output: tail.toString('utf8') })
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
    log.append({ type: 'turn.started', node: spec.id, turn, mode, harness: adapter.name, pid, outFile: turnSpec.outFile, errFile: turnSpec.errFile })
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

  const runWork = async (spec: NodeSpec, goal: string) => {
    let prompt = composeBrief(goal, spec, workspace)
    let sessionId: string | undefined
    let fixRounds = 0
    let reminded = false
    for (let turn = 1; ; turn++) {
      const t = await runTurn(spec, turn, prompt, sessionId)
      if (stopping) return
      sessionId = t.sessionId ?? sessionId
      if (!t.result) {
        if (reminded || !sessionId) return fail(spec.id, `turn ${turn} ended without a structured result`)
        reminded = true
        prompt = resultReminder()
        continue
      }
      if (t.result.status !== 'done') {
        return fail(spec.id, `${t.result.status}: ${t.result.question ?? t.result.summary}`)
      }
      if (!spec.command) return complete(spec.id, t.result.summary)
      const c = await check(spec.id, spec.command)
      if (stopping) return
      if (c.exitCode === 0) return complete(spec.id, t.result.summary)
      if (fixRounds === MAX_FIX_ROUNDS) {
        return fail(spec.id, `acceptance check still fails after ${MAX_FIX_ROUNDS} fix rounds (exit ${c.exitCode})`)
      }
      if (!sessionId) return fail(spec.id, `acceptance check failed (exit ${c.exitCode}) and the session is unknown`)
      fixRounds++
      prompt = fixPrompt(spec.command, c.exitCode, c.output)
    }
  }

  const runCheckNode = async (spec: NodeSpec) => {
    const c = await check(spec.id, spec.command!)
    if (stopping) return
    if (c.exitCode === 0) complete(spec.id, 'check passed')
    else fail(spec.id, `check exited ${c.exitCode}`)
  }

  const complete = (node: string, summary: string) => void log.append({ type: 'node.completed', node, summary })
  const fail = (node: string, reason: string) => void log.append({ type: 'node.failed', node, reason })

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    for (;;) {
      const state = fold(log.events)
      if (state.status !== 'running') return state.status
      if (stopping) {
        if (!inFlight.size) return 'interrupted'
        await Promise.race([...inFlight.values()].map((f) => f.done))
        continue
      }

      const nodes = [...state.nodes.values()]
      const blocked = nodes.find((n) => (n.status === 'pending' || n.status === 'ready') &&
        n.spec.needs?.some((id) => state.nodes.get(id)?.status === 'failed'))
      if (blocked) {
        const failed = blocked.spec.needs!.find((id) => state.nodes.get(id)?.status === 'failed')
        fail(blocked.spec.id, `needs ${failed}, which failed`)
        continue
      }

      if (!inFlight.size && nodes.every((n) => n.status === 'completed' || n.status === 'failed')) {
        const failed = nodes.filter((n) => n.status === 'failed').map((n) => n.spec.id)
        if (failed.length) log.append({ type: 'run.failed', reason: `failed nodes: ${failed.join(', ')}` })
        else log.append({ type: 'run.completed', summary: `${nodes.length} nodes completed` })
        continue
      }

      for (const n of nodes) {
        if (n.status !== 'ready' || inFlight.has(n.spec.id) || inFlight.size >= MAX_CONCURRENT) continue
        const writing = !n.spec.readOnly
        if (writing && [...inFlight.values()].some((f) => !f.spec.readOnly)) continue
        const spec = n.spec
        const done = (spec.kind === 'check' ? runCheckNode(spec) : runWork(spec, state.goal))
          .catch((err) => { if (!stopping) fail(spec.id, `supervisor error: ${(err as Error).message}`) })
          .finally(() => inFlight.delete(spec.id))
        inFlight.set(spec.id, { spec, done })
      }
      if (!inFlight.size) {
        log.append({ type: 'run.failed', reason: 'no node can start' })
        continue
      }
      await Promise.race([...inFlight.values()].map((f) => f.done))
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    log.close()
  }
}
