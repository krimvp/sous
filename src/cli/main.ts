// The sous commands: `main` parses the arguments and runs one, with the adapters and the lead runner it is given
// (src/cli.ts, the program, gives it the real ones).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SOUS_VERSION } from '../self.ts'
import { startUi } from '../ui/index.ts'
import { clean } from './clean.ts'
import type { CliDeps } from './deps.ts'
import { diff } from './diff.ts'
import { doctor } from './doctor.ts'
import { exportRun } from './export.ts'
import { sendCommand } from './person.ts'
import { announceRoot, repoWorkspace, resumeRun, run } from './run.ts'
import { runs, status } from './status.ts'
import { usageError, usageOf } from './usage.ts'
import { wait } from './wait.ts'
import { worker } from './worker.ts'

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  // A worker's message is text, not options: `sous send b "--force is required now"`.
  if (argv[0] === 'send' || argv[0] === 'receive') return await worker(argv)
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      workspace: { type: 'string' }, 'max-depth': { type: 'string' }, 'max-cost': { type: 'string' }, agents: { type: 'string' }, 'approve-splits': { type: 'boolean' },
      port: { type: 'string' }, json: { type: 'boolean' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      stat: { type: 'boolean' }, all: { type: 'boolean' }, branches: { type: 'boolean' }, unmerged: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    } })
  } catch (err) {
    // Node's message goes on to explain `--`; keep the first sentence.
    const [problem] = (err as Error).message.split('. ')
    return usageError(problem[0].toLowerCase() + problem.slice(1))
  }
  const [command, ...args] = parsed.positionals
  if (parsed.values.version) {
    console.log(SOUS_VERSION)
    return 0
  }
  if (parsed.values.help || command === 'help') {
    console.log(usageOf(command === 'help' ? args[0] : command))
    return 0
  }
  if (parsed.values.json && command !== 'status' && command !== 'wait') return usageError('--json is for status and wait')
  if (parsed.values.timeout !== undefined && command !== 'wait') return usageError('--timeout is for wait')
  if (parsed.values.stat && command !== 'diff') return usageError('--stat is for diff')
  for (const flag of ['all', 'branches', 'unmerged', 'dry-run'] as const) {
    if (parsed.values[flag] && command !== 'clean') return usageError(`--${flag} is for clean`)
  }
  const rawCost = parsed.values['max-cost']
  if (rawCost !== undefined && command !== 'run' && command !== 'resume') return usageError('--max-cost is for run and resume')
  const maxCost = rawCost === undefined ? undefined : Number(rawCost)
  if (maxCost !== undefined && !(/^\d*\.?\d+$/.test(rawCost!) && maxCost > 0)) return usageError('--max-cost must be a positive number of US dollars')
  // An explicit --workspace is used as given; the default, the current directory, becomes the repository's top level.
  const { workspace, from } = parsed.values.workspace === undefined ? repoWorkspace(process.cwd()) : { workspace: resolve(parsed.values.workspace), from: undefined }
  try {
    switch (command) {
      case 'run': {
        if (args.length !== 1) return usageError('run takes one argument')
        const raw = parsed.values['max-depth']
        const maxDepth = raw === undefined ? undefined : Number(raw)
        if (maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 8)) {
          return usageError('--max-depth must be a whole number from 1 to 8')
        }
        announceRoot(workspace, from)
        return await run(args[0], workspace, deps, { maxDepth, maxCost, agentsFile: parsed.values.agents, approveSplits: parsed.values['approve-splits'] })
      }
      case 'resume':
        if (args.length > 1) return usageError('resume takes at most one argument: a run id')
        return await resumeRun(workspace, deps, args[0], maxCost)
      case 'status':
        if (args.length > 1) return usageError('status takes at most one argument: a run id')
        return status(workspace, args[0], parsed.values.json)
      case 'wait': {
        if (args.length > 1) return usageError('wait takes at most one argument: a run id')
        const raw = parsed.values.timeout
        if (raw !== undefined && !/^\d+(\.\d+)?$/.test(raw)) return usageError('--timeout must be a number of seconds')
        return await wait(workspace, args[0], raw === undefined ? undefined : Number(raw), parsed.values.json)
      }
      case 'runs':
        if (args.length) return usageError('runs takes no arguments')
        return runs(workspace)
      case 'answer':
        if (args.length < 2 || args.length > 3) return usageError('answer takes a node, the answer and optionally a run id')
        if (!args[1].trim()) return usageError('the answer is empty')
        return sendCommand(workspace, { type: 'answer', node: args[0], text: args[1] }, args[2])
      case 'approve':
      case 'cancel':
        if (args.length < 1 || args.length > 2) return usageError(`${command} takes a node and optionally a run id`)
        return sendCommand(workspace, { type: command, node: args[0] }, args[1])
      case 'doctor':
        if (args.length) return usageError('doctor takes no arguments')
        announceRoot(workspace, from)
        return await doctor(workspace, deps.leadCredential, deps.loginProblem)
      case 'export':
        if (args.length < 1 || args.length > 2) return usageError('export takes an exporter (atif or otlp) and optionally a run id')
        if (!['atif', 'otlp'].includes(args[0])) return usageError(`unknown exporter ${args[0]}`)
        return await exportRun(args[0] as 'atif' | 'otlp', workspace, deps, args[1])
      case 'diff':
        if (args.length > 1) return usageError('diff takes at most one argument: a run id')
        return diff(workspace, args[0], parsed.values.stat ?? false)
      case 'clean': {
        if (args.length > 1) return usageError('clean takes at most one argument: a run id')
        if (parsed.values.all && args.length) return usageError('clean takes a run id or --all, not both')
        const { all, branches, unmerged } = parsed.values
        return clean(workspace, all ? undefined : args, { branches, unmerged, dryRun: parsed.values['dry-run'] })
      }
      case 'ui': {
        const port = parsed.values.port ?? '0'
        if (args.length) return usageError('ui takes no arguments')
        if (!/^\d+$/.test(port) || Number(port) > 65535) return usageError('--port must be a number from 0 to 65535')
        const ui = await startUi(workspace, (h, raw) => deps.getAdapter(h).parse(raw), Number(port))
        console.log(`sous ui: ${ui.url}\n(Ctrl-C stops it)`)
        // Serves until the process is stopped.
        return await new Promise<number>(() => {})
      }
    }
  } catch (err) {
    console.error(`sous: ${(err as Error).message}`)
    return 1
  }
  return usageError(command === undefined ? undefined : `unknown command ${command}`)
}
