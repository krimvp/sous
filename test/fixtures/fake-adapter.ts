// A WorkerAdapter that runs test/fixtures/fake-worker.ts as a real child process in its own process group.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedTurn, RunningTurn, TurnSpec, WorkerAdapter } from '../../src/contracts/index.ts'
import type { FakeStep } from './fake-worker.ts'

const WORKER = new URL('./fake-worker.ts', import.meta.url).pathname

/** The brief line that scripts a fake worker. */
export function fakePlan(steps: FakeStep[]): string {
  return `FAKE_PLAN: ${JSON.stringify(steps)}`
}

export function fakeAdapter(sessionDir: string): WorkerAdapter {
  mkdirSync(sessionDir, { recursive: true })
  const launch = (spec: TurnSpec, sessionId: string): RunningTurn => {
    const out = openSync(spec.outFile, 'w')
    const err = openSync(spec.errFile, 'w')
    const child = spawn(process.execPath, [WORKER, join(sessionDir, `${sessionId}.json`)], {
      cwd: spec.cwd, detached: true, stdio: ['pipe', out, err], env: { ...process.env, ...spec.env },
    })
    closeSync(out)
    closeSync(err)
    child.stdin!.end(spec.prompt)
    return {
      pid: child.pid!,
      sessionId: Promise.resolve(sessionId),
      exit: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
    }
  }
  return {
    name: 'claude',
    start: (spec) => launch(spec, spec.sessionId ?? randomUUID()),
    resume: (spec) => launch(spec, spec.sessionId),
    parse(raw) {
      const turn: ParsedTurn = { items: [], ended: false }
      for (const line of raw.split('\n')) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'session') turn.sessionId = event.id
        if (event.type === 'message') turn.items.push({ kind: 'message', role: 'assistant', text: event.text })
        if (event.type === 'result') Object.assign(turn, { ended: true, result: event.result })
      }
      return turn
    },
  }
}
