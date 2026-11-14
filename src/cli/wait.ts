// `sous wait`: block until a run needs the person or is over (or the timeout), print why with its status, as text or
// JSON, and exit with the code that says which (WAIT_EXIT_CODES).
import { WAIT_EXIT_CODES } from '../contracts/index.ts'
import type { RunWait } from '../contracts/index.ts'
import { usd } from '../run/index.ts'
import { waitRun } from '../status/index.ts'
import { findRun, runRef } from './lookup.ts'
import { statusText } from './status.ts'

export async function wait(workspace: string, runId?: string, timeoutSeconds?: number, json?: boolean): Promise<number> {
  const { id, runDir } = findRun(workspace, runId)
  const r = runRef(workspace, id)
  const w = await waitRun(id, runDir, r, timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000)
  console.log(json ? JSON.stringify(w, null, 2) : waitText(w, r, timeoutSeconds))
  return WAIT_EXIT_CODES[w.wait]
}

/** `sous wait` as text: why it returned, then the run's status. */
function waitText(w: RunWait, r: string, timeoutSeconds?: number): string {
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
