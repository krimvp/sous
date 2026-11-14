// Process groups: every turn and check runs as the leader of its own group. Signalling and stopping a group, whether a
// recorded turn still runs, the end of a turn's stderr, the registry of live groups with terminate(), and runCommand.
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { withoutIdentity } from '../contracts/index.ts'
import { procStartTime } from '../run/index.ts'
import type { TurnState } from '../run/index.ts'

const OUTPUT_TAIL = 4096
/** How much of a failed turn's stderr goes into its error: the last non-empty lines, at most this many characters. */
const STDERR_LINES = 5
const STDERR_CHARS = 600

/** Signal a turn's whole process group. Ignores a group that is already gone. */
function interrupt(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether a turn's process group, started by an earlier supervisor, still runs. A pid whose start time differs was
 * reused by another process; a turn recorded without a start time is never signalled. */
export function turnAlive(t: TurnState): boolean {
  if (t.startTime === undefined) return false
  const now = procStartTime(t.pid)
  if (now !== undefined) return now === t.startTime
  return groupExists(t.pid) // the leader is gone: its pid is not reused while members of its group remain
}

/** SIGTERM the group, SIGKILL it after the grace, and resolve once it is gone (or shortly after SIGKILL). */
export async function stopGroup(pid: number, graceMs: number): Promise<void> {
  interrupt(pid, 'SIGTERM')
  let deadline = Date.now() + graceMs
  let killed = false
  while (groupExists(pid)) {
    if (Date.now() >= deadline) {
      if (killed) return
      interrupt(pid, 'SIGKILL')
      killed = true
      deadline = Date.now() + 2000
    }
    await sleep(20)
  }
}

/** The last non-empty lines of a turn's stderr file (only its last OUTPUT_TAIL bytes are read), or '' without any. */
export function stderrTail(file: string): string {
  let text = ''
  try {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, OUTPUT_TAIL))
      readSync(fd, buf, 0, buf.length, size - buf.length)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {}
  const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-STDERR_LINES).join('\n')
  return tail.length > STDERR_CHARS ? `…${tail.slice(-STDERR_CHARS)}` : tail
}

export type Processes = ReturnType<typeof createProcesses>

/** The run's live process groups. The maps are shared: turns register their groups, the main loop and the shutdown
 * read them to stop what must stop. */
export function createProcesses(graceMs: number) {
  // Live process groups, so a stop request can reach them; `turn` is absent for shell checks.
  const groups = new Map<number, { node: string; turn?: number }>()
  // Acceptance checks stopped because their worker got an urgent message, with the reason.
  const interruptedChecks = new Map<number, string>()
  // Every group the supervisor stops is awaited until it is gone, so no process outlives its turn or check.
  const terminations = new Map<number, Promise<void>>()
  const terminate = (pid: number) => {
    let done = terminations.get(pid)
    if (!done) {
      done = stopGroup(pid, graceMs).finally(() => terminations.delete(pid))
      terminations.set(pid, done)
    }
    return done
  }

  /** Run a shell command in its own process group; returns its exit code and the tail of its output. The command's
   * exit ends the check: what it left running in its group is stopped, and the pipes are read until they close
   * (or, held open by a process that escaped the group, until the grace is over). */
  const runCommand = (node: string, command: string, cwd: string) =>
    new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: withoutIdentity() })
      let tail = Buffer.alloc(0)
      const keep = (chunk: Buffer) => {
        tail = Buffer.concat([tail, chunk])
        if (tail.length > OUTPUT_TAIL) tail = tail.subarray(tail.length - OUTPUT_TAIL)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      if (child.pid) groups.set(child.pid, { node })
      const closed = new Promise<void>((done) => child.on('close', () => done()))
      let finished = false
      const finish = async (exitCode: number | null) => {
        if (finished) return
        finished = true
        if (child.pid) {
          groups.delete(child.pid)
          await terminate(child.pid) // background processes the command left behind
        }
        let grace: NodeJS.Timeout | undefined
        await Promise.race([closed, new Promise<void>((done) => (grace = setTimeout(done, graceMs)))])
        clearTimeout(grace)
        child.stdout.destroy()
        child.stderr.destroy()
        let output = tail.toString('utf8')
        if (child.pid) {
          const why = interruptedChecks.get(child.pid)
          interruptedChecks.delete(child.pid)
          if (why) output += `${output && !output.endsWith('\n') ? '\n' : ''}interrupted: ${why}\n`
        }
        resolve({ exitCode, output })
      }
      child.on('error', (err) => {
        keep(Buffer.from(String(err)))
        finish(null)
      })
      child.on('exit', (code) => finish(code))
    })

  return { groups, interruptedChecks, terminations, terminate, runCommand }
}
