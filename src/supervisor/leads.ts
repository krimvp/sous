// Leads: the LeadHost given to the lead runner (tool calls, read tools, settled turns), routing to each lead (its brief,
// messages, child outcomes, retries and idle reminders), recording and handing deliveries to the runner, abandoning a
// lead that cannot go on, and cancelling finished leads in the runner. Owns the runner and the sets of leads abandoned
// and cancelled there.
import { PERSON, SPLITTER } from '../contracts/index.ts'
import type { CreateLeadRunner, LeadHost } from '../contracts/index.ts'
import { childAgents, roleChoices } from '../definitions/index.ts'
import type { Agent } from '../definitions/index.ts'
import { idleReminder, leadBrief, leadMessageText, outcomeText, retryPrompt, splitApproval } from '../prompts/index.ts'
import { ancestors, callKey, childrenOf, isFinal, roleAgent } from '../run/index.ts'
import type { NodeState, RunState } from '../run/index.ts'
import { listFiles, readText } from '../workspace/index.ts'
import type { Root } from '../workspace/index.ts'
import type { Context } from './context.ts'
import { accepted, depthOf, notesFor, refusal } from './policy.ts'

const MAX_REMINDERS = 2

export type Leads = ReturnType<typeof createLeads>

export function createLeads(ctx: Context, createLeadRunner: CreateLeadRunner | undefined) {
  const { workspace, runDir, folder, unavailable, log, current, nodeNow, agentOf, fail, resultsDir } = ctx

  const host: LeadHost = {
    act(node, callId, call) {
      if (ctx.closed) return 'refused: the run is over'
      const state = current()
      const recorded = state.calls.get(callKey(node, callId))
      if (recorded !== undefined) return recorded
      const why = refusal(state, node, call)
      const result = why ? `refused: ${why}` : accepted(state, node, call, state.nodes.get(node)!.spec.parent ?? PERSON)
      log.append({ type: 'lead.call', node, callId, call, ok: !why, result })
      ctx.wakeUp()
      return result
    },
    read(node, callId, call) {
      if (ctx.closed) return 'refused: the run is over'
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
      if (ctx.closed || log.events.some((e) => e.type === 'lead.turn' && e.node === node && e.requestId === requestId)) return
      log.append({ type: 'lead.turn', node, requestId, status, text, model, ...(usage ? { usage } : {}) })
      ctx.wakeUp()
    },
  }
  const runner = createLeadRunner?.({ runDir, host })
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
    runner!.deliver(node, text, { requestId, mode, model: agent.model }).catch((err) => {
      if (ctx.closed || isFinal(nodeNow(node))) return
      abandon(current(), node, `lead runner: ${(err as Error).message}`)
      ctx.wakeUp()
    })
  }

  /** Brief, messages, child outcomes and idle reminders for one lead. */
  const routeLead = (state: RunState, lead: NodeState) => {
    const id = lead.spec.id
    if (isFinal(lead) || lead.status === 'pending') return
    if (!runner) return fail(id, 'no lead runner is configured')
    const agent = agentOf(state, lead)
    if (typeof agent === 'string') return abandon(state, id, agent)
    if (!lead.delivered.length) {
      // With a splitter, the brief waits for its proposal, and with --approve-splits for the person's answer to it.
      const splitter = roleAgent(state, id, SPLITTER)
      if (splitter !== undefined) {
        const { split } = lead
        if (!split) return void log.append({ type: 'split.requested', node: id, agent: splitter })
        if (split.status === 'requested') return
        const answered = lead.inbox.some((m) => m.from === PERSON && m.seq > split.endSeq!)
        if (state.approveSplits && split.status === 'proposed' && !answered) {
          if (lead.status !== 'waiting') log.append({ type: 'message', from: id, to: PERSON, body: splitApproval(id, split.parts!, split.summary!), mode: 'queue' })
          return
        }
      }
      const roles = { splitter, choices: roleChoices(state.definitions, unavailable) }
      const brief = leadBrief(state.goal, lead.spec, notesFor(state, id), childAgents(state.agents, unavailable), depthOf(state, id), agent.instructions, lead.split, roles, state.mode)
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
    // A waiting child with messages is about to resume, and one whose open question is to the person (a gate, a lead
    // whose split awaits approval) waits for them, not for this lead, so both still count as working.
    const asksPerson = (c: NodeState) => state.questions.some((q) => q.from === c.spec.id)
    const waiting = children.filter((c) => c.status === 'waiting' && !c.inbox.length && !asksPerson(c)).map((c) => c.spec.id)
    if (children.some((c) => !isFinal(c) && !waiting.includes(c.spec.id))) return
    // Where an idle lead would be reminded, one whose last delivery the runner could not get answered (a model error,
    // an expired login) gets one retry instead; then it fails with the reason. A working child's outcome gives it a
    // fresh delivery first.
    if (lead.unanswered) {
      if (lead.unanswered.retried) return abandon(state, id, `unanswered after a retry: ${lead.unanswered.reason}`)
      return deliver(lead, agent, `evt-${lead.lastTurn}`, retryPrompt(lead.unanswered.reason), 'queue')
    }
    if (lead.reminders >= MAX_REMINDERS) return abandon(state, id, `idle after ${MAX_REMINDERS} reminders`)
    deliver(lead, agent, `evt-${lead.lastTurn}`, idleReminder(id, lead.reminders + 1, MAX_REMINDERS, waiting), 'queue')
  }

  /** Stop in the runner every lead that was cancelled or abandoned, once. */
  const cancelInRunner = (nodes: NodeState[]) => {
    for (const n of nodes) {
      const id = n.spec.id
      if (n.spec.kind !== 'lead' || !(n.cancelledBy || abandoned.has(id)) || runnerCancelled.has(id)) continue
      runnerCancelled.add(id)
      runner?.cancel(id).catch(() => {})
    }
  }

  return { runner, routeLead, send, cancelInRunner }
}
