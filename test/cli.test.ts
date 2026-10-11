import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEvents } from '../src/log.ts'
import { fakePlan } from './fixtures/fake-adapter.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const MURM = new URL('./fixtures/murm-fake.ts', import.meta.url).pathname

function setup(steps: FakeStep[]) {
  const workspace = mkdtempSync(join(tmpdir(), 'murm-cli-'))
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({
    goal: 'write a greeting',
    harness: 'claude',
    nodes: [
      { id: 'write', kind: 'work', brief: `Write hello.txt.\n${fakePlan(steps)}` },
      { id: 'test', kind: 'check', command: 'grep -q hello hello.txt', needs: ['write'] },
    ],
  }))
  return { workspace, graph, sessions: join(workspace, 'sessions') }
}

function murm(args: string[], cwd: string, sessions: string) {
  const child = spawn(process.execPath, [MURM, ...args], { cwd, env: { ...process.env, FAKE_SESSIONS: sessions } })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stdout += d))
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve))
  return { child, exit, output: () => stdout }
}

const runDirOf = (workspace: string) => {
  const runs = join(workspace, '.murm', 'runs')
  const ids = existsSync(runs) ? readdirSync(runs) : []
  return ids.length ? join(runs, ids[0]) : undefined
}

test('murm run completes a work then check graph and murm status shows it', async () => {
  const { workspace, graph, sessions } = setup([{ write: { 'hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote hello.txt' } }])
  const run = murm(['run', graph], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /turn.ended +write turn 1 done: wrote hello.txt/)
  assert.match(run.output(), /run.completed +2 nodes completed/)
  const runDir = runDirOf(workspace)!
  assert.match(runDir, /\/\d{8}T\d{6}Z-[0-9a-f]{4}$/)
  assert.equal(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).goal, 'write a greeting')
  assert.equal(existsSync(join(runDir, 'lock')), false)

  const status = murm(['status', '--workspace', workspace], tmpdir(), sessions)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /^run \S+ completed: write a greeting\n  write completed turns 1: wrote hello.txt\n  test completed/)
})

test('SIGINT stops the running turn group, a SIGTERM-ignoring grandchild included, and leaves the run resumable', async () => {
  const { workspace, graph, sessions } = setup([{ spawnSleeper: 'ignore-term', sleepMs: 60_000, result: { status: 'done', summary: 'late' } }])
  const run = murm(['run', graph], workspace, sessions)
  let grandchild: number | undefined
  for (let i = 0; i < 100 && grandchild === undefined; i++) {
    await sleep(100)
    const file = existsSync(sessions) && readdirSync(sessions).find((f) => f.endsWith('.grandchild'))
    if (file) grandchild = Number(readFileSync(join(sessions, file), 'utf8'))
  }
  assert.ok(grandchild, 'the worker started its grandchild')
  run.child.kill('SIGINT')
  assert.equal(await run.exit, 1, run.output())

  const events = readEvents(runDirOf(workspace)!)
  const types = events.map((e) => e.type)
  assert.deepEqual(types.slice(-2), ['turn.interrupted', 'turn.ended'])
  assert.ok(!types.includes('run.failed'))
  const started = events.find((e) => e.type === 'turn.started')!
  assert.throws(() => process.kill(started.type === 'turn.started' ? started.pid : 0, 0), /ESRCH/)
  // The supervisor exits only after the group is gone: SIGKILL after the 5 s grace for this grandchild.
  assert.throws(() => process.kill(grandchild!, 0), /ESRCH/)
  assert.equal(existsSync(join(runDirOf(workspace)!, 'lock')), false)
  assert.match(run.output(), /can be resumed later/)
})
