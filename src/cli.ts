#!/usr/bin/env node
// murm: run a graph file or a goal, resume a stopped run, show a run's status, answer, approve and cancel nodes of a
// running run.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { agentNames, agentSpec, checkAgents, whyUnavailable } from './agents.ts'
import type { Unavailable } from './agents.ts'
import { loadGraph } from './graph.ts'
import { lockHolder, openLog, readEvents } from './log.ts'
import { eventMessage, fold, isFinal } from './state.ts'
import type { NodeState, RunState } from './state.ts'
import { runSupervisor } from './supervisor.ts'
import type { PersonCommand, SupervisorOptions } from './supervisor.ts'
import { exportAtif } from './trace/atif.ts'
import { exportOtlp } from './trace/otlp.ts'
import { PERSON } from './types.ts'
import type { Event, GraphFile, HarnessName, ParsedTurn } from './types.ts'

const USAGE = `usage:
  murm run <graph.json | "goal"> [--workspace <dir>]
  murm resume [run-id] [--workspace <dir>]
  murm status [run-id] [--workspace <dir>]
  murm answer <node> "text" [--workspace <dir>]
  murm approve <node> [--workspace <dir>]
  murm cancel <node> [--workspace <dir>]
  murm export atif|otlp [run-id] [--workspace <dir>]`

export interface CliDeps {
  getAdapter: SupervisorOptions['getAdapter']
  createLeadRunner?: SupervisorOptions['createLeadRunner']
  /** Whether lead agents on `provider` can run: the Pi login has a credential for it. */
  hasLeadCredential: (provider: string) => Promise<boolean>
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
      case 'resume':
        if (args.length > 1) break
        return await resumeRun(workspace, deps, args[0])
      case 'status':
        if (args.length > 1) break
        return status(workspace, args[0])
      case 'answer':
        if (args.length !== 2 || !args[1].trim()) break
        return sendCommand(workspace, { type: 'answer', node: args[0], text: args[1] })
      case 'approve':
      case 'cancel':
        if (args.length !== 1) break
        return sendCommand(workspace, { type: command, node: args[0] })
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

/** An argument naming an existing file is a graph file; anything else is a goal for one lead named `lead`. */
async function run(arg: string, workspace: string, deps: CliDeps): Promise<number> {
  const isGraph = existsSync(arg) && statSync(arg).isFile()
  if (!isGraph && !arg.trim()) throw new Error('the goal is empty')
  const graph: GraphFile = isGraph ? loadGraph(arg) : { goal: arg, nodes: [{ id: 'lead', kind: 'lead', brief: arg }] }
  if (!existsSync(workspace)) throw new Error(`workspace ${workspace} does not exist`)
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(2).toString('hex')
  const runDir = join(workspace, '.murm', 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const createdAt = new Date().toISOString()
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ id, goal: graph.goal, workspace, ...(isGraph ? { graph: resolve(arg) } : {}), createdAt }, null, 2) + '\n')
  console.log(`run ${id} (${runDir})`)

  const unavailable = await agents(graph, deps)
  const printEvent = printer()
  const log = openLog(runDir, printEvent)
  log.append({ type: 'run.created', goal: graph.goal, workspace, ...(isGraph ? { graph } : {}) })
  for (const node of graph.nodes) log.append({ type: 'node.added', node, by: isGraph ? 'graph' : 'goal' })
  log.close()

  const outcome = await runSupervisor({
    workspace, runDir, getAdapter: deps.getAdapter, createLeadRunner: deps.createLeadRunner, onEvent: printEvent, unavailable,
  })
  printResult(runDir)
  if (outcome === 'interrupted') console.log(`stopped; continue with: murm resume ${id}`)
  return outcome === 'completed' ? 0 : 1
}

/** Continue a run whose supervisor stopped or crashed. */
async function resumeRun(workspace: string, deps: CliDeps, runId?: string): Promise<number> {
  const { id, runDir } = findRun(workspace, runId)
  const events = readEvents(runDir)
  const state = fold(events)
  if (state.status !== 'running') throw new Error(`run ${id} already ${state.status}; a finished run is not resumed`)
  console.log(`resuming run ${id} (${runDir})`)
  const unavailable = await agents(state.graph, deps)
  printPending(state)
  const printEvent = printer(events)
  const outcome = await runSupervisor({
    workspace: state.workspace, runDir, getAdapter: deps.getAdapter, createLeadRunner: deps.createLeadRunner, onEvent: printEvent,
    resume: true, unavailable,
  })
  printResult(runDir)
  if (outcome === 'interrupted') console.log(`stopped; continue with: murm resume ${id}`)
  return outcome === 'completed' ? 0 : 1
}

/** Names the branch that holds the run's merged work, once the run has one. */
function printResult(runDir: string): void {
  const branch = fold(readEvents(runDir)).integration?.branch
  if (branch) console.log(`result: branch ${branch}`)
}

/** Check which agents can run, once per run start, and print it. */
async function agents(graph: GraphFile | undefined, deps: CliDeps): Promise<Unavailable> {
  const unavailable = await checkAgents(graph, deps.hasLeadCredential)
  const why = (name: string) => whyUnavailable(agentSpec(graph, name)!.runs, agentSpec(graph, name)!.model, unavailable)
  const names = agentNames(graph)
  const missing = names.filter(why).map((n) => `${n} (${why(n)})`)
  console.log(`agents: ${names.filter((n) => !why(n)).join(', ') || 'none'}${missing.length ? `; not available: ${missing.join(', ')}` : ''}`)
  return unavailable
}

/** Prints one line per event, every message to the person as a question to answer, and every gate's request.
 * `past` are the events already in the log, which this does not print. */
function printer(past: Event[] = []): (e: Event) => void {
  const nodes = new Map<string, { parent?: string; kind: string }>()
  const track = (e: Event) => {
    if (e.type === 'node.added') nodes.set(e.node.id, e.node)
    if (e.type === 'lead.call' && e.ok && e.call.tool === 'spawn') for (const c of e.call.children) nodes.set(c.id, { parent: e.node, kind: c.kind })
  }
  past.forEach(track)
  return (e) => {
    track(e)
    printEvent(e)
    const m = eventMessage(e, (id) => nodes.get(id)?.parent)
    if (m?.to !== PERSON) return
    if (nodes.get(m.from)?.kind === 'gate') console.log(`\n${approvalText(m.from, m.body)}\n`)
    else console.log(`\nQuestion from ${m.from}:\n${m.body}\nAnswer with: murm answer ${m.from} "<answer>"\n`)
  }
}

const approvalText = (gate: string, body: string) =>
  `Approval requested by ${gate}:\n${body}\nApprove with: murm approve ${gate}, or reject with: murm cancel ${gate}`

function printEvent(e: Event): void {
  const time = e.at.slice(11, 19)
  let text: string
  switch (e.type) {
    case 'run.created': text = `goal: ${e.goal}`; break
    case 'node.added': text = `${e.node.id} (${e.node.kind}${e.node.agent ? `, ${e.node.agent}` : ''})`; break
    case 'turn.started': text = `${e.node} turn ${e.turn} ${e.mode}${e.agent ? ` on ${e.agent}` : ''} pid ${e.pid}`; break
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
    case 'run.resumed': text = 'unfinished turns and deliveries are recovered'; break
    case 'integration.created': text = `${e.branch} at ${e.path}`; break
    case 'worktree.created': text = `${e.node} ${e.branch} at ${e.path}`; break
    case 'merge.queued': text = `${e.node} ${e.branch}`; break
    case 'merge.withdrawn': text = `${e.node}: messages arrived; its worker resumes`; break
    case 'merge.conflict': text = `${e.node}: ${e.reason}`; break
    case 'merge.done': text = `${e.node} ${e.commit} by ${e.by}`; break
    case 'merge.failed': text = `${e.node}: ${e.reason}`; break
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
  if (state.integration) console.log(`  result: branch ${state.integration.branch}`)
  const children = (parent?: string) => [...state.nodes.values()].filter((n) => n.spec.parent === parent)
  const print = (n: NodeState, depth: number) => {
    const turns = n.turns.length ? ` turns ${n.turns.length}` : ''
    const agent = n.turns.findLast((t) => t.agent)?.agent ?? n.spec.agent
    console.log(`${'  '.repeat(depth)}${n.spec.id} ${n.status}${agent ? ` on ${agent}` : ''}${turns}${lastSummary(n)}`)
    for (const c of children(n.spec.id)) print(c, depth + 1)
  }
  for (const n of children(undefined)) print(n, 1)
  printPending(state)
  if (live === 'stopped') console.log(`continue it with: murm resume ${id}`)
  return 0
}

/** Questions and gate approvals waiting for the person. */
function printPending(state: RunState): void {
  const open = state.questions.filter((q) => !isFinal(state.nodes.get(q.from)))
  const isGate = (q: { from: string }) => state.nodes.get(q.from)?.spec.kind === 'gate'
  const questions = open.filter((q) => !isGate(q))
  const gates = open.filter(isGate)
  if (questions.length) console.log('questions for you (murm answer <node> "<answer>"):')
  for (const q of questions) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (gates.length) console.log('approvals for you (murm approve <node>, or murm cancel <node> to reject):')
  for (const q of gates) console.log(`  ${q.from}: ${oneLine(q.body)}`)
}

/** Hand a person's answer, approval or cancel to the run's supervisor through a command file. */
function sendCommand(workspace: string, cmd: PersonCommand): number {
  const { id, runDir } = findRun(workspace)
  const node = fold(readEvents(runDir)).nodes.get(cmd.node)
  if (!node) throw new Error(`run ${id} has no node ${cmd.node}`)
  if (isFinal(node)) throw new Error(`node ${cmd.node} is already ${node.status}`)
  const gate = node.spec.kind === 'gate'
  if (cmd.type === 'answer' && gate) throw new Error(`node ${cmd.node} is a gate: approve it with murm approve, or reject it with murm cancel`)
  if (cmd.type === 'approve' && !gate) throw new Error(`node ${cmd.node} is not a gate`)
  if (cmd.type === 'approve' && node.status !== 'waiting') throw new Error(`gate ${cmd.node} is not waiting for approval yet`)
  if (lockHolder(runDir) === undefined) throw new Error(`run ${id} is not running`)
  const dir = join(runDir, 'commands')
  const file = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(cmd) + '\n')
  renameSync(`${file}.tmp`, `${file}.json`)
  console.log(`${cmd.type} for ${cmd.node} sent to run ${id}`)
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
  const [{ getAdapter }, { createLeadRunner, hasLeadCredential }] = await Promise.all([import('./adapters/index.ts'), import('./lead/index.ts')])
  process.exitCode = await main(process.argv.slice(2), { getAdapter, createLeadRunner, hasLeadCredential })
}
