// `sous status` and `sous runs`: a run's status (RunStatus, built by src/status/) as text or JSON, and the workspace's
// runs. Also the text of its parts that `sous run`, `sous resume` and `sous wait` print too: what waits for the person,
// where the results are, the usage and the budget.
import { join } from 'node:path'
import type { RunStatus, StatusAsk, StatusNode } from '../contracts/index.ts'
import { fold, listRuns, liveStatus, readEvents, usd } from '../run/index.ts'
import { runStatus } from '../status/index.ts'
import { findRun, runRef } from './lookup.ts'
import { duration, firstLine, oneLine } from './text.ts'

export function status(workspace: string, runId?: string, json?: boolean): number {
  const { id, runDir } = findRun(workspace, runId)
  const r = runRef(workspace, id)
  const s = runStatus(id, runDir, r)
  console.log(json ? JSON.stringify(s, null, 2) : statusText(s, r))
  return 0
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

/** Questions, gate approvals and proposed splits waiting for the person, by kind; `r` names the run in the commands. */
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

export const resultText = (result: NonNullable<RunStatus['result']>) => ('branch' in result ? `branch ${result.branch}${result.deleted ? ' (deleted)' : ''}` : `folder ${result.folder}`)

/** A cost is only what was reported: the turns that reported none are counted, not priced, and not counted against a
 * budget either, which this says once. */
export function usageText(t: NonNullable<RunStatus['usage']>): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const budget = t.maxCostUsd === undefined ? '' : ` of a ${usd(t.maxCostUsd)} budget`
  const unpriced = t.unpriced ? ` (${t.unpriced} turn${t.unpriced === 1 ? '' : 's'} reported no cost${budget ? ` and ${t.unpriced === 1 ? 'is' : 'are'} not counted against it` : ''})` : ''
  const cost = t.costUsd === undefined ? `no cost reported${budget}${unpriced}` : `${usd(t.costUsd)} cost reported${budget}${unpriced}`
  return `usage: ${n(t.input)} tokens in (${n(t.cached)} cached), ${n(t.output)} out; ${cost}`
}

/** Why a run stopped at its budget, with the limits of the number. */
export const budgetText = (b: NonNullable<RunStatus['budget']>) =>
  `stopped at its cost budget: ${usd(b.spentUsd)} reported of ${usd(b.maxCostUsd)} (a cost is known when a turn ends, so turns in flight can overshoot)`

/** The workspace's runs, newest first. */
export function runs(workspace: string): number {
  const { runsDir, ids } = listRuns(workspace)
  if (!ids.length) console.log(`no runs in ${runsDir}`)
  for (const id of ids.toReversed()) {
    const runDir = join(runsDir, id)
    try {
      const events = readEvents(runDir)
      // The log file exists before its first event is written.
      if (events[0]?.type !== 'run.created') {
        console.log(`${id}  starting`)
        continue
      }
      const state = fold(events)
      const live = liveStatus(runDir, state)
      console.log(`${id}  ${live.padEnd(9)}  ${events[0].at.slice(0, 19)}Z  ${firstLine(state.goal)}`)
    } catch (err) {
      console.log(`${id}  unreadable  ${oneLine((err as Error).message)}`)
    }
  }
  return 0
}
