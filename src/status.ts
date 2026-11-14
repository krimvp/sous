// What `sous status` and `sous wait` report about a run: one RunStatus (src/types.ts) from the fold of its log, printed
// as JSON or rendered as text. Both only read the run's files; the supervisor stays the only writer.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { branchExists, commitsNotIn } from './git.ts'
import { listRuns, lockHolder, readEvents } from './log.ts'
import { ancestors, awaitsSplitApproval, budgetResume, completedText, fold, isFinal, overBudget, usd } from './state.ts'
import type { NodeState, RunState } from './state.ts'
import { logView, runTokens } from './trace/run.ts'
import { WAIT_EXIT_CODES } from './types.ts'
import type { Event, RunLiveness, RunStatus, RunWait, StatusAsk, StatusNode, WaitReason } from './types.ts'

/** A run as `sous status` reports it: a running run without a live supervisor is stopped. */
export function liveStatus(runDir: string, state: RunState): RunLiveness {
  return state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
}

/** How `sous answer`, `approve` and `cancel` name run `id` in the commands sous prints: by its id when the workspace has
 * more than one run, else not at all. */
export const runRef = (workspace: string, id: string) => (listRuns(workspace).ids.length > 1 ? ` ${id}` : '')

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

/** A cost is only what was reported: the turns that reported none are counted, not priced, and not counted against a
 * budget either, which this says once. */
export function usageText(t: NonNullable<RunStatus['usage']>): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const budget = t.maxCostUsd === undefined ? '' : ` of a ${usd(t.maxCostUsd)} budget`
  const unpriced = t.unpriced ? ` (${t.unpriced} turn${t.unpriced === 1 ? '' : 's'} reported no cost${budget ? ` and ${t.unpriced === 1 ? 'is' : 'are'} not counted against it` : ''})` : ''
  const cost = t.costUsd === undefined ? `no cost reported${budget}${unpriced}` : `${usd(t.costUsd)} cost reported${budget}${unpriced}`
  return `usage: ${n(t.input)} tokens in (${n(t.cached)} cached), ${n(t.output)} out; ${cost}`
}

/** A run that stopped at its budget: the cost reported and the budget, while it is not over. */
export function budgetOf(state: RunState): RunStatus['budget'] {
  if (state.status !== 'running' || !(state.budgetReached || overBudget(state))) return undefined
  return { spentUsd: state.spent.costUsd, maxCostUsd: state.maxCost! }
}

/** Why a run stopped at its budget, with the limits of the number. */
export const budgetText = (b: NonNullable<RunStatus['budget']>) =>
  `stopped at its cost budget: ${usd(b.spentUsd)} reported of ${usd(b.maxCostUsd)} (a cost is known when a turn ends, so turns in flight can overshoot)`

/** For a finished git-mode run, the one line naming what the person may do next: look at the result, merge it, clean
 * up; each only while it still applies. */
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

export const resultText = (result: NonNullable<RunStatus['result']>) => ('branch' in result ? `branch ${result.branch}${result.deleted ? ' (deleted)' : ''}` : `folder ${result.folder}`)

/** Run `id`'s status now, from its log, its lock, its turns' output files and its waiting command files. */
export function runStatus(workspace: string, id: string, runDir: string): RunStatus {
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

  const r = runRef(workspace, id)
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
  const next = nextSteps(state, runDir, runRef(workspace, id))
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
    (n.checks.length ? lastLine(n.checks[n.checks.length - 1].output) : undefined)
}

/** `sous status` as text; `r` names the run in the commands of the section headers (`runRef`). */
export function statusText(s: RunStatus, r: string): string {
  const lines = [`run ${s.id} ${s.state}: ${firstLine(s.goal)}`]
  if (s.reason) lines.push(`  ${oneLine(s.reason)}`)
  if (s.budget) lines.push(`  ${budgetText(s.budget)}`)
  if (s.result) lines.push(`  result: ${resultText(s.result)}`)
  if (s.usage) lines.push(`  ${usageText(s.usage)}`)
  const parent = new Map(s.nodes.map((n) => [n.id, n.parent]))
  const depth = (n: StatusNode) => {
    let d = 1
    for (let p = n.parent; p !== undefined; p = parent.get(p)) d++
    return d
  }
  for (const n of s.nodes) {
    const turn = n.turn && ` (turn ${n.turn.number} running for ${duration(n.turn.ageSeconds * 1000)}, ${n.turn.lastOutputAgeSeconds === undefined
      ? 'no output yet' : `last output ${duration(n.turn.lastOutputAgeSeconds * 1000)} ago`})`
    lines.push(`${'  '.repeat(depth(n))}${n.id} ${n.status}${n.agent ? ` on ${n.agent}` : ''}${n.turns ? ` turns ${n.turns}` : ''}${turn ?? ''}${n.summary ? `: ${oneLine(n.summary)}` : ''}`)
  }
  lines.push(...waitingLines(s.waiting, r))
  if (s.refused.length) lines.push('commands not applied (latest last):', ...s.refused.map((e) => `  ${e.at.slice(11, 19)} ${oneLine(e.reason)}`))
  if (s.resume) lines.push(`continue it with: ${s.resume}`)
  if (s.next) lines.push(s.next)
  return lines.join('\n')
}

/** Questions, gate approvals and proposed splits waiting for the person, by kind. */
export function waitingLines(waiting: StatusAsk[], r: string): string[] {
  const sections: [StatusAsk['kind'], string][] = [
    ['question', `questions for you (sous answer <node> "<answer>"${r}):`],
    ['gate', `approvals for you (sous approve <node>${r}, or sous cancel <node>${r} to reject):`],
    ['split', `splits for you to approve (sous approve <lead>${r}, or sous answer <lead> "<changes>"${r}):`],
  ]
  return sections.flatMap(([kind, header]) => {
    const asks = waiting.filter((a) => a.kind === kind)
    return asks.length ? [header, ...asks.map((a) => `  ${a.node}: ${oneLine(a.text)}${a.sent ? ' (answer sent)' : ''}`)] : []
  })
}

const POLL_MS = 500

/** Wait until run `id` needs the person or is over, or `timeoutMs` passes. A run seen without a live supervisor is
 * looked at once more after a poll before it counts as stopped: `sous run` releases the lock for a moment between
 * creating the run and starting its supervisor. */
export async function waitRun(workspace: string, id: string, runDir: string, timeoutMs = Infinity): Promise<RunWait> {
  const deadline = Date.now() + timeoutMs
  let stoppedBefore = false
  for (;;) {
    const s = runStatus(workspace, id, runDir)
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

/** `sous wait` as text: why it returned, then the run's status. */
export function waitText(w: RunWait, r: string, timeoutSeconds?: number): string {
  const asks = w.waiting.filter((a) => !a.sent)
  const why = {
    completed: `run ${w.id} completed`,
    failed: w.state === 'completed' ? `run ${w.id} completed with failed checks` : `run ${w.id} failed`,
    waiting: `run ${w.id} waits for you: ${asks.map((a) => `${a.kind === 'question' ? 'a question from' : a.kind === 'gate' ? 'approval of gate' : 'approval of the split of'} ${a.node}`).join(', ')}`,
    stopped: w.budget ? `run ${w.id} stopped at its cost budget (${usd(w.budget.spentUsd)} reported of ${usd(w.budget.maxCostUsd)}); continue it with a higher budget: ${w.resume}`
      : `run ${w.id} stopped before it was over; continue it with: ${w.resume}`,
    timeout: `run ${w.id} still running after ${timeoutSeconds} s`,
  }[w.wait]
  return `${why} (exit ${WAIT_EXIT_CODES[w.wait]})\n${statusText(w, r)}`
}

/** A duration as 45s, 3m 05s or 2h 05m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function lastLine(output: string): string {
  return output.trimEnd().split('\n').at(-1) ?? ''
}

/** The first line of a multi-line text, marked as cut when more follows. */
export function firstLine(text: string): string {
  const [first, ...rest] = text.trim().split('\n')
  return oneLine(rest.length ? `${first}...` : first)
}

export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? line.slice(0, 157) + '...' : line
}
