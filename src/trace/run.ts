// Loads a run's event log and turn output files, and folds them into per-node views for the exporters.

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Definitions, Event, HarnessName, NodeSpec, ParsedTurn, Usage } from '../contracts/index.ts'
import { agentSpec } from '../definitions/index.ts'
import { childNode, fold } from '../run/index.ts'

export type ParseTurn = (harness: HarnessName, raw: string) => ParsedTurn
export type EventOf<T extends Event['type']> = Extract<Event, { type: T }>

export interface LoadedRun {
  runId: string
  events: Event[]
  /** Parsed turn output keyed by `turnKey(node, turn)`. */
  turns: Record<string, ParsedTurn>
}

function turnKey(node: string, turn: number): string {
  return `${node}#${turn}`
}

/** Reads events.jsonl. A final line cut short by a crash mid-append is ignored; any other bad line throws. */
export function readEvents(file: string): Event[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const events: Event[] = []
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try {
      events.push(JSON.parse(line))
    } catch (err) {
      if (i === lines.length - 1) return
      throw new Error(`${file}:${i + 1}: ${(err as Error).message}`)
    }
  })
  return events
}

/** Nodes a lead's `spawn` call added: children of the calling lead, as the run state has them. */
function spawned(e: Event, specOf: (id: string) => NodeSpec | undefined): NodeSpec[] {
  if (e.type !== 'lead.call' || !e.ok || e.call.tool !== 'spawn') return []
  const lead = specOf(e.node) ?? { id: e.node, kind: 'lead' }
  return e.call.children.map((c) => childNode(c, lead))
}

/** The harness a turn ran on: recorded on the turn, else the runtime of its agent. */
function harnessOf(e: EventOf<'turn.started'>, spec: NodeSpec | undefined, defs: Definitions): HarnessName | undefined {
  if (e.harness) return e.harness
  const name = e.agent ?? spec?.agent
  const runs = name === undefined ? undefined : agentSpec(defs, name)?.runs
  return runs === 'lead' ? undefined : runs
}

/** `parses` picks the nodes whose turn files are read and parsed; the others get empty turns (their usage still comes
 * from the log). The UI parses only the node a person opens. */
export function loadRun(runDir: string, parseTurn: ParseTurn, parses: (node: string) => boolean = () => true): LoadedRun {
  const events = readEvents(resolve(runDir, 'events.jsonl'))
  const defs = fold(events).agents
  const specs = new Map<string, NodeSpec>()
  const turns: Record<string, ParsedTurn> = {}
  for (const e of events) {
    if (e.type === 'node.added') specs.set(e.node.id, e.node)
    for (const spec of spawned(e, (id) => specs.get(id))) specs.set(spec.id, spec)
    if (e.type !== 'turn.started') continue
    const harness = harnessOf(e, specs.get(e.node), defs)
    const file = resolve(runDir, e.outFile)
    turns[turnKey(e.node, e.turn)] = harness && parses(e.node) && existsSync(file)
      ? parseTurn(harness, readFileSync(file, 'utf8'))
      : { items: [], ended: false }
  }
  return { runId: basename(resolve(runDir)), events, turns }
}

// ---- Views shared by the exporters ------------------------------------------------------------

export interface TurnView {
  turn: number
  mode: 'start' | 'resume'
  /** The agent that ran the turn. */
  agent?: string
  model?: string
  /** The brief on start, the delivered messages on resume, or a placeholder when neither was recorded. */
  prompt: string
  sessionId?: string
  startedAt: string
  endedAt: string
  interrupted?: EventOf<'turn.interrupted'>
  ended?: EventOf<'turn.ended'>
  parsed: ParsedTurn
  usage?: Usage
}

export interface NodeView {
  spec: NodeSpec
  /** Who added the node: `graph`, the person, or the lead that spawned it. */
  by: string
  /** The `lead.call` that spawned this node, if a lead did. */
  spawnCall?: string
  addedAt: string
  endedAt: string
  status: 'completed' | 'failed' | 'unfinished'
  /** Completion summary or failure reason. */
  outcome?: string
  /** Set when this node or an ancestor was cancelled while it was unfinished. */
  cancelledBy?: string
  /** This node's events in log order: its own node.added excluded; `node.added` of a child it did not spawn
   * and a `node.cancelled` for an ancestor included. */
  events: Event[]
  turns: Map<number, TurnView>
  children: NodeView[]
}

export interface RunView {
  runId: string
  goal: string
  workspace?: string
  /** The run's agent definitions, with the agents leads defined. */
  agents: Definitions
  createdAt: string
  endedAt: string
  end?: EventOf<'run.completed'> | EventOf<'run.failed'>
  /** Every node in the order it was added. */
  nodes: NodeView[]
  /** Nodes without a parent node: children of the implicit root. */
  top: NodeView[]
}

/** Model usage of one node: its worker turns and its lead turns. */
export function usagesOf(node: NodeView): (Usage | undefined)[] {
  return [
    ...[...node.turns.values()].map((t) => t.usage),
    ...node.events.map((e) => (e.type === 'lead.turn' ? e.usage : undefined)),
  ]
}

function nodeOf(e: Event): string | undefined {
  if (e.type === 'message') return e.to
  return 'node' in e && typeof e.node === 'string' ? e.node : undefined
}

export function viewRun(run: LoadedRun): RunView {
  const created = run.events.find((e) => e.type === 'run.created')
  const lastAt = run.events.at(-1)?.at ?? new Date(0).toISOString()
  const view: RunView = {
    runId: run.runId,
    goal: created?.goal ?? '',
    workspace: created?.workspace,
    agents: fold(run.events).agents,
    createdAt: created?.at ?? run.events[0]?.at ?? lastAt,
    endedAt: lastAt,
    nodes: [],
    top: [],
  }
  const nodes = new Map<string, NodeView>()
  const inbox = new Map<string, string[]>()
  const add = (spec: NodeSpec, by: string, e: Event, spawnCall?: string) => {
    if (nodes.has(spec.id)) return
    const node: NodeView = { spec, by, spawnCall, addedAt: e.at, endedAt: e.at, status: 'unfinished', events: [], turns: new Map(), children: [] }
    nodes.set(spec.id, node)
    view.nodes.push(node)
    const parent = spec.parent === undefined ? undefined : nodes.get(spec.parent)
    if (!parent) return void view.top.push(node)
    parent.children.push(node)
    if (spawnCall === undefined) parent.events.push(e)
  }
  // Cancelling fails every unfinished node of the subtree; each gets the event, so its trace shows why it stopped.
  const cancel = (e: EventOf<'node.cancelled'>) => {
    const visit = (node: NodeView) => {
      if (node.status === 'unfinished') {
        Object.assign(node, { status: 'failed', outcome: `cancelled by ${e.by}`, cancelledBy: e.by, endedAt: e.at })
        node.events.push(e)
      }
      node.children.forEach(visit)
    }
    const node = nodes.get(e.node)
    if (node) visit(node)
  }
  for (const e of run.events) {
    if (e.type === 'run.completed' || e.type === 'run.failed') {
      view.end = e
      view.endedAt = e.at
      continue
    }
    if (e.type === 'node.added') {
      add(e.node, e.by, e)
      continue
    }
    if (e.type === 'node.cancelled') {
      cancel(e)
      continue
    }
    const id = nodeOf(e)
    const node = id === undefined ? undefined : nodes.get(id)
    if (!node || !id) continue
    // A cancelled node's failure repeats the cancellation, which its events already show.
    if (e.type === 'node.failed' && node.cancelledBy) continue
    node.events.push(e)
    node.endedAt = e.at
    const turn = 'turn' in e ? node.turns.get(e.turn) : undefined
    switch (e.type) {
      case 'message':
        inbox.set(id, [...(inbox.get(id) ?? []), e.body])
        break
      case 'turn.started': {
        const parts = [...(e.mode === 'start' ? [node.spec.brief ?? ''] : []), ...(inbox.get(id) ?? [])].filter(Boolean)
        inbox.delete(id)
        const parsed = run.turns[turnKey(id, e.turn)] ?? { items: [], ended: false }
        node.turns.set(e.turn, {
          turn: e.turn,
          mode: e.mode,
          agent: e.agent ?? node.spec.agent ?? e.harness,
          model: parsed.model ?? node.spec.model ?? (e.agent ? agentSpec(view.agents, e.agent)?.model : undefined),
          prompt: e.prompt ?? (parts.join('\n\n') || `(${e.mode} prompt for turn ${e.turn} not recorded)`),
          sessionId: parsed.sessionId,
          startedAt: e.at,
          endedAt: e.at,
          parsed,
          usage: parsed.usage,
        })
        break
      }
      case 'turn.session':
        if (turn) turn.sessionId = e.sessionId
        break
      case 'turn.interrupted':
        if (turn) Object.assign(turn, { interrupted: e, endedAt: e.at })
        break
      case 'turn.ended':
        if (turn) Object.assign(turn, { ended: e, endedAt: e.at, usage: turn.usage ?? e.usage })
        break
      case 'node.completed':
        Object.assign(node, { status: 'completed', outcome: e.summary })
        break
      case 'node.failed':
        Object.assign(node, { status: 'failed', outcome: e.reason })
        break
      // A work node completes, or fails, with its merge.
      case 'merge.done':
        Object.assign(node, { status: 'completed', outcome: [...node.turns.values()].findLast((t) => t.ended?.result)?.ended?.result?.summary ?? 'merged' })
        break
      case 'merge.failed':
        Object.assign(node, { status: 'failed', outcome: `merge failed: ${e.reason}` })
        break
      case 'lead.call': {
        // A call's effects follow from the call itself; a refused call changed nothing.
        if (!e.ok) break
        const { call } = e
        for (const spec of spawned(e, (id) => nodes.get(id)?.spec)) add(spec, id, e, e.callId)
        if (call.tool === 'send') inbox.set(call.to, [...(inbox.get(call.to) ?? []), call.body])
        if (call.tool === 'cancel') cancel({ type: 'node.cancelled', node: call.node, by: id, seq: e.seq, at: e.at })
        if (call.tool === 'complete') Object.assign(node, { status: 'completed', outcome: call.summary })
        if (call.tool === 'fail') Object.assign(node, { status: 'failed', outcome: call.reason })
        break
      }
    }
  }
  return view
}
