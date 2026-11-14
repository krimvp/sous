// Finding a run in a workspace: by its id or the latest (findRun), the one with a live supervisor (runningRun), and how
// the commands sous prints name it (runRef).
import { join } from 'node:path'
import { fold, listRuns, lockHolder, readEvents } from '../run/index.ts'

/** How `sous answer`, `approve` and `cancel` name run `id` in the commands sous prints: by its id when the workspace has
 * more than one run, else not at all. */
export const runRef = (workspace: string, id: string) => (listRuns(workspace).ids.length > 1 ? ` ${id}` : '')

/** The run directory for `runId`, or the latest run. */
export function findRun(workspace: string, runId?: string): { id: string; runDir: string } {
  const { runsDir, ids } = listRuns(workspace)
  const id = runId ?? ids.at(-1)
  if (!id || !ids.includes(id)) throw new Error(runId ? `no run ${runId} in ${runsDir}` : `no runs in ${runsDir}`)
  return { id, runDir: join(runsDir, id) }
}

export function runningRun(workspace: string, command: string): { id: string; runDir: string } {
  const { runsDir, ids } = listRuns(workspace)
  const running = ids.filter((id) => lockHolder(join(runsDir, id)) !== undefined)
  if (running.length === 1) return { id: running[0], runDir: join(runsDir, running[0]) }
  if (running.length > 1) throw new Error(`${running.length} runs are running (${running.join(', ')}): name one, as in sous ${command} <node>${command === 'answer' ? ' "text"' : ''} <run-id>`)
  const newest = ids.at(-1)
  if (!newest) throw new Error(`no runs in ${runsDir}`)
  const status = fold(readEvents(join(runsDir, newest))).status
  throw new Error(`no run is running in ${runsDir}; the newest, ${newest}, is ${status === 'running' ? `stopped (continue it with sous resume ${newest})` : status}`)
}
