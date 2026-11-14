// `sous clean`: remove what a finished run no longer needs (its worktrees, its node branches, its folders), keeping its
// result and everything `sous status`, `ui` and `export` read (the event log, turn files, lead storage, traces). Only
// what the run's log records creating is removed, never anything found by name alone.
import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Event } from '../contracts/index.ts'
import { fold, listRuns, lockHolder, readEvents } from '../run/index.ts'
import { branchExists, commitsNotIn, deleteBranch, filesIn, pruneWorktrees, removeWorktree, uncommitted, worktreePaths } from '../workspace/index.ts'
import { findRun } from './lookup.ts'

export interface CleanOptions {
  /** Also delete the result branch `sous/<run>`, once the workspace's HEAD contains it. */
  branches?: boolean
  /** Also remove work no branch or folder of the results holds: node branches with commits the result lacks,
   * worktrees with uncommitted changes, work folders that were never collected. */
  unmerged?: boolean
  dryRun?: boolean
}

export interface CleanReport {
  /** What was (or, with `dryRun`, would be) removed, one line each. */
  removed: string[]
  /** What was kept and why, one line each. */
  kept: string[]
  /** Why `--branches` did not delete the result branch. */
  refused?: string
}

/** Why run `id` may not be cleaned now: its supervisor is alive, or it is not over (a stopped run is resumed in its
 * worktrees). */
function cleanRefusal(id: string, runDir: string, events: Event[]): string | undefined {
  const pid = lockHolder(runDir)
  if (pid !== undefined) return `run ${id} is running (supervisor pid ${pid}): clean it once it has ended`
  if (events[0]?.type !== 'run.created') return `run ${id} has not started`
  if (fold(events).status === 'running') {
    return `run ${id} is stopped, not over, and sous resume needs its worktrees: continue it with sous resume ${id} and clean it once it has ended`
  }
}

/** Removes the worktrees and node branches the run's log records creating (git mode) or its work folders (folder
 * mode); never anything found by name alone. Call after `cleanRefusal`. Cleaning again removes nothing more. */
function cleanRun(workspace: string, id: string, runDir: string, events: Event[], opts: CleanOptions): CleanReport {
  return fold(events).mode === 'folder' ? cleanFolders(runDir, events, opts) : cleanGit(workspace, id, runDir, events, opts)
}

function cleanGit(workspace: string, id: string, runDir: string, events: Event[], opts: CleanOptions): CleanReport {
  const report: CleanReport = { removed: [], kept: [] }
  const verb = opts.dryRun ? 'would remove' : 'removed'
  const show = (path: string) => relative(workspace, path) || path
  // By name and, for a path that exists, by real path: a link in the run directory to another worktree is not in the run.
  const inRun = (path: string) => resolve(path).startsWith(resolve(runDir) + sep)
    && (!existsSync(path) || realpathSync(path).startsWith(realpathSync(runDir) + sep))
  const result = events.find((e) => e.type === 'integration.created')
  const trees = [
    ...events.flatMap((e) => (e.type === 'worktree.created' ? [{ path: e.path, branch: e.branch, node: e.node as string | undefined }] : [])),
    ...(result ? [{ path: result.path, branch: result.branch, node: undefined }] : []),
  ].filter((t, i, all) => inRun(t.path) && (t.branch === `sous/${id}` || t.branch.startsWith(`sous/${id}.`)) && all.findIndex((u) => u.path === t.path) === i)
  const attempt = (what: string, act: () => void): boolean => {
    try {
      if (!opts.dryRun) act()
      report.removed.push(`${verb} ${what}`)
      return true
    } catch (err) {
      report.kept.push(`kept ${what}: ${(err as Error).message.split('\n')[0]}`)
      return false
    }
  }

  // Worktrees first: git deletes no branch a worktree has checked out.
  const registered = worktreePaths(workspace)
  const keptTrees = new Set<string>()
  for (const t of trees) {
    // Gone already (cleaned before), or never a worktree of this repository.
    if (!existsSync(t.path) || !registered.has(realpathSync(t.path))) continue
    const dirty = uncommitted(t.path).length
    const what = `worktree ${show(t.path)}`
    if (dirty && !opts.unmerged) {
      report.kept.push(`kept ${what}: ${dirty} uncommitted change${dirty === 1 ? '' : 's'} (--unmerged removes it)`)
      keptTrees.add(t.branch)
    } else if (!attempt(what, () => removeWorktree(workspace, t.path, dirty > 0))) keptTrees.add(t.branch)
  }
  if (!opts.dryRun) {
    pruneWorktrees(workspace)
    // The folder that held the node worktrees, once empty.
    try { rmdirSync(join(runDir, 'worktrees')) } catch {}
  }

  const resultExists = result !== undefined && branchExists(workspace, result.branch)
  for (const t of trees.filter((t) => t.node !== undefined)) {
    if (!branchExists(workspace, t.branch)) continue
    if (keptTrees.has(t.branch)) {
      report.kept.push(`kept branch ${t.branch}: its worktree is kept`)
      continue
    }
    const unmerged = commitsNotIn(workspace, t.branch, [...(resultExists ? [`refs/heads/${result!.branch}`] : []), 'HEAD'])
    if (unmerged && !opts.unmerged) {
      report.kept.push(`kept branch ${t.branch}: ${unmerged} commit${unmerged === 1 ? '' : 's'} not in ${resultExists ? result!.branch : 'HEAD'} (--unmerged deletes it)`)
    } else attempt(`branch ${t.branch}${unmerged ? ` (${unmerged} unmerged commit${unmerged === 1 ? '' : 's'})` : ''}`, () => deleteBranch(workspace, t.branch))
  }

  if (result && resultExists) {
    if (!opts.branches) report.kept.push(`kept branch ${result.branch}: the result (once it is merged, --branches deletes it)`)
    else if (keptTrees.has(result.branch)) report.refused = `branch ${result.branch} is not deleted: its worktree is kept`
    else if (commitsNotIn(workspace, result.branch, ['HEAD'])) {
      report.refused = `branch ${result.branch} is not deleted: it is not merged into HEAD; merge it first (git merge ${result.branch}) or keep it`
    } else if (!attempt(`branch ${result.branch} (merged into HEAD)`, () => deleteBranch(workspace, result.branch))) {
      report.refused = `branch ${result.branch} is not deleted`
    }
  }
  return report
}

/** Folder mode: each node's folder under `work/` goes, except a work node's that holds files never collected. The
 * output folder stays. `rmSync` removes the `workspace` and `results` links, not what they point to. */
function cleanFolders(runDir: string, events: Event[], opts: CleanOptions): CleanReport {
  const report: CleanReport = { removed: [], kept: [] }
  const state = fold(events)
  const work = join(runDir, 'work')
  const collected = new Set(events.flatMap((e) => (e.type === 'merge.done' ? [e.node] : [])))
  for (const name of existsSync(work) ? readdirSync(work).sort() : []) {
    const dir = join(work, name)
    const spec = state.nodes.get(name)?.spec
    const files = filesIn(dir).filter((f) => f !== 'workspace' && f !== 'results').length
    if (spec?.kind === 'work' && !spec.standing && !collected.has(name) && files && !opts.unmerged) {
      report.kept.push(`kept folder work/${name}: ${files} file${files === 1 ? '' : 's'} not collected into output/ (--unmerged removes it)`)
      continue
    }
    if (!opts.dryRun) rmSync(dir, { recursive: true, force: true })
    report.removed.push(`${opts.dryRun ? 'would remove' : 'removed'} folder work/${name}`)
  }
  if (!opts.dryRun) try { rmdirSync(work) } catch {}
  if (existsSync(join(runDir, 'output'))) report.kept.push(`kept folder ${join(runDir, 'output')}: the result`)
  return report
}

/** Clean run `ids[0]` (the latest without one), or with `ids` undefined every finished run, printing what was removed
 * and kept. A run that may not be cleaned is refused (skipped with --all). */
export function clean(workspace: string, ids: string[] | undefined, opts: CleanOptions): number {
  const all = ids === undefined
  const runs = all ? listRuns(workspace).ids.map((id) => ({ id, runDir: join(listRuns(workspace).runsDir, id) })) : [findRun(workspace, ids[0])]
  if (all && !runs.length) console.log(`no runs in ${listRuns(workspace).runsDir}`)
  let code = 0
  for (const { id, runDir } of runs) {
    const events = readEvents(runDir)
    const why = cleanRefusal(id, runDir, events)
    if (why && !all) throw new Error(why)
    if (why) {
      console.log(`skipped ${why}`)
      continue
    }
    const report = cleanRun(workspace, id, runDir, events, opts)
    console.log(`run ${id} (${fold(events).status})${opts.dryRun ? ', dry run' : ''}:`)
    if (!report.removed.length) console.log('  nothing to remove')
    for (const line of [...report.removed, ...report.kept]) console.log(`  ${line}`)
    if (report.refused) {
      console.error(`sous: ${report.refused}`)
      code = 1
    }
  }
  return code
}
