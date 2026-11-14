// One worker turn (runTurn), or one turn of a lead on a CLI harness: start or resume its harness, record its start,
// session, stall and end, and stop its group once it is done. A check (check): run a command and record its end. A worker's question (ask). The Exited record of a
// turn that exited on its own without its end-of-turn marker.
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PERSON } from '../contracts/index.ts'
import type { HarnessName, LeadResult, LeadTurnSpec, NodeSpec, ParsedTurn, TurnResult, TurnSpec } from '../contracts/index.ts'
import type { Agent } from '../definitions/index.ts'
import { procStartTime } from '../run/index.ts'
import type { InboxMessage, TurnState } from '../run/index.ts'
import type { Context } from './context.ts'
import { stderrTail } from './processes.ts'

/** A turn that exited non-zero, on its own, without its end-of-turn marker: its exit code and the end of its stderr.
 * `quiet`: it produced no output (no message or tool call), so resuming it would fail the same way. */
export interface Exited {
  code: number
  stderr: string
  quiet: boolean
}

/** Times a supervisor stop may cut a node's turn short before the node fails. */
export const MAX_RECOVERIES = 3

/** Whether turn `t` shows that its harness had a conversation: it recorded a result, or its output holds a trace item
 * other than the harness's own error report (a system message). A harness given its session ID up front (Claude, Pi)
 * and stopped in its first moments has none to resume: Claude refuses the ID, Pi would open an empty session under it. */
export const established = (ctx: Context, t: TurnState): boolean => {
  if (t.result || t.lead) return true
  try {
    return ctx.getAdapter(t.harness!).parse(readFileSync(t.outFile, 'utf8')).items.some((i) => i.kind !== 'message' || i.role !== 'system')
  } catch {
    return false
  }
}

/** The session the next turn of a node with `turns` resumes: that of its last established turn. None when no turn was
 * established: the node starts again, in a new session, as if it never had one. `unseen`: the messages taken by the turns
 * after it, which its session never saw (a worker's or standing node's; a lead's deliveries stay unanswered instead).
 * `unknown`: the last established turn named no session, so what it did cannot be continued. */
export const resumable = (ctx: Context, turns: TurnState[]): { sessionId?: string; unseen: InboxMessage[]; unknown: boolean } => {
  const i = turns.findLastIndex((t) => established(ctx, t))
  const sessionId = i < 0 ? undefined : turns[i]!.sessionId
  return { sessionId, unseen: turns.slice(i + 1).flatMap((t) => t.took ?? []), unknown: i >= 0 && !sessionId }
}

export const exitedText = (turn: number, e: Exited) => `turn ${turn} exited ${e.code} with no output; ${e.stderr}`

export const check = async (ctx: Context, node: string, command: string, cwd: string) => {
  const r = await ctx.processes.runCommand(node, command, cwd)
  if (!ctx.stopping) ctx.log.append({ type: 'check.ended', node, command, ...r })
  return r
}

/** `lead`: the turn is a lead's (a lead on a CLI harness), read only and ending with a lead result. */
export const runTurn = async (ctx: Context, spec: NodeSpec, agent: Agent, turn: number, prompt: string, cwd: string, sessionId?: string, recovery = false, lead?: LeadTurnSpec) => {
  const { getAdapter, runDir, log, graceMs, stallMs, nodeNow } = ctx
  const { groups, terminate } = ctx.processes
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
        if (!stalled && !ended && !ctx.stopping && Date.now() - grewAt >= stallMs) {
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
  ctx.checkBudget()
  return { result, lead: leadResult, sessionId: session, exited }
}

/** A worker's question (its `needs_input` or `blocked` result) goes to its parent. */
export const ask = (ctx: Context, spec: NodeSpec, result: TurnResult) =>
  ctx.log.append({ type: 'message', from: spec.id, to: spec.parent ?? PERSON, body: result.question ?? result.summary, mode: 'queue' })
