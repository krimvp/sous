// Leads: the LeadHost given to the lead runner (tool calls, read tools, settled turns), routing to each lead (its brief,
// messages, child outcomes, retries and idle reminders, coalesced into one delivery while the lead is busy or what
// waits needs no answer), recording and handing deliveries to the runner, the turns of a lead on a CLI harness
// (driveLead), abandoning a lead that cannot go on, and cancelling finished leads in the runner. Owns the runner and the
// sets of leads abandoned and cancelled there.
import { PERSON, SPLITTER } from '../contracts/index.ts'
import type { CreateLeadRunner, Event, LeadCall, LeadHost } from '../contracts/index.ts'
import { childAgents, roleChoices } from '../definitions/index.ts'
import type { Agent } from '../definitions/index.ts'
import { HARNESS_LEAD_ROLE, idleReminder, leadBrief, leadMessageText, leadTurnPrompt, outcomeText, retryPrompt, splitApproval } from '../prompts/index.ts'
import { ancestors, callKey, childrenOf, isFinal, roleAgent } from '../run/index.ts'
import type { NodeState, RunState, TurnState } from '../run/index.ts'
import { linkedFolder, listFiles, readText } from '../workspace/index.ts'
import type { Root } from '../workspace/index.ts'
import type { Context } from './context.ts'
import { accepted, depthOf, notesFor, refusal } from './policy.ts'
import { exitedText, MAX_RECOVERIES, runTurn } from './turns.ts'

const MAX_REMINDERS = 2

export type Leads = ReturnType<typeof createLeads>

export function createLeads(ctx: Context, createLeadRunner: CreateLeadRunner | undefined) {
  const { workspace, runDir, folder, unavailable, log, current, nodeNow, agentOf, fail, nodeFolder, resultsDir } = ctx

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
      ctx.checkBudget()
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

  const deliver = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt', carries: string[] = []) => {
    log.append({ type: 'lead.delivered', node: lead.spec.id, requestId, text, mode, ...(carries.length ? { carries } : {}) })
    send(lead, agent, requestId, text, mode)
  }
  /** Hand a recorded delivery to the runner; a repeated requestId is ignored there. A lead on a CLI harness gets it in its
   * next turn (`driveLead`); an urgent one stops its running turn first (the main loop, as for a worker). */
  const send = (lead: NodeState, agent: Agent, requestId: string, text: string, mode: 'queue' | 'interrupt') => {
    if (agent.runs !== 'lead') return ctx.wakeUp()
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
    const agent = agentOf(state, lead)
    if (typeof agent === 'string') return abandon(state, id, agent)
    const onHarness = agent.runs !== 'lead'
    if (!onHarness && !runner) return fail(id, 'no lead runner is configured')
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
      const brief = leadBrief(state.goal, lead.spec, notesFor(state, id), childAgents(state.agents, unavailable), depthOf(state, id), agent.instructions, lead.split, roles, state.mode, onHarness)
      return deliver(lead, agent, `${id}:brief`, brief, 'queue')
    }
    const children = childrenOf(state, id)
    // `info`: a worker's `send` (to this lead, or a copy of one to a sibling), which needs no answer.
    const items = lead.inbox.map((m) => ({
      seq: m.seq, mode: m.mode, info: m.sent === true, text: leadMessageText(m, state.nodes.get(m.from)?.spec.parent === id),
    }))
    for (const c of children) {
      if (isFinal(c) && c.cancelledBy !== id) items.push({ seq: c.endSeq!, mode: 'queue', info: false, text: outcomeText(c) })
    }
    const taken = (seq: number) => lead.delivered.includes(`evt-${seq}`) || lead.carried.includes(`evt-${seq}`)
    const fresh = items.filter((i) => !taken(i.seq)).sort((a, b) => a.seq - b.seq)
    // A waiting child with messages is about to resume, and one whose open question is to the person (a gate, a lead
    // whose split awaits approval) waits for them, not for this lead, so both still count as working.
    const asksPerson = (c: NodeState) => state.questions.some((q) => q.from === c.spec.id)
    const waiting = children.filter((c) => c.status === 'waiting' && !c.inbox.length && !asksPerson(c)).map((c) => c.spec.id)
    const working = children.some((c) => !isFinal(c) && !waiting.includes(c.spec.id))
    // Everything waiting goes in one delivery, in order: at once when urgent; else once the lead has answered what it
    // has, and only for an item that needs it or when no child is working (nothing else would come), so a message
    // that needs no answer rides along with the next one that does instead of being a lead turn of its own.
    if (fresh.length) {
      const urgent = fresh.some((i) => i.mode === 'interrupt')
      if (!urgent && !(lead.idle && (!working || fresh.some((i) => !i.info)))) return
      const ids = fresh.map((i) => `evt-${i.seq}`)
      return deliver(lead, agent, ids.at(-1)!, fresh.map((i) => i.text).join('\n\n'), urgent ? 'interrupt' : 'queue', ids.slice(0, -1))
    }
    if (!lead.idle || lead.escalated || working) return
    // Where an idle lead would be reminded, one whose last delivery the runner could not get answered (a model error,
    // an expired login) gets one retry instead; then it fails with the reason. A working child's outcome gives it a
    // fresh delivery first.
    if (lead.unanswered) {
      if (lead.unanswered.retried) return abandon(state, id, `unanswered after a retry: ${lead.unanswered.reason}`)
      return deliver(lead, agent, `evt-${lead.lastTurn}`, retryPrompt(lead.unanswered.reason), 'queue')
    }
    // A lead on a harness learns its calls' results in its next turn. A refused call earns that turn only here, as a
    // reminder: while a child works its next delivery carries them, so refused calls cannot drive turns of their own.
    const refused = onHarness ? refusedCall(id) : undefined
    if (lead.reminders >= MAX_REMINDERS) {
      return abandon(state, id, `idle after ${MAX_REMINDERS} reminders${refused ? `; ${refused.call.tool} was ${refused.result}` : ''}`)
    }
    deliver(lead, agent, `evt-${lead.lastTurn}`, idleReminder(id, lead.reminders + 1, MAX_REMINDERS, waiting, refused !== undefined), 'queue')
  }

  // ---- Leads on a CLI harness -------------------------------------------------------------------
  // A lead whose agent runs a lead-certified harness runs as turns of that harness, one per delivery (or per coalesced
  // delivery), each ending with a LeadResult. Its calls are applied after `turn.ended`, in order, through `host.act`
  // with call IDs `t<turn>.<index>`, so a recorded call is never applied twice; the first refused call stops the rest.
  // Only an uninterrupted turn's recorded result has effects: a turn stopped or cut short applied nothing.

  const leadCallId = (turn: number, index: number) => `t${turn}.${index}`
  /** The last turn of a lead on a harness whose calls count: it ended with a lead result and was not interrupted. */
  const appliedTurn = (lead: NodeState) => lead.turns.findLast((t) => t.lead && !t.interrupted)
  const startSeq = (node: string, turn: number) => log.events.find((e) => e.type === 'turn.started' && e.node === node && e.turn === turn)!.seq

  /** The results of the calls of lead `id`'s last applied turn, and the calls not applied after a refused one. */
  const callResults = (state: RunState, id: string) => {
    const t = appliedTurn(state.nodes.get(id)!)
    const results: { call: LeadCall; result: string }[] = []
    for (const [i, call] of (t?.lead!.calls ?? []).entries()) {
      const result = state.calls.get(callKey(id, leadCallId(t!.number, i)))
      if (result === undefined) return { results, skipped: t!.lead!.calls.slice(i) }
      results.push({ call, result })
    }
    return { results, skipped: [] }
  }

  /** The refused call of lead `id`'s last applied turn, if one was refused. */
  const refusedCall = (id: string) => {
    const t = appliedTurn(nodeNow(id))
    if (!t) return undefined
    return log.events.find((e) => e.type === 'lead.call' && e.node === id && !e.ok && e.callId.startsWith(`t${t.number}.`)) as Extract<Event, { type: 'lead.call' }> | undefined
  }

  /** Apply the calls of turn `t`, then settle the deliveries its prompt carried (`covered`), whose answer it was. */
  const settleLead = (id: string, t: TurnState, agent: Agent, covered: string[]) => {
    const { answer, calls } = t.lead!
    for (const [i, call] of calls.entries()) {
      if (host.act(id, leadCallId(t.number, i), call).startsWith('refused:')) break
    }
    for (const requestId of covered) host.settled(id, { requestId, status: 'done', text: answer, model: agent.model ?? `${agent.runs} default` })
  }

  /** Turns of lead `id` on its harness while deliveries wait for an answer: a recorded result is settled first (a turn
   * that ended while the supervisor was down, or a stop between two of its calls), then each turn carries the results of
   * the last turn's calls and every delivery not yet answered. A turn cut short (interrupted, stopped, or without a
   * result) applied nothing, and the next one says so; a second turn without a result, or one that exits with no
   * output, fails the lead. */
  const driveLead = async (id: string) => {
    let missed = 0
    let first = true
    for (;;) {
      if (ctx.stopping) return
      const state = current()
      const lead = state.nodes.get(id)!
      if (isFinal(lead)) return
      const agent = agentOf(state, lead)
      if (typeof agent === 'string') return abandon(state, id, agent)
      const answered = new Set(log.events.flatMap((e) => (e.type === 'lead.turn' && e.node === id ? [e.requestId] : [])))
      const pending = log.events.flatMap((e) => (e.type === 'lead.delivered' && e.node === id && !answered.has(e.requestId) ? [e] : []))
      const last = lead.turns.at(-1)
      const applied = appliedTurn(lead)
      if (applied && applied === last) {
        const since = startSeq(id, applied.number)
        const covered = pending.filter((d) => d.seq < since).map((d) => d.requestId)
        if (covered.length) {
          settleLead(id, applied, agent, covered)
          ctx.wakeUp()
          continue
        }
      }
      if (!pending.length) return
      const cut = last && last !== applied ? last.number : undefined
      const recovery = first && cut !== undefined
      first = false
      if (recovery && lead.turns.filter((t) => t.recovery).length >= MAX_RECOVERIES) {
        return abandon(state, id, `a supervisor stop cut its turn short after ${MAX_RECOVERIES} recoveries`)
      }
      const { results, skipped } = callResults(state, id)
      const prompt = leadTurnPrompt(pending.map((d) => d.text), results, skipped, cut, applied?.number)
      const out = resultsDir()
      const cwd = folder ? linkedFolder(nodeFolder(id), workspace, out) : out
      const sessionId = lead.turns.findLast((t) => t.sessionId)?.sessionId
      const number = lead.turns.length + 1
      const t = await runTurn(ctx, lead.spec, agent, number, prompt, cwd, sessionId, recovery,
        { system: HARNESS_LEAD_ROLE, ...(folder ? { readable: [workspace, out] } : {}) })
      if (ctx.stopping || isFinal(nodeNow(id))) return
      if (t.exited?.quiet) return abandon(current(), id, exitedText(number, t.exited))
      if (t.lead || nodeNow(id).turns.find((x) => x.number === number)?.interrupted) continue
      if (++missed === 2) return abandon(current(), id, `turn ${number} ended without a lead result, as did the one before${t.exited ? `; ${t.exited.stderr}` : ''}`)
    }
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

  return { runner, routeLead, send, cancelInRunner, driveLead, abandon }
}
