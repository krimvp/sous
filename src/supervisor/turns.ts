// One worker turn (runTurn): start or resume its harness, record its start, session, stall and end, and stop its group
// once it is done. A check (check): run a command and record its end. A worker's question (ask). The Exited record of a
// turn that exited on its own without its end-of-turn marker.
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PERSON } from '../contracts/index.ts'
import type { HarnessName, NodeSpec, ParsedTurn, TurnResult } from '../contracts/index.ts'
import type { Agent } from '../definitions/index.ts'
import { procStartTime } from '../run/index.ts'
import type { Context } from './context.ts'
import { stderrTail } from './processes.ts'

/** A turn that exited non-zero, on its own, without its end-of-turn marker: its exit code and the end of its stderr.
 * `quiet`: it produced no output (no message or tool call), so resuming it would fail the same way. */
export interface Exited {
  code: number
  stderr: string
  quiet: boolean
}

export const exitedText = (turn: number, e: Exited) => `turn ${turn} exited ${e.code} with no output; ${e.stderr}`

export const check = async (ctx: Context, node: string, command: string, cwd: string) => {
  const r = await ctx.processes.runCommand(node, command, cwd)
  if (!ctx.stopping) ctx.log.append({ type: 'check.ended', node, command, ...r })
  return r
}

export const runTurn = async (ctx: Context, spec: NodeSpec, agent: Agent, turn: number, prompt: string, cwd: string, sessionId?: string, recovery = false) => {
  const { getAdapter, runDir, log, graceMs, stallMs, nodeNow } = ctx
  const { groups, terminate } = ctx.processes
  const adapter = getAdapter(agent.runs as HarnessName)
  const dir = join(runDir, 'nodes', spec.id)
  mkdirSync(dir, { recursive: true })
  const turnSpec = {
    nodeId: spec.id, turn, cwd, prompt,
    outFile: join(dir, `turn-${turn}.jsonl`), errFile: join(dir, `turn-${turn}.err`),
    model: agent.model, sessionId,
    // A worker of the tree may message others while it works (`sous send`, or sous's MCP tool).
    ...(spec.standing ? {} : { env: { SOUS_RUN_DIR: resolve(runDir), SOUS_NODE: spec.id, SOUS_TURN: String(turn) } }),
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
  let error: string | undefined
  let usage
  let parsed: ParsedTurn | undefined
  try {
    parsed = adapter.parse(readFileSync(turnSpec.outFile, 'utf8'))
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
  log.append({ type: 'turn.ended', node: spec.id, turn, exitCode: exit.code, signal: exit.signal, result, usage, error })
  return { result, sessionId: session, exited }
}

/** A worker's question (its `needs_input` or `blocked` result) goes to its parent. */
export const ask = (ctx: Context, spec: NodeSpec, result: TurnResult) =>
  ctx.log.append({ type: 'message', from: spec.id, to: spec.parent ?? PERSON, body: result.question ?? result.summary, mode: 'queue' })
