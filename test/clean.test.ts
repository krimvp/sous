// The last mile of a run: `sous diff` shows what it changed and `sous clean` removes what it no longer needs, in real
// git repositories (and a plain folder) through the real CLI.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog } from '../src/run/index.ts'
import { fakePlan } from './helpers/fake-adapter.ts'
import { git, gitWorkspace } from './helpers/git-repo.ts'
import type { FakeStep } from './helpers/fake-worker.ts'
import { runDirOf, sous, waitFor } from './helpers/sous-proc.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, steps: FakeStep[]) => ({ id, kind: 'work', agent: 'claude', brief: `Do ${id}.\n${fakePlan(steps)}` })
const COMMIT = 'git add -A && git -c user.name=W -c user.email=w@example.com commit -q -m wip'

async function ran(args: string[], workspace: string) {
  const r = sous(args, workspace, join(workspace, 'sessions'))
  const code = await r.exitWithin()
  return { code, output: r.output() }
}

const branches = (workspace: string) => git(workspace, 'branch', '--format=%(refname:short)').split('\n').sort()
const worktrees = (workspace: string) => git(workspace, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length

test('sous diff shows what a run merged; sous clean removes its worktrees and merged node branches, keeps unmerged work and the result, and status, export and resume still work', async () => {
  const workspace = gitWorkspace('sous-clean-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'two files and two failures',
    nodes: [
      work('a', [{ write: { 'a.txt': 'from a\n' }, result: done('wrote a') }]),
      work('b', [{ write: { 'b.txt': 'from b\n' }, result: done('wrote b') }]),
      // Fails with a commit of its own: unmerged work on its branch.
      work('committed', [{ write: { 'c.txt': 'kept?\n' }, sh: COMMIT, exit: 1 }]),
      // Fails leaving a file uncommitted in its worktree.
      work('dirty', [{ write: { 'd.txt': 'kept?\n' }, exit: 1 }]),
    ],
  }))
  const run = await ran(['run', graph], workspace)
  assert.equal(run.code, 1, run.output)
  const runDir = runDirOf(workspace)!
  const id = runDir.split('/').at(-1)!
  assert.match(run.output, new RegExp(`^result: branch sous/${id}\nnext: sous diff, then sous clean$`, 'm'))
  assert.equal(worktrees(workspace), 6)

  const diff = await ran(['diff'], workspace)
  assert.equal(diff.code, 0, diff.output)
  assert.match(diff.output, /^\+\+\+ b\/a\.txt\n@@ .* @@\n\+from a$/m)
  assert.match(diff.output, /^\+from b$/m)
  assert.doesNotMatch(diff.output, /c\.txt|d\.txt/)
  const stat = await ran(['diff', id, '--stat'], workspace)
  assert.match(stat.output, /^ 2 files changed, 2 insertions\(\+\)$/m)

  const dry = await ran(['clean', '--dry-run'], workspace)
  assert.equal(dry.code, 0, dry.output)
  assert.match(dry.output, new RegExp(`^ {2}would remove worktree .sous/runs/${id}/worktrees/a$`, 'm'))
  assert.equal(worktrees(workspace), 6)
  assert.equal(branches(workspace).length, 6)

  const clean = await ran(['clean'], workspace)
  assert.equal(clean.code, 0, clean.output)
  const r = `.sous/runs/${id}`
  assert.equal(clean.output, [
    `run ${id} (failed):`,
    `  removed worktree ${r}/worktrees/a`,
    `  removed worktree ${r}/worktrees/b`,
    `  removed worktree ${r}/worktrees/committed`,
    `  removed worktree ${r}/integration`,
    `  removed branch sous/${id}.a`,
    `  removed branch sous/${id}.b`,
    `  kept worktree ${r}/worktrees/dirty: 1 uncommitted change (--unmerged removes it)`,
    `  kept branch sous/${id}.committed: 1 commit not in sous/${id} (--unmerged deletes it)`,
    `  kept branch sous/${id}.dirty: its worktree is kept`,
    `  kept branch sous/${id}: the result (once it is merged, --branches deletes it)`,
    '',
  ].join('\n'))
  assert.deepEqual(branches(workspace), ['main', `sous/${id}`, `sous/${id}.committed`, `sous/${id}.dirty`])
  assert.equal(worktrees(workspace), 2)
  assert.deepEqual(readdirSync(join(runDir, 'worktrees')), ['dirty'])
  assert.equal(existsSync(join(runDir, 'integration')), false)

  // The cleaned run still reads: status, export, diff; resume refuses it as finished; cleaning again changes nothing.
  const status = await ran(['status'], workspace)
  assert.match(status.output, new RegExp(`^ {2}result: branch sous/${id}$`, 'm'))
  assert.match(status.output, /^ {2}a completed on claude turns 1: wrote a$/m)
  assert.match(status.output, /^next: sous diff, then sous clean$/m)
  const atif = await ran(['export', 'atif'], workspace)
  assert.equal(atif.code, 0, atif.output)
  assert.equal((await ran(['diff', '--stat'], workspace)).output, stat.output)
  const resume = await ran(['resume'], workspace)
  assert.equal(resume.code, 1)
  assert.match(resume.output, new RegExp(`^sous: run ${id} already failed; a finished run is not resumed$`, 'm'))
  const again = await ran(['clean'], workspace)
  assert.match(again.output, /^ {2}nothing to remove$/m)

  // --branches refuses a result HEAD does not contain; once merged it goes, and --unmerged takes the failed work.
  const refused = await ran(['clean', '--branches'], workspace)
  assert.equal(refused.code, 1)
  assert.match(refused.output, new RegExp(`^sous: branch sous/${id} is not deleted: it is not merged into HEAD; merge it first \\(git merge sous/${id}\\) or keep it$`, 'm'))
  assert.ok(branches(workspace).includes(`sous/${id}`))
  git(workspace, 'merge', '-q', '--no-edit', `sous/${id}`)
  assert.match((await ran(['status'], workspace)).output, /^next: sous diff, then sous clean --branches$/m)
  const all = await ran(['clean', '--branches', '--unmerged'], workspace)
  assert.equal(all.code, 0, all.output)
  assert.match(all.output, new RegExp(`^ {2}removed branch sous/${id}.committed \\(1 unmerged commit\\)$`, 'm'))
  assert.match(all.output, new RegExp(`^ {2}removed branch sous/${id} \\(merged into HEAD\\)$`, 'm'))
  assert.deepEqual(branches(workspace), ['main'])
  assert.equal(worktrees(workspace), 1)
  assert.match((await ran(['status'], workspace)).output, new RegExp(`^ {2}result: branch sous/${id} \\(deleted\\)$`, 'm'))
  assert.doesNotMatch((await ran(['status'], workspace)).output, /^next:/m)
})

test('sous clean refuses a running and a stopped run, and --all skips them; a branch the log did not record is never touched', async () => {
  const workspace = gitWorkspace('sous-clean-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'wait', nodes: [work('w', [{ write: { 'w.txt': 'w\n' }, result: done('wrote w') }]), { id: 'ship', kind: 'gate', brief: 'Ship?', needs: ['w'] }] }))
  const run = sous(['run', graph], workspace, join(workspace, 'sessions'))
  await waitFor(workspace, (e) => e.type === 'message' && e.from === 'ship')
  const runDir = runDirOf(workspace)!
  const id = runDir.split('/').at(-1)!
  // A branch named like the run's, which the run did not create.
  git(workspace, 'branch', `sous/${id}.other`)

  const live = await ran(['clean'], workspace)
  assert.equal(live.code, 1)
  assert.match(live.output, new RegExp(`^sous: run ${id} is running \\(supervisor pid \\d+\\): clean it once it has ended$`, 'm'))
  // The result so far.
  assert.match((await ran(['diff'], workspace)).output, /^\+w$/m)

  run.child.kill('SIGINT')
  await run.exitWithin()
  const stopped = await ran(['clean', id], workspace)
  assert.equal(stopped.code, 1)
  assert.match(stopped.output, new RegExp(`^sous: run ${id} is stopped, not over, and sous resume needs its worktrees: continue it with sous resume ${id} and clean it once it has ended$`, 'm'))
  const skipped = await ran(['clean', '--all'], workspace)
  assert.equal(skipped.code, 0, skipped.output)
  assert.match(skipped.output, new RegExp(`^skipped run ${id} is stopped`, 'm'))
  assert.equal(worktrees(workspace), 3)

  // Rejecting the gate ends the run; then it is cleaned, the unrecorded branch left alone.
  const resumed = sous(['resume'], workspace, join(workspace, 'sessions'))
  await waitFor(workspace, (e) => e.type === 'run.resumed')
  assert.equal((await ran(['cancel', 'ship'], workspace)).code, 0)
  await resumed.exitWithin()
  const cleaned = await ran(['clean', '--all'], workspace)
  assert.equal(cleaned.code, 0, cleaned.output)
  assert.deepEqual(branches(workspace), ['main', `sous/${id}`, `sous/${id}.other`])
  assert.equal(worktrees(workspace), 1)
})

test('sous clean leaves a worktree outside the run alone when the logged path is a link to it inside the run', async () => {
  const workspace = gitWorkspace('sous-clean-')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'one file', nodes: [work('a', [{ write: { 'a.txt': 'a\n' }, result: done('wrote a') }])] }))
  assert.equal((await ran(['run', graph], workspace)).code, 0)
  const runDir = runDirOf(workspace)!
  const id = runDir.split('/').at(-1)!
  // Another worktree of the repository, on a branch named like the run's, reached through a link in the run directory.
  const outside = join(mkdtempSync(join(tmpdir(), 'sous-outside-')), 'tree')
  git(workspace, 'worktree', 'add', '-q', '-b', `sous/${id}.evil`, outside)
  symlinkSync(outside, join(runDir, 'evil'))
  const log = openLog(runDir)
  log.append({ type: 'worktree.created', node: 'evil', path: join(runDir, 'evil'), branch: `sous/${id}.evil`, base: 'HEAD' })
  log.close()
  const cleaned = await ran(['clean'], workspace)
  assert.equal(cleaned.code, 0, cleaned.output)
  assert.doesNotMatch(cleaned.output, /evil/)
  assert.ok(existsSync(outside))
  assert.ok(branches(workspace).includes(`sous/${id}.evil`))
})

test('folder mode: sous diff lists the output files; sous clean removes the work folders, not output or what the links point to', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sous-clean-folder-'))
  writeFileSync(join(workspace, 'input.txt'), 'input\n')
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'a report',
    nodes: [
      work('report', [{ write: { 'report.md': '# report\n' }, result: done('wrote it') }]),
      work('broken', [{ write: { 'draft.md': 'draft\n' }, exit: 1 }]),
    ],
  }))
  const run = await ran(['run', graph], workspace)
  assert.equal(run.code, 1, run.output)
  assert.doesNotMatch(run.output, /^next:/m)
  const runDir = runDirOf(workspace)!

  const diff = await ran(['diff'], workspace)
  assert.equal(diff.output, `${join(runDir, 'output')}:\n         9  report.md\n1 file, 9 bytes\n`)
  const clean = await ran(['clean'], workspace)
  assert.equal(clean.code, 0, clean.output)
  assert.match(clean.output, /^ {2}removed folder work\/report\n {2}kept folder work\/broken: 1 file not collected into output\/ \(--unmerged removes it\)\n {2}kept folder .*\/output: the result$/m)
  assert.deepEqual(readdirSync(join(runDir, 'work')), ['broken'])
  assert.ok(existsSync(join(workspace, 'input.txt')))
  assert.ok(existsSync(join(runDir, 'output', 'report.md')))
  await ran(['clean', '--unmerged'], workspace)
  assert.equal(existsSync(join(runDir, 'work')), false)
  assert.ok(existsSync(join(workspace, 'input.txt')))
  assert.equal((await ran(['status'], workspace)).code, 0)
})
