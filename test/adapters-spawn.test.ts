// The shared spawn helper with real processes: no harness, no model.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnTurn } from '../src/adapters/common.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'murm-spawn-'))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return
  assert.fail('timed out')
}

test('SIGKILL to -pid stops the turn and the grandchildren it started', async () => {
  const cwd = tempDir()
  const spec = { nodeId: 'n', turn: 1, cwd, prompt: '', outFile: join(cwd, 'out.jsonl'), errFile: join(cwd, 'err.txt') }
  // The grandchild ignores the parent dying, the way Codex's real process outlives its launcher.
  const turn = spawnTurn('sh', ['-c', 'sleep 300 & echo $! > grandchild.pid; wait'], spec)
  const file = join(cwd, 'grandchild.pid')
  await until(() => {
    try {
      return readFileSync(file, 'utf8').endsWith('\n')
    } catch {
      return false
    }
  })
  const grandchild = Number(readFileSync(file, 'utf8'))
  assert.ok(alive(grandchild))

  process.kill(-turn.pid, 'SIGKILL')
  assert.deepEqual(await turn.exit, { code: null, signal: 'SIGKILL' })
  await until(() => !alive(grandchild))
})

test('the prompt arrives on stdin and output reaches outFile after the starting process has exited', async () => {
  const cwd = tempDir()
  const spec = { nodeId: 'n', turn: 1, cwd, prompt: 'hello turn', outFile: join(cwd, 'out.jsonl'), errFile: join(cwd, 'err.txt') }
  // A stand-in supervisor starts a turn that writes after a delay, then exits at once.
  const helper = new URL('../src/adapters/common.ts', import.meta.url).href
  const script = `
    import { spawnTurn } from ${JSON.stringify(helper)}
    const spec = ${JSON.stringify(spec)}
    spawnTurn('sh', ['-c', 'read line; sleep 0.5; echo "got $line"; echo oops >&2'], spec)
    process.exit(0)
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script])
  await until(() => readFileSync(spec.outFile, 'utf8') === 'got hello turn\n')
  await until(() => readFileSync(spec.errFile, 'utf8') === 'oops\n')
})
