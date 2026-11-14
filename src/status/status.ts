// A run's status (RunStatus, src/contracts/status.ts) from the fold of its log, its lock, its running turns' output files
// and its unapplied command files; the waiting of `sous wait` on it; and the parts `sous run` prints at its end (where
// the results are, the usage, the budget, the next steps). Only reads the run's files: the supervisor stays the only
// writer.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Event, RunStatus, RunWait, StatusAsk, StatusNode, WaitReason } from '../contracts/index.ts'
import { ancestors, awaitsSplitApproval, budgetResume, completedText, fold, isFinal, liveStatus, overBudget, readEvents } from '../run/index.ts'
import type { NodeState, RunState } from '../run/index.ts'
import { logView, runTokens } from '../trace/index.ts'
import { branchExists, commitsNotIn } from '../workspace/index.ts'

/** The results of the run: its branch, or its output folder once it exists. */
export function resultOf(state: RunState, runDir: string): RunStatus['result'] {
  if (state.mode === 'folder') return existsSync(join(runDir, 'output')) ? { folder: join(runDir, 'output') } : undefined
  if (!state.integration) return undefined
  const { branch } = state.integration
  return branchExists(state.workspace, branch) ? { branch } : { branch, deleted: true }
}

/** The run's tokens and the cost its harnesses reported, from the log alone, as the UI totals them, with the run's budget
 * (`maxCost`); nothing when no turn recorded usage and the run has no budget. */
export function runUsage(runDir: string, maxCost?: number): RunStatus['usage'] {
  const t = runTokens(logView(runDir))
  if (t.costUsd === undefined && !t.unpriced && maxCost === undefined) return undefined
  return maxCost === undefined ? t : { ...t, maxCostUsd: maxCost }
}

/** A run that stopped at its budget: the cost reported and the budget, while it is not over. */
export function budgetOf(state: RunState): RunStatus['budget'] {
  if (state.status !== 'running' || !(state.budgetReached || overBudget(state))) return undefined
  return { spentUsd: state.spent.costUsd, maxCostUsd: state.maxCost! }
}

/** For a finished git-mode run, the one line naming what the person may do next: look at the result, merge it, clean
 * up; each only while it still applies. `r` names the run in the commands (`runRef` in src/cli/lookup.ts). */
export function nextSteps(state: RunState, runDir: string, r: string): string | undefined {
  if (state.mode === 'folder' || state.status === 'running' || !state.integration) return undefined
  const { branch } = state.integration
  const exists = branchExists(state.workspace, branch)
  const merged = exists && commitsNotIn(state.workspace, branch, ['HEAD']) === 0
  const leftovers = readEvents(runDir).some((e) => (e.type === 'integration.created' || e.type === 'worktree.created') && existsSync(e.path))
  const steps = [
    ...(exists ? [`sous diff${r}`] : []),
    ...(exists && !merged && state.status === 'completed' ? [`git merge ${branch}`] : []),
    ...(merged ? [`sous clean --branches${r}`] : leftovers ? [`sous clean${r}`] : []),
  ]
  return steps.length ? `next: ${steps.join(', then ')}` : undefined
}

/** Run `id`'s status now, from its log, its lock, its turns' output files and its waiting command files. `r` names the
 * run in the commands it gives (`runRef` in src/cli/lookup.ts: the id when the workspace has several runs). */
export function runStatus(id: string, runDir: string, r: string): RunStatus {
  const events = readEvents(runDir)
  const state = fold(events)
  const live = liveStatus(runDir, state)
  const now = Date.now()
  const at = new Date(now).toISOString()
  const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))
  const startedAt = new Map(events.flatMap((e) => (e.type === 'turn.started' ? [[`${e.node} ${e.turn}`, e.at]] : [])))
  const nodes: StatusNode[] = []
  const add = (n: NodeState) => {
    const last = n.turns.at(-1)
    const node: StatusNode = { id: n.spec.id, kind: n.spec.kind, status: n.status, turns: n.turns.length }
    if (n.spec.parent !== undefined) node.parent = n.spec.parent
    if (n.spec.standing) node.standing = true
    const agent = n.turns.findLast((t) => t.agent)?.agent ?? n.spec.agent
    if (agent !== undefined) node.agent = agent
    const summary = summaryOf(n)
    if (summary !== undefined) node.summary = summary
    if (n.failedChecks?.length) node.failedChecks = n.failedChecks
    // A running turn's age and the age of its last output (its output file's last change), so a hung turn shows.
    if (live === 'running' && last && !last.ended) {
      const started = startedAt.get(`${n.spec.id} ${last.number}`)!
      node.turn = { number: last.number, startedAt: started, ageSeconds: seconds(now - Date.parse(started)) }
      try {
        const out = statSync(resolve(runDir, last.outFile))
        if (out.size) Object.assign(node.turn, { lastOutputAt: out.mtime.toISOString(), lastOutputAgeSeconds: seconds(now - out.mtimeMs) })
      } catch {}
    }
    nodes.push(node)
    for (const c of state.nodes.values()) if (c.spec.parent === n.spec.id) add(c)
  }
  for (const n of state.nodes.values()) if (n.spec.parent === undefined) add(n)

  const sent = sentCommands(runDir, events)
  const waiting = state.questions.filter((q) => !isFinal(state.nodes.get(q.from))).map((q): StatusAsk => {
    const node = state.nodes.get(q.from)
    const kind = node?.spec.kind === 'gate' ? 'gate' : node && awaitsSplitApproval(node) ? 'split' : 'question'
    const commands: StatusAsk['commands'] = kind === 'gate' ? { approve: `sous approve ${q.from}${r}`, reject: `sous cancel ${q.from}${r}` }
      : kind === 'split' ? { approve: `sous approve ${q.from}${r}`, answer: `sous answer ${q.from} "<changes>"${r}` }
      : { answer: `sous answer ${q.from} "<answer>"${r}` }
    const ask: StatusAsk = { kind, node: q.from, text: q.body, seq: q.seq, commands }
    const answered = sent.some((c) => c.node === q.from || (c.type === 'cancel' && ancestors(state, q.from).some((a) => a.spec.id === c.node)))
    if (answered) ask.sent = true
    return ask
  })
  const refused = events.flatMap((e) => (e.type === 'command.refused' ? [{ at: e.at, reason: e.reason }] : [])).slice(-3)
  const result = resultOf(state, runDir)
  const usage = runUsage(runDir, state.maxCost)
  const budget = budgetOf(state)
  const next = nextSteps(state, runDir, r)
  return {
    id, state: live, goal: state.goal, mode: state.mode,
    ...(state.summary !== undefined ? { summary: state.summary } : {}),
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    ...(budget ? { budget } : {}),
    nodes, waiting, refused,
    ...(live === 'stopped' ? { resume: budget ? budgetResume(id) : `sous resume ${id}` } : {}),
    ...(next ? { next } : {}),
    at,
  }
}

/** The person's answers, approvals and cancels in the run's `commands/` that the supervisor has not applied yet (it
 * records a command's effect, naming its file, before it removes the file). */
function sentCommands(runDir: string, events: readonly Event[]): { type: string; node: string }[] {
  const dir = join(runDir, 'commands')
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const applied = new Set(events.flatMap((e) => ('command' in e && typeof e.command === 'string' ? [e.command] : [])))
  return files.filter((f) => !applied.has(f)).flatMap((f) => {
    try {
      const cmd = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      return ['answer', 'approve', 'cancel'].includes(cmd?.type) && typeof cmd.node === 'string' ? [{ type: cmd.type, node: cmd.node }] : []
    } catch {
      // Removed by the supervisor since it was listed.
      return []
    }
  })
}

function summaryOf(n: NodeState): string | undefined {
  return n.reason ?? (n.failedChecks?.length ? completedText(n) : undefined) ?? n.turns.findLast((t) => t.result)?.result?.summary ?? n.summary ??
    (n.checks.length ? n.checks[n.checks.length - 1].output.trimEnd().split('\n').at(-1) : undefined)
}

const POLL_MS = 500

/** Wait until run `id` needs the person or is over, or `timeoutMs` passes. A run seen without a live supervisor is
 * looked at once more after a poll before it counts as stopped: `sous run` releases the lock for a moment between
 * creating the run and starting its supervisor. */
export async function waitRun(id: string, runDir: string, r: string, timeoutMs = Infinity): Promise<RunWait> {
  const deadline = Date.now() + timeoutMs
  let stoppedBefore = false
  for (;;) {
    const s = runStatus(id, runDir, r)
    const failedChecks = s.nodes.some((n) => n.parent === undefined && !n.standing && n.failedChecks?.length)
    let reason: WaitReason | undefined
    if (s.state === 'completed') reason = failedChecks ? 'failed' : 'completed'
    else if (s.state === 'failed') reason = 'failed'
    else if (s.state === 'stopped' && stoppedBefore) reason = 'stopped'
    else if (s.state === 'running' && s.waiting.some((a) => !a.sent)) reason = 'waiting'
    if (reason) return { ...s, wait: reason }
    const confirming = s.state === 'stopped'
    stoppedBefore = confirming
    if (!confirming && Date.now() >= deadline) return { ...s, wait: 'timeout' }
    await sleep(confirming ? POLL_MS : Math.min(POLL_MS, deadline - Date.now()))
  }
}
