// Run state as a pure fold of the event log.
import { DEFAULT_MAX_LEAD_DEPTH, PERSON } from './types.ts'
import type { ChildSpec, Event, GraphFile, HarnessName, NodeSpec, TurnResult, Usage } from './types.ts'

/** `waiting`: a worker that asked its parent and waits for a message, a lead waiting on its escalation, or a gate
 * waiting for the person's approval. `merging`: a finished work node in the merge queue. `idle`: a standing node
 * between requests. */
export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'merging' | 'idle' | 'completed' | 'failed'

export interface CheckState {
  command: string
  exitCode: number | null
  output: string
}

export interface TurnState {
  number: number
  mode: 'start' | 'resume'
  harness?: HarnessName
  agent?: string
  pid: number
  startTime?: string
  /** Continues (or restarts) a turn that a supervisor stop cut short. */
  recovery?: boolean
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
  /** Seq of the event that sent it: a `message`, or the sending `lead.call`. */
  seq: number
  from: string
  body: string
  mode: 'queue' | 'interrupt'
}

/** A work node's place in the merge queue. */
export interface MergeState {
  /** Seq of its `merge.queued`: the queue order. */
  queued: number
  branch: string
  /** Set once the merge went to the integrator. */
  conflict?: { seq: number; reason: string; files: string[]; onto: string }
}

export interface NodeState {
  spec: NodeSpec
  status: NodeStatus
  merge?: MergeState
  turns: TurnState[]
  /** Runs of a `check` node's command. */
  checks: CheckState[]
  /** Messages not yet taken: a turn's start takes them all, a lead delivery `evt-<seq>` takes one. */
  inbox: InboxMessage[]
  summary?: string
  reason?: string
  /** Seq of the event that completed or failed the node. */
  endSeq?: number
  /** Who cancelled the node or an ancestor, when it ended that way. */
  cancelledBy?: string
  /** Leads: notes recorded for the subtree. */
  notes: string[]
  /** Leads: request IDs delivered, in order. */
  delivered: string[]
  /** Leads: answered every delivery (a lead may report an earlier delivery after a later one was delivered). */
  idle: boolean
  /** Leads: seq of the last `lead.turn`. */
  lastTurn?: number
  /** Leads: reminders delivered since the last accepted tool call. */
  reminders: number
  /** Leads: escalated, and no message from the parent since. */
  escalated: boolean
}

export interface RunState {
  goal: string
  /** How deep leads may nest in this run. */
  maxDepth: number
  workspace: string
  graph?: GraphFile
  status: 'running' | 'completed' | 'failed'
  summary?: string
  reason?: string
  /** Nodes in the order they were added. Children always follow their parent. */
  nodes: Map<string, NodeState>
  /** Messages to the person not yet answered with a message back to their sender. */
  questions: { seq: number; from: string; body: string }[]
  /** Recorded results of lead tool calls by callKey(node, callId). */
  calls: Map<string, string>
  /** The run's integration branch, once created. */
  integration?: { branch: string; path: string }
}

export const isFinal = (n: NodeState | undefined) => n?.status === 'completed' || n?.status === 'failed'

export const callKey = (node: string, callId: string) => `${node}\n${callId}`

/** The node a lead's child becomes. A child lead that names no agent gets its parent's agent and model; a work
 * child that names none gets the default worker when it starts. */
export function childNode(c: ChildSpec, lead: NodeSpec): NodeSpec {
  const node: NodeSpec = { id: c.id, kind: c.kind, parent: lead.id }
  for (const key of ['brief', 'command', 'acceptance', 'needs', 'agent', 'model'] as const) if (c[key] !== undefined) Object.assign(node, { [key]: c[key] })
  if (c.kind === 'lead' && c.agent === undefined) {
    if (lead.agent !== undefined) node.agent = lead.agent
    if (c.model === undefined && lead.model !== undefined) node.model = lead.model
  }
  return node
}

/** The message an event carries, if any: a `message`, or an accepted lead `send` or `escalate`. */
export function eventMessage(e: Event, parentOf: (node: string) => string | undefined) {
  if (e.type === 'message') return { from: e.from, to: e.to, body: e.body, mode: e.mode }
  if (e.type !== 'lead.call' || !e.ok) return undefined
  if (e.call.tool === 'send') return { from: e.node, to: e.call.to, body: e.call.body, mode: e.call.mode }
  if (e.call.tool === 'escalate') return { from: e.node, to: parentOf(e.node) ?? PERSON, body: e.call.question, mode: 'queue' as const }
  return undefined
}

/** A node's ancestors, outermost first. */
export function ancestors(state: RunState, id: string): NodeState[] {
  const out: NodeState[] = []
  for (let p = state.nodes.get(id)?.spec.parent; p; p = state.nodes.get(p)?.spec.parent) {
    const node = state.nodes.get(p)
    if (!node) break
    out.unshift(node)
  }
  return out
}

export function childrenOf(state: RunState, id: string | undefined): NodeState[] {
  return [...state.nodes.values()].filter((n) => n.spec.parent === id)
}

export function fold(events: readonly Event[]): RunState {
  const state: RunState = { goal: '', maxDepth: DEFAULT_MAX_LEAD_DEPTH, workspace: '', status: 'running', nodes: new Map(), questions: [], calls: new Map() }
  const turn = (node: string, number: number) => state.nodes.get(node)?.turns.find((t) => t.number === number)
  const add = (spec: NodeSpec) => state.nodes.set(spec.id, {
    spec, status: 'pending', turns: [], checks: [], inbox: [], notes: [], delivered: [], idle: false, reminders: 0, escalated: false,
  })
  const finish = (node: NodeState | undefined, status: 'completed' | 'failed', text: string, seq: number) => {
    if (!node || isFinal(node)) return
    Object.assign(node, { status, endSeq: seq, [status === 'completed' ? 'summary' : 'reason']: text })
  }
  // A node and its whole subtree; children always follow their parent in `nodes`.
  const cancel = (id: string, by: string, seq: number) => {
    const gone = new Set([id])
    for (const n of state.nodes.values()) {
      if (n.spec.id !== id && !(n.spec.parent && gone.has(n.spec.parent))) continue
      gone.add(n.spec.id)
      if (isFinal(n)) continue
      finish(n, 'failed', `cancelled by ${by}`, seq)
      n.cancelledBy = by
    }
  }
  const parentOf = (id: string) => state.nodes.get(id)?.spec.parent
  const answered = new Map<string, Set<string>>()
  for (const e of events) {
    const message = eventMessage(e, parentOf)
    if (message) {
      if (message.to === PERSON) state.questions.push({ seq: e.seq, from: message.from, body: message.body })
      if (message.from === PERSON) state.questions = state.questions.filter((q) => q.from !== message.to)
      const to = state.nodes.get(message.to)
      if (to) {
        to.inbox.push({ seq: e.seq, from: message.from, body: message.body, mode: message.mode })
        if (message.from === (to.spec.parent ?? PERSON)) to.escalated = false
      }
    }
    switch (e.type) {
      case 'run.created':
        Object.assign(state, { goal: e.goal, workspace: e.workspace, graph: e.graph, maxDepth: e.maxDepth ?? DEFAULT_MAX_LEAD_DEPTH })
        break
      case 'node.added':
        add(e.node)
        break
      case 'turn.started': {
        const node = state.nodes.get(e.node)
        node?.turns.push({
          number: e.turn, mode: e.mode, harness: e.harness, agent: e.agent, pid: e.pid, startTime: e.startTime, recovery: e.recovery,
          outFile: e.outFile, errFile: e.errFile, ended: false,
        })
        if (node) node.inbox = []
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
      case 'node.completed':
        finish(state.nodes.get(e.node), 'completed', e.summary, e.seq)
        break
      case 'node.failed':
        finish(state.nodes.get(e.node), 'failed', e.reason, e.seq)
        break
      case 'node.cancelled':
        cancel(e.node, e.by, e.seq)
        break
      case 'lead.delivered': {
        const node = state.nodes.get(e.node)
        if (!node) break
        if (node.lastTurn !== undefined && e.requestId === `evt-${node.lastTurn}`) node.reminders++
        node.delivered.push(e.requestId)
        node.inbox = node.inbox.filter((m) => `evt-${m.seq}` !== e.requestId)
        node.idle = false
        break
      }
      case 'lead.turn': {
        const node = state.nodes.get(e.node)
        if (!node) break
        const done = answered.get(e.node) ?? new Set<string>()
        answered.set(e.node, done.add(e.requestId))
        Object.assign(node, { idle: node.delivered.every((r) => done.has(r)), lastTurn: e.seq })
        break
      }
      case 'lead.call': {
        state.calls.set(callKey(e.node, e.callId), e.result)
        const lead = state.nodes.get(e.node)
        if (!e.ok || !lead) break
        lead.reminders = 0
        const call = e.call
        if (call.tool === 'spawn') for (const c of call.children) add(childNode(c, lead.spec))
        else if (call.tool === 'note') lead.notes.push(call.text)
        else if (call.tool === 'cancel') cancel(call.node, e.node, e.seq)
        else if (call.tool === 'complete') finish(lead, 'completed', call.summary, e.seq)
        else if (call.tool === 'fail') finish(lead, 'failed', call.reason, e.seq)
        else if (call.tool === 'escalate') lead.escalated = true
        break
      }
      case 'integration.created':
        state.integration = { branch: e.branch, path: e.path }
        break
      case 'merge.queued': {
        const node = state.nodes.get(e.node)
        if (node) node.merge = { queued: e.seq, branch: e.branch }
        break
      }
      case 'merge.withdrawn': {
        const node = state.nodes.get(e.node)
        if (node) node.merge = undefined
        break
      }
      case 'merge.conflict': {
        const merge = state.nodes.get(e.node)?.merge
        if (merge) merge.conflict = { seq: e.seq, reason: e.reason, files: e.files, onto: e.onto }
        break
      }
      // A work node completes, or fails, with its merge.
      case 'merge.done': {
        const node = state.nodes.get(e.node)
        finish(node, 'completed', node?.turns.findLast((t) => t.result)?.result?.summary ?? 'merged', e.seq)
        break
      }
      case 'merge.failed':
        finish(state.nodes.get(e.node), 'failed', `merge failed: ${e.reason}`, e.seq)
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
    if (isFinal(node)) continue
    const last = node.turns.at(-1)
    if (node.spec.standing) node.status = node.inbox.length || (last && !last.ended) ? 'running' : 'idle'
    else if (node.merge) node.status = 'merging'
    else if (node.spec.kind === 'lead' && node.delivered.length) node.status = node.escalated ? 'waiting' : 'running'
    // A gate's approval request is its question to the person; the person never messages a gate.
    else if (node.spec.kind === 'gate' && state.questions.some((q) => q.from === node.spec.id)) node.status = 'waiting'
    else if (last?.ended && last.result && last.result.status !== 'done') node.status = 'waiting'
    else if (node.turns.length || node.checks.length) node.status = 'running'
    else if ((node.spec.needs ?? []).every((id) => state.nodes.get(id)?.status === 'completed')) node.status = 'ready'
  }
  return state
}
