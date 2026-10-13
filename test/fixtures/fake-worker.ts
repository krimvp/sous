// A scripted stand-in for a harness CLI. Reads the prompt on stdin and plays one step of the plan
// found on a `FAKE_PLAN: {...}` line of the first prompt; the session file remembers the plan and
// every prompt received, so a resumed session continues where it left off.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export interface FakeStep {
  /** Files to write, relative to the working directory. */
  write?: Record<string, string>
  /** A shell command to run in the working directory after writing. */
  sh?: string
  /** Start a grandchild `sleep` (optionally ignoring SIGTERM) and write its pid to <session file>.grandchild. */
  spawnSleeper?: boolean | 'ignore-term'
  /** Sleep before printing the result. */
  sleepMs?: number
  result?: { status: 'done' | 'blocked' | 'needs_input'; summary: string; question?: string }
  /** Keep running after printing the result. */
  lingerMs?: number
  /** An assistant message to print before anything else is done. */
  say?: string
  /** Text to write to stderr, and the code to exit with, after everything else. */
  stderr?: string
  exit?: number
}

const sessionFile = process.argv[2]
const prompt = readFileSync(0, 'utf8')
const session: { plan: FakeStep[]; prompts: string[] } = existsSync(sessionFile)
  ? JSON.parse(readFileSync(sessionFile, 'utf8'))
  : { plan: JSON.parse(/^FAKE_PLAN: (.*)$/m.exec(prompt)?.[1] ?? '[]'), prompts: [] }
const step = session.plan[session.prompts.length] ?? {}
session.prompts.push(prompt)
writeFileSync(sessionFile, JSON.stringify(session))

const emit = (line: object) => process.stdout.write(JSON.stringify(line) + '\n')
emit({ type: 'session', id: basename(sessionFile, '.json') })
if (step.say) emit({ type: 'message', text: step.say })
for (const [path, content] of Object.entries(step.write ?? {})) writeFileSync(path, content)
if (step.sh) spawnSync('sh', ['-c', step.sh], { stdio: 'ignore' })
if (step.spawnSleeper) {
  const pidFile = sessionFile + '.grandchild'
  const trap = step.spawnSleeper === 'ignore-term' ? "trap '' TERM; " : ''
  spawn('sh', ['-c', `${trap}echo $$ > "$0.tmp" && mv "$0.tmp" "$0"; exec sleep 60`, pidFile], { stdio: 'ignore' })
  while (!existsSync(pidFile)) await sleep(10)
}
if (step.sleepMs) await sleep(step.sleepMs)
if (step.result) emit({ type: 'result', result: step.result })
if (step.lingerMs) await sleep(step.lingerMs)
if (step.stderr) process.stderr.write(step.stderr)
process.exit(step.exit ?? 0)
