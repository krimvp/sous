// What a person asks of a running run, `sous answer`, `approve` and `cancel`: whether it applies to the run as it is.
import { INTEGRATOR, roleNode, SPLITTER } from '../contracts/index.ts'
import type { PersonCommand } from '../contracts/index.ts'
import { awaitsSplitApproval, isFinal } from '../run/index.ts'
import type { RunState } from '../run/index.ts'

/** Why a person's answer, approval or cancel does not apply to the run as it is, if it does not: `sous answer`,
 * `approve` and `cancel` check it before they write the command file, and the supervisor again when it reads it, as the
 * run may have moved on since (or the file came from elsewhere). A standing node (the integrator, a splitter) is not
 * cancelled: the run would lose it for good. Cancelling the node it works for stops that work. */
export function commandRefusal(state: RunState, cmd: PersonCommand): string | undefined {
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
