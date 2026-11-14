import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  abortMerge, commitAll, createIntegration, createNodeWorktree, ensureRepo, hasChanges, head, merge, mergeInProgress, uncommitted,
} from '../src/workspace/index.ts'

// No user identity anywhere: sous's commits must carry their own.
process.env.HOME = mkdtempSync(join(tmpdir(), 'sous-git-home-'))
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A workspace repo with one commit, where git refuses to guess an identity. */
function repo(): { workspace: string; runDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'sous-git-'))
  sh(workspace, 'init', '-q', '-b', 'main')
  sh(workspace, 'config', 'user.useConfigOnly', 'true')
  writeFileSync(join(workspace, 'a.txt'), 'one\n')
  writeFileSync(join(workspace, '.gitignore'), '*.log\n')
  sh(workspace, 'add', '-A')
  sh(workspace, '-c', 'user.name=Person', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'init')
  return { workspace, runDir: join(workspace, '.sous', 'runs', 'r1') }
}

test('rejects a directory that is not a repository, and a repository with no commits', () => {
  const plain = mkdtempSync(join(tmpdir(), 'sous-git-'))
  assert.throws(() => ensureRepo(plain), /must be a git repository with at least one commit/)
  sh(plain, 'init', '-q')
  assert.throws(() => ensureRepo(plain), /must be a git repository with at least one commit/)
})

test('integration and node worktrees are created once, and found again on resume', () => {
  const { workspace, runDir } = repo()
  const start = head(workspace)
  ensureRepo(workspace)
  ensureRepo(workspace)
  assert.equal(readFileSync(join(workspace, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '.sous/').length, 1)

  const integration = createIntegration(workspace, 'r1', runDir)
  assert.deepEqual(integration, { branch: 'sous/r1', path: join(runDir, 'integration'), base: start })
  assert.equal(sh(integration.path, 'branch', '--show-current'), 'sous/r1')
  const node = createNodeWorktree(workspace, 'r1', runDir, 'build', start)
  assert.deepEqual(node, { branch: 'sous/r1.build', path: join(runDir, 'worktrees', 'build'), base: start })
  assert.equal(readFileSync(join(node.path, 'a.txt'), 'utf8'), 'one\n')

  // On resume the branches exist: no base is reported (the events hold it), whatever HEAD is now.
  const { base: _i, ...existingIntegration } = integration
  const { base: _n, ...existingNode } = node
  sh(workspace, 'checkout', '-q', '--orphan', 'elsewhere')
  sh(workspace, '-c', 'user.name=Person', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'unrelated')
  assert.deepEqual(createIntegration(workspace, 'r1', runDir), existingIntegration)
  assert.deepEqual(createNodeWorktree(workspace, 'r1', runDir, 'build', head(workspace)), existingNode)
  assert.equal(sh(workspace, 'status', '--porcelain'), '')

  // A node worktree whose directory was lost is checked out again on its existing branch.
  writeFileSync(join(node.path, 'b.txt'), 'b\n')
  commitAll(node.path, 'b')
  const tip = head(node.path)
  rmSync(node.path, { recursive: true })
  assert.deepEqual(createNodeWorktree(workspace, 'r1', runDir, 'build', start), existingNode)
  assert.equal(head(node.path), tip)

  assert.throws(() => createNodeWorktree(workspace, 'r1', runDir, 'a..b', start), /check-ref-format/)
})

test('ensureRepo from a linked worktree excludes .sous/ in the shared repository', () => {
  const { workspace } = repo()
  const linked = join(mkdtempSync(join(tmpdir(), 'sous-git-')), 'linked')
  sh(workspace, 'worktree', 'add', '-q', '-b', 'side', linked)
  ensureRepo(linked)
  mkdirSync(join(linked, '.sous'))
  writeFileSync(join(linked, '.sous', 'x'), 'x')
  assert.equal(sh(linked, 'status', '--porcelain'), '')
})

test('commitAll commits untracked files as sous, honours .gitignore, and reports when there is nothing', () => {
  const { workspace, runDir } = repo()
  ensureRepo(workspace)
  const node = createNodeWorktree(workspace, 'r1', runDir, 'n', head(workspace))
  writeFileSync(join(node.path, 'new.txt'), 'new\n')
  writeFileSync(join(node.path, 'debug.log'), 'noise\n')

  assert.equal(commitAll(node.path, 'node n'), true)
  assert.equal(sh(node.path, 'log', '-1', '--format=%an <%ae>|%s'), 'sous <sous@localhost>|node n')
  assert.deepEqual(sh(node.path, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['new.txt'])
  assert.equal(existsSync(join(node.path, 'debug.log')), true)
  assert.equal(commitAll(node.path, 'again'), false)
})

test('uncommitted names changed, added and renamed paths as they are, and leaves ignored files out', () => {
  const { workspace, runDir } = repo()
  ensureRepo(workspace)
  const node = createNodeWorktree(workspace, 'r1', runDir, 'n', head(workspace))
  assert.deepEqual(uncommitted(node.path), [])
  writeFileSync(join(node.path, 'c.txt'), 'c\n')
  sh(node.path, 'add', 'c.txt')
  sh(node.path, '-c', 'user.name=P', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'c')
  sh(node.path, 'mv', 'c.txt', 'd.txt')
  writeFileSync(join(node.path, 'a.txt'), 'changed\n')
  writeFileSync(join(node.path, 'new file.txt'), 'x\n')
  writeFileSync(join(node.path, 'debug.log'), 'noise\n')
  assert.deepEqual(uncommitted(node.path), ['a.txt', 'd.txt', 'new file.txt'])
})

test('a clean merge returns its commit; a branch without commits has no changes', () => {
  const { workspace, runDir } = repo()
  ensureRepo(workspace)
  const integration = createIntegration(workspace, 'r1', runDir)
  const idle = createNodeWorktree(workspace, 'r1', runDir, 'idle', head(integration.path))
  assert.equal(hasChanges(integration.path, idle.branch), false)

  const node = createNodeWorktree(workspace, 'r1', runDir, 'n', head(integration.path))
  writeFileSync(join(node.path, 'b.txt'), 'b\n')
  commitAll(node.path, 'b')
  assert.equal(hasChanges(integration.path, node.branch), true)

  const result = merge(integration.path, node.branch, 'merge n')
  assert.deepEqual(result, { ok: true, commit: head(integration.path) })
  assert.equal(sh(integration.path, 'log', '-1', '--format=%P').split(' ').length, 2)
  assert.equal(readFileSync(join(integration.path, 'b.txt'), 'utf8'), 'b\n')
  assert.equal(hasChanges(integration.path, node.branch), false)
})

test('a conflict returns its files and leaves the merge in progress; abort restores the integration branch', () => {
  const { workspace, runDir } = repo()
  ensureRepo(workspace)
  const integration = createIntegration(workspace, 'r1', runDir)
  const base = head(integration.path)
  for (const id of ['x', 'y']) {
    const node = createNodeWorktree(workspace, 'r1', runDir, id, base)
    writeFileSync(join(node.path, 'a.txt'), `${id}\n`)
    writeFileSync(join(node.path, 'café.txt'), `${id}\n`)
    writeFileSync(join(node.path, `${id}.txt`), `${id}\n`)
    commitAll(node.path, id)
  }
  assert.equal(merge(integration.path, 'sous/r1.x', 'merge x').ok, true)
  const before = head(integration.path)

  assert.deepEqual(merge(integration.path, 'sous/r1.y', 'merge y'), { ok: false, files: ['a.txt', 'café.txt'] })
  assert.equal(mergeInProgress(integration.path), true)

  abortMerge(integration.path)
  assert.equal(mergeInProgress(integration.path), false)
  assert.equal(head(integration.path), before)
  assert.equal(sh(integration.path, 'status', '--porcelain'), '')
})

test('a merge that fails without a conflict throws git\'s error and is aborted', () => {
  const { workspace, runDir } = repo()
  ensureRepo(workspace)
  const integration = createIntegration(workspace, 'r1', runDir)
  const before = head(integration.path)
  const node = createNodeWorktree(workspace, 'r1', runDir, 'n', before)
  writeFileSync(join(node.path, 'b.txt'), 'b\n')
  commitAll(node.path, 'b')
  const hook = join(workspace, '.git', 'hooks', 'prepare-commit-msg')
  writeFileSync(hook, '#!/bin/sh\necho hook says no >&2\nexit 1\n', { mode: 0o755 })

  assert.throws(() => merge(integration.path, node.branch, 'merge n'), /git merge --no-ff sous\/r1\.n failed.*/)
  assert.equal(mergeInProgress(integration.path), false)
  assert.equal(head(integration.path), before)
  assert.equal(sh(integration.path, 'status', '--porcelain'), '')
})
