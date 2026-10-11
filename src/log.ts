// The append-only event log of one run (<runDir>/events.jsonl) and the single-writer lock.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, ftruncateSync, linkSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
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

/** Take the run's lock and open its log for appending. Throws if a live supervisor holds the lock. */
export function openLog(runDir: string, onEvent?: (event: Event) => void): EventLog {
  acquireLock(runDir)
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

function procStartTime(pid: number): string | undefined {
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

// The lock file appears atomically with its full contents (written to a temp file, then linked into
// place), so a lock that does not parse is never treated as stale. A stale lock is removed only by the
// one taker that creates its takeover token `lock.stale-<hash of its contents>`; nobody else can remove
// that lock instance, and no new lock can appear while it exists. Tokens are kept so a slow taker that
// saw the same stale lock cannot remove a newer one.
function acquireLock(runDir: string): void {
  const path = join(runDir, 'lock')
  const mine = JSON.stringify({ pid: process.pid, startTime: procStartTime(process.pid), nonce: randomBytes(8).toString('hex') }) + '\n'
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, mine)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path)
        held.set(runDir, mine)
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      const raw = readRaw(path)
      if (raw === undefined) continue // released in the meantime
      const holder = parseLock(raw)
      if (!holder) throw new Error(`lock ${path} is unreadable; remove it if no supervisor is running`)
      if (alive(holder)) throw new Error(`run ${runDir} is locked by a live supervisor (pid ${holder.pid})`)
      const token = `${path}.stale-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
      try {
        writeFileSync(token, `${process.pid}\n`, { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        throw new Error(`another process is taking over the stale lock of run ${runDir} (remove ${token} and ${path} if none is)`)
      }
      if (readRaw(path) === raw) rmSync(path)
    }
    throw new Error(`could not take the lock of run ${runDir}`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function releaseLock(runDir: string): void {
  const path = join(runDir, 'lock')
  if (held.get(runDir) === readRaw(path)) rmSync(path, { force: true })
  held.delete(runDir)
}
