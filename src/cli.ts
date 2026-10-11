#!/usr/bin/env node
// murm: run a graph file, show a run's status.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadGraph } from './graph.ts'
import { lockHolder, openLog, readEvents } from './log.ts'
import { fold } from './state.ts'
import type { NodeState } from './state.ts'
import { runSupervisor } from './supervisor.ts'
import type { SupervisorOptions } from './supervisor.ts'
import { exportAtif } from './trace/atif.ts'
import { exportOtlp } from './trace/otlp.ts'
import type { Event, HarnessName, ParsedTurn } from './types.ts'

const USAGE = `usage:
  murm run <graph.json> [--workspace <dir>]
  murm status [run-id] [--workspace <dir>]
  murm export atif|otlp [run-id] [--workspace <dir>]`

export interface CliDeps {
  getAdapter: SupervisorOptions['getAdapter']
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { workspace: { type: 'string' } } })
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`)
    return 2
  }
  const [command, ...args] = parsed.positionals
  const workspace = resolve(parsed.values.workspace ?? process.cwd())
  try {
    switch (command) {
      case 'run':
        if (args.length !== 1) break
        return await run(args[0], workspace, deps)
      case 'status':
        if (args.length > 1) break
        return status(workspace, args[0])
      case 'export':
        if (args.length < 1 || args.length > 2 || !['atif', 'otlp'].includes(args[0])) break
        return await exportRun(args[0] as 'atif' | 'otlp', workspace, deps, args[1])
    }
  } catch (err) {
    console.error(`murm: ${(err as Error).message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

async function run(graphPath: string, workspace: string, deps: CliDeps): Promise<number> {
  const graph = loadGraph(graphPath)
  if (!existsSync(workspace)) throw new Error(`workspace ${workspace} does not exist`)
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(2).toString('hex')
  const runDir = join(workspace, '.murm', 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const createdAt = new Date().toISOString()
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ id, goal: graph.goal, workspace, graph: resolve(graphPath), createdAt }, null, 2) + '\n')
  console.log(`run ${id} (${runDir})`)

  const log = openLog(runDir, printEvent)
  log.append({ type: 'run.created', goal: graph.goal, workspace, graph })
  for (const node of graph.nodes) log.append({ type: 'node.added', node, by: 'graph' })
  log.close()

  const outcome = await runSupervisor({ workspace, runDir, getAdapter: deps.getAdapter, onEvent: printEvent })
  if (outcome === 'interrupted') console.log(`stopped; run ${id} can be resumed later`)
  return outcome === 'completed' ? 0 : 1
}

function printEvent(e: Event): void {
  const time = e.at.slice(11, 19)
  let text: string
  switch (e.type) {
    case 'run.created': text = `goal: ${e.goal}`; break
    case 'node.added': text = `${e.node.id} (${e.node.kind}${e.node.harness ? `, ${e.node.harness}` : ''})`; break
    case 'turn.started': text = `${e.node} turn ${e.turn} ${e.mode} pid ${e.pid}`; break
    case 'turn.session': text = `${e.node} turn ${e.turn} session ${e.sessionId}`; break
    case 'turn.interrupted': text = `${e.node} turn ${e.turn} ${e.signal}: ${e.reason}`; break
    case 'turn.ended':
      text = `${e.node} turn ${e.turn} ` + (e.result ? `${e.result.status}: ${e.result.summary}` : `exit ${e.exitCode ?? e.signal}, ${e.error}`)
      break
    case 'check.ended': text = `${e.node} exit ${e.exitCode}: ${lastLine(e.output)}`; break
    case 'node.completed': text = `${e.node}: ${e.summary}`; break
    case 'node.failed': text = `${e.node}: ${e.reason}`; break
    case 'message': text = `${e.from} -> ${e.to} (${e.mode})`; break
    case 'lead.delivered': text = `${e.node} <- ${e.requestId} (${e.mode})`; break
    case 'lead.call': text = `${e.node} ${e.call.tool}${e.ok ? '' : ' refused'}: ${e.result}`; break
    case 'lead.turn': text = `${e.node} ${e.status}: ${e.text}`; break
    case 'node.cancelled': text = `${e.node} by ${e.by}`; break
    case 'run.completed': text = e.summary; break
    case 'run.failed': text = e.reason; break
  }
  console.log(`${time} ${e.type.padEnd(16)} ${oneLine(text)}`)
}

/** The run directory for `runId`, or the latest run. */
function findRun(workspace: string, runId?: string): { id: string; runDir: string } {
  const runsDir = join(workspace, '.murm', 'runs')
  const ids = existsSync(runsDir) ? readdirSync(runsDir).sort() : []
  const id = runId ?? ids.at(-1)
  if (!id || !ids.includes(id)) throw new Error(runId ? `no run ${runId} in ${runsDir}` : `no runs in ${runsDir}`)
  return { id, runDir: join(runsDir, id) }
}

async function exportRun(format: 'atif' | 'otlp', workspace: string, deps: CliDeps, runId?: string): Promise<number> {
  const { runDir } = findRun(workspace, runId)
  const parse = (h: HarnessName, raw: string): ParsedTurn => deps.getAdapter(h).parse(raw)
  if (format === 'atif') {
    const file = join(runDir, 'trace.atif.json')
    writeFileSync(file, exportAtif(runDir, parse))
    console.log(file)
  } else {
    console.log(`trace ${await exportOtlp(runDir, parse)}`)
  }
  return 0
}

function status(workspace: string, runId?: string): number {
  const { id, runDir } = findRun(workspace, runId)
  const state = fold(readEvents(runDir))
  const live = state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
  console.log(`run ${id} ${live}: ${state.goal}`)
  if (state.reason) console.log(`  ${oneLine(state.reason)}`)
  const children = (parent?: string) => [...state.nodes.values()].filter((n) => n.spec.parent === parent)
  const print = (n: NodeState, depth: number) => {
    const turns = n.turns.length ? ` turns ${n.turns.length}` : ''
    console.log(`${'  '.repeat(depth)}${n.spec.id} ${n.status}${turns}${lastSummary(n)}`)
    for (const c of children(n.spec.id)) print(c, depth + 1)
  }
  for (const n of children(undefined)) print(n, 1)
  return 0
}

function lastSummary(n: NodeState): string {
  const text = n.reason ?? n.turns.findLast((t) => t.result)?.result?.summary ?? n.summary ??
    (n.checks.length ? lastLine(n.checks[n.checks.length - 1].output) : undefined)
  return text ? `: ${oneLine(text)}` : ''
}

function lastLine(output: string): string {
  return output.trimEnd().split('\n').at(-1) ?? ''
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? line.slice(0, 157) + '...' : line
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { getAdapter } = await import('./adapters/index.ts')
  process.exitCode = await main(process.argv.slice(2), { getAdapter })
}
