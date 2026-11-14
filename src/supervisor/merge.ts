// The merge queue: merge (git mode) or collect (folder mode) the first queued node into the results, one at a time;
// run its check after a clean merge; hand a conflict or a failing check to the integrator and verify its answer
// (integrate); fail a merge and drop it from the integration branch (mergeFailed).
import { INTEGRATOR } from '../contracts/index.ts'
import type { NodeSpec } from '../contracts/index.ts'
import { integratorAgent } from '../definitions/index.ts'
import { INTEGRATOR_BRIEF, inboxPrompt, integratorPrompt, mergeRequest, recoveryPrompt } from '../prompts/index.ts'
import { isFinal } from '../run/index.ts'
import type { InboxMessage, NodeState, RunState } from '../run/index.ts'
import { changedFiles, collect, hasChanges, head, merge, mergedOnto, mergeInProgress, resetTo, uncommitted, withConflictMarkers } from '../workspace/index.ts'
import { SUPERVISOR } from './context.ts'
import type { Context } from './context.ts'
import { check, exitedText, runTurn } from './turns.ts'

/** Drop the node's merge from the integration branch and fail the node; its parent hears of it. */
const mergeFailed = (ctx: Context, id: string, reason: string, onto?: string) => {
  if (onto) resetTo(ctx.integrationTree().path, onto)
  ctx.log.append({ type: 'merge.failed', node: id, reason })
}

/** Folder mode: add a finished node's files to the output folder. Collecting again after a crash changes nothing.
 * Messages that arrived while it waited come first, as in git mode: it leaves the queue and its worker resumes. */
const collectFiles = (ctx: Context, n: NodeState) => {
  const { runDir, log, nodeNow, nodeFolder, resultsDir } = ctx
  const { spec } = n
  if (n.inbox.length) return void log.append({ type: 'merge.withdrawn', node: spec.id })
  try {
    const { files, renamed } = collect(nodeFolder(spec.id), resultsDir(), spec.id, runDir)
    log.append({ type: 'merge.done', node: spec.id, by: files.length ? 'supervisor' : 'nothing', files, ...(Object.keys(renamed).length ? { renamed } : {}) })
  } catch (err) {
    if (!ctx.stopping && !isFinal(nodeNow(spec.id))) log.append({ type: 'merge.failed', node: spec.id, reason: `supervisor error: ${(err as Error).message}` })
  }
}

/** Merge (or, in folder mode, collect) the first node of the queue into the results: one at a time, in queue order. */
export const mergeNext = async (ctx: Context) => {
  const { folder, log, current, nodeNow, integrationTree } = ctx
  const n = [...current().nodes.values()].filter((n) => n.status === 'merging').sort((a, b) => a.merge!.queued - b.merge!.queued)[0]
  if (!n) return
  const { spec } = n
  if (folder) return collectFiles(ctx, n)
  const { conflict } = n.merge!
  const branch = n.merge!.branch!
  let onto = conflict?.onto
  try {
    const { path } = integrationTree()
    if (conflict) return await integrate(ctx, spec, conflict.onto)
    // A clean tree at its head: a merge a stopped supervisor left in progress never reached the integrator, so it
    // starts again, and what the last check run here left behind (changed or new files) would refuse this merge.
    let commit = head(path)
    resetTo(path, commit)
    onto = mergedOnto(path, branch) // the merge finished before the stop
    // Messages that arrived while it waited come first: it leaves the queue and its worker resumes with them.
    if (onto === undefined && n.inbox.length) return void log.append({ type: 'merge.withdrawn', node: spec.id })
    if (onto === undefined) {
      if (!hasChanges(path, branch)) return void log.append({ type: 'merge.done', node: spec.id, commit, by: 'nothing', files: [] })
      onto = commit
      const r = merge(path, branch, `sous: merge ${spec.id}`)
      if (!r.ok) {
        log.append({ type: 'merge.conflict', node: spec.id, reason: `conflict in ${r.files.join(', ')}`, files: r.files, onto })
        return await integrate(ctx, spec, onto)
      }
      commit = r.commit
    }
    if (spec.command) {
      const c = await check(ctx, spec.id, spec.command, path)
      if (ctx.stopping) return
      // Cancelled meanwhile: its merge leaves the integration branch, as when the integrator works on it.
      if (isFinal(nodeNow(spec.id))) return resetTo(path, onto)
      resetTo(path, commit) // what the check left behind is not part of the merge
      if (c.exitCode !== 0) {
        log.append({ type: 'merge.conflict', node: spec.id, reason: `check failed after the merge (exit ${c.exitCode})`, files: [], onto })
        return await integrate(ctx, spec, onto)
      }
    }
    log.append({ type: 'merge.done', node: spec.id, commit, by: 'supervisor', files: changedFiles(path, onto, branch) })
  } catch (err) {
    if (ctx.stopping) return
    if (isFinal(nodeNow(spec.id))) {
      // Cancelled meanwhile: what of its merge reached the integration branch leaves it, as on the paths above.
      try {
        if (onto) resetTo(integrationTree().path, onto)
      } catch {}
      return
    }
    try {
      mergeFailed(ctx, spec.id, `supervisor error: ${(err as Error).message}`, onto)
    } catch {
      log.append({ type: 'merge.failed', node: spec.id, reason: `supervisor error: ${(err as Error).message}` })
    }
  }
}

/** The integrator's request for the node's merge, from its recorded conflict (and the check after a clean merge). */
const requestFor = (ctx: Context, state: RunState, id: string) => {
  const n = state.nodes.get(id)!
  const merged = [...state.nodes.values()].filter((m) => m.status === 'completed' && m.merge).sort((a, b) => a.endSeq! - b.endSeq!).map((m) => m.spec)
  const files = n.merge!.conflict!.files
  return mergeRequest(n.spec, n.merge!.branch!, ctx.integrationTree().branch, files, merged, files.length ? undefined : n.turns.at(-1)?.check)
}

/** Hand the node's merge to the integrator and verify its answer: no merge in progress, nothing left uncommitted, and
 * the node's check passes. One retry; then, or when the integrator is blocked, the merge fails. */
const integrate = async (ctx: Context, spec: NodeSpec, onto: string) => {
  const { unavailable, log, current, nodeNow, agentOf, integrationTree } = ctx
  const id = spec.id
  const { path, branch } = integrationTree()
  const { conflict } = nodeNow(id).merge!
  const nodeBranch = nodeNow(id).merge!.branch!
  if (!current().nodes.has(INTEGRATOR)) {
    const agent = integratorAgent(current().agents, unavailable)
    if (!agent) return mergeFailed(ctx, id, 'no agent is available for the integrator', onto)
    log.append({ type: 'node.added', node: { id: INTEGRATOR, kind: 'work', standing: true, agent, brief: INTEGRATOR_BRIEF }, by: SUPERVISOR })
  }
  const since = conflict!.seq
  const requests = () => log.events.filter((e) => e.seq > since && e.type === 'message' && e.from === SUPERVISOR && e.to === INTEGRATOR).length
  const request = (body: string) => log.append({ type: 'message', from: SUPERVISOR, to: INTEGRATOR, body, mode: 'queue' })
  if (!requests()) request(requestFor(ctx, current(), id))
  // After a restart, the integrator's last turn may have answered (or been cut short) already.
  let first = true
  for (;;) {
    if (ctx.stopping) return
    if (isFinal(nodeNow(id))) return resetTo(path, onto) // cancelled meanwhile
    const state = current()
    const ig = state.nodes.get(INTEGRATOR)!
    if (isFinal(ig)) return mergeFailed(ctx, id, `the integrator ${ig.status}`, onto)
    const last = ig.turns.at(-1)
    const recorded = first && !ig.inbox.length && last?.ended
    first = false
    let result = recorded ? last.result : undefined
    if (!result) {
      const agent = agentOf(state, ig)
      if (typeof agent === 'string') return mergeFailed(ctx, id, agent, onto)
      const sessionId = ig.turns.findLast((t) => t.sessionId)?.sessionId
      const inbox: InboxMessage[] = ig.inbox.length ? ig.inbox : [{ seq: 0, from: SUPERVISOR, body: requestFor(ctx, state, id), mode: 'queue' }]
      const prompt = !sessionId ? integratorPrompt(state.goal, ig.spec, path, branch, inbox, agent.instructions)
        : recorded ? recoveryPrompt(ig.inbox) : inboxPrompt(ig.inbox)
      const t = await runTurn(ctx, ig.spec, agent, ig.turns.length + 1, prompt, path, sessionId, !!recorded)
      if (ctx.stopping) return
      // A node cancelled meanwhile is handled at the top of the loop.
      if (t.exited?.quiet && !isFinal(nodeNow(id))) return mergeFailed(ctx, id, `the integrator's ${exitedText(ig.turns.length + 1, t.exited)}`, onto)
      result = t.result
      if (nodeNow(INTEGRATOR).inbox.length) continue // messages that arrived meanwhile come first
    }
    if (result && result.status !== 'done') {
      return mergeFailed(ctx, id, `the integrator is ${result.status}: ${result.question ?? result.summary}`, onto)
    }
    const left = result && !mergeInProgress(path) ? uncommitted(path) : []
    let why = !result ? 'your last turn ended without the required structured result'
      : mergeInProgress(path) ? 'the merge is still in progress: resolve every conflict and commit the merge'
      : left.length ? `uncommitted changes remain in ${left.slice(0, 5).join(', ')}${left.length > 5 ? ` and ${left.length - 5} more` : ''}: `
        + 'commit what belongs to the merge and delete the rest'
      : hasChanges(path, nodeBranch) ? `branch ${nodeBranch} is not merged`
      : undefined
    const marked = why ? [] : withConflictMarkers(path, conflict!.files)
    if (marked.length) why = `conflict markers remain in ${marked.join(', ')}`
    if (!why && spec.command) {
      const c = await check(ctx, id, spec.command, path)
      if (ctx.stopping) return
      resetTo(path, head(path)) // what the check left behind is not part of the merge
      if (c.exitCode !== 0) why = `its check still fails (exit code ${c.exitCode}):\n${c.output.trimEnd()}`
    }
    if (isFinal(nodeNow(id))) continue
    if (!why) return void log.append({ type: 'merge.done', node: id, commit: head(path), by: 'integrator', files: changedFiles(path, onto, nodeBranch) })
    if (requests() > 1) return mergeFailed(ctx, id, `not verified after a retry: ${why.split('\n')[0]}`, onto)
    request(`Node ${id} is not merged yet: ${why}\n\nFix it and commit, then report done again.`)
  }
}
