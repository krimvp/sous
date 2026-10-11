// sous ui: a local page that shows the workspace's runs, live or finished, read from their logs and turn files.
// It only reads: the supervisor stays the only writer of a run.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { listRuns, lockHolder, readEvents } from './log.ts'
import { awaitsSplitApproval, fold, isFinal } from './state.ts'
import type { RunState } from './state.ts'
import { loadRun, usagesOf, viewRun } from './trace/run.ts'
import type { NodeView, ParseTurn, RunView } from './trace/run.ts'
import type { Event, TraceItem, Usage } from './types.ts'

const PAGE = new URL('./ui.html', import.meta.url)

/** How often the stream looks for log changes, and the longest text of one trace item the page gets. */
const POLL_MS = 500
const MAX_TEXT = 20_000

export interface UiServer {
  url: string
  close(): Promise<void>
}

/** Serve the page on 127.0.0.1. Every request needs the random token in the URL, so other sites open in the browser
 * cannot read runs; the Host header must name this machine, so a rebound DNS name cannot either. */
export async function startUi(workspace: string, parseTurn: ParseTurn, port = 0): Promise<UiServer> {
  const token = randomBytes(16).toString('hex')
  const streams = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, 'text/plain', 'sous ui answers only on 127.0.0.1\n')
    const given = Buffer.from(url.searchParams.get('token') ?? '')
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) return send(res, 403, 'text/plain', 'open the address sous ui printed: it carries the token\n')
    try {
      route(url, req, res)
    } catch (err) {
      send(res, 404, 'application/json', JSON.stringify({ error: (err as Error).message }))
    }
  })
  const route = (url: URL, req: IncomingMessage, res: ServerResponse) => {
    const id = url.searchParams.get('run') ?? ''
    switch (url.pathname) {
      case '/': return send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE))
      case '/api/runs': return json(res, { workspace, runs: listRuns(workspace).ids.reverse().map((r) => runSummary(runDir(r))) })
      case '/api/run': return json(res, runDetail(runDir(id)))
      case '/api/node': return json(res, nodeDetail(runDir(id), url.searchParams.get('node') ?? '', parseTurn))
      case '/api/stream': return stream(req, res)
    }
    throw new Error(`no such page ${url.pathname}`)
  }
  const runDir = (id: string) => {
    if (!listRuns(workspace).ids.includes(id)) throw new Error(`no run ${id}`)
    return join(workspace, '.sous', 'runs', id)
  }
  // One stream for the workspace: it sends each run's log size and liveness whenever one changes.
  const stream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    streams.add(res)
    let last = ''
    const tick = () => {
      const sig = JSON.stringify(Object.fromEntries(listRuns(workspace).ids.map((r) => {
        const dir = join(workspace, '.sous', 'runs', r)
        // A lock left by a killed supervisor does not count: the run shows as stopped.
        return [r, [statSync(join(dir, 'events.jsonl')).size, lockHolder(dir) !== undefined]]
      })))
      if (sig !== last) res.write(`data: ${sig}\n\n`)
      last = sig
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    req.on('close', () => {
      clearInterval(timer)
      streams.delete(res)
    })
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const { port: bound } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${bound}/?token=${token}`,
    close: () => new Promise((resolve) => {
      for (const res of streams) res.end()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const json = (res: ServerResponse, body: unknown) => send(res, 200, 'application/json', JSON.stringify(body))

// ---- Views -------------------------------------------------------------------------------------

type Live = 'running' | 'stopped' | 'completed' | 'failed'

/** A run's status as `sous status` reports it: a running run without a live supervisor is stopped. */
function liveStatus(runDir: string, state: RunState): Live {
  return state.status === 'running' && lockHolder(runDir) === undefined ? 'stopped' : state.status
}

interface Tokens { input: number; output: number; cached: number; costUsd?: number }

function addUsage(total: Tokens, u: Usage | undefined): Tokens {
  if (!u) return total
  total.input += u.inputTokens
  total.output += u.outputTokens
  total.cached += u.cachedTokens
  if (u.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + u.costUsd
  return total
}

const tokensOf = (usages: (Usage | undefined)[]) => usages.reduce(addUsage, { input: 0, output: 0, cached: 0 })

/** Levels of the node tree, top-level nodes being level 1. */
function depthOf(view: RunView): number {
  const depth = (n: NodeView): number => 1 + Math.max(0, ...n.children.map(depth))
  return Math.max(0, ...view.top.map(depth))
}

/** One line per run for the list: from the log alone. Folded views are kept while the log keeps its size. */
const summaries = new Map<string, { size: number; live: boolean; summary: ReturnType<typeof summarize> }>()

function runSummary(runDir: string) {
  const size = statSync(join(runDir, 'events.jsonl')).size
  const live = lockHolder(runDir) !== undefined
  const cached = summaries.get(runDir)
  if (cached?.size === size && cached.live === live) return cached.summary
  const summary = summarize(runDir)
  summaries.set(runDir, { size, live, summary })
  return summary
}

function summarize(runDir: string) {
  const events = readEvents(runDir)
  const state = fold(events)
  const view = viewRun(loadRun(runDir, () => ({ items: [], ended: false }), () => false))
  return {
    id: view.runId,
    goal: state.goal,
    status: liveStatus(runDir, state),
    createdAt: view.createdAt,
    endedAt: view.endedAt,
    nodes: view.nodes.length,
    depth: depthOf(view),
    tokens: tokensOf(view.nodes.flatMap(usagesOf)),
    waiting: openQuestions(state).length,
  }
}

/** Messages to the person still waiting for an answer: questions, gates to approve, splits to approve. */
function openQuestions(state: RunState) {
  return state.questions.filter((q) => !isFinal(state.nodes.get(q.from))).map((q) => {
    const node = state.nodes.get(q.from)
    const kind = node?.spec.kind === 'gate' ? 'gate' : node && awaitsSplitApproval(node) ? 'split' : 'question'
    return { from: q.from, body: q.body, kind }
  })
}

/** A stretch of time a node was busy, for the timeline. `end` is absent while it goes on. */
interface Span { kind: 'turn' | 'lead' | 'merge'; start: string; end?: string; label: string; outcome?: string }

/** `end`: when the node finished, if it did; nothing it started is still going then. */
function spansOf(node: NodeView, end: string | undefined): Span[] {
  const spans: Span[] = []
  for (const t of node.turns.values()) {
    const outcome = t.ended?.result?.status ?? (t.interrupted ? 'interrupted' : t.ended ? 'no result' : undefined)
    spans.push({ kind: 'turn', start: t.startedAt, end: t.ended?.at ?? t.interrupted?.at ?? end, label: `turn ${t.turn}${t.agent ? ` on ${t.agent}` : ''}`, outcome })
  }
  // A lead is busy from a delivery until it has answered every queued one. An interrupt steers the answer under way,
  // so it joins the stretch without being answered on its own.
  let busy: { start: string; ids: string[] } | undefined
  const unanswered = new Set<string>()
  let queued: string | undefined
  for (const e of node.events) {
    if (e.type === 'lead.delivered') {
      busy ??= { start: e.at, ids: [] }
      busy.ids.push(e.requestId)
      if (e.mode === 'queue') unanswered.add(e.requestId)
    }
    if (e.type === 'lead.turn') {
      unanswered.delete(e.requestId)
      if (busy && !unanswered.size) spans.push({ kind: 'lead', start: busy.start, end: e.at, label: busy.ids.join(', '), outcome: e.status })
      if (!unanswered.size) busy = undefined
    }
    if (e.type === 'merge.queued') queued = e.at
    if ((e.type === 'merge.done' || e.type === 'merge.failed' || e.type === 'merge.withdrawn') && queued) {
      spans.push({ kind: 'merge', start: queued, end: e.at, label: 'merge', outcome: e.type.slice(6) })
      queued = undefined
    }
  }
  if (busy) spans.push({ kind: 'lead', start: busy.start, end, label: busy.ids.join(', ') })
  if (queued) spans.push({ kind: 'merge', start: queued, end, label: 'merge' })
  return spans.sort((a, b) => a.start.localeCompare(b.start))
}

function runDetail(runDir: string) {
  const events = readEvents(runDir)
  const state = fold(events)
  const view = viewRun(loadRun(runDir, () => ({ items: [], ended: false }), () => false))
  const status = liveStatus(runDir, state)
  return {
    ...runSummary(runDir),
    status,
    summary: state.summary,
    reason: state.reason,
    branch: state.integration?.branch,
    now: new Date().toISOString(),
    questions: openQuestions(state),
    nodes: view.nodes.map((n) => {
      const s = state.nodes.get(n.spec.id)
      const final = s && isFinal(s) ? n.endedAt : undefined
      const checks = n.events.filter((e): e is Extract<Event, { type: 'check.ended' }> => e.type === 'check.ended')
      return {
        id: n.spec.id,
        kind: n.spec.kind,
        parent: n.spec.parent,
        needs: n.spec.needs,
        standing: n.spec.standing,
        agent: [...n.turns.values()].findLast((t) => t.agent)?.agent ?? n.spec.agent,
        model: [...n.turns.values()].findLast((t) => t.model)?.model ?? n.spec.model,
        status: s?.status ?? 'pending',
        outcome: n.outcome ?? s?.summary ?? s?.reason,
        addedAt: n.addedAt,
        endedAt: final,
        turns: n.turns.size,
        tokens: tokensOf(usagesOf(n)),
        merged: n.events.some((e) => e.type === 'merge.done'),
        refused: n.events.filter((e) => e.type === 'lead.call' && !e.ok).length,
        checks: checks.map((c) => ({ at: c.at, exitCode: c.exitCode })),
        spans: spansOf(n, final),
      }
    }),
  }
}

/** The texts an event carries that can be long: check output, deliveries, answers, messages and results. */
function clipEvent(e: Event): Event {
  const cut = (text: string) => clip(text).text
  switch (e.type) {
    case 'check.ended': return { ...e, output: cut(e.output) }
    case 'lead.delivered': case 'lead.turn': return { ...e, text: cut(e.text) }
    case 'message': return { ...e, body: cut(e.body) }
    case 'turn.ended': return e.result ? { ...e, result: { ...e.result, summary: cut(e.result.summary) } } : e
    default: return e
  }
}

const clip = (text: string) => (text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), clipped: text.length - MAX_TEXT } : { text })

function clipItem(item: TraceItem) {
  if (item.kind === 'message') return { ...item, ...clip(item.text), ...(item.reasoning === undefined ? {} : { reasoning: clip(item.reasoning).text }) }
  if (item.kind === 'tool_result') {
    const { text, clipped } = clip(item.content)
    return { ...item, content: text, clipped }
  }
  const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments, null, 2)
  const { text, clipped } = clip(args ?? '')
  return { ...item, arguments: text, clipped }
}

/** Everything about one node: its brief, its own events (a lead's decisions), and each worker turn with its parsed
 * trace. Only this node's turn files are read. */
function nodeDetail(runDir: string, id: string, parseTurn: ParseTurn) {
  const view = viewRun(loadRun(runDir, parseTurn, (n) => n === id))
  const node = view.nodes.find((n) => n.spec.id === id)
  if (!node) throw new Error(`no node ${id}`)
  const state = fold(readEvents(runDir)).nodes.get(id)
  return {
    spec: node.spec,
    by: node.by,
    status: state?.status ?? 'pending',
    outcome: node.outcome,
    notes: state?.notes ?? [],
    events: node.events.map(clipEvent),
    turns: [...node.turns.values()].map((t) => ({
      turn: t.turn,
      mode: t.mode,
      agent: t.agent,
      model: t.model,
      prompt: clip(t.prompt),
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      interrupted: t.interrupted && { reason: t.interrupted.reason, signal: t.interrupted.signal },
      result: t.ended?.result ?? t.parsed.result,
      error: t.ended?.error,
      usage: t.usage,
      items: t.parsed.items.map(clipItem),
    })),
  }
}
