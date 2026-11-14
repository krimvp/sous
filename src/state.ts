// Run state as a pure fold of the event log.
import { defineAgent, registry } from './agents.ts'
import { DEFAULT_MAX_LEAD_DEPTH, PERSON } from './types.ts'
import type { ChildSpec, Definitions, Event, GraphFile, HarnessName, NodeSpec, Role, RunMode, TurnResult, Usage } from './types.ts'

/** `waiting`: a worker that asked its parent and waits for a message, a lead waiting on its escalation or on the
 * person's approval of its split, or a gate waiting for the person's approval. `merging`: a finished work node in the merge queue. `idle`: a standing node
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
  /** A worker's `send`, which expects no answer. */
  sent?: true
  /** Leads: this is a copy of a child's `send` to its sibling `copyOf`. */
  copyOf?: string
}

/** A work node's place in the merge queue. */
export interface MergeState {
  /** Seq of its `merge.queued`: the queue order. */
  queued: number
  /** Git mode only. */
  branch?: string
  /** Set once the merge went to the integrator. */
  conflict?: { seq: number; reason: string; files: string[]; onto: string }
}

/** A lead's split, proposed by the run's splitter before the lead's brief. */
export interface SplitState {
  /** Seq of its `split.requested`: the order in which its splitter takes requests. */
  seq: number
  /** The splitter agent asked. */
  agent: string
  status: 'requested' | 'proposed' | 'failed'
  /** Seq of the `split.proposed` or `split.failed`. */
  endSeq?: number
  parts?: ChildSpec[]
  summary?: string
  reason?: string
}

export interface NodeState {
  spec: NodeSpec
  status: NodeStatus
  merge?: MergeState
  turns: TurnState[]
  /** Runs of a `check` node's command. */
  checks: CheckState[]
  /** Messages not yet taken: a turn's start takes them all, a lead delivery takes those it names (`evt-<seq>`). */
  inbox: InboxMessage[]
  summary?: string
  reason?: string
  /** Work nodes: the files their merge (or collection) brought into the results, and (folder mode) the files kept under
   * a new name, by original path. */
  files?: string[]
  renamed?: Record<string, string>
  /** Seq of the event that completed or failed the node. */
  endSeq?: number
  /** Who cancelled the node or an ancestor, when it ended that way. */
  cancelledBy?: string
  /** Leads: check children that had failed when the lead completed (see `failedChecks`). */
  failedChecks?: string[]
  /** Leads: notes recorded for the subtree. */
  notes: string[]
  /** Leads: request IDs delivered, in order. */
  delivered: string[]
  /** Leads: request IDs of the items delivered under another's request ID (`lead.delivered.carries`). */
  carried: string[]
  /** Leads: answered every delivery (a lead may report an earlier delivery after a later one was delivered). */
  idle: boolean
  /** Leads: seq of the last `lead.turn`. */
  lastTurn?: number
  /** Leads: the last `lead.turn` was `unanswered` (the runner could not get the delivery answered: a model error), with
   * its reason and whether the one retry for it has been delivered. */
  unanswered?: { reason: string; retried: boolean }
  /** Leads: reminders delivered since the last accepted tool call. */
  reminders: number
  /** Leads: escalated, and no message from the parent since. */
  escalated: boolean
  /** Workers: the messages they read during their current turn (`receive`), dropped from the inbox when the turn ends
   * with a result. */
  read?: { turn: number; upTo: number }
  /** Leads, in a run with a splitter: the split proposed for it. */
  split?: SplitState
}

export interface RunState {
  goal: string
  /** How deep leads may nest in this run. */
  maxDepth: number
  /** The person approves each proposed split before its lead receives it. */
  approveSplits: boolean
  workspace: string
  mode: RunMode
  graph?: GraphFile
  /** The model of lead agents that name none, from `run.created`. */
  leadModel?: string
  /** The run's agent definitions (its graph's, or its agents file's), with every agent leads defined so far. */
  agents: Definitions
  /** The agent definitions the person wrote (the graph's, or the agents file's), without those leads defined. */
  definitions: Definitions
  status: 'running' | 'completed' | 'failed'
  summary?: string
  reason?: string
  /** Nodes in the order they were added. Children always follow their parent. */
  nodes: Map<string, NodeState>
  /** Messages to the person not yet answered with a message back to their sender. */
  questions: { seq: number; from: string; body: string }[]
  /** Recorded results of lead tool calls by callKey(node, callId). */
  calls: Map<string, string>
  /** Messages each worker sent with `send`, by node. */
  sent: Map<string, number>
  /** The run's integration branch, once created. */
  integration?: { branch: string; path: string }
}

export const isFinal = (n: NodeState | undefined) => n?.status === 'completed' || n?.status === 'failed'

export const callKey = (node: string, callId: string) => `${node}\n${callId}`

/** A lead whose proposed split waits for the person: `sous approve` or `sous answer` releases it. */
export const awaitsSplitApproval = (lead: NodeState) =>
  lead.spec.kind === 'lead' && !lead.delivered.length && lead.split?.status === 'proposed' && lead.status === 'waiting'

/** The node a lead's child becomes; a child that defines an agent names it. A child lead that names no agent gets its
 * parent's agent and model; a work child that names none gets the default worker when it starts. */
export function childNode(c: ChildSpec, lead: NodeSpec): NodeSpec {
  const node: NodeSpec = { id: c.id, kind: c.kind, parent: lead.id }
  for (const key of ['brief', 'command', 'acceptance', 'needs', 'model', 'roles'] as const) if (c[key] !== undefined) Object.assign(node, { [key]: c[key] })
  if (c.agent !== undefined) node.agent = typeof c.agent === 'string' ? c.agent : c.agent.name
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

/** The agent in `role` for lead `id`: the nearest `roles` entry from the lead up through its ancestors, else the run's
 * agent named after the role, if the run defines one. */
export function roleAgent(state: RunState, id: string, role: Role): string | undefined {
  for (const n of [state.nodes.get(id)!, ...ancestors(state, id).reverse()]) {
    const agent = n.spec.roles?.[role]
    if (agent !== undefined) return agent
  }
  return Object.hasOwn(state.agents.agents ?? {}, role) ? role : undefined
}

export function childrenOf(state: RunState, id: string | undefined): NodeState[] {
  return [...state.nodes.values()].filter((n) => n.spec.parent === id)
}

/** The lead's check children that failed (not cancelled) with no check child added after them that passed: a lead may
 * complete over them, and its completion says so. */
export function failedChecks(state: RunState, lead: string): string[] {
  const checks = childrenOf(state, lead).filter((c) => c.spec.kind === 'check')
  return checks.filter((c, i) => c.status === 'failed' && !c.cancelledBy && !checks.slice(i + 1).some((l) => l.status === 'completed'))
    .map((c) => c.spec.id)
}

/** A node's completion summary, naming the failed checks a lead completed over. */
export function completedText(n: NodeState): string {
  return n.failedChecks?.length ? `completed with failed checks: ${n.failedChecks.join(', ')}. ${n.summary}` : n.summary ?? ''
}

export function fold(events: readonly Event[]): RunState {
  const state: RunState = {
    goal: '', maxDepth: DEFAULT_MAX_LEAD_DEPTH, approveSplits: false, workspace: '', mode: 'git', agents: {}, definitions: {}, status: 'running', nodes: new Map(), questions: [], calls: new Map(), sent: new Map(),
  }
  const turn = (node: string, number: number) => state.nodes.get(node)?.turns.find((t) => t.number === number)
  const add = (spec: NodeSpec) => state.nodes.set(spec.id, {
    spec, status: 'pending', turns: [], checks: [], inbox: [], notes: [], delivered: [], carried: [], idle: false, reminders: 0, escalated: false,
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
      const sent = e.type === 'message' && e.sent ? { sent: true as const } : {}
      if (to) {
        to.inbox.push({ seq: e.seq, from: message.from, body: message.body, mode: message.mode, ...sent })
        if (message.from === (to.spec.parent ?? PERSON)) to.escalated = false
      }
      if (e.type === 'message' && e.sent) {
        state.sent.set(e.from, (state.sent.get(e.from) ?? 0) + 1)
        // The lead sees what its children tell each other.
        const lead = state.nodes.get(parentOf(e.from) ?? '')
        if (lead && lead.spec.id !== e.to) lead.inbox.push({ seq: e.seq, from: e.from, body: e.body, mode: 'queue', sent: true, copyOf: e.to })
      }
    }
    switch (e.type) {
      case 'run.created': {
        const { agent, agents, models } = e.graph ?? e.definitions ?? {}
        Object.assign(state, { goal: e.goal, workspace: e.workspace, mode: e.mode ?? 'git', graph: e.graph, leadModel: e.leadModel, maxDepth: e.maxDepth ?? DEFAULT_MAX_LEAD_DEPTH, approveSplits: e.approveSplits === true })
        state.agents = { agent, agents: registry(agents), models }
        state.definitions = { agent, agents: registry(agents), models }
        break
      }
      case 'node.added':
        add(e.node)
        break
      case 'turn.started': {
        const node = state.nodes.get(e.node)
        node?.turns.push({
          number: e.turn, mode: e.mode, harness: e.harness, agent: e.agent, pid: e.pid, startTime: e.startTime, recovery: e.recovery,
          outFile: e.outFile, errFile: e.errFile, ended: false,
        })
        if (node) Object.assign(node, { inbox: [], read: undefined })
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
        const node = state.nodes.get(e.node)
        if (node?.read?.turn === e.turn) {
          if (e.result) node.inbox = node.inbox.filter((m) => m.seq > node.read!.upTo)
          node.read = undefined
        }
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
      case 'inbox.read': {
        // Only the node's current turn reads; what it read counts once that turn ends with a result.
        const node = state.nodes.get(e.node)
        const t = turn(e.node, e.turn)
        if (!node || !t || node.turns.at(-1) !== t) break
        if (!t.ended) node.read = { turn: e.turn, upTo: Math.max(e.upTo, node.read?.upTo ?? 0) }
        else if (t.result) node.inbox = node.inbox.filter((m) => m.seq > e.upTo)
        break
      }
      case 'lead.delivered': {
        const node = state.nodes.get(e.node)
        if (!node) break
        // A delivery named after the last turn is the retry of an unanswered one, else an idle reminder.
        if (node.lastTurn !== undefined && e.requestId === `evt-${node.lastTurn}`) {
          if (node.unanswered) node.unanswered.retried = true
          else node.reminders++
        }
        node.delivered.push(e.requestId)
        node.carried.push(...(e.carries ?? []))
        const taken = new Set([e.requestId, ...(e.carries ?? [])])
        node.inbox = node.inbox.filter((m) => !taken.has(`evt-${m.seq}`))
        node.idle = false
        break
      }
      case 'lead.turn': {
        const node = state.nodes.get(e.node)
        if (!node) break
        const done = answered.get(e.node) ?? new Set<string>()
        answered.set(e.node, done.add(e.requestId))
        Object.assign(node, {
          idle: node.delivered.every((r) => done.has(r)), lastTurn: e.seq,
          unanswered: e.status === 'unanswered' ? { reason: e.text, retried: node.unanswered?.retried ?? false } : undefined,
        })
        break
      }
      case 'lead.call': {
        state.calls.set(callKey(e.node, e.callId), e.result)
        const lead = state.nodes.get(e.node)
        if (!e.ok || !lead) break
        lead.reminders = 0
        const call = e.call
        if (call.tool === 'spawn') {
          for (const c of call.children) {
            if (typeof c.agent === 'object') state.agents.agents![c.agent.name] = defineAgent(state.agents, c.agent)
            add(childNode(c, lead.spec))
          }
        }
        else if (call.tool === 'note') lead.notes.push(call.text)
        else if (call.tool === 'cancel') cancel(call.node, e.node, e.seq)
        else if (call.tool === 'complete') {
          const failed = failedChecks(state, e.node)
          if (failed.length && !isFinal(lead)) lead.failedChecks = failed
          finish(lead, 'completed', call.summary, e.seq)
        }
        else if (call.tool === 'fail') finish(lead, 'failed', call.reason, e.seq)
        else if (call.tool === 'escalate') lead.escalated = true
        break
      }
      case 'split.requested': {
        const node = state.nodes.get(e.node)
        if (node) node.split = { seq: e.seq, agent: e.agent, status: 'requested' }
        break
      }
      case 'split.proposed':
      case 'split.failed': {
        const split = state.nodes.get(e.node)?.split
        if (split) Object.assign(split, e.type === 'split.proposed'
          ? { status: 'proposed', endSeq: e.seq, parts: e.parts, summary: e.summary }
          : { status: 'failed', endSeq: e.seq, reason: e.reason })
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
        if (node && !isFinal(node)) Object.assign(node, { files: e.files, renamed: e.renamed })
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
    // Before its brief, a lead's only message to the person is its split for approval.
    else if (node.spec.kind === 'lead' && node.split) node.status = state.questions.some((q) => q.from === node.spec.id) ? 'waiting' : 'running'
    // A gate's approval request is its question to the person; the person never messages a gate.
    else if (node.spec.kind === 'gate' && state.questions.some((q) => q.from === node.spec.id)) node.status = 'waiting'
    else if (last?.ended && last.result && last.result.status !== 'done') node.status = 'waiting'
    else if (node.turns.length || node.checks.length) node.status = 'running'
    else if ((node.spec.needs ?? []).every((id) => state.nodes.get(id)?.status === 'completed')) node.status = 'ready'
  }
  return state
}
