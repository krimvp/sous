// What a worker says to others while it works, and what it reads from them: `send` to a sibling or its lead, and
// `receive` of the messages waiting for it, through `sous send`/`sous receive` or sous's MCP server. Both check here
// and hand the supervisor a command file; the supervisor checks it again when it applies it, and stays the only writer
// of the log.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEvents, writeCommand } from './log.ts'
import { fold, isFinal } from './state.ts'
import type { InboxMessage, RunState } from './state.ts'

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

/** How long `receive` may wait for a message. */
export const MAX_WAIT_SECONDS = 60

/** Why `node` may not receive now, if it may not: only a worker of the tree, during its work. */
function receiveRefusal(state: RunState, node: string): string | undefined {
  const n = state.nodes.get(node)
  if (!n || n.spec.kind !== 'work' || n.spec.standing) return `${node} is not a worker of the tree`
  return isFinal(n) ? `${node} is already ${n.status}` : undefined
}

/** The highest seq that `receive` commands of `node` not yet applied have taken. */
function pendingReceives(runDir: string, node: string): number {
  let upTo = 0
  let files: string[] = []
  try {
    files = readdirSync(join(runDir, 'commands')).filter((f) => f.endsWith('.json'))
  } catch {}
  for (const f of files) {
    try {
      const cmd = JSON.parse(readFileSync(join(runDir, 'commands', f), 'utf8'))
      if (cmd?.type === 'receive' && cmd.node === node && typeof cmd.upTo === 'number') upTo = Math.max(upTo, cmd.upTo)
    } catch {} // applied and removed meanwhile: the log has it
  }
  return upTo
}

/** `sous receive` and the MCP tool: the messages waiting for worker `node`, waiting up to `waitSeconds` for one. They
 * are taken: the supervisor records them read, so they are not delivered again when the turn ends. */
export async function workerReceive(runDir: string, node: string, waitSeconds = 0): Promise<{ ok: boolean; text: string }> {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000
  for (;;) {
    // Pending commands first: one applied in between is then in the log.
    const taken = pendingReceives(runDir, node)
    const state = fold(readEvents(runDir))
    const why = receiveRefusal(state, node)
    if (why) return { ok: false, text: `cannot receive: ${why}` }
    const waiting: InboxMessage[] = state.nodes.get(node)!.inbox.filter((m) => m.seq > taken)
    if (waiting.length) {
      writeCommand(runDir, { type: 'receive', node, upTo: Math.max(...waiting.map((m) => m.seq)) })
      return { ok: true, text: waiting.map((m) => `Message from ${m.from}:\n${m.body}`).join('\n\n') }
    }
    if (Date.now() >= deadline) return { ok: true, text: 'No messages.' }
    await sleep(250)
  }
}

/** `sous send` and the MCP tool: check the message against the run's current state and hand it to the supervisor. */
export function workerSend(runDir: string, from: string, to: string, body: string): { ok: boolean; text: string } {
  const why = sendRefusal(fold(readEvents(runDir)), from, to, body)
  if (why) return { ok: false, text: `not sent: ${why}` }
  writeCommand(runDir, { type: 'send', from, to, text: body })
  return { ok: true, text: `sent to ${to}; it reads it when its current turn ends, and nobody answers within yours` }
}
