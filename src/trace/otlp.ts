// OTLP/JSON export for Langfuse: one trace per run with run → node → turn → generation/tool spans.

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

export const traceIdOf = (runId: string) => hexId(`murm:${runId}`, 32)

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
  }, view.end?.type === 'run.failed' ? view.end.reason : undefined)

  const addTurn = (nodeId: string, parent: string, t: TurnView) => {
    const key = `${nodeId}/${t.turn}`
    const interrupted = t.interrupted && `interrupted (${t.interrupted.signal}): ${t.interrupted.reason}`
    const turnSpan = span(`turn/${key}`, parent, `turn ${t.turn}`, 'chain', t.startedAt, t.endedAt, {
      'langfuse.observation.input': t.prompt,
      'langfuse.observation.output': t.ended?.result ?? t.parsed.result,
      'murm.turn.mode': t.mode,
      'murm.turn.harness': t.harness,
      'murm.turn.session_id': t.sessionId,
      'murm.turn.exit_code': t.ended?.exitCode,
    }, t.ended?.error ?? interrupted, t.ended?.error ? 'ERROR' : 'WARNING')
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

  for (const node of view.nodes) {
    const { spec } = node
    const check = node.events.findLast((e) => e.type === 'check.ended')
    const nodeSpan = span(`node/${spec.id}`, root, `${spec.kind} ${spec.id}`, spec.kind === 'check' ? 'span' : 'agent', node.addedAt, node.endedAt, {
      'langfuse.observation.input': spec.kind === 'check' ? spec.command : spec.brief,
      'langfuse.observation.output': spec.kind === 'check' && check?.type === 'check.ended' ? check.output : node.outcome,
      'murm.node.id': spec.id,
      'murm.node.kind': spec.kind,
      'murm.node.status': node.status,
      'murm.check.exit_code': spec.kind === 'check' && check?.type === 'check.ended' ? check.exitCode : undefined,
    }, node.status === 'failed' ? node.outcome : undefined)
    let prevAt = node.addedAt
    for (const e of node.events) {
      if (e.type === 'turn.started') {
        const turn = node.turns.get(e.turn)
        if (turn) addTurn(spec.id, nodeSpan, turn)
      } else if (e.type === 'check.ended' && spec.kind !== 'check') {
        span(`check/${spec.id}/${e.seq}`, nodeSpan, 'acceptance check', 'span', prevAt, e.at, {
          'langfuse.observation.input': e.command,
          'langfuse.observation.output': e.output,
          'murm.check.exit_code': e.exitCode,
        }, e.exitCode === 0 ? undefined : `exit code ${e.exitCode}`)
      }
      prevAt = e.at
    }
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
