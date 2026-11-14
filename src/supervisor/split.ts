// The splitter: take a splitter agent's first requested split (splitNext), run its standing node in its own worktree or
// folder until it writes a proposal that is valid as a spawn of the lead (split), and read the proposal file. Owns
// splitFor, the lead each splitter's running turn works for, so the main loop can stop it when that lead finishes.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CHILDREN, roleNode, SPLITTER } from '../contracts/index.ts'
import type { ChildSpec } from '../contracts/index.ts'
import { childAgents, roleChoices } from '../definitions/index.ts'
import { inboxPrompt, recoveryPrompt, splitRequest, SPLITTER_BRIEF, splitterPrompt } from '../prompts/index.ts'
import { childrenOf, isFinal } from '../run/index.ts'
import type { InboxMessage } from '../run/index.ts'
import { createNodeWorktree, head, linkedFolder, resetTo } from '../workspace/index.ts'
import { SUPERVISOR } from './context.ts'
import type { Context } from './context.ts'
import { depthOf, notesFor, refusal } from './policy.ts'
import { exitedText, runTurn } from './turns.ts'

/** The parts in a proposal file, or why there are none. */
function readProposal(file: string): ChildSpec[] | string {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? `no proposal was written to ${file}` : `${file} is not valid JSON: ${(err as Error).message}`
  }
  const parts = (raw as { parts?: unknown })?.parts
  return Array.isArray(parts) ? parts : `${file} must hold a JSON object {"parts": [...]}`
}

export function createSplitter(ctx: Context) {
  const { workspace, runDir, runId, folder, unavailable, log, current, nodeNow, agentOf, nodeFolder, resultsDir } = ctx

  // By splitter node, the lead whose split its running turn works on: the turn stops when that lead finishes.
  const splitFor = new Map<string, string>()

  /** Ask splitter `agent` for its first requested split and record its proposal once it is valid as a spawn of the lead.
   * Each splitter agent is its own standing node with its own worktree, reset to the integration branch before each
   * request (folder mode: its own folder, linking the workspace and the results), so what it reads is current and
   * nothing it writes reaches the run. One retry for an invalid proposal;
   * then, or when the splitter is blocked or cannot run, the split fails and the lead splits on its own. */
  const splitNext = async (agent: string) => {
    const lead = [...current().nodes.values()].filter((n) => n.split?.status === 'requested' && n.split.agent === agent)
      .sort((a, b) => a.split!.seq - b.split!.seq)[0]
    if (!lead) return
    const id = lead.spec.id
    const failed = (reason: string) => void log.append({ type: 'split.failed', node: id, reason })
    try {
      await split(id, agent, roleNode(SPLITTER, agent), failed)
    } catch (err) {
      if (!ctx.stopping) failed(`supervisor error: ${(err as Error).message}`)
    }
  }

  const split = async (id: string, agent: string, node: string, failed: (reason: string) => void) => {
    if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
    let results: string
    try {
      results = resultsDir()
    } catch (err) {
      return failed((err as Error).message)
    }
    if (!current().nodes.has(node)) {
      log.append({ type: 'node.added', node: { id: node, kind: 'work', standing: true, agent, brief: SPLITTER_BRIEF }, by: SUPERVISOR })
    }
    const file = join(runDir, 'splits', `${id}.json`)
    // Git mode: its own worktree, reset to the integration branch for each request. Folder mode: its own folder with the
    // links workspace/ and results/, which always show the current results.
    let cwd = nodeFolder(node)
    if (folder) linkedFolder(cwd, workspace, results)
    else {
      const tree = createNodeWorktree(workspace, runId, runDir, node, head(results))
      if (tree.base) log.append({ type: 'worktree.created', node, branch: tree.branch, path: tree.path, base: tree.base })
      cwd = tree.path
    }
    // A splitter takes its splits one at a time in request order, so this one's messages are those after it was requested
    // and after every other split of this splitter settled: a lead requested while an earlier split ran must not count
    // that split's messages.
    const before = current()
    const since = Math.max(before.nodes.get(id)!.split!.seq,
      ...[...before.nodes.values()].flatMap((n) => (n.split?.agent === agent ? n.split.endSeq ?? [] : [])))
    const ours = (): InboxMessage[] => log.events.flatMap((e) =>
      e.seq > since && e.type === 'message' && e.from === SUPERVISOR && e.to === node ? [{ seq: e.seq, from: e.from, body: e.body, mode: e.mode }] : [])
    const requests = () => ours().length
    const request = (body: string) => log.append({ type: 'message', from: SUPERVISOR, to: node, body, mode: 'queue' })
    mkdirSync(join(runDir, 'splits'), { recursive: true })
    if (!requests()) {
      const commit = folder ? undefined : head(results)
      if (commit) resetTo(cwd, commit)
      rmSync(file, { force: true })
      const state = current()
      const used = [...state.nodes.values()].filter((n) => !n.spec.standing).map((n) => n.spec.id)
      request(splitRequest(state.nodes.get(id)!.spec, notesFor(state, id), childAgents(state.agents, unavailable), depthOf(state, id),
        { cwd, commit, file, used, maxParts: MAX_CHILDREN - childrenOf(state, id).length, roleChoices: roleChoices(state.definitions, unavailable) }))
    }
    // After a restart, the splitter's last turn may have answered (or been cut short) already.
    let first = true
    for (;;) {
      if (ctx.stopping) return
      const state = current()
      const sp = state.nodes.get(node)!
      if (isFinal(sp)) return failed(`splitter ${node} ${sp.status}`)
      const last = sp.turns.at(-1)
      const recorded = first && !sp.inbox.length && last?.ended
      first = false
      let result = recorded ? last.result : undefined
      if (!result) {
        const runs = agentOf(state, sp)
        if (typeof runs === 'string') return failed(runs)
        const sessionId = sp.turns.findLast((t) => t.sessionId)?.sessionId
        // A turn cut short may have stopped before the splitter read its prompt: a recovery turn repeats this split's
        // messages, and so does a first prompt whose request a cut-short turn already took from the inbox.
        const inbox = recorded || !sp.inbox.length ? ours() : sp.inbox
        const prompt = !sessionId ? splitterPrompt(state.goal, sp.spec, inbox, runs.instructions, state.mode)
          : recorded ? recoveryPrompt(inbox) : inboxPrompt(inbox)
        splitFor.set(node, id)
        let t
        try {
          t = await runTurn(ctx, sp.spec, runs, sp.turns.length + 1, prompt, cwd, sessionId, !!recorded)
        } finally {
          splitFor.delete(node)
        }
        if (ctx.stopping) return
        if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
        if (t.exited?.quiet) return failed(`the splitter's ${exitedText(sp.turns.length + 1, t.exited)}`)
        result = t.result
        if (nodeNow(node).inbox.length) continue // messages that arrived meanwhile come first
      }
      if (isFinal(nodeNow(id))) return failed(`${id} finished before its split`)
      if (result && result.status !== 'done') return failed(`the splitter is ${result.status}: ${result.question ?? result.summary}`)
      const parts = result ? readProposal(file) : 'your last turn ended without the required structured result'
      const why = typeof parts === 'string' ? parts : refusal(current(), id, { tool: 'spawn', children: parts })
      if (!why) return void log.append({ type: 'split.proposed', node: id, parts: parts as ChildSpec[], summary: result!.summary })
      if (requests() > 1) return failed(`no valid proposal after a retry: ${why}`)
      request(`Your proposal for lead ${id} is not valid: ${why}\n\nWrite a corrected proposal to ${file}, then report done again.`)
    }
  }

  return { splitNext, splitFor: splitFor as ReadonlyMap<string, string> }
}
