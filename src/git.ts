// The git layer of merging: integration and node worktrees, commits and merges, over the `git` CLI.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** sous's commits carry this identity, so they work without any user git config. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'sous',
  GIT_AUTHOR_EMAIL: 'sous@localhost',
  GIT_COMMITTER_NAME: 'sous',
  GIT_COMMITTER_EMAIL: 'sous@localhost',
}

export interface Worktree {
  branch: string
  path: string
  /** The commit the branch started from; only when this call created the branch. On resume the
   * `integration.created` / `worktree.created` event holds it. */
  base?: string
}

export type MergeResult = { ok: true; commit: string } | { ok: false; files: string[] }

function run(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (r.error) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.error.message}`)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
}

function git(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout.trim()}`)
  return r.stdout.trim()
}

/** Whether `git` runs and `dir` is inside a git work tree: then a run there uses git mode, otherwise folder mode. */
export function inWorkTree(dir: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' })
  return !r.error && r.status === 0 && r.stdout.trim() === 'true'
}

/** The top level of the git work tree that holds `dir`, if there is one. */
export function repoRoot(dir: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  return !r.error && r.status === 0 ? r.stdout.trim() : undefined
}

/** How many entries `git status` lists (changed paths and untracked files or folders), not counting `.sous/`. It takes
 * no index lock, so it cannot get in the way of the person's own git. */
export function dirtyChanges(workspace: string): number {
  return git(workspace, ['--no-optional-locks', 'status', '--porcelain', '--', '.', ':(exclude).sous']).split('\n').filter(Boolean).length
}

/** The workspace must be a git repository with at least one commit. Excludes `.sous/` from git. */
export function ensureRepo(workspace: string): void {
  if (run(workspace, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).status !== 0) {
    throw new Error(`${workspace} must be a git repository with at least one commit`)
  }
  const info = join(git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info')
  const exclude = join(info, 'exclude')
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (text.split('\n').some((line) => line.trim() === '.sous/')) return
  mkdirSync(info, { recursive: true })
  appendFileSync(exclude, (text && !text.endsWith('\n') ? '\n' : '') + '.sous/\n')
}

/** Branch `sous/<run>` from the workspace's HEAD, checked out at `<runDir>/integration/`. */
export function createIntegration(workspace: string, runId: string, runDir: string): Worktree {
  return ensureWorktree(workspace, `sous/${runId}`, join(runDir, 'integration'), 'HEAD')
}

/** Branch `sous/<run>.<node>` from `fromCommit`, checked out at `<runDir>/worktrees/<node>/`. git cannot
 * have `sous/<run>/<node>` beside the branch `sous/<run>`, so the node joins the run ID with a dot. */
export function createNodeWorktree(workspace: string, runId: string, runDir: string, node: string, fromCommit: string): Worktree {
  return ensureWorktree(workspace, `sous/${runId}.${node}`, join(runDir, 'worktrees', node), fromCommit)
}

/** Creates the branch and its worktree, or returns them when they already exist (resume); an existing
 * branch is checked out again if its worktree was lost, and `start` is then not used. */
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
    return { branch, path }
  }
  if (run(workspace, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0) {
    git(workspace, ['worktree', 'add', path, branch])
    return { branch, path }
  }
  const base = git(workspace, ['rev-parse', '--verify', `${start}^{commit}`])
  git(workspace, ['worktree', 'add', '-b', branch, path, base])
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
 * progress for the integrator, and the conflicted files are returned. Any other failure aborts the
 * merge (if git left one in progress) and throws git's error. */
export function merge(integrationPath: string, branch: string, message: string): MergeResult {
  const r = run(integrationPath, ['merge', '--no-ff', '--no-verify', '-m', message, branch])
  if (r.status === 0) return { ok: true, commit: head(integrationPath) }
  const files = run(integrationPath, ['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean)
  if (files.length > 0) return { ok: false, files }
  if (mergeInProgress(integrationPath)) abortMerge(integrationPath)
  throw new Error(`git merge --no-ff ${branch} failed in ${integrationPath}: ${r.stderr || r.stdout.trim()}`)
}

/** Files `branch` changed since it left the integration branch, which was at `onto` or before it. */
export function changedFiles(integrationPath: string, onto: string, branch: string): string[] {
  return git(integrationPath, ['diff', '--name-only', '-z', `${onto}...${branch}`]).split('\0').filter(Boolean)
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

/** When HEAD is the merge commit of `branch` (a merge that finished before a supervisor stop), the commit it
 * merged onto. */
export function mergedOnto(path: string, branch: string): string | undefined {
  const second = run(path, ['rev-parse', '-q', '--verify', 'HEAD^2'])
  if (second.status !== 0 || second.stdout.trim() !== git(path, ['rev-parse', branch])) return undefined
  return git(path, ['rev-parse', 'HEAD^1'])
}

/** Whether tracked files have changes that are not committed. */
export function hasUncommitted(path: string): boolean {
  return git(path, ['status', '--porcelain', '--untracked-files=no']) !== ''
}

/** Drop a merge that could not be finished: abort it if in progress, and move the branch back to `commit`. */
export function resetTo(path: string, commit: string): void {
  if (mergeInProgress(path)) abortMerge(path)
  git(path, ['reset', '-q', '--hard', commit])
  git(path, ['clean', '-q', '-fd'])
}

/** Which of `files` (relative to the worktree) still hold conflict marker lines, of the size git uses for each file
 * (`conflict-marker-size` in .gitattributes, else 7). A deleted file has none. */
export function withConflictMarkers(path: string, files: string[]): string[] {
  return files.filter((file) => {
    if (!existsSync(join(path, file))) return false
    // Git uses the attribute only when it is a positive integer; otherwise (unset, invalid, 0, negative) 7.
    const size = Number(git(path, ['check-attr', 'conflict-marker-size', '--', file]).split(': ').at(-1))
    const n = Number.isInteger(size) && size > 0 ? size : 7
    return new RegExp(`^(<{${n}}|\\|{${n}}|={${n}}|>{${n}})( |$)`, 'm').test(readFileSync(join(path, file), 'utf8'))
  })
}
