// `sous diff`: what a run changed so far. In git mode `git diff` from the commit its branch started at to the branch's
// head (what is merged; a merge in progress is not), git's output passed through; in folder mode the files of its
// output folder.
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { fold, readEvents } from '../run/index.ts'
import { branchExists, filesIn, showDiff } from '../workspace/index.ts'
import { findRun } from './lookup.ts'

export function diff(workspace: string, runId: string | undefined, stat: boolean): number {
  const { id, runDir } = findRun(workspace, runId)
  const events = readEvents(runDir)
  if (fold(events).mode === 'folder') {
    const output = join(runDir, 'output')
    const files = existsSync(output) ? filesIn(output) : []
    if (!files.length) {
      console.log(`run ${id} has no files in ${output} yet`)
      return 0
    }
    let total = 0
    console.log(`${output}:`)
    for (const file of files) {
      const size = lstatSync(join(output, file)).size
      total += size
      console.log(`${String(size).padStart(10)}  ${file}`)
    }
    console.log(`${files.length} file${files.length === 1 ? '' : 's'}, ${total} bytes`)
    return 0
  }
  const created = events.find((e) => e.type === 'integration.created')
  if (!created) throw new Error(`run ${id} has no branch yet: nothing is merged`)
  if (!branchExists(workspace, created.branch)) throw new Error(`branch ${created.branch} of run ${id} no longer exists`)
  const code = showDiff(workspace, created.base, created.branch, stat)
  if (code === false) console.log(`no changes on ${created.branch} since ${created.base.slice(0, 12)}`)
  return code || 0
}
