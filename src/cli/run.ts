// `sous run` and `sous resume`: start a run from a graph file or a goal, or continue a stopped one, after checking
// which agents can run; print its events while the supervisor runs it, and where its results are after. Also which
// folder is the workspace: in a git repository, its top level.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_LEAD_MODEL, SPLITTER } from '../contracts/index.ts'
import type { Definitions, GraphFile, NodeSpec } from '../contracts/index.ts'
import { agentSpec, checkAgents, defaultLeadModel, defines, loadDefinitions, loadGraph, startAgents, unusableNodeAgents, whyUnavailable } from '../definitions/index.ts'
import type { Unavailable } from '../definitions/index.ts'
import { fold, lockHolder, openLog, readEvents } from '../run/index.ts'
import { runSupervisor } from '../supervisor/index.ts'
import type { SupervisorOutcome } from '../supervisor/index.ts'
import { dirtyChanges, inWorkTree, repoRoot } from '../workspace/index.ts'
import type { CliDeps } from './deps.ts'
import { printer } from './events.ts'
import { findRun, runRef } from './lookup.ts'
import { printPending, resultOf } from './status.ts'

/** In a git repository the workspace is its top level, wherever sous was started: worktrees cover the whole repository,
 * so workers and checks work from the root, and `.sous/` must be there too, or `sous status` from another folder would
 * not find the run. `from` is the folder it moved from. */
export function repoWorkspace(dir: string): { workspace: string; from?: string } {
  const root = existsSync(dir) ? repoRoot(dir) : undefined
  return root === undefined || realpathSync(root) === realpathSync(dir) ? { workspace: dir } : { workspace: root, from: dir }
}

/** Say that the workspace is not where sous was started. */
export function announceRoot(workspace: string, from?: string): void {
  if (from) console.log(`workspace is the git repository root ${workspace}, not ${from}: runs and .sous/ live there`)
}

/** An argument naming an existing file is a graph file; anything else is a goal for one lead named `lead`, with the
 * agent definitions of `agentsFile`, if given. An argument that looks like a file name (one word, not a URL, that ends in
 * `.json` or has a path separator) but names no file is refused, not taken for a goal. */
export async function run(arg: string, workspace: string, deps: CliDeps, opts: { maxDepth?: number; agentsFile?: string; approveSplits?: boolean }): Promise<number> {
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
export async function resumeRun(workspace: string, deps: CliDeps, runId?: string): Promise<number> {
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
