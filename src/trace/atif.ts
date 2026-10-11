// ATIF-v1.8 export (Harbor RFC 0001): one document per run; each node is an embedded subagent trajectory.
// ATIF rejects unknown keys, so everything Murmuration-specific goes in `extra`.

import type { HarnessName, Usage } from '../types.ts'
import { loadRun, MURM_VERSION, viewRun } from './run.ts'
import type { LoadedRun, NodeView, ParseTurn, TurnView } from './run.ts'

export const ATIF_VERSION = 'ATIF-v1.8'

const AGENT_NAMES: Record<HarnessName, string> = { claude: 'claude-code', codex: 'codex', pi: 'pi' }

interface Step {
  step_id: number
  timestamp?: string
  source: 'system' | 'user' | 'agent'
  model_name?: string
  message: string
  reasoning_content?: string
  tool_calls?: { tool_call_id: string; function_name: string; arguments: object; extra?: object }[]
  observation?: { results: Record<string, unknown>[] }
  metrics?: Record<string, unknown>
  llm_call_count?: number
  extra?: Record<string, unknown>
}

type StepInput = Omit<Step, 'step_id'>

function stepList() {
  const steps: Step[] = []
  const add = (s: StepInput): Step => {
    const step = { step_id: steps.length + 1, ...s }
    steps.push(step)
    return step
  }
  return { steps, add }
}

function metrics(u: Usage): Record<string, unknown> {
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    cached_tokens: u.cachedTokens,
    cost_usd: u.costUsd,
    extra: { scope: 'turn', cache_creation_input_tokens: u.cacheWriteTokens },
  }
}

function sumUsage(usages: (Usage | undefined)[]): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  for (const u of usages) {
    if (!u) continue
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.cachedTokens += u.cachedTokens
    if (u.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + u.cacheWriteTokens
    if (u.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + u.costUsd
  }
  return total
}

function finalMetrics(usages: (Usage | undefined)[], totalSteps: number) {
  const u = sumUsage(usages)
  return {
    total_prompt_tokens: u.inputTokens,
    total_completion_tokens: u.outputTokens,
    total_cached_tokens: u.cachedTokens,
    total_cost_usd: u.costUsd,
    total_steps: totalSteps,
    extra: u.cacheWriteTokens === undefined ? undefined : { total_cache_creation_input_tokens: u.cacheWriteTokens },
  }
}

const asObject = (v: unknown): object => (v && typeof v === 'object' && !Array.isArray(v) ? v : { input: v })

function addTurn(add: (s: StepInput) => Step, t: TurnView): void {
  add({
    source: 'user',
    timestamp: t.startedAt,
    message: t.prompt,
    extra: { turn: t.turn, mode: t.mode, harness: t.harness, session_id: t.sessionId },
  })
  let open: Step | undefined
  let last: Step | undefined
  const byCall = new Map<string, Step>()
  const agentStep = (at: string | undefined, model: string | undefined, message: string, reasoning?: string) => {
    open = last = add({ source: 'agent', timestamp: at, model_name: model ?? t.model, message, reasoning_content: reasoning })
    return open
  }
  for (const item of t.parsed.items) {
    if (item.kind === 'message') {
      if (item.role === 'assistant') agentStep(item.at, item.model, item.text, item.reasoning)
      else {
        add({ source: item.role, timestamp: item.at, message: item.text })
        open = undefined
      }
    } else if (item.kind === 'tool_call') {
      // A call joins the open agent step until that step has results; then it starts a new step.
      const step = open && !open.observation ? open : agentStep(item.at, undefined, '')
      ;(step.tool_calls ??= []).push({ tool_call_id: item.id, function_name: item.name, arguments: asObject(item.arguments) })
      byCall.set(item.id, step)
    } else {
      const step = byCall.get(item.callId)
      const extra = item.isError ? { is_error: true } : undefined
      if (step) (step.observation ??= { results: [] }).results.push({ source_call_id: item.callId, content: item.content, extra })
      else {
        add({ source: 'system', timestamp: item.at, message: 'Tool result without a matching call', observation: { results: [{ content: item.content, extra: { ...extra, call_id: item.callId } }] } })
        open = undefined
      }
    }
  }
  if (!t.usage) return
  // A turn with no parsed agent output still used the model: keep its usage on an empty agent step.
  ;(last ?? add({ source: 'agent', timestamp: t.endedAt, model_name: t.model, message: '' })).metrics = metrics(t.usage)
}

function nodeTrajectory(runId: string, node: NodeView): object {
  const { steps, add } = stepList()
  const { spec } = node
  for (const e of node.events) {
    if (e.type === 'turn.started') {
      const turn = node.turns.get(e.turn)
      if (turn) addTurn(add, turn)
    } else if (e.type === 'turn.interrupted') {
      add({ source: 'system', timestamp: e.at, message: `Turn ${e.turn} interrupted (${e.signal}): ${e.reason}` })
    } else if (e.type === 'check.ended' && spec.kind === 'check') {
      add({
        source: 'agent',
        timestamp: e.at,
        llm_call_count: 0,
        message: `$ ${e.command}`,
        tool_calls: [{ tool_call_id: 'check', function_name: 'shell', arguments: { command: e.command } }],
        observation: { results: [{ source_call_id: 'check', content: e.output, extra: { exit_code: e.exitCode } }] },
      })
    } else if (e.type === 'check.ended') {
      add({
        source: 'system',
        timestamp: e.at,
        message: `Acceptance check exited ${e.exitCode}: ${e.command}`,
        observation: { results: [{ content: e.output, extra: { command: e.command, exit_code: e.exitCode } }] },
      })
    } else if (e.type === 'node.failed') {
      add({ source: 'system', timestamp: e.at, message: `Node failed: ${e.reason}` })
    }
  }
  if (!steps.length) add({ source: 'system', timestamp: node.addedAt, message: `Node ${spec.id} did not run` })

  const turns = [...node.turns.values()]
  const harness = turns[0]?.harness ?? spec.harness
  return {
    schema_version: ATIF_VERSION,
    session_id: runId,
    trajectory_id: `${runId}/${spec.id}`,
    agent: spec.kind === 'check' || !harness
      ? { name: 'murmuration', version: MURM_VERSION }
      : { name: AGENT_NAMES[harness], version: 'unknown', model_name: turns[0]?.model },
    steps,
    final_metrics: finalMetrics(turns.map((t) => t.usage), steps.length),
    extra: {
      node: spec,
      status: node.status,
      outcome: node.outcome,
      turns: turns.map((t) => ({
        turn: t.turn,
        mode: t.mode,
        harness: t.harness,
        session_id: t.sessionId,
        started_at: t.startedAt,
        ended_at: t.endedAt,
        exit_code: t.ended?.exitCode,
        signal: t.ended?.signal,
        result: t.ended?.result ?? t.parsed.result,
        error: t.ended?.error,
        interrupted: t.interrupted?.reason,
      })),
    },
  }
}

export function toAtif(run: LoadedRun): object {
  const view = viewRun(run)
  const { steps, add } = stepList()
  add({ source: 'user', timestamp: view.createdAt, message: view.goal })
  for (const node of view.nodes) {
    const callId = `run-${node.spec.id}`
    add({
      source: 'agent',
      timestamp: node.addedAt,
      llm_call_count: 0,
      message: `Run ${node.spec.kind} node ${node.spec.id}`,
      tool_calls: [{ tool_call_id: callId, function_name: 'run_node', arguments: node.spec }],
      observation: {
        results: [{
          source_call_id: callId,
          content: node.outcome ?? node.status,
          subagent_trajectory_ref: [{ trajectory_id: `${view.runId}/${node.spec.id}`, session_id: view.runId }],
          extra: { status: node.status },
        }],
      },
      extra: { added_by: node.by },
    })
  }
  if (view.end) {
    const text = view.end.type === 'run.completed' ? `Run completed: ${view.end.summary}` : `Run failed: ${view.end.reason}`
    add({ source: 'agent', timestamp: view.end.at, llm_call_count: 0, message: text })
  }
  const doc = {
    schema_version: ATIF_VERSION,
    session_id: view.runId,
    trajectory_id: view.runId,
    agent: { name: 'murmuration', version: MURM_VERSION },
    steps,
    notes: 'Root trajectory is the Murmuration supervisor; each node is an embedded subagent trajectory. final_metrics totals include the subagents.',
    final_metrics: finalMetrics(view.nodes.flatMap((n) => [...n.turns.values()].map((t) => t.usage)), steps.length),
    extra: {
      goal: view.goal,
      workspace: view.workspace,
      status: view.end?.type === 'run.completed' ? 'completed' : view.end ? 'failed' : 'unfinished',
    },
    subagent_trajectories: view.nodes.map((n) => nodeTrajectory(view.runId, n)),
  }
  // Drop undefined fields so the document has only keys with values.
  return JSON.parse(JSON.stringify(doc))
}

export function exportAtif(runDir: string, parseTurn: ParseTurn): string {
  return JSON.stringify(toAtif(loadRun(runDir, parseTurn)), null, 2) + '\n'
}
