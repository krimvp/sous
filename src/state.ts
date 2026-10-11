// Run state as a pure fold of the event log.
import type { Event, GraphFile, HarnessName, NodeSpec, TurnResult, Usage } from './types.ts'

export type NodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed'

export interface CheckState {
  command: string
  exitCode: number | null
  output: string
}

export interface TurnState {
  number: number
  mode: 'start' | 'resume'
  harness?: HarnessName
  pid: number
  outFile: string
  errFile: string
  sessionId?: string
  interrupted?: { reason: string; signal: NodeJS.Signals }
  ended: boolean
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  result?: TurnResult
  usage?: Usage
  error?: string
  /** The node's acceptance check run after this turn, if any. */
  check?: CheckState
}

export interface InboxMessage {
  seq: number
  from: string
  body: string
  mode: 'queue' | 'interrupt'
}

export interface NodeState {
  spec: NodeSpec
  status: NodeStatus
  turns: TurnState[]
  /** Runs of a `check` node's command. */
  checks: CheckState[]
  inbox: InboxMessage[]
  summary?: string
  reason?: string
}

export interface RunState {
  goal: string
  workspace: string
  graph?: GraphFile
  status: 'running' | 'completed' | 'failed'
  summary?: string
  reason?: string
  /** Nodes in the order they were added. */
  nodes: Map<string, NodeState>
}

export function fold(events: readonly Event[]): RunState {
  const state: RunState = { goal: '', workspace: '', status: 'running', nodes: new Map() }
  const turn = (node: string, number: number) => state.nodes.get(node)?.turns.find((t) => t.number === number)
  for (const e of events) {
    switch (e.type) {
      case 'run.created':
        Object.assign(state, { goal: e.goal, workspace: e.workspace, graph: e.graph })
        break
      case 'node.added':
        state.nodes.set(e.node.id, { spec: e.node, status: 'pending', turns: [], checks: [], inbox: [] })
        break
      case 'turn.started': {
        const node = state.nodes.get(e.node)
        node?.turns.push({ number: e.turn, mode: e.mode, harness: e.harness, pid: e.pid, outFile: e.outFile, errFile: e.errFile, ended: false })
        break
      }
      case 'turn.session': {
        const t = turn(e.node, e.turn)
        if (t) t.sessionId = e.sessionId
        break
      }
      case 'turn.interrupted': {
        const t = turn(e.node, e.turn)
        if (t) t.interrupted = { reason: e.reason, signal: e.signal }
        break
      }
      case 'turn.ended': {
        const t = turn(e.node, e.turn)
        if (t) Object.assign(t, { ended: true, exitCode: e.exitCode, signal: e.signal, result: e.result, usage: e.usage, error: e.error })
        break
      }
      case 'check.ended': {
        const node = state.nodes.get(e.node)
        const check = { command: e.command, exitCode: e.exitCode, output: e.output }
        if (node?.spec.kind === 'check') node.checks.push(check)
        else if (node?.turns.length) node.turns[node.turns.length - 1].check = check
        break
      }
      case 'node.completed': {
        const node = state.nodes.get(e.node)
        if (node) Object.assign(node, { status: 'completed', summary: e.summary })
        break
      }
      case 'node.failed': {
        const node = state.nodes.get(e.node)
        if (node) Object.assign(node, { status: 'failed', reason: e.reason })
        break
      }
      case 'message':
        state.nodes.get(e.to)?.inbox.push({ seq: e.seq, from: e.from, body: e.body, mode: e.mode })
        break
      case 'run.completed':
        Object.assign(state, { status: 'completed', summary: e.summary })
        break
      case 'run.failed':
        Object.assign(state, { status: 'failed', reason: e.reason })
        break
    }
  }
  for (const node of state.nodes.values()) {
    if (node.status === 'completed' || node.status === 'failed') continue
    if (node.turns.length || node.checks.length) node.status = 'running'
    else if ((node.spec.needs ?? []).every((id) => state.nodes.get(id)?.status === 'completed')) node.status = 'ready'
  }
  return state
}
