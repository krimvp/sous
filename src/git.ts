// The git layer of merging: integration and node worktrees, commits and merges, over the `git` CLI.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Murmuration's commits carry this identity, so they work without any user git config. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Murmuration',
  GIT_AUTHOR_EMAIL: 'murmuration@localhost',
  GIT_COMMITTER_NAME: 'Murmuration',
  GIT_COMMITTER_EMAIL: 'murmuration@localhost',
}

export interface Worktree {
  branch: string
  path: string
  /** The commit the branch started from. */
  base: string
}

export type MergeResult = { ok: true; commit: string } | { ok: false; files: string[] }

function run(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (r.error) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.error.message}`)
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }
}

function git(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout
}

/** The workspace must be a git repository with at least one commit. Excludes `.murm/` from git. */
export function ensureRepo(workspace: string): void {
  if (run(workspace, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).status !== 0) {
    throw new Error(`${workspace} must be a git repository with at least one commit`)
  }
  const info = join(git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info')
  const exclude = join(info, 'exclude')
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (text.split('\n').some((line) => line.trim() === '.murm/')) return
  mkdirSync(info, { recursive: true })
  appendFileSync(exclude, (text && !text.endsWith('\n') ? '\n' : '') + '.murm/\n')
}

/** Branch `murm/<run>` from the workspace's HEAD, checked out at `<runDir>/integration/`. */
export function createIntegration(workspace: string, runId: string, runDir: string): Worktree {
  return ensureWorktree(workspace, `murm/${runId}`, join(runDir, 'integration'), 'HEAD')
}

/** Branch `murm/<run>.<node>` from `fromCommit`, checked out at `<runDir>/worktrees/<node>/`. git cannot
 * have `murm/<run>/<node>` beside the branch `murm/<run>`, so the node joins the run ID with a dot. */
export function createNodeWorktree(workspace: string, runId: string, runDir: string, node: string, fromCommit: string): Worktree {
  return ensureWorktree(workspace, `murm/${runId}.${node}`, join(runDir, 'worktrees', node), fromCommit)
}

/** Creates the branch and its worktree, or returns them when they already exist (resume). */
function ensureWorktree(workspace: string, branch: string, path: string, start: string): Worktree {
  path = resolve(path)
  if (run(workspace, ['check-ref-format', `refs/heads/${branch}`]).status !== 0) {
    throw new Error(`git check-ref-format: ${branch} is not a valid branch name`)
  }
  git(workspace, ['worktree', 'prune'])
  const entry = git(workspace, ['worktree', 'list', '--porcelain']).split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))
  if (entry) {
    const at = entry[0].slice('worktree '.length)
    if (!existsSync(path) || realpathSync(at) !== realpathSync(path)) {
      throw new Error(`branch ${branch} is checked out at ${at}, not ${path}`)
    }
  } else if (run(workspace, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0) {
    git(workspace, ['worktree', 'add', path, branch])
  } else {
    git(workspace, ['worktree', 'add', '-b', branch, path, start])
  }
  const base = git(workspace, ['merge-base', start, branch])
  return { branch, path, base }
}

/** Commits every change in the worktree, untracked files included (.gitignore honoured).
 * Returns whether anything was committed. */
export function commitAll(path: string, message: string): boolean {
  git(path, ['add', '-A'])
  if (run(path, ['diff', '--cached', '--quiet']).status === 0) return false
  git(path, ['commit', '--no-verify', '-q', '-m', message])
  return true
}

/** Whether `branch` has commits that the integration worktree's branch does not. */
export function hasChanges(integrationPath: string, branch: string): boolean {
  return Number(git(integrationPath, ['rev-list', '--count', `HEAD..${branch}`])) > 0
}

/** `git merge --no-ff` of `branch` into the integration worktree. On a conflict the merge stays in
 * progress for the integrator, and the conflicted files are returned. */
export function merge(integrationPath: string, branch: string, message: string): MergeResult {
  const r = run(integrationPath, ['merge', '--no-ff', '--no-verify', '-m', message, branch])
  if (r.status === 0) return { ok: true, commit: head(integrationPath) }
  if (!mergeInProgress(integrationPath)) {
    throw new Error(`git merge --no-ff ${branch} failed in ${integrationPath}: ${r.stderr || r.stdout}`)
  }
  const files = git(integrationPath, ['diff', '--name-only', '--diff-filter=U'])
  return { ok: false, files: files ? files.split('\n') : [] }
}

export function mergeInProgress(path: string): boolean {
  return run(path, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).status === 0
}

export function abortMerge(path: string): void {
  git(path, ['merge', '--abort'])
}

export function head(path: string): string {
  return git(path, ['rev-parse', 'HEAD'])
}
