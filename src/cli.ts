#!/usr/bin/env node
// sous: run a graph file or a goal, resume a stopped run, show a run's status, answer, approve and cancel nodes of a
// running run.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { agentNames, agentSpec, checkAgents, defines, unusableNodeAgents, whyUnavailable } from './agents.ts'
import { inWorkTree } from './git.ts'
import type { Unavailable } from './agents.ts'
import { loadDefinitions, loadGraph } from './graph.ts'
import { listRuns, lockHolder, openLog, readEvents, writeCommand } from './log.ts'
import { MAX_WAIT_SECONDS, workerReceive, workerSend } from './send.ts'
import { awaitsSplitApproval, completedText, eventMessage, fold, isFinal } from './state.ts'
import type { NodeState, RunState } from './state.ts'
import { runSupervisor } from './supervisor.ts'
import type { PersonCommand, SupervisorOptions, SupervisorOutcome } from './supervisor.ts'
import { exportAtif } from './trace/atif.ts'
import { exportOtlp } from './trace/otlp.ts'
import { startUi } from './ui.ts'
import { PERSON, SPLITTER } from './types.ts'
import type { Definitions, Event, GraphFile, HarnessName, NodeSpec, ParsedTurn } from './types.ts'

const USAGE = `usage:
  sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--approve-splits] [--workspace <dir>]
  sous resume [run-id] [--workspace <dir>]
  sous status [run-id] [--workspace <dir>]
  sous answer <node> "text" [--workspace <dir>]
  sous approve <node> [--workspace <dir>]
  sous cancel <node> [--workspace <dir>]
  sous send <to> 'text'          (a worker of a running run, to a sibling or its lead)
  sous receive [seconds]         (a worker: the messages waiting for it, waiting up to 60 seconds for one)
  sous export atif|otlp [run-id] [--workspace <dir>]
  sous ui [--port <n>] [--workspace <dir>]   (a local page showing the workspace's runs, live or finished)`

export interface CliDeps {
  getAdapter: SupervisorOptions['getAdapter']
  createLeadRunner?: SupervisorOptions['createLeadRunner']
  /** Whether lead agents on `provider` can run: the Pi login has a credential for it. */
  hasLeadCredential: (provider: string) => Promise<boolean>
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  // A worker's message is text, not options: `sous send b "--force is required now"`.
  if (argv[0] === 'send' || argv[0] === 'receive') {
    const seconds = argv[0] === 'receive' && argv[1] !== undefined && /^\d+(\.\d+)?$/.test(argv[1]) ? Number(argv[1]) : argv[1] === undefined ? 0 : NaN
    if (argv[0] === 'send' ? argv.length !== 3 : argv.length > 2 || !(seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) {
      console.error(USAGE)
      return 2
    }
    const { SOUS_RUN_DIR: runDir, SOUS_NODE: node, SOUS_TURN: turn } = process.env
    if (!runDir || !node || !turn) {
      console.error(`sous: sous ${argv[0]} is for a worker inside a run: SOUS_RUN_DIR, SOUS_NODE and SOUS_TURN are not set`)
      return 1
    }
    const r = argv[0] === 'send' ? workerSend(runDir, node, argv[1], argv[2]) : await workerReceive(runDir, node, Number(turn), seconds)
    ;(r.ok ? console.log : console.error)(r.text)
    return r.ok ? 0 : 1
  }
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      workspace: { type: 'string' }, 'max-depth': { type: 'string' }, agents: { type: 'string' }, 'approve-splits': { type: 'boolean' },
      port: { type: 'string' },
    } })
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`)
    return 2
  }
  const [command, ...args] = parsed.positionals
  const workspace = resolve(parsed.values.workspace ?? process.cwd())
  try {
    switch (command) {
      case 'run': {
        if (args.length !== 1) break
        const raw = parsed.values['max-depth']
        const maxDepth = raw === undefined ? undefined : Number(raw)
        if (maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 8)) {
          console.error('sous: --max-depth must be a whole number from 1 to 8')
          return 2
        }
        return await run(args[0], workspace, deps, { maxDepth, agentsFile: parsed.values.agents, approveSplits: parsed.values['approve-splits'] })
      }
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
      case 'ui': {
        const port = Number(parsed.values.port ?? 0)
        if (args.length || !(Number.isInteger(port) && port >= 0 && port < 65536)) break
        const ui = await startUi(workspace, (h, raw) => deps.getAdapter(h).parse(raw), port)
        console.log(`sous ui: ${ui.url}\n(Ctrl-C stops it)`)
        // Serves until the process is stopped.
        return await new Promise<number>(() => {})
      }
    }
  } catch (err) {
    console.error(`sous: ${(err as Error).message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

/** An argument naming an existing file is a graph file; anything else is a goal for one lead named `lead`, with the
 * agent definitions of `agentsFile`, if given. An argument that looks like a file name (one word, not a URL, that ends in
 * `.json` or has a path separator) but names no file is refused, not taken for a goal. */
async function run(arg: string, workspace: string, deps: CliDeps, opts: { maxDepth?: number; agentsFile?: string; approveSplits?: boolean }): Promise<number> {
  const { maxDepth, agentsFile, approveSplits } = opts
  const isGraph = existsSync(arg) && statSync(arg).isFile()
  if (!isGraph && !arg.trim()) throw new Error('the goal is empty')
  if (!isGraph && !/\s/.test(arg) && !arg.includes('://') && (arg.endsWith('.json') || /[\\/]/.test(arg))) {
    throw new Error(`${existsSync(arg) ? 'not a file' : 'no such file'}: ${arg}; if it is a goal, write it as a sentence`)
  }
  if (isGraph && agentsFile !== undefined) throw new Error('--agents is for goal runs: put agents in the graph file')
  const definitions = agentsFile === undefined ? undefined : loadDefinitions(agentsFile)
  const graph: GraphFile = isGraph ? loadGraph(arg) : { goal: arg, ...definitions, nodes: [{ id: 'lead', kind: 'lead', brief: arg }] }
  // A lead may give a subtree a splitter from the agents the person defined, so any defined worker agent may become one.
  const splitters = defines(graph, SPLITTER) || graph.nodes.some((n) => n.roles?.splitter) || Object.values(graph.agents ?? {}).some((a) => a.runs !== 'lead')
  if (approveSplits && !splitters) throw new Error('--approve-splits needs a splitter: define an agent named splitter, or agents leads may give the splitter role')
  if (!existsSync(workspace)) throw new Error(`workspace ${workspace} does not exist`)
  // Refused before the run exists, as no process starts and nothing is spent on a graph that cannot run.
  const unavailable = await agents(graph, deps)
  const unusable = unusableNodeAgents(graph, unavailable)
  if (unusable.length) throw new Error(unusable.join('\n'))
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(2).toString('hex')
  const runDir = join(workspace, '.sous', 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const createdAt = new Date().toISOString()
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ id, goal: graph.goal, workspace, ...(isGraph ? { graph: resolve(arg) } : {}), ...(definitions ? { agents: resolve(agentsFile!) } : {}), createdAt }, null, 2) + '\n')
  console.log(`run ${id} (${runDir})`)

  // Decided once: a resumed run keeps the mode it was created with.
  const mode = inWorkTree(workspace) ? 'git' : 'folder'
  if (mode === 'folder') console.log(`folder mode (not a git repository): results go to ${join(runDir, 'output')}`)
  const printEvent = printer()
  const log = openLog(runDir, printEvent)
  log.append({ type: 'run.created', goal: graph.goal, workspace, ...(isGraph ? { graph } : definitions ? { definitions } : {}), ...(maxDepth ? { maxDepth } : {}), ...(approveSplits ? { approveSplits } : {}), mode })
  for (const node of graph.nodes) log.append({ type: 'node.added', node, by: isGraph ? 'graph' : 'goal' })
  log.close()

  let outcome: SupervisorOutcome | undefined
  try {
    outcome = await runSupervisor({
      workspace, runDir, getAdapter: deps.getAdapter, createLeadRunner: deps.createLeadRunner, onEvent: printEvent, unavailable,
    })
  } finally {
    printEnd(id, runDir)
  }
  return outcome === 'completed' ? 0 : 1
}

/** Continue a run whose supervisor stopped or crashed. */
async function resumeRun(workspace: string, deps: CliDeps, runId?: string): Promise<number> {
  const { id, runDir } = findRun(workspace, runId)
  const events = readEvents(runDir)
  const state = fold(events)
  if (state.status !== 'running') throw new Error(`run ${id} already ${state.status}; a finished run is not resumed`)
  console.log(`resuming run ${id} (${runDir})`)
  const unavailable = await agents({ ...state.agents, nodes: state.graph?.nodes }, deps)
  printPending(state)
  const printEvent = printer(events)
  let outcome: SupervisorOutcome | undefined
  try {
    outcome = await runSupervisor({
      workspace: state.workspace, runDir, getAdapter: deps.getAdapter, createLeadRunner: deps.createLeadRunner, onEvent: printEvent,
      resume: true, unavailable,
    })
  } finally {
    printEnd(id, runDir)
  }
  return outcome === 'completed' ? 0 : 1
}

/** After the supervisor: where the run's results are (the branch that holds its merged work, once it has one, or its
 * output folder), and how to continue a run that is not over, whether stopped or left by a supervisor error. */
function printEnd(id: string, runDir: string): void {
  const state = fold(readEvents(runDir))
  const result = resultOf(state, runDir)
  if (result) console.log(`result: ${result}`)
  if (state.status === 'running' && lockHolder(runDir) === undefined) console.log(`stopped; continue with: sous resume ${id}`)
}

function resultOf(state: RunState, runDir: string): string | undefined {
  if (state.mode === 'folder') return existsSync(join(runDir, 'output')) ? `folder ${join(runDir, 'output')}` : undefined
  return state.integration && `branch ${state.integration.branch}`
}

/** Check which agents can run, once per run start, and print it. */
async function agents(graph: Definitions & { nodes?: NodeSpec[] }, deps: CliDeps): Promise<Unavailable> {
  const unavailable = await checkAgents(graph, deps.hasLeadCredential)
  const why = (name: string) => whyUnavailable(agentSpec(graph, name)!.runs, agentSpec(graph, name)!.model, unavailable)
  const names = agentNames(graph)
  const missing = names.filter(why).map((n) => `${n} (${why(n)})`)
  console.log(`agents: ${names.filter((n) => !why(n)).join(', ') || 'none'}${missing.length ? `; not available: ${missing.join(', ')}` : ''}`)
  return unavailable
}

/** Prints one line per event, every message to the person as a question to answer, and every gate's or proposed
 * split's request. `past` are the events already in the log, which this does not print. */
function printer(past: Event[] = []): (e: Event) => void {
  const nodes = new Map<string, { parent?: string; kind: string }>()
  // Leads whose proposed split came before their brief: their message to the person asks for its approval.
  const proposed = new Set<string>()
  const track = (e: Event) => {
    if (e.type === 'node.added') nodes.set(e.node.id, e.node)
    if (e.type === 'lead.call' && e.ok && e.call.tool === 'spawn') for (const c of e.call.children) nodes.set(c.id, { parent: e.node, kind: c.kind })
    if (e.type === 'split.proposed') proposed.add(e.node)
    if (e.type === 'lead.delivered') proposed.delete(e.node)
  }
  past.forEach(track)
  return (e) => {
    track(e)
    printEvent(e)
    const m = eventMessage(e, (id) => nodes.get(id)?.parent)
    if (m?.to !== PERSON) return
    if (nodes.get(m.from)?.kind === 'gate') console.log(`\n${approvalText(m.from, m.body)}\n`)
    else if (proposed.has(m.from)) console.log(`\n${splitApprovalText(m.from, m.body)}\n`)
    else console.log(`\nQuestion from ${m.from}:\n${m.body}\nAnswer with: sous answer ${m.from} "<answer>"\n`)
  }
}

const approvalText = (gate: string, body: string) =>
  `Approval requested by ${gate}:\n${body}\nApprove with: sous approve ${gate}, or reject with: sous cancel ${gate}`

const splitApprovalText = (lead: string, body: string) =>
  `${body}\nApprove with: sous approve ${lead}, or give ${lead} changes with: sous answer ${lead} "<changes>"`

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
    case 'inbox.read': text = `${e.node} read its messages up to evt-${e.upTo}`; break
    case 'lead.call': text = `${e.node} ${e.call.tool}${e.ok ? '' : ' refused'}: ${e.result}`; break
    case 'lead.read': text = `${e.node} ${e.tool} ${e.path ?? '.'}${e.offset ? ` from ${e.offset}` : ''}: ${e.refused ? `refused: ${e.refused}` : `${e.bytes} bytes`}`; break
    case 'lead.turn': text = `${e.node} ${e.status}: ${e.text}`; break
    case 'node.cancelled': text = `${e.node} by ${e.by}`; break
    case 'run.resumed': text = 'unfinished turns and deliveries are recovered'; break
    case 'integration.created': text = `${e.branch} at ${e.path}`; break
    case 'worktree.created': text = `${e.node} ${e.branch} at ${e.path}`; break
    case 'merge.queued': text = `${e.node}${e.branch ? ` ${e.branch}` : ''}`; break
    case 'merge.withdrawn': text = `${e.node}: messages arrived; its worker resumes`; break
    case 'merge.conflict': text = `${e.node}: ${e.reason}`; break
    case 'merge.done': text = `${e.node}${e.commit ? ` ${e.commit}` : ''} by ${e.by}${e.files ? `, ${e.files.length} files` : ''}`; break
    case 'merge.failed': text = `${e.node}: ${e.reason}`; break
    case 'split.requested': text = `${e.node} waits for splitter ${e.agent}`; break
    case 'split.proposed': text = `${e.node}: ${e.parts.map((p) => p.id).join(', ')}: ${e.summary}`; break
    case 'split.failed': text = `${e.node}: ${e.reason}`; break
    case 'run.completed': text = e.summary; break
    case 'run.failed': text = e.reason; break
  }
  console.log(`${time} ${e.type.padEnd(16)} ${oneLine(text)}`)
}

/** The run directory for `runId`, or the latest run. */
function findRun(workspace: string, runId?: string): { id: string; runDir: string } {
  const { runsDir, ids } = listRuns(workspace)
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
  const result = resultOf(state, runDir)
  if (result) console.log(`  result: ${result}`)
  const children = (parent?: string) => [...state.nodes.values()].filter((n) => n.spec.parent === parent)
  const print = (n: NodeState, depth: number) => {
    const turns = n.turns.length ? ` turns ${n.turns.length}` : ''
    const agent = n.turns.findLast((t) => t.agent)?.agent ?? n.spec.agent
    console.log(`${'  '.repeat(depth)}${n.spec.id} ${n.status}${agent ? ` on ${agent}` : ''}${turns}${lastSummary(n)}`)
    for (const c of children(n.spec.id)) print(c, depth + 1)
  }
  for (const n of children(undefined)) print(n, 1)
  printPending(state)
  if (live === 'stopped') console.log(`continue it with: sous resume ${id}`)
  return 0
}

/** Questions, gate approvals and proposed splits waiting for the person. */
function printPending(state: RunState): void {
  const open = state.questions.filter((q) => !isFinal(state.nodes.get(q.from)))
  const isGate = (q: { from: string }) => state.nodes.get(q.from)?.spec.kind === 'gate'
  const isSplit = (q: { from: string }) => awaitsSplitApproval(state.nodes.get(q.from)!)
  const questions = open.filter((q) => !isGate(q) && !isSplit(q))
  const gates = open.filter(isGate)
  const splits = open.filter(isSplit)
  if (questions.length) console.log('questions for you (sous answer <node> "<answer>"):')
  for (const q of questions) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (gates.length) console.log('approvals for you (sous approve <node>, or sous cancel <node> to reject):')
  for (const q of gates) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (splits.length) console.log('splits for you to approve (sous approve <lead>, or sous answer <lead> "<changes>"):')
  for (const q of splits) console.log(`  ${q.from}: ${oneLine(q.body)}`)
}

/** Hand a person's answer, approval or cancel to the run's supervisor through a command file. */
function sendCommand(workspace: string, cmd: Exclude<PersonCommand, { type: 'send' }>): number {
  const { id, runDir } = findRun(workspace)
  const node = fold(readEvents(runDir)).nodes.get(cmd.node)
  if (!node) throw new Error(`run ${id} has no node ${cmd.node}`)
  if (isFinal(node)) throw new Error(`node ${cmd.node} is already ${node.status}`)
  const gate = node.spec.kind === 'gate'
  if (cmd.type === 'answer' && gate) throw new Error(`node ${cmd.node} is a gate: approve it with sous approve, or reject it with sous cancel`)
  if (cmd.type === 'approve' && !gate && !awaitsSplitApproval(node)) {
    throw new Error(node.spec.kind === 'lead' ? `lead ${cmd.node} has no proposed split waiting for approval` : `node ${cmd.node} is not a gate or a lead`)
  }
  if (cmd.type === 'approve' && gate && node.status !== 'waiting') throw new Error(`gate ${cmd.node} is not waiting for approval yet`)
  if (lockHolder(runDir) === undefined) throw new Error(`run ${id} is not running`)
  writeCommand(runDir, cmd)
  console.log(`${cmd.type} for ${cmd.node} sent to run ${id}`)
  return 0
}

function lastSummary(n: NodeState): string {
  const text = n.reason ?? (n.failedChecks?.length ? completedText(n) : undefined) ?? n.turns.findLast((t) => t.result)?.result?.summary ?? n.summary ??
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
