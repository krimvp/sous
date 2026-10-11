import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog, readEvents } from '../src/log.ts'

const tempRun = () => mkdtempSync(join(tmpdir(), 'murm-log-'))

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

test('refuses a lock held by a live process and takes over a stale one', async (t) => {
  const runDir = tempRun()
  const lockPath = join(runDir, 'lock')
  const live = spawn('sleep', ['30'])
  t.after(() => live.kill())
  const stat = readFileSync(`/proc/${live.pid}/stat`, 'utf8')
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]

  writeFileSync(lockPath, JSON.stringify({ pid: live.pid, startTime }))
  assert.throws(() => openLog(runDir), /locked by a live supervisor/)

  // Same pid, different start time: the pid was reused, so the lock is stale.
  writeFileSync(lockPath, JSON.stringify({ pid: live.pid, startTime: '1' }))
  const log = openLog(runDir)
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  log.close()
  assert.equal(existsSync(lockPath), false)
})
