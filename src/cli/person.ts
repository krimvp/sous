// `sous answer`, `sous approve` and `sous cancel`: the person's commands, handed to a running run's supervisor.
import { commandRefusal } from '../commands/index.ts'
import type { PersonCommand } from '../contracts/index.ts'
import { fold, lockHolder, readEvents, writeCommand } from '../run/index.ts'
import { findRun, runningRun } from './lookup.ts'

/** Hand a person's answer, approval or cancel to a running run's supervisor through a command file: run `runId`, or
 * else the workspace's one run with a live supervisor (not the newest, which may be another). */
export function sendCommand(workspace: string, cmd: PersonCommand, runId?: string): number {
  const { id, runDir } = runId === undefined ? runningRun(workspace, cmd.type) : findRun(workspace, runId)
  const why = commandRefusal(fold(readEvents(runDir)), cmd)
  if (why) throw new Error(`run ${id}: ${why}`)
  if (lockHolder(runDir) === undefined) throw new Error(`run ${id} is not running`)
  writeCommand(runDir, cmd)
  console.log(`${cmd.type} for ${cmd.node} sent to run ${id}`)
  return 0
}
