// Runs `sous` (with the fake adapter and fake lead runner) as a real process, and waits on a run's event log.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEvents } from '../../src/log.ts'
import type { Event } from '../../src/types.ts'
import { HARNESSES } from '../../src/types.ts'

const SOUS = new URL('./sous-fake.ts', import.meta.url).pathname

const GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

/** A directory with stand-ins for the harness commands `names`, so the agents that run them count as available,
 * and the real git. The stand-ins are never run: the fake adapter runs every worker. */
export function fakeBin(names: readonly string[] = HARNESSES): string {
  const dir = mkdtempSync(join(tmpdir(), 'sous-bin-'))
  symlinkSync(GIT, join(dir, 'git'))
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  return dir
}

const BIN = fakeBin()

/** `path` is the PATH sous sees; by default every harness command is on it. */
export function sous(args: string[], cwd: string, sessions: string, path = `${BIN}${delimiter}${process.env.PATH}`) {
  const child = spawn(process.execPath, [SOUS, ...args], { cwd, env: { ...process.env, PATH: path, FAKE_SESSIONS: sessions } })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stdout += d))
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve))
  return { child, exit, output: () => stdout }
}

/** The workspace's only run directory, once it exists. */
export const runDirOf = (workspace: string) => {
  const runs = join(workspace, '.sous', 'runs')
  const ids = existsSync(runs) ? readdirSync(runs) : []
  return ids.length ? join(runs, ids[0]) : undefined
}

/** Polls the run's log until `found` matches an event; returns that event. */
export async function waitFor(workspace: string, found: (e: Event) => boolean): Promise<Event> {
  for (let i = 0; i < 200; i++) {
    const runDir = runDirOf(workspace)
    const event = runDir && existsSync(join(runDir, 'events.jsonl')) ? readEvents(runDir).find(found) : undefined
    if (event) return event
    await sleep(50)
  }
  throw new Error('timed out waiting for an event')
}
