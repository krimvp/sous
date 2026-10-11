// OTLP/JSON export for Langfuse: one trace per run with run → node → turn → generation/tool spans. A lead's
// node holds a chain per delivery with its tool calls and its answer; a spawned node hangs under its spawn call.

import { createHash } from 'node:crypto'
import type { Usage } from '../types.ts'
import { loadRun, MURM_VERSION, viewRun } from './run.ts'
import type { LoadedRun, ParseTurn, TurnView } from './run.ts'

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
type Attr = { key: string; value: AttrValue }

interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attr[]
  status?: { code: number; message?: string }
}

const SPAN_KIND_INTERNAL = 1
const STATUS_ERROR = 2

const hexId = (seed: string, length: number) => createHash('sha256').update(seed).digest('hex').slice(0, length)

const traceIdOf = (runId: string) => hexId(`murm:${runId}`, 32)

const nanos = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString()

function attributes(values: Record<string, unknown>): Attr[] {
  const out: Attr[] = []
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue
    let value: AttrValue
    if (typeof v === 'string') value = { stringValue: v }
    else if (typeof v === 'boolean') value = { boolValue: v }
    else if (typeof v === 'number') value = Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
    else value = { stringValue: JSON.stringify(v) }
    out.push({ key, value })
  }
  return out
}

/** Usage as Langfuse usage_details: input excludes cache reads and writes, so no category is counted twice. */
function usageDetails(u: Usage) {
  const cacheWrite = u.cacheWriteTokens ?? 0
  return {
    input: Math.max(0, u.inputTokens - u.cachedTokens - cacheWrite),
    output: u.outputTokens,
    input_cache_read: u.cachedTokens,
    input_cache_creation: u.cacheWriteTokens,
    total: u.inputTokens + u.outputTokens,
  }
}

export function toOtlp(run: LoadedRun): object {
  const view = viewRun(run)
  const traceId = traceIdOf(view.runId)
  const spans: Span[] = []
  const span = (
    key: string, parent: string | undefined, name: string, type: string, start: string, end: string,
    attrs: Record<string, unknown>, error?: string, level = 'ERROR',
  ): string => {
    const spanId = hexId(`murm:${view.runId}:${key}`, 16)
    spans.push({
      traceId,
      spanId,
      parentSpanId: parent,
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end < start ? start : end),
      attributes: attributes({
        'session.id': view.runId,
        'langfuse.observation.type': type,
        ...attrs,
        ...(error ? { 'langfuse.observation.level': level, 'langfuse.observation.status_message': error } : {}),
      }),
      ...(error && level === 'ERROR' ? { status: { code: STATUS_ERROR, message: error } } : {}),
    })
    return spanId
  }

  const runOutput = view.end?.type === 'run.completed' ? view.end.summary : view.end?.reason
  const root = span('run', undefined, `murm run ${view.runId}`, 'span', view.createdAt, view.endedAt, {
    'langfuse.trace.name': `murm run ${view.runId}`,
    'langfuse.trace.input': view.goal,
    'langfuse.trace.output': runOutput,
    'langfuse.observation.input': view.goal,
    'langfuse.observation.output': runOutput,
    'murm.workspace': view.workspace,
    'murm.result_branch': run.events.find((e) => e.type === 'integration.created')?.branch,
  }, view.end?.type === 'run.failed' ? view.end.reason : undefined)

  const addTurn = (nodeId: string, parent: string, t: TurnView, cancelled: boolean) => {
    const key = `${nodeId}/${t.turn}`
    const interrupted = t.interrupted && `interrupted (${t.interrupted.signal}): ${t.interrupted.reason}`
    const turnSpan = span(`turn/${key}`, parent, `turn ${t.turn}`, 'chain', t.startedAt, t.endedAt, {
      'langfuse.observation.input': t.prompt,
      'langfuse.observation.output': t.ended?.result ?? t.parsed.result,
      'murm.turn.mode': t.mode,
      'murm.turn.agent': t.agent,
      'murm.turn.session_id': t.sessionId,
      'murm.turn.exit_code': t.ended?.exitCode,
    }, t.ended?.error ?? interrupted, t.ended?.error && !cancelled ? 'ERROR' : 'WARNING')
    const items = t.parsed.items
    const lastGeneration = items.findLastIndex((i) => i.kind === 'message' && i.role === 'assistant')
    const usage = t.usage && {
      'langfuse.observation.usage_details': usageDetails(t.usage),
      'langfuse.observation.cost_details': t.usage.costUsd === undefined ? undefined : { total: t.usage.costUsd },
    }
    let prevAt = t.startedAt
    items.forEach((item, i) => {
      const at = item.at ?? prevAt
      if (item.kind === 'message' && item.role === 'assistant') {
        span(`item/${key}/${i}`, turnSpan, 'generation', 'generation', prevAt, at, {
          'gen_ai.request.model': item.model ?? t.model,
          'langfuse.observation.output': item.text,
          'langfuse.observation.metadata.reasoning': item.reasoning,
          ...(i === lastGeneration ? usage : {}),
        })
      } else if (item.kind === 'tool_call') {
        const result = items.find((r) => r.kind === 'tool_result' && r.callId === item.id)
        const output = result?.kind === 'tool_result' ? result : undefined
        span(`item/${key}/${i}`, turnSpan, item.name, 'tool', at, output?.at ?? at, {
          'langfuse.observation.input': item.arguments,
          'langfuse.observation.output': output?.content,
          'murm.tool.call_id': item.id,
        }, output?.isError ? 'tool returned an error' : undefined)
      }
      prevAt = at
    })
    // A turn with no assistant text (only tool calls and the structured result) still used the model.
    if (lastGeneration < 0 && usage) {
      span(`usage/${key}`, turnSpan, 'generation', 'generation', t.startedAt, t.endedAt, { 'gen_ai.request.model': t.model, ...usage })
    }
  }

  // Lead answers: a chain per delivery, from lead.delivered to the lead.turn with its requestId. An interrupt steers
  // the answer in progress, so it joins it and ends with it; a queued delivery waits for the answer to end.
  interface Chain { requestId: string; span: Span; lastAt: string }
  const nodeSpans = new Map<string, string>()
  const callSpans = new Map<string, string>()
  for (const node of view.nodes) {
    const { spec } = node
    const parent = (node.spawnCall && callSpans.get(`${spec.parent}/${node.spawnCall}`)) || (spec.parent && nodeSpans.get(spec.parent)) || root
    const check = node.events.findLast((e) => e.type === 'check.ended')
    const nodeSpan = span(`node/${spec.id}`, parent, `${spec.kind} ${spec.id}`, spec.kind === 'check' ? 'span' : 'agent', node.addedAt, node.endedAt, {
      'langfuse.observation.input': spec.kind === 'check' ? spec.command : spec.brief,
      'langfuse.observation.output': spec.kind === 'check' && check?.type === 'check.ended' ? check.output : node.outcome,
      'murm.node.id': spec.id,
      'murm.node.kind': spec.kind,
      'murm.node.status': node.status,
      'murm.check.exit_code': spec.kind === 'check' && check?.type === 'check.ended' ? check.exitCode : undefined,
    }, node.status === 'failed' ? node.outcome : undefined, node.cancelledBy ? 'WARNING' : 'ERROR')
    nodeSpans.set(spec.id, nodeSpan)
    let running: Chain[] = []
    let queued: Chain[] = []
    let prevAt = node.addedAt
    for (const e of node.events) {
      if (e.type === 'turn.started') {
        const turn = node.turns.get(e.turn)
        if (turn) addTurn(spec.id, nodeSpan, turn, node.cancelledBy !== undefined)
      } else if (e.type === 'check.ended' && spec.kind !== 'check') {
        span(`check/${spec.id}/${e.seq}`, nodeSpan, 'acceptance check', 'span', prevAt, e.at, {
          'langfuse.observation.input': e.command,
          'langfuse.observation.output': e.output,
          'murm.check.exit_code': e.exitCode,
        }, e.exitCode === 0 ? undefined : `exit code ${e.exitCode}`)
      } else if (e.type === 'merge.queued' || e.type === 'merge.withdrawn' || e.type === 'merge.conflict' || e.type === 'merge.done' || e.type === 'merge.failed') {
        const { type, node: _, seq, at, ...details } = e
        const problem = e.type === 'merge.conflict' || e.type === 'merge.failed' ? e.reason : undefined
        span(`merge/${spec.id}/${seq}`, nodeSpan, type, 'span', at, at,
          Object.fromEntries(Object.entries(details).map(([key, value]) => [`murm.merge.${key}`, value])), problem, type === 'merge.failed' ? 'ERROR' : 'WARNING')
      } else if (e.type === 'lead.delivered') {
        span(`chain/${spec.id}/${e.requestId}`, nodeSpan, `delivery ${e.requestId}`, 'chain', e.at, e.at, {
          'langfuse.observation.input': e.text,
          'murm.lead.request_id': e.requestId,
          'murm.lead.mode': e.mode,
        })
        const chain = { requestId: e.requestId, span: spans.at(-1)!, lastAt: e.at }
        if (!running.length) running = [chain]
        else if (e.mode === 'interrupt') running.push(chain)
        else queued.push(chain)
      } else if (e.type === 'lead.call') {
        const { tool, ...args } = e.call
        const chain = running.at(-1)
        if (chain) chain.lastAt = e.at
        callSpans.set(`${spec.id}/${e.callId}`, span(`call/${spec.id}/${e.callId}`, chain?.span.spanId ?? nodeSpan, tool, 'tool', e.at, e.at, {
          'langfuse.observation.input': args,
          'langfuse.observation.output': e.result,
          'murm.tool.call_id': e.callId,
          'murm.tool.ok': e.ok,
        }, e.ok ? undefined : 'call refused', 'WARNING'))
      } else if (e.type === 'lead.turn') {
        const inRunning = running.some((c) => c.requestId === e.requestId)
        const ended = inRunning ? running : queued.filter((c) => c.requestId === e.requestId)
        for (const c of ended) c.span.endTimeUnixNano = nanos(e.at)
        const chain = ended.find((c) => c.requestId === e.requestId)
        chain?.span.attributes.push(...attributes({ 'langfuse.observation.output': e.text, 'murm.lead.status': e.status }))
        // The answer's generation runs from the answer's last delivery or tool call to the lead.turn.
        const from = ended.map((c) => c.lastAt).sort().at(-1) ?? prevAt
        span(`generation/${spec.id}/${e.seq}`, chain?.span.spanId ?? nodeSpan, 'generation', 'generation', from, e.at, {
          'gen_ai.request.model': e.model,
          'langfuse.observation.output': e.text,
          'langfuse.observation.usage_details': e.usage && usageDetails(e.usage),
          'langfuse.observation.cost_details': e.usage?.costUsd === undefined ? undefined : { total: e.usage.costUsd },
        })
        if (inRunning) running = queued.splice(0, 1)
        else queued = queued.filter((c) => !ended.includes(c))
      }
      prevAt = e.at
    }
    // Deliveries never answered (a cancelled or unfinished lead) end with the node.
    for (const c of [...running, ...queued]) c.span.endTimeUnixNano = nanos(node.endedAt)
  }

  return {
    resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': 'murmuration', 'service.version': MURM_VERSION }) },
      scopeSpans: [{ scope: { name: 'murmuration', version: MURM_VERSION }, spans }],
    }],
  }
}

export interface LangfuseConfig {
  host: string
  publicKey: string
  secretKey: string
}

export async function postOtlp(payload: object, { host, publicKey, secretKey }: LangfuseConfig): Promise<void> {
  const res = await fetch(`${host.replace(/\/+$/, '')}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Langfuse OTLP export failed: ${res.status} ${res.statusText}: ${await res.text()}`)
}

/** `murm export otlp`: posts the run's trace to Langfuse; returns the trace ID. */
export async function exportOtlp(runDir: string, parseTurn: ParseTurn, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { LANGFUSE_HOST: host, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = env
  if (!host || !publicKey || !secretKey) {
    throw new Error('set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to export to Langfuse')
  }
  const run = loadRun(runDir, parseTurn)
  await postOtlp(toOtlp(run), { host, publicKey, secretKey })
  return traceIdOf(run.runId)
}
