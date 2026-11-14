// `sous doctor` through the real CLI (real adapters and lead providers, nothing started), with stand-ins for the
// harness commands on PATH and a home directory with no Pi login. Keys in the environment are not real.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { gitWorkspace } from './fixtures/git-repo.ts'
import { fakeBin } from './fixtures/sous-proc.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

/** Runs `sous doctor` in `cwd` with harness stand-ins `bin` on PATH (and the real git), no Pi login, no provider key
 * but those in `keys`. */
function doctor(cwd: string, bin: string, keys: Record<string, string> = {}, home = mkdtempSync(join(tmpdir(), 'sous-home-')), args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, HOME: home, ...keys }
  for (const name of ['OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) if (!(name in keys)) delete env[name]
  const started = Date.now()
  const res = spawnSync(process.execPath, [CLI, 'doctor', ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 })
  return { code: res.status, out: res.stdout, err: res.stderr, ms: Date.now() - started }
}

test('sous doctor reports each harness with its version, the lead credentials and model, the git state, and what is missing', () => {
  // claude answers --version, codex is missing, pi hangs on it (in a grandchild that holds the output open, as a
  // wrapper that forks without exec would), droid fails it.
  const bin = fakeBin([], ['git', 'sleep'])
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.296 (Claude Code)"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
  writeFileSync(join(bin, 'droid'), '#!/bin/sh\necho "no such option" >&2\nexit 2\n', { mode: 0o755 })
  const workspace = gitWorkspace('sous-doctor-')
  writeFileSync(join(workspace, 'README.md'), 'changed\n')
  writeFileSync(join(workspace, 'notes.md'), 'new\n')

  const none = doctor(workspace, bin)
  assert.equal(none.code, 1, none.out + none.err)
  assert.ok(none.ms < 20_000, `doctor took ${none.ms} ms: the hung --version and what it started are not waited for`)
  assert.equal(none.out, [
    'claude: 2.1.296 (Claude Code); login not checked',
    'codex: not on PATH',
    'pi: on PATH; --version gave nothing in 5 s; login not checked',
    'droid: on PATH; --version exited 2: no such option; login not checked',
    'lead credentials: none',
    'lead model: none',
    'worker models: claude (haiku), pi (harness default), droid (harness default)',
    `workspace: ${workspace}, git repository at its top level, 2 uncommitted changes (workers see HEAD only)`,
    'not ready: no lead provider has a credential: set OLLAMA_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY, or run pi, then /login',
    '',
  ].join('\n'))

  const keyed = doctor(workspace, bin, { ANTHROPIC_API_KEY: 'test-not-a-key', OPENAI_API_KEY: 'test-not-a-key' })
  assert.equal(keyed.code, 0, keyed.out + keyed.err)
  assert.doesNotMatch(keyed.out, /not-a-key/, 'no credential value is printed')
  assert.match(keyed.out, /^lead credentials: anthropic \(ANTHROPIC_API_KEY\), openai \(OPENAI_API_KEY\)\nlead model: anthropic\/claude-haiku-5-5\n/m)
  assert.match(keyed.out, /\nready: lead on anthropic\/claude-haiku-5-5, workers on claude, pi, droid\n$/)

  // A Pi login file that is not JSON is reported, and does not hide the key in the environment.
  const home = mkdtempSync(join(tmpdir(), 'sous-home-'))
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(home, '.pi', 'agent', 'auth.json'), '{not json')
  const broken = doctor(workspace, bin, { ANTHROPIC_API_KEY: 'test-not-a-key' }, home)
  assert.equal(broken.code, 0, broken.out + broken.err)
  assert.match(broken.out, new RegExp(`^lead credentials: anthropic \\(ANTHROPIC_API_KEY\\)\nPi login: ${home}/.pi/agent/auth.json is not valid JSON; the Pi login is ignored \\(run pi, then /login\\)\nlead model: anthropic/claude-haiku-5-5$`, 'm'))
})

test('sous doctor says when the workspace is below the top level, outside git, or without a worker, and refuses arguments', () => {
  const bin = fakeBin(['codex'])
  const keys = { OLLAMA_API_KEY: 'test-not-a-key' }
  const workspace = gitWorkspace('sous-doctor-')
  const sub = join(workspace, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'notes.md'), 'new\n')
  // Workers see the whole repository's HEAD, so changes above the workspace count too.
  writeFileSync(join(workspace, 'README.md'), 'edited\n')
  writeFileSync(join(workspace, 'top.txt'), 'new\n')
  // Started there, a run uses the repository root; an explicit --workspace is taken as given.
  const moved = doctor(sub, bin, keys)
  assert.equal(moved.code, 0, moved.out + moved.err)
  assert.match(moved.out, new RegExp(`^workspace is the git repository root ${workspace}, not ${sub}: runs and .sous/ live there\n`))
  assert.match(moved.out, new RegExp(`^workspace: ${workspace}, git repository at its top level, 3 uncommitted changes \\(workers see HEAD only\\)$`, 'm'))
  const below = doctor(workspace, bin, keys, undefined, ['--workspace', sub])
  assert.equal(below.code, 0, below.out + below.err)
  assert.match(below.out, new RegExp(`^workspace: ${sub}, inside git repository ${workspace}, not at its top level \\(--workspace is used as given: .sous/ lands here; workers and checks run at the top level\\), 3 uncommitted changes \\(workers see HEAD only\\)$`, 'm'))
  assert.doesNotMatch(below.out, /git repository root/)
  assert.match(below.out, /^codex: on PATH; --version exited 1 with nothing; login not checked$/m)

  const folder = doctor(mkdtempSync(join(tmpdir(), 'sous-doctor-')), bin, keys)
  assert.equal(folder.code, 0, folder.out + folder.err)
  assert.match(folder.out, /^workspace: .*, not a git repository \(folder mode\)\nready: lead on ollama-cloud\/deepseek-v4.1-flash, workers on codex\n$/m)

  const noWorker = doctor(workspace, fakeBin([]), keys)
  assert.equal(noWorker.code, 1)
  assert.match(noWorker.out, /^not ready: no worker CLI on PATH: install claude, codex, pi, droid\n$/m)

  const usage = spawnSync(process.execPath, [CLI, 'doctor', 'extra'], { cwd: workspace, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: 'utf8' })
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /^sous: doctor takes no arguments\nusage:\n[\s\S]*sous doctor \[--workspace <dir>\]/)
})
