// What a worker says to others while it works: a message to a sibling or to its lead, through `sous send` or sous's
// MCP server. Both check it here and hand it to the supervisor as a command file; the supervisor checks it again when
// it applies it, and stays the only writer of the log.
import { readEvents, writeCommand } from './log.ts'
import { fold, isFinal } from './state.ts'
import type { RunState } from './state.ts'

/** Messages a worker may send over the whole run. */
export const MAX_SENDS = 5

/** Who worker `from` may message: its lead (absent for a top-level node) and its siblings that take messages. */
export function sendTargets(state: RunState, from: string): { lead?: string; siblings: string[] } {
  const parent = state.nodes.get(from)?.spec.parent
  const siblings = [...state.nodes.values()].filter((n) => n.spec.parent === parent && n.spec.id !== from && !n.spec.standing &&
    (n.spec.kind === 'work' || n.spec.kind === 'lead') && !isFinal(n) && n.status !== 'merging').map((n) => n.spec.id)
  return { lead: parent, siblings }
}

/** Why worker `from` may not send `body` to `to` now, if it may not. */
export function sendRefusal(state: RunState, from: string, to: string, body: unknown): string | undefined {
  const sender = state.nodes.get(from)
  if (!sender || sender.spec.kind !== 'work' || sender.spec.standing) return `${from} is not a worker of the tree, so it cannot send`
  if (isFinal(sender)) return `${from} is already ${sender.status}`
  if (typeof body !== 'string' || !body.trim()) return 'the message must be non-empty text'
  const sent = state.sent.get(from) ?? 0
  if (sent >= MAX_SENDS) return `${from} already sent the ${MAX_SENDS} messages a worker may send`
  const target = state.nodes.get(to)
  const lead = sender.spec.parent
  if (to === from) return 'you cannot send to yourself'
  if (to !== lead && (!target || target.spec.parent !== lead || target.spec.standing)) {
    return `${to} is not your lead or a sibling; you may send to ${[lead, ...sendTargets(state, from).siblings].filter(Boolean).join(', ') || 'nobody'}`
  }
  if (isFinal(target)) return `${to} is already ${target!.status}`
  if (target!.spec.kind === 'check' || target!.spec.kind === 'gate') return `${to} is a ${target!.spec.kind} and takes no messages`
  if (target!.status === 'merging') return `${to} is done and waits to merge; tell your lead if its work must change`
  return undefined
}

/** `sous send` and the MCP tool: check the message against the run's current state and hand it to the supervisor. */
export function workerSend(runDir: string, from: string, to: string, body: string): { ok: boolean; text: string } {
  const why = sendRefusal(fold(readEvents(runDir)), from, to, body)
  if (why) return { ok: false, text: `not sent: ${why}` }
  writeCommand(runDir, { type: 'send', from, to, text: body })
  return { ok: true, text: `sent to ${to}; it reads it when its current turn ends, and nobody answers within yours` }
}
