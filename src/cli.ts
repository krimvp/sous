#!/usr/bin/env node
// sous: run a graph file or a goal, resume a stopped run, show a run's status, answer, approve and cancel nodes of a
// running run.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { agentSpec, checkAgents, defaultLeadModel, defines, startAgents, unusableNodeAgents, whyUnavailable } from './agents.ts'
import { dirtyChanges, inWorkTree, repoRoot } from './git.ts'
import type { Unavailable } from './agents.ts'
import { loadDefinitions, loadGraph } from './graph.ts'
import { doctor } from './doctor.ts'
import { listRuns, lockHolder, openLog, readEvents, writeCommand } from './log.ts'
import { MAX_WAIT_SECONDS, workerReceive, workerSend } from './send.ts'
import { awaitsSplitApproval, completedText, eventMessage, fold, isFinal } from './state.ts'
import type { NodeState, RunState } from './state.ts'
import { commandRefusal, runSupervisor } from './supervisor.ts'
import type { PersonCommand, SupervisorOptions, SupervisorOutcome } from './supervisor.ts'
import { exportAtif } from './trace/atif.ts'
import { exportOtlp } from './trace/otlp.ts'
import { startUi } from './ui.ts'
import { DEFAULT_LEAD_MODEL, PERSON, SPLITTER } from './types.ts'
import type { Definitions, Event, GraphFile, HarnessName, NodeSpec, ParsedTurn } from './types.ts'

const USAGE = `usage:
  sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--approve-splits] [--workspace <dir>]
  sous resume [run-id] [--workspace <dir>]
  sous status [run-id] [--workspace <dir>]
  sous runs [--workspace <dir>]  (the workspace's runs, newest first)
  sous answer <node> "text" [run-id] [--workspace <dir>]
  sous approve <node> [run-id] [--workspace <dir>]
  sous cancel <node> [run-id] [--workspace <dir>]
  sous send <to> 'text'          (a worker of a running run, to a sibling or its lead)
  sous receive [seconds]         (a worker: the messages waiting for it, waiting up to 60 seconds for one)
  sous export atif|otlp [run-id] [--workspace <dir>]
  sous --help | --version        (sous <command> --help shows one command)
  sous ui [--port <n>] [--workspace <dir>]   (a local page showing the workspace's runs, live or finished)
  sous doctor [--workspace <dir>]  (whether a run could start here: harnesses and versions, lead credentials, git state)`

/** The usage lines of `command`, or all of them when it names none. */
function usageOf(command?: string): string {
  const own = USAGE.split('\n').filter((line) => line.startsWith(`  sous ${command} `))
  return command !== undefined && own.length ? `usage:\n${own.join('\n')}` : USAGE
}

/** One line saying what was wrong, then the usage, on stderr; the exit code for a command that was not understood. */
function usageError(problem?: string): number {
  console.error(problem === undefined ? USAGE : `sous: ${problem}\n${USAGE}`)
  return 2
}

const version = () => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export interface CliDeps {
  getAdapter: SupervisorOptions['getAdapter']
  createLeadRunner?: SupervisorOptions['createLeadRunner']
  /** Where lead agents on `provider` get their credential (an environment variable, or the Pi login), if anywhere. */
  leadCredential: (provider: string) => Promise<string | undefined>
  /** Lists the person's Codex MCP servers for the Codex adapter, at run start when Codex is available. */
  listCodexServers?: () => Promise<void>
  /** What is wrong with the Pi login file, if anything (`sous doctor` says so). */
  loginProblem?: () => string | undefined
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  // A worker's message is text, not options: `sous send b "--force is required now"`.
  if (argv[0] === 'send' || argv[0] === 'receive') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
      console.log(usageOf(argv[0]))
      return 0
    }
    const seconds = argv[0] === 'receive' && argv[1] !== undefined && /^\d+(\.\d+)?$/.test(argv[1]) ? Number(argv[1]) : argv[1] === undefined ? 0 : NaN
    if (argv[0] === 'send' && argv.length !== 3) return usageError('send takes a recipient and a text')
    if (argv[0] === 'receive' && argv.length > 2) return usageError('receive takes at most one argument: the seconds to wait')
    if (argv[0] === 'receive' && !(seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) return usageError(`receive waits from 0 to ${MAX_WAIT_SECONDS} seconds`)
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
      port: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } })
  } catch (err) {
    // Node's message goes on to explain `--`; keep the first sentence.
    const [problem] = (err as Error).message.split('. ')
    return usageError(problem[0].toLowerCase() + problem.slice(1))
  }
  const [command, ...args] = parsed.positionals
  if (parsed.values.version) {
    console.log(version())
    return 0
  }
  if (parsed.values.help || command === 'help') {
    console.log(usageOf(command === 'help' ? args[0] : command))
    return 0
  }
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
        return await run(args[0], workspace, deps, { maxDepth, agentsFile: parsed.values.agents, approveSplits: parsed.values['approve-splits'] })
      }
      case 'resume':
        if (args.length > 1) return usageError('resume takes at most one argument: a run id')
        return await resumeRun(workspace, deps, args[0])
      case 'status':
        if (args.length > 1) return usageError('status takes at most one argument: a run id')
        return status(workspace, args[0])
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

/** In a git repository the workspace is its top level, wherever sous was started: worktrees cover the whole repository,
 * so workers and checks work from the root, and `.sous/` must be there too, or `sous status` from another folder would
 * not find the run. `from` is the folder it moved from. */
function repoWorkspace(dir: string): { workspace: string; from?: string } {
  const root = existsSync(dir) ? repoRoot(dir) : undefined
  return root === undefined || realpathSync(root) === realpathSync(dir) ? { workspace: dir } : { workspace: root, from: dir }
}

/** Say that the workspace is not where sous was started. */
function announceRoot(workspace: string, from?: string): void {
  if (from) console.log(`workspace is the git repository root ${workspace}, not ${from}: runs and .sous/ live there`)
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
  else {
    const changes = dirtyChanges(workspace)
    if (changes) console.log(`workspace has ${changes} uncommitted change${changes === 1 ? '' : 's'}; workers see HEAD only`)
  }
  const printEvent = printer([], () => runRef(workspace, id))
  const log = openLog(runDir, printEvent)
  log.append({ type: 'run.created', goal: graph.goal, workspace, ...(isGraph ? { graph } : definitions ? { definitions } : {}), ...(maxDepth ? { maxDepth } : {}), ...(approveSplits ? { approveSplits } : {}), mode, ...(unavailable.leadModel ? { leadModel: unavailable.leadModel } : {}) })
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
  // A run from before the choice was recorded started on the fixed default.
  const unavailable = await agents({ ...state.agents, nodes: state.graph?.nodes }, deps, state.leadModel ?? DEFAULT_LEAD_MODEL)
  printPending(state, runRef(workspace, id))
  const printEvent = printer(events, () => runRef(workspace, id))
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
 * output folder), and how to continue a run that is not over, whether stopped or left by a supervisor error. Nothing
 * when another supervisor holds the run (this one never ran it), and never an error over the supervisor's own. */
function printEnd(id: string, runDir: string): void {
  try {
    if (lockHolder(runDir) !== undefined) return
    const state = fold(readEvents(runDir))
    const result = resultOf(state, runDir)
    if (result) console.log(`result: ${result}`)
    if (state.status === 'running') console.log(`stopped; continue with: sous resume ${id}`)
  } catch {}
}

function resultOf(state: RunState, runDir: string): string | undefined {
  if (state.mode === 'folder') return existsSync(join(runDir, 'output')) ? `folder ${join(runDir, 'output')}` : undefined
  return state.integration && `branch ${state.integration.branch}`
}

/** Check which agents can run, once per run start, and print it, with the model each lead agent runs on (`leadModel`:
 * the one recorded for a resumed run). */
async function agents(graph: Definitions & { nodes?: NodeSpec[] }, deps: CliDeps, leadModel?: string): Promise<Unavailable> {
  const unavailable = await checkAgents(graph, deps.leadCredential, leadModel)
  const why = (name: string) => whyUnavailable(agentSpec(graph, name)!.runs, agentSpec(graph, name)!.model, unavailable)
  const label = (name: string) => {
    const spec = agentSpec(graph, name)!
    return spec.runs === 'lead' ? `${name} (${spec.model ?? defaultLeadModel(unavailable)})` : name
  }
  const names = startAgents(graph, unavailable)
  const missing = names.filter(why).map((n) => `${n} (${why(n)})`)
  console.log(`agents: ${names.filter((n) => !why(n)).map(label).join(', ') || 'none'}${missing.length ? `; not available: ${missing.join(', ')}` : ''}`)
  // Here rather than on a Codex worker's first turn, where it would hold up the supervisor.
  if (!unavailable.commands.includes('codex')) await deps.listCodexServers?.()
  return unavailable
}

/** Prints one line per event, every message to the person as a question to answer, and every gate's or proposed
 * split's request. `past` are the events already in the log, which this does not print. `ref` is what the commands in
 * those requests name the run with (see `runRef`). */
function printer(past: Event[], ref: () => string): (e: Event) => void {
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
    const r = ref()
    if (nodes.get(m.from)?.kind === 'gate') console.log(`\n${approvalText(m.from, m.body, r)}\n`)
    else if (proposed.has(m.from)) console.log(`\n${splitApprovalText(m.from, m.body, r)}\n`)
    else console.log(`\nQuestion from ${m.from}:\n${m.body}\nAnswer with: sous answer ${m.from} "<answer>"${r}\n`)
  }
}

const approvalText = (gate: string, body: string, r: string) =>
  `Approval requested by ${gate}:\n${body}\nApprove with: sous approve ${gate}${r}, or reject with: sous cancel ${gate}${r}`

const splitApprovalText = (lead: string, body: string, r: string) =>
  `${body}\nApprove with: sous approve ${lead}${r}, or give ${lead} changes with: sous answer ${lead} "<changes>"${r}`

/** How `sous answer`, `approve` and `cancel` name run `id` in the commands sous prints: by its id when the workspace has
 * more than one run, else not at all. */
const runRef = (workspace: string, id: string) => (listRuns(workspace).ids.length > 1 ? ` ${id}` : '')

function printEvent(e: Event): void {
  const time = e.at.slice(11, 19)
  let text: string
  switch (e.type) {
    case 'run.created': text = `goal: ${e.goal}`; break
    case 'node.added': text = `${e.node.id} (${e.node.kind}${e.node.agent ? `, ${e.node.agent}` : ''})`; break
    case 'turn.started': text = `${e.node} turn ${e.turn} ${e.mode}${e.agent ? ` on ${e.agent}` : ''} pid ${e.pid}`; break
    case 'turn.session': text = `${e.node} turn ${e.turn} session ${e.sessionId}`; break
    case 'turn.interrupted': text = `${e.node} turn ${e.turn} ${e.signal}: ${e.reason}`; break
    case 'turn.stalled': text = `${e.node} turn ${e.turn}: no output for ${duration(Date.parse(e.at) - Date.parse(e.since))}; it keeps running`; break
    case 'turn.ended':
      text = `${e.node} turn ${e.turn} ` + (e.result ? `${e.result.status}: ${e.result.summary}` : `exit ${e.exitCode ?? e.signal}, ${e.error}`)
      break
    case 'check.ended': text = `${e.node} exit ${e.exitCode}: ${lastLine(e.output)}`; break
    case 'node.completed': text = `${e.node}: ${e.summary}`; break
    case 'node.failed': text = `${e.node}: ${e.reason}`; break
    case 'message': text = `${e.from} -> ${e.to} (${e.mode})`; break
    case 'lead.delivered': text = `${e.node} <- ${[...(e.carries ?? []), e.requestId].join(', ')} (${e.mode})`; break
    case 'inbox.read': text = `${e.node} read its messages up to evt-${e.upTo}`; break
    case 'lead.call': text = `${e.node} ${e.call.tool}${e.ok ? '' : ' refused'}: ${e.result}`; break
    case 'lead.read': text = `${e.node} ${e.tool} ${e.path ?? '.'}${e.offset ? ` from ${e.offset}` : ''}: ${e.refused ? `refused: ${e.refused}` : `${e.bytes} bytes`}`; break
    case 'lead.turn': text = `${e.node} ${e.status}: ${e.text}`; break
    case 'node.cancelled': text = `${e.node} by ${e.by}`; break
    case 'command.refused': text = e.reason; break
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
  const events = readEvents(runDir)
  const state = fold(events)
  const live = state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
  console.log(`run ${id} ${live}: ${firstLine(state.goal)}`)
  if (state.reason) console.log(`  ${oneLine(state.reason)}`)
  const result = resultOf(state, runDir)
  if (result) console.log(`  result: ${result}`)
  const children = (parent?: string) => [...state.nodes.values()].filter((n) => n.spec.parent === parent)
  // A running turn's age and the age of its last output (its output file's last change), so a hung turn shows.
  const now = Date.now()
  const startedAt = new Map(events.flatMap((e) => (e.type === 'turn.started' ? [[`${e.node} ${e.turn}`, Date.parse(e.at)]] : [])))
  const running = (n: NodeState) => {
    const t = n.turns.at(-1)
    if (live !== 'running' || !t || t.ended) return ''
    let output = 'no output yet'
    try {
      const out = statSync(resolve(runDir, t.outFile))
      if (out.size) output = `last output ${duration(now - out.mtimeMs)} ago`
    } catch {}
    return ` (turn ${t.number} running for ${duration(now - startedAt.get(`${n.spec.id} ${t.number}`)!)}, ${output})`
  }
  const print = (n: NodeState, depth: number) => {
    const turns = n.turns.length ? ` turns ${n.turns.length}` : ''
    const agent = n.turns.findLast((t) => t.agent)?.agent ?? n.spec.agent
    console.log(`${'  '.repeat(depth)}${n.spec.id} ${n.status}${agent ? ` on ${agent}` : ''}${turns}${running(n)}${lastSummary(n)}`)
    for (const c of children(n.spec.id)) print(c, depth + 1)
  }
  for (const n of children(undefined)) print(n, 1)
  printPending(state, runRef(workspace, id))
  const refused = events.flatMap((e) => (e.type === 'command.refused' ? [e] : [])).slice(-3)
  if (refused.length) console.log('commands not applied (latest last):')
  for (const e of refused) console.log(`  ${e.at.slice(11, 19)} ${oneLine(e.reason)}`)
  if (live === 'stopped') console.log(`continue it with: sous resume ${id}`)
  return 0
}

/** The workspace's runs, newest first. */
function runs(workspace: string): number {
  const { runsDir, ids } = listRuns(workspace)
  if (!ids.length) console.log(`no runs in ${runsDir}`)
  for (const id of ids.toReversed()) {
    const runDir = join(runsDir, id)
    try {
      const events = readEvents(runDir)
      // The log file exists before its first event is written.
      if (events[0]?.type !== 'run.created') {
        console.log(`${id}  starting`)
        continue
      }
      const state = fold(events)
      const live = state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
      console.log(`${id}  ${live.padEnd(9)}  ${events[0].at.slice(0, 19)}Z  ${firstLine(state.goal)}`)
    } catch (err) {
      console.log(`${id}  unreadable  ${oneLine((err as Error).message)}`)
    }
  }
  return 0
}

/** Questions, gate approvals and proposed splits waiting for the person; `r` names the run in the commands (`runRef`). */
function printPending(state: RunState, r: string): void {
  const open = state.questions.filter((q) => !isFinal(state.nodes.get(q.from)))
  const isGate = (q: { from: string }) => state.nodes.get(q.from)?.spec.kind === 'gate'
  const isSplit = (q: { from: string }) => awaitsSplitApproval(state.nodes.get(q.from)!)
  const questions = open.filter((q) => !isGate(q) && !isSplit(q))
  const gates = open.filter(isGate)
  const splits = open.filter(isSplit)
  if (questions.length) console.log(`questions for you (sous answer <node> "<answer>"${r}):`)
  for (const q of questions) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (gates.length) console.log(`approvals for you (sous approve <node>${r}, or sous cancel <node>${r} to reject):`)
  for (const q of gates) console.log(`  ${q.from}: ${oneLine(q.body)}`)
  if (splits.length) console.log(`splits for you to approve (sous approve <lead>${r}, or sous answer <lead> "<changes>"${r}):`)
  for (const q of splits) console.log(`  ${q.from}: ${oneLine(q.body)}`)
}

/** Hand a person's answer, approval or cancel to a running run's supervisor through a command file: run `runId`, or
 * else the workspace's one run with a live supervisor (not the newest, which may be another). */
function sendCommand(workspace: string, cmd: Exclude<PersonCommand, { type: 'send' | 'receive' }>, runId?: string): number {
  const { id, runDir } = runId === undefined ? runningRun(workspace, cmd.type) : findRun(workspace, runId)
  const why = commandRefusal(fold(readEvents(runDir)), cmd)
  if (why) throw new Error(`run ${id}: ${why}`)
  if (lockHolder(runDir) === undefined) throw new Error(`run ${id} is not running`)
  writeCommand(runDir, cmd)
  console.log(`${cmd.type} for ${cmd.node} sent to run ${id}`)
  return 0
}

function runningRun(workspace: string, command: string): { id: string; runDir: string } {
  const { runsDir, ids } = listRuns(workspace)
  const running = ids.filter((id) => lockHolder(join(runsDir, id)) !== undefined)
  if (running.length === 1) return { id: running[0], runDir: join(runsDir, running[0]) }
  if (running.length > 1) throw new Error(`${running.length} runs are running (${running.join(', ')}): name one, as in sous ${command} <node>${command === 'answer' ? ' "text"' : ''} <run-id>`)
  const newest = ids.at(-1)
  if (!newest) throw new Error(`no runs in ${runsDir}`)
  const status = fold(readEvents(join(runsDir, newest))).status
  throw new Error(`no run is running in ${runsDir}; the newest, ${newest}, is ${status === 'running' ? `stopped (continue it with sous resume ${newest})` : status}`)
}

function lastSummary(n: NodeState): string {
  const text = n.reason ?? (n.failedChecks?.length ? completedText(n) : undefined) ?? n.turns.findLast((t) => t.result)?.result?.summary ?? n.summary ??
    (n.checks.length ? lastLine(n.checks[n.checks.length - 1].output) : undefined)
  return text ? `: ${oneLine(text)}` : ''
}

/** A duration as 45s, 3m 05s or 2h 05m. */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function lastLine(output: string): string {
  return output.trimEnd().split('\n').at(-1) ?? ''
}

/** The first line of a multi-line text, marked as cut when more follows. */
function firstLine(text: string): string {
  const [first, ...rest] = text.trim().split('\n')
  return oneLine(rest.length ? `${first}...` : first)
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? line.slice(0, 157) + '...' : line
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ getAdapter, listCodexServers }, { createLeadRunner, leadCredential, loginProblem }] = await Promise.all([import('./adapters/index.ts'), import('./lead/index.ts')])
  process.exitCode = await main(process.argv.slice(2), { getAdapter, createLeadRunner, leadCredential, listCodexServers, loginProblem })
}
