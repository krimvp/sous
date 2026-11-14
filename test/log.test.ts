import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { openLog, procStartTime, readEvents } from '../src/run/index.ts'

const tempRun = () => mkdtempSync(join(tmpdir(), 'sous-log-'))

test('a truncated final line is ignored on read and replaced on the next append', () => {
  const runDir = tempRun()
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace: '/w' })
  log.append({ type: 'node.completed', node: 'a', summary: 's' })
  log.close()
  appendFileSync(join(runDir, 'events.jsonl'), '{"type":"node.fail')

  assert.deepEqual(readEvents(runDir).map((e) => e.seq), [1, 2])
  const again = openLog(runDir)
  again.append({ type: 'run.completed', summary: 'ok' })
  again.close()
  const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trimEnd().split('\n')
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3])
})

test('refuses a lock held by a live supervisor; only a takeover (sous resume) replaces one left by a stopped one', async (t) => {
  const runDir = tempRun()
  const lockPath = join(runDir, 'lock')
  const live = spawn('sleep', ['30'])
  t.after(() => live.kill())
  const startTime = procStartTime(live.pid!)
  assert.ok(startTime, 'the live process has a start time')

  writeFileSync(lockPath, JSON.stringify({ pid: live.pid, startTime }))
  assert.throws(() => openLog(runDir), /locked by a live supervisor/)
  assert.throws(() => openLog(runDir, undefined, { takeOver: true }), /locked by a live supervisor/)

  // Same pid, different start time: the pid was reused, so the supervisor that wrote it is gone.
  writeFileSync(lockPath, JSON.stringify({ pid: live.pid, startTime: '1' }))
  assert.throws(() => openLog(runDir), /stopped supervisor; continue it with sous resume/)
  const log = openLog(runDir, undefined, { takeOver: true })
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  log.close()
  assert.equal(existsSync(lockPath), false)
})

test('a live process keeps its start time when the time zone changes, so its lock still holds', (t) => {
  const live = spawn('sleep', ['30'])
  const tz = process.env.TZ
  t.after(() => {
    live.kill()
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })
  process.env.TZ = 'America/New_York'
  const runDir = tempRun()
  const startTime = procStartTime(live.pid!)
  assert.ok(startTime, 'the live process has a start time')
  writeFileSync(join(runDir, 'lock'), JSON.stringify({ pid: live.pid, startTime }))
  process.env.TZ = 'Europe/Madrid'
  assert.throws(() => openLog(runDir, undefined, { takeOver: true }), /locked by a live supervisor/)
})

test('only one of many concurrent supervisors gets the lock', async () => {
  const taker = new URL('./helpers/lock-taker.ts', import.meta.url).pathname
  for (let round = 0; round < 5; round++) {
    const runDir = tempRun()
    const exits = Array.from({ length: 16 }, (_, id) => {
      const child = spawn(process.execPath, [taker, runDir, String(id), '16'], { stdio: 'ignore' })
      return new Promise((resolve) => child.on('exit', resolve))
    })
    while (readdirSync(runDir).filter((f) => f.startsWith('ready-')).length < 16) await sleep(10)
    writeFileSync(join(runDir, 'go'), '')
    await Promise.all(exits)
    assert.equal(readdirSync(runDir).filter((f) => f.startsWith('held-')).length, 1, `round ${round}`)
  }
})
