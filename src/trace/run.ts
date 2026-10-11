// Loads a run's event log and turn output files, and folds them into per-node views for the exporters.

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Event, GraphFile, HarnessName, NodeSpec, ParsedTurn, Usage } from '../types.ts'

export type ParseTurn = (harness: HarnessName, raw: string) => ParsedTurn
export type EventOf<T extends Event['type']> = Extract<Event, { type: T }>

export interface LoadedRun {
  runId: string
  events: Event[]
  /** Parsed turn output keyed by `turnKey(node, turn)`. */
  turns: Record<string, ParsedTurn>
}

export const MURM_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export function turnKey(node: string, turn: number): string {
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

export function loadRun(runDir: string, parseTurn: ParseTurn): LoadedRun {
  const events = readEvents(resolve(runDir, 'events.jsonl'))
  const graph = events.find((e) => e.type === 'run.created')?.graph
  const specs = new Map<string, NodeSpec>()
  const turns: Record<string, ParsedTurn> = {}
  for (const e of events) {
    if (e.type === 'node.added') specs.set(e.node.id, e.node)
    if (e.type !== 'turn.started') continue
    const harness = e.harness ?? specs.get(e.node)?.harness ?? graph?.harness
    const file = resolve(runDir, e.outFile)
    turns[turnKey(e.node, e.turn)] = harness && existsSync(file)
      ? parseTurn(harness, readFileSync(file, 'utf8'))
      : { items: [], ended: false }
  }
  return { runId: basename(resolve(runDir)), events, turns }
}

// ---- Views shared by the exporters ------------------------------------------------------------

export interface TurnView {
  turn: number
  mode: 'start' | 'resume'
  harness?: HarnessName
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
  by: string
  addedAt: string
  endedAt: string
  status: 'completed' | 'failed' | 'unfinished'
  /** Completion summary or failure reason. */
  outcome?: string
  /** This node's events in log order (node.added excluded). */
  events: Event[]
  turns: Map<number, TurnView>
}

export interface RunView {
  runId: string
  goal: string
  workspace?: string
  graph?: GraphFile
  createdAt: string
  endedAt: string
  end?: EventOf<'run.completed'> | EventOf<'run.failed'>
  nodes: NodeView[]
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
    graph: created?.graph,
    createdAt: created?.at ?? run.events[0]?.at ?? lastAt,
    endedAt: lastAt,
    nodes: [],
  }
  const nodes = new Map<string, NodeView>()
  const inbox = new Map<string, string[]>()
  for (const e of run.events) {
    if (e.type === 'run.completed' || e.type === 'run.failed') {
      view.end = e
      view.endedAt = e.at
      continue
    }
    if (e.type === 'node.added') {
      const node: NodeView = { spec: e.node, by: e.by, addedAt: e.at, endedAt: e.at, status: 'unfinished', events: [], turns: new Map() }
      nodes.set(e.node.id, node)
      view.nodes.push(node)
      continue
    }
    const id = nodeOf(e)
    const node = id === undefined ? undefined : nodes.get(id)
    if (!node || !id) continue
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
          harness: e.harness ?? node.spec.harness ?? view.graph?.harness,
          model: parsed.model ?? node.spec.model ?? view.graph?.model,
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
    }
  }
  return view
}
