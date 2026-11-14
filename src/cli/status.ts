// `sous status` and `sous runs`: a run's tree of nodes and what waits for the person, and the workspace's runs. Also
// where a run's results are (resultOf) and what waits for the person (printPending), which `sous run` and `sous resume`
// print too.
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { awaitsSplitApproval, fold, isFinal, listRuns, lockHolder, readEvents } from '../run/index.ts'
import type { NodeState, RunState } from '../run/index.ts'
import { findRun, runRef } from './lookup.ts'
import { duration, firstLine, lastSummary, oneLine } from './text.ts'

export function status(workspace: string, runId?: string): number {
  const { id, runDir } = findRun(workspace, runId)
  const events = readEvents(runDir)
  const state = fold(events)
  const live = state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
  console.log(`run ${id} ${live}: ${firstLine(state.goal)}`)
  if (state.reason) console.log(`  ${oneLine(state.reason)}`)
  const result = resultOf(state, runDir)
  if (result) console.log(`  result: ${result}`)
  const children = (parent?: string) => [...state.nodes.values()].filter((n) => n.spec.parent === parent)
  // A running turn's age and the age of its last output (its output file's last change), so a hung turn shows.
  const now = Date.now()
  const startedAt = new Map(events.flatMap((e) => (e.type === 'turn.started' ? [[`${e.node} ${e.turn}`, Date.parse(e.at)]] : [])))
  const running = (n: NodeState) => {
    const t = n.turns.at(-1)
    if (live !== 'running' || !t || t.ended) return ''
    let output = 'no output yet'
    try {
      const out = statSync(resolve(runDir, t.outFile))
      if (out.size) output = `last output ${duration(now - out.mtimeMs)} ago`
    } catch {}
    return ` (turn ${t.number} running for ${duration(now - startedAt.get(`${n.spec.id} ${t.number}`)!)}, ${output})`
  }
  const print = (n: NodeState, depth: number) => {
    const turns = n.turns.length ? ` turns ${n.turns.length}` : ''
    const agent = n.turns.findLast((t) => t.agent)?.agent ?? n.spec.agent
    console.log(`${'  '.repeat(depth)}${n.spec.id} ${n.status}${agent ? ` on ${agent}` : ''}${turns}${running(n)}${lastSummary(n)}`)
    for (const c of children(n.spec.id)) print(c, depth + 1)
  }
  for (const n of children(undefined)) print(n, 1)
  printPending(state, runRef(workspace, id))
  const refused = events.flatMap((e) => (e.type === 'command.refused' ? [e] : [])).slice(-3)
  if (refused.length) console.log('commands not applied (latest last):')
  for (const e of refused) console.log(`  ${e.at.slice(11, 19)} ${oneLine(e.reason)}`)
  if (live === 'stopped') console.log(`continue it with: sous resume ${id}`)
  return 0
}

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
      const live = state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
      console.log(`${id}  ${live.padEnd(9)}  ${events[0].at.slice(0, 19)}Z  ${firstLine(state.goal)}`)
    } catch (err) {
      console.log(`${id}  unreadable  ${oneLine((err as Error).message)}`)
    }
  }
  return 0
}

/** Questions, gate approvals and proposed splits waiting for the person; `r` names the run in the commands (`runRef`). */
export function printPending(state: RunState, r: string): void {
  const open = state.questions.filter((q) => !isFinal(state.nodes.get(q.from)))
  const isGate = (q: { from: string }) => state.nodes.get(q.from)?.spec.kind === 'gate'
  const isSplit = (q: { from: string }) => awaitsSplitApproval(state.nodes.get(q.from)!)
  const questions = open.filter((q) => !isGate(q) && !isSplit(q))
  const gates = open.filter(isGate)
  const splits = open.filter(isSplit)
  if (questions.length) console.log(`questions for you (sous answer <node> "<answer>"${r}):`)
  for (const q of questions) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (gates.length) console.log(`approvals for you (sous approve <node>${r}, or sous cancel <node>${r} to reject):`)
  for (const q of gates) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (splits.length) console.log(`splits for you to approve (sous approve <lead>${r}, or sous answer <lead> "<changes>"${r}):`)
  for (const q of splits) console.log(`  ${q.from}: ${oneLine(q.body)}`)
}

export function resultOf(state: RunState, runDir: string): string | undefined {
  if (state.mode === 'folder') return existsSync(join(runDir, 'output')) ? `folder ${join(runDir, 'output')}` : undefined
  return state.integration && `branch ${state.integration.branch}`
}
