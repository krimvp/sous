// The append-only event log of one run (<runDir>/events.jsonl) and the single-writer lock.
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Event, EventBody } from './types.ts'

export interface EventLog {
  /** Every event in the log, oldest first, including the ones appended through this handle. */
  readonly events: readonly Event[]
  append(body: EventBody): Event
  /** Close the log and release the lock. */
  close(): void
}

/** Read a run's events. A truncated final line (no trailing newline) is ignored. */
export function readEvents(runDir: string): Event[] {
  return parseLog(readLog(join(runDir, 'events.jsonl')).complete)
}

/** Take the run's lock and open its log for appending. Throws if a live supervisor holds the lock, and, unless
 * `takeOver` (`sous resume`), if a stopped one left it. */
export function openLog(runDir: string, onEvent?: (event: Event) => void, opts: { takeOver?: boolean } = {}): EventLog {
  acquireLock(runDir, opts.takeOver ?? false)
  const path = join(runDir, 'events.jsonl')
  let fd: number | undefined
  try {
    const { complete } = readLog(path)
    const events = parseLog(complete)
    fd = openSync(path, 'a')
    // Drop a partial final line left by a crash so the next append starts on a fresh line.
    ftruncateSync(fd, Buffer.byteLength(complete))
    const handle = fd
    return {
      events,
      append(body) {
        const event = { ...body, seq: events.length + 1, at: new Date().toISOString() } as Event
        writeSync(handle, JSON.stringify(event) + '\n')
        fsyncSync(handle)
        events.push(event)
        onEvent?.(event)
        return event
      },
      close() {
        closeSync(handle)
        releaseLock(runDir)
      },
    }
  } catch (err) {
    if (fd !== undefined) closeSync(fd)
    releaseLock(runDir)
    throw err
  }
}

/** Hand a command to the run's supervisor as a file in `<runDir>/commands/`, written whole (by rename) so the supervisor
 * never reads half of it. */
export function writeCommand(runDir: string, cmd: object): void {
  const dir = join(runDir, 'commands')
  const file = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(cmd) + '\n')
  renameSync(`${file}.tmp`, `${file}.json`)
}

/** The pid of the live supervisor holding the run's lock, if any. */
export function lockHolder(runDir: string): number | undefined {
  const lock = parseLock(readRaw(join(runDir, 'lock')))
  return lock && alive(lock) ? lock.pid : undefined
}

function readLog(path: string): { complete: string } {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  return { complete: raw.slice(0, raw.lastIndexOf('\n') + 1) }
}

function parseLog(complete: string): Event[] {
  const lines = complete.split('\n').slice(0, -1)
  return lines.map((line, i) => {
    let event: Event
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`events.jsonl line ${i + 1} is not valid JSON`)
    }
    if (event.seq !== i + 1) throw new Error(`events.jsonl line ${i + 1} has seq ${event.seq}, expected ${i + 1}`)
    return event
  })
}

// ---- Lock ------------------------------------------------------------------------------------

interface Lock {
  pid: number
  /** Process start time in clock ticks since boot (field 22 of /proc/<pid>/stat); absent off Linux. */
  startTime?: string
}

/** A process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat); undefined when it is gone. */
export function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after the command name, which is in parentheses and may contain spaces; starttime is field 22.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

function alive(lock: Lock): boolean {
  try {
    process.kill(lock.pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  return lock.startTime === undefined || procStartTime(lock.pid) === lock.startTime
}

function parseLock(raw: string | undefined): Lock | undefined {
  try {
    const lock = JSON.parse(raw ?? '')
    return typeof lock?.pid === 'number' ? lock : undefined
  } catch {
    return undefined
  }
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

const held = new Map<string, string>()

// The lock is created exclusively, so exactly one supervisor holds it. A lock left by a stopped supervisor is
// taken over only by an explicit `sous resume`; `sous run` never does.
function acquireLock(runDir: string, takeOver: boolean): void {
  const path = join(runDir, 'lock')
  const mine = JSON.stringify({ pid: process.pid, startTime: procStartTime(process.pid) }) + '\n'
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, mine, { flag: 'wx' })
      held.set(runDir, mine)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const raw = readRaw(path)
    const holder = parseLock(raw)
    if (holder && alive(holder)) throw new Error(`run ${runDir} is locked by a live supervisor (pid ${holder.pid})`)
    if (!takeOver || attempt > 0) throw new Error(`run ${runDir} has a lock from a stopped supervisor; continue it with sous resume`)
    // Remove the stale lock only if it is still the one just read, then create ours exclusively.
    if (readRaw(path) === raw) rmSync(path, { force: true })
  }
}

function releaseLock(runDir: string): void {
  const path = join(runDir, 'lock')
  if (held.get(runDir) === readRaw(path)) rmSync(path, { force: true })
  held.delete(runDir)
}
