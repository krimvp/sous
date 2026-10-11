// Pi: `pi -p --mode json`. Pi has no structured-output flag, so the prompt asks for the result as a
// JSON object in a ```json fence at the end of the final message, and parse reads the last such fence.

import { randomUUID } from 'node:crypto'
import type { ParsedTurn, TurnSpec, Usage, WorkerAdapter } from '../types.ts'
import { jsonLines, spawnTurn, textOf, toTurnResult } from './common.ts'

export const RESULT_INSTRUCTION = [
  'When you finish, end your final message with your result as a JSON object in a ```json fenced block:',
  '{"status": "done" | "blocked" | "needs_input", "summary": "...", "question": "... (only when needs_input)",',
  '"note_for_parent": "... (optional)"}',
].join('\n')

function run(spec: TurnSpec, sessionId: string) {
  // Pi creates the session when the ID is new and continues it otherwise. Default tools.
  const args = ['-p', '--mode', 'json', '--session-id', sessionId, ...(spec.model ? ['--model', spec.model] : [])]
  const prompt = `${spec.prompt}\n\n${RESULT_INSTRUCTION}`
  return { ...spawnTurn('pi', args, { ...spec, prompt }), sessionId: Promise.resolve(sessionId) }
}

export const pi: WorkerAdapter = {
  name: 'pi',

  start(spec) {
    return run(spec, spec.sessionId ?? randomUUID())
  },

  resume(spec) {
    return run(spec, spec.sessionId)
  },

  parse(raw) {
    const turn: ParsedTurn = { items: [], ended: false }
    let usage: Required<Usage> | undefined
    let last: string | undefined
    for (const event of jsonLines(raw)) {
      if (event.type === 'session' && typeof event.id === 'string') turn.sessionId ??= event.id
      else if (event.type === 'agent_end') turn.ended = true
      if (event.type !== 'message_end') continue
      const message = event.message ?? {}
      const at = typeof message.timestamp === 'number' ? new Date(message.timestamp).toISOString() : undefined
      const parts: Record<string, any>[] = Array.isArray(message.content) ? message.content : []
      if (message.role === 'assistant') {
        const model = typeof message.model === 'string' ? message.model : undefined
        if (model) turn.model = model
        last = textOf(message.content)
        const reasoning = parts.filter((p) => p?.type === 'thinking').map((p) => p.thinking).join('\n')
        if (last || reasoning) turn.items.push({ kind: 'message', role: 'assistant', text: last, model, at, ...(reasoning ? { reasoning } : {}) })
        for (const part of parts) {
          if (part?.type === 'toolCall') turn.items.push({ kind: 'tool_call', id: part.id, name: part.name, arguments: part.arguments, at })
        }
        if (message.stopReason === 'error' && message.errorMessage) {
          turn.items.push({ kind: 'message', role: 'system', text: String(message.errorMessage), at })
        }
        // Pi's `input` excludes cache reads and writes; the Usage convention includes them.
        const u = message.usage
        if (u) {
          usage ??= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
          usage.inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
          usage.outputTokens += u.output ?? 0
          usage.cachedTokens += u.cacheRead ?? 0
          usage.cacheWriteTokens += u.cacheWrite ?? 0
          usage.costUsd += u.cost?.total ?? 0
        }
      } else if (message.role === 'toolResult') {
        turn.items.push({ kind: 'tool_result', callId: message.toolCallId, content: textOf(message.content), isError: message.isError === true, at })
      }
      // User messages are the prompt Pi echoes back; the supervisor already has it.
    }
    if (usage) {
      // Providers without a price table report zero, which is not a cost.
      const { costUsd, ...counts } = usage
      turn.usage = costUsd > 0 ? usage : counts
    }
    if (turn.ended && last) turn.result = toTurnResult(lastJsonFence(last))
    return turn
  },
}

function lastJsonFence(text: string): string | undefined {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  return fences.at(-1)?.[1]
}
