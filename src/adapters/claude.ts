// Claude Code: `claude -p --output-format stream-json`. The structured result is the `result` event's
// `structured_output`, produced through `--json-schema`.

import { randomUUID } from 'node:crypto'
import { TURN_RESULT_SCHEMA } from '../contracts/index.ts'
import type { ParsedTurn, TraceItem, TurnSpec, Usage, WorkerAdapter } from '../contracts/index.ts'
import { jsonLines, num, sousServer, spawnTurn, str, textOf, toTurnResult } from './common.ts'

function run(spec: TurnSpec, session: string[], sessionId: string) {
  const server = sousServer(spec)
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    ...session,
    '--json-schema', JSON.stringify(TURN_RESULT_SCHEMA),
    // No MCP server but sous's, and none of the person's own settings, CLAUDE.md, skills or plugins: what a worker tells
    // others goes through sous. The project's settings and CLAUDE.md still apply.
    '--strict-mcp-config', '--setting-sources', 'project',
    ...(server ? ['--mcp-config', JSON.stringify({ mcpServers: { sous: { type: 'stdio', ...server } } })] : []),
    // Workers run with full permissions in their working directory (an open design question).
    '--permission-mode', 'bypassPermissions',
    ...(spec.model ? ['--model', spec.model] : []),
  ]
  return { ...spawnTurn('claude', args, spec), sessionId: Promise.resolve(sessionId) }
}

type Message = Extract<TraceItem, { kind: 'message' }>

export const claude: WorkerAdapter = {
  name: 'claude',

  start(spec) {
    const sessionId = spec.sessionId ?? randomUUID()
    return run(spec, ['--session-id', sessionId], sessionId)
  },

  resume(spec) {
    return run(spec, ['--resume', spec.sessionId], spec.sessionId)
  },

  parse(raw) {
    const turn: ParsedTurn = { items: [], ended: false }
    // Claude writes one event per content block; blocks of one API message share its ID.
    const messages = new Map<string, Message>()
    for (const event of jsonLines(raw)) {
      if (typeof event.session_id === 'string') turn.sessionId ??= event.session_id
      const at = typeof event.timestamp === 'string' ? event.timestamp : undefined
      if (event.type === 'assistant') {
        const message = event.message ?? {}
        if (typeof message.model === 'string') turn.model = message.model
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type === 'text' || block?.type === 'thinking') {
            let item = messages.get(message.id)
            if (!item) {
              item = { kind: 'message', role: 'assistant', text: '', model: message.model, at }
              turn.items.push(item)
              if (message.id) messages.set(message.id, item)
            }
            if (block.type === 'text') item.text = join(item.text, block.text)
            else item.reasoning = join(item.reasoning, block.thinking)
          } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
            // A call without an ID cannot be paired with its result; it is left out.
            turn.items.push({ kind: 'tool_call', id: block.id, name: str(block.name), arguments: block.input, at })
          }
        }
      } else if (event.type === 'user') {
        const content = event.message?.content
        if (typeof content === 'string') turn.items.push({ kind: 'message', role: 'user', text: content, at })
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type === 'tool_result') {
            turn.items.push({ kind: 'tool_result', callId: str(block.tool_use_id), content: textOf(block.content), isError: block.is_error === true, at })
          } else if (block?.type === 'text') {
            // Text Claude Code itself injects mid-turn; the prompt is not echoed without --replay-user-messages.
            turn.items.push({ kind: 'message', role: 'user', text: block.text, at })
          }
        }
      } else if (event.type === 'result') {
        turn.ended = true
        turn.usage = usageOf(event)
        turn.result = toTurnResult(event.structured_output)
        if (event.is_error) turn.items.push({ kind: 'message', role: 'system', text: String(event.result ?? event.subtype) })
      }
    }
    return turn
  },
}

function join(a: string | undefined, b: unknown): string {
  const text = typeof b === 'string' ? b : ''
  return a ? `${a}\n${text}` : text
}

/** Claude's `input_tokens` excludes cache reads and writes; the Usage convention includes them. */
function usageOf(event: Record<string, any>): Usage | undefined {
  const usage = event.usage
  if (!usage) return undefined
  const read = num(usage.cache_read_input_tokens)
  const write = num(usage.cache_creation_input_tokens)
  return {
    inputTokens: num(usage.input_tokens) + read + write,
    outputTokens: num(usage.output_tokens),
    cachedTokens: read,
    cacheWriteTokens: write,
    ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}),
  }
}
