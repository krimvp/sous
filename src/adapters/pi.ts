// Pi: `pi -p --mode json`. Pi has no structured-output flag, so the prompt asks for the result as a
// JSON object in a ```json fence at the end of the final message, and parse reads it back (`resultFromText`).

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedTurn, TurnSpec, Usage, WorkerAdapter } from '../contracts/index.ts'
import { jsonLines, num, RESULT_INSTRUCTION, resultFromText, spawnTurn, str, textOf } from './common.ts'

function run(spec: TurnSpec, sessionId: string) {
  // Pi creates the session when the ID is new and continues it otherwise. Default tools, no MCP: a worker tells others
  // through `sous send`. None of the person's skills, prompt templates or context files: only the project's own
  // AGENTS.md and CLAUDE.md, at the top of the worktree.
  const project = ['AGENTS.md', 'CLAUDE.md'].map((f) => join(spec.cwd, f)).filter((f) => existsSync(f))
  const args = [
    '-p', '--mode', 'json', '--session-id', sessionId, '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files',
    ...project.flatMap((f) => ['--append-system-prompt', f]),
    ...(spec.model ? ['--model', spec.model] : []),
  ]
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
      else if (event.type === 'agent_end') {
        // Pi marks a failed attempt it will retry; only the final attempt ends the turn and gives the result.
        if (event.willRetry === true) last = undefined
        else turn.ended = true
      }
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
          // A call without an ID cannot be paired with its result; it is left out.
          if (part?.type === 'toolCall' && typeof part.id === 'string') turn.items.push({ kind: 'tool_call', id: part.id, name: str(part.name), arguments: part.arguments, at })
        }
        if (message.stopReason === 'error' && message.errorMessage) {
          turn.items.push({ kind: 'message', role: 'system', text: String(message.errorMessage), at })
        }
        // Pi's `input` excludes cache reads and writes; the Usage convention includes them.
        const u = message.usage
        if (u) {
          usage ??= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
          usage.inputTokens += num(u.input) + num(u.cacheRead) + num(u.cacheWrite)
          usage.outputTokens += num(u.output)
          usage.cachedTokens += num(u.cacheRead)
          usage.cacheWriteTokens += num(u.cacheWrite)
          usage.costUsd += num(u.cost?.total)
        }
      } else if (message.role === 'toolResult') {
        turn.items.push({ kind: 'tool_result', callId: str(message.toolCallId), content: textOf(message.content), isError: message.isError === true, at })
      }
      // User messages are the prompt Pi echoes back; the supervisor already has it.
    }
    if (usage) {
      // Providers without a price table report zero, which is not a cost.
      const { costUsd, ...counts } = usage
      turn.usage = costUsd > 0 ? usage : counts
    }
    if (turn.ended && last) turn.result = resultFromText(last)
    return turn
  },
}
