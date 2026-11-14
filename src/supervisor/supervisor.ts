// runSupervisor: open the log, build the context, recover on `sous resume`, then the main loop, which is the run's
// scheduling policy: read commands, stop what must stop, fail what is blocked, end the run, route leads and gates, start
// merges, splits, work and checks, and wait. Ctrl-C and the shutdown in `finally` stop every process group.
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PERSON } from '../contracts/index.ts'
import type { NodeSpec } from '../contracts/index.ts'
import { childrenOf, completedText, fold, isFinal, openLog } from '../run/index.ts'
import { readCommands } from './commands.ts'
import { createContext } from './context.ts'
import type { SupervisorOptions } from './context.ts'
import { createLeads } from './leads.ts'
import { mergeNext } from './merge.ts'
import { recover } from './recover.ts'
import { createSplitter } from './split.ts'
import { runCheckNode, runWork } from './work.ts'

export type SupervisorOutcome = 'completed' | 'failed' | 'interrupted'

const MAX_CONCURRENT = 4
/** How often `<runDir>/commands/` is checked for the person's `sous answer`, `sous approve` and `sous cancel`, and
 * workers' `send` and `receive`. */
const POLL_MS = 200

export async function runSupervisor(opts: SupervisorOptions): Promise<SupervisorOutcome> {
  const log = openLog(opts.runDir, opts.onEvent, { takeOver: opts.resume })
  if (opts.resume) {
    const { status } = fold(log.events)
    if (status !== 'running') {
      log.close()
      throw new Error(`the run already ${status}; a finished run is not resumed`)
    }
    log.append({ type: 'run.resumed' })
  }
  const ctx = createContext(opts, log)
  mkdirSync(ctx.commandsDir, { recursive: true })
  const { current, fail, resultsDir } = ctx
  const { groups, interruptedChecks, terminations, terminate } = ctx.processes

  const stop = () => {
    if (ctx.stopping) return
    ctx.stopping = true
    // Every group is stopped whatever the log does: it may be what failed (a full disk, a throwing onEvent), and then
    // the interruptions go unrecorded.
    let recording = true
    for (const [pid, g] of groups) {
      void terminate(pid)
      if (g.turn === undefined || !recording) continue
      try {
        log.append({ type: 'turn.interrupted', node: g.node, turn: g.turn, reason: 'supervisor stopped', signal: 'SIGTERM' })
      } catch {
        recording = false
      }
    }
  }
  /** Ctrl-C (or SIGTERM) stops the run; a second one while it stops kills every group still being stopped. */
  const onSignal = () => {
    if (!ctx.stopping) return stop()
    for (const pid of new Set([...groups.keys(), ...terminations.keys()])) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {} // gone already, or not ours any more
    }
  }

  const leads = createLeads(ctx, opts.createLeadRunner)
  const { runner } = leads
  const splitter = createSplitter(ctx)

  // ---- Main loop ------------------------------------------------------------------------------

  const inFlight = new Map<string, { spec: NodeSpec; done: Promise<void> }>()
  // The merge (or collection) in progress, if any. It and check nodes take turns in the results.
  let merging: Promise<void> | undefined
  // The split in progress of each splitter agent: a splitter takes one request at a time, splitters run in parallel.
  const splitting = new Map<string, Promise<void>>()
  const tasks = () => [...[...inFlight.values()].map((f) => f.done), ...(merging ? [merging] : []), ...splitting.values()]

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let failed: unknown
  try {
    if (opts.resume) await recover(ctx, leads)
    for (;;) {
      const before = log.events.length
      const changed = () => log.events.length !== before
      if (!ctx.stopping) readCommands(ctx)
      const state = current()
      if (state.status !== 'running') return state.status
      if (ctx.stopping) {
        if (!tasks().length) return 'interrupted'
        await Promise.race(tasks())
        continue
      }
      const nodes = [...state.nodes.values()]

      // Stop the work of finished (cancelled or abandoned) nodes; interrupt workers that have an urgent message.
      for (const [pid, g] of groups) {
        const n = state.nodes.get(g.node)!
        // An urgent message the worker already read during its turn does not stop it.
        const urgent = n.inbox.find((m) => m.mode === 'interrupt' && m.seq > (n.read?.upTo ?? 0))
        const serving = splitter.splitFor.get(g.node)
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
      leads.cancelInRunner(nodes)
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

      for (const n of nodes) if (n.spec.kind === 'lead') leads.routeLead(state, n)
      // A ready gate asks the person for approval and waits for `sous approve` or `sous cancel`.
      for (const n of nodes) {
        if (n.spec.kind === 'gate' && n.status === 'ready') log.append({ type: 'message', from: n.spec.id, to: PERSON, body: n.spec.brief ?? '', mode: 'queue' })
      }
      if (changed()) continue

      const checking = () => [...inFlight.values()].some((f) => f.spec.kind === 'check')
      if (!merging && !checking() && nodes.some((n) => n.status === 'merging')) {
        merging = mergeNext(ctx).finally(() => (merging = undefined))
      }
      for (const agent of new Set(nodes.flatMap((n) => (n.split?.status === 'requested' ? [n.split.agent] : [])))) {
        if (!splitting.has(agent)) splitting.set(agent, splitter.splitNext(agent).finally(() => splitting.delete(agent)))
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
        const done = (spec.kind === 'check' ? runCheckNode(ctx, spec) : runWork(ctx, spec))
          .catch((err) => { if (!ctx.stopping) fail(spec.id, `supervisor error: ${(err as Error).message}`) })
          .finally(() => inFlight.delete(spec.id))
        inFlight.set(spec.id, { spec, done })
      }
      if (changed()) continue
      const live = nodes.filter((n) => !isFinal(n))
      if (!tasks().length && !live.some((n) => n.status === 'waiting' || (n.spec.kind === 'lead' && n.status === 'running'))) {
        log.append({ type: 'run.failed', reason: 'no node can start' })
        continue
      }
      const woken = new Promise<void>((resolve) => (ctx.wakeUp = resolve))
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
    ctx.closed = true // the run is over: later tool calls and turns of a closing runner are not recorded
    await attempt(() => runner?.close())
    await attempt(() => log.close())
    if (failed === undefined && errors.length) throw errors[0]
  }
}
