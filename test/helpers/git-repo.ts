// Test workspaces are git repositories with one commit, as sous requires.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim()

/** A new temporary git repository with `files` (default: a README) committed. */
export function gitWorkspace(prefix = 'sous-ws-', files: Record<string, string> = { 'README.md': 'test\n' }): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, 'init', '-q', '-b', 'main')
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
