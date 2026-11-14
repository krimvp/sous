// `sous resume`: close the turns a stopped supervisor left open (closeTurn), stop again at the budget, drop the merges
// of nodes cancelled while they merged, send the workers' questions not yet sent, resume the lead runner and hand it
// again every delivery it did not answer (recover).
import { readFileSync } from 'node:fs'
import type { NodeSpec, ParsedTurn } from '../contracts/index.ts'
import { callKey, isFinal } from '../run/index.ts'
import type { TurnState } from '../run/index.ts'
import { hasChanges, mergedOnto, resetTo } from '../workspace/index.ts'
import type { Context } from './context.ts'
import type { Leads } from './leads.ts'
import { turnAlive } from './processes.ts'
import { ask } from './turns.ts'

/** Close a turn the last supervisor left without `turn.ended`: record its result (a lead's turn: its lead result) if its
 * output has one; stop its group if it still runs. A node left without a result is then resumed by `runWork`, a lead on
 * a CLI harness by `driveLead`. */
const closeTurn = async (ctx: Context, spec: NodeSpec, t: TurnState) => {
  const { getAdapter, log } = ctx
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
    await ctx.processes.terminate(t.pid)
    parsed = read()
  }
  if (parsed?.sessionId && !t.sessionId) log.append({ type: 'turn.session', node: spec.id, turn: t.number, sessionId: parsed.sessionId })
  const { result, lead } = outcome(parsed)
  const error = !parsed?.ended ? 'the supervisor stopped during this turn' : result || lead ? undefined : 'no parsable structured result'
  log.append({ type: 'turn.ended', node: spec.id, turn: t.number, exitCode: null, signal: null, result, ...(lead ? { lead } : {}), usage: parsed?.usage, error })
}

export const recover = async (ctx: Context, leads: Leads) => {
  const { folder, log, current, agentOf, integrationTree } = ctx
  const { runner, send } = leads
  for (const n of current().nodes.values()) {
    for (const t of n.turns) if (!t.ended) await closeTurn(ctx, n.spec, t)
  }
  // A turn that ended while the supervisor was down may have reached the budget: then nothing runs, the lead runner's
  // unfinished work included, and the run stops again.
  ctx.checkBudget()
  if (ctx.stopping) return
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
    if (!log.events.slice(end).some((e) => e.type === 'message' && e.from === n.spec.id)) ask(ctx, n.spec, last.result)
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
