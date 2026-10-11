// Codex: `codex exec --json`. The structured result is the last `agent_message`, constrained by
// `--output-schema`. The session (thread) ID appears in the first `thread.started` event.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { TURN_RESULT_SCHEMA } from '../types.ts'
import type { ParsedTurn, TurnSpec, Usage, WorkerAdapter } from '../types.ts'
import { jsonLines, spawnTurn, toTurnResult } from './common.ts'
import type { Exit, Json } from './common.ts'

// OpenAI's strict structured output requires every property to be listed in `required`;
// optional properties become nullable instead.
const REQUIRED: readonly string[] = TURN_RESULT_SCHEMA.required
const STRICT_SCHEMA = {
  ...TURN_RESULT_SCHEMA,
  required: Object.keys(TURN_RESULT_SCHEMA.properties),
  properties: Object.fromEntries(
    Object.entries(TURN_RESULT_SCHEMA.properties).map(([key, prop]) =>
      [key, REQUIRED.includes(key) ? prop : { ...prop, type: [prop.type, 'null'] }]),
  ),
}

function run(spec: TurnSpec, args: string[]) {
  // Absolute, because Codex runs in spec.cwd.
  const schemaFile = resolve(`${spec.outFile.replace(/\.jsonl$/, '')}.schema.json`)
  mkdirSync(dirname(schemaFile), { recursive: true })
  writeFileSync(schemaFile, JSON.stringify(STRICT_SCHEMA))
  return spawnTurn('codex', [
    ...args, '--json', '--skip-git-repo-check', '--output-schema', schemaFile,
    ...(spec.model ? ['-m', spec.model] : []),
    '-',
  ], spec)
}

export const codex: WorkerAdapter = {
  name: 'codex',

  start(spec) {
    // Full permissions in the working directory: workspace-write cannot write .git and has no network.
    const turn = run(spec, ['exec', '-s', 'danger-full-access'])
    return { ...turn, sessionId: threadId(spec.outFile, turn.exit) }
  },

  resume(spec) {
    // `exec resume` has no -s flag; the config key sets the same sandbox mode.
    const turn = run(spec, ['exec', 'resume', spec.sessionId, '-c', 'sandbox_mode="danger-full-access"'])
    return { ...turn, sessionId: Promise.resolve(spec.sessionId) }
  },

  parse(raw) {
    const turn: ParsedTurn = { items: [], ended: false }
    const started = new Set<string>()
    let reasoning: string | undefined
    let last: string | undefined
    let succeeded = false
    for (const event of jsonLines(raw)) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') turn.sessionId ??= event.thread_id
      else if (event.type === 'item.started' || event.type === 'item.completed') {
        const item: Json = event.item ?? {}
        const completed = event.type === 'item.completed'
        if (item.type === 'agent_message') {
          if (!completed) continue
          last = String(item.text ?? '')
          turn.items.push({ kind: 'message', role: 'assistant', text: last, ...(reasoning ? { reasoning } : {}) })
          reasoning = undefined
        } else if (item.type === 'reasoning') {
          if (completed) reasoning = reasoning ? `${reasoning}\n${item.text}` : String(item.text ?? '')
        } else {
          const tool = toolOf(item)
          if (!tool) continue
          if (!started.has(item.id)) {
            started.add(item.id)
            turn.items.push({ kind: 'tool_call', id: item.id, name: tool.name, arguments: tool.arguments })
          }
          if (completed) turn.items.push({ kind: 'tool_result', callId: item.id, content: tool.content, isError: tool.isError })
        }
      } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        // A failed turn ends too, but only a completed one may yield a result.
        turn.ended = true
        succeeded = event.type === 'turn.completed'
        if (event.usage) turn.usage = usageOf(event.usage)
        if (event.error) turn.items.push({ kind: 'message', role: 'system', text: String(event.error.message ?? '') })
      }
    }
    if (reasoning) turn.items.push({ kind: 'message', role: 'assistant', text: '', reasoning })
    if (succeeded && last !== undefined) turn.result = toTurnResult(last)
    return turn
  },
}

type Tool = { name: string; arguments: unknown; content: string; isError: boolean }

function toolOf(item: Json): Tool | undefined {
  const failed = item.status === 'failed'
  switch (item.type) {
    case 'command_execution':
      return {
        name: 'shell',
        arguments: { command: item.command },
        content: String(item.aggregated_output ?? ''),
        isError: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0),
      }
    case 'file_change':
      return { name: 'file_change', arguments: { changes: item.changes }, content: String(item.status ?? ''), isError: failed }
    case 'mcp_tool_call':
      return {
        name: `${item.server}.${item.tool}`,
        arguments: item.arguments,
        content: JSON.stringify(item.error ?? item.result ?? null),
        isError: failed,
      }
    case 'web_search':
      return { name: 'web_search', arguments: { query: item.query }, content: '', isError: false }
  }
  return undefined
}

/** Codex's `input_tokens` already includes cached tokens. */
function usageOf(usage: Json): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokens: usage.cached_input_tokens ?? 0,
    ...(typeof usage.cache_write_input_tokens === 'number' ? { cacheWriteTokens: usage.cache_write_input_tokens } : {}),
  }
}

/** Poll the turn's output until `thread.started` names the thread; reject if the process exits first. */
function threadId(outFile: string, exit: Promise<Exit>): Promise<string> {
  const find = () => {
    try {
      return codex.parse(readFileSync(outFile, 'utf8')).sessionId
    } catch {
      return undefined
    }
  }
  const id = new Promise<string>((resolve, reject) => {
    const timer = setInterval(() => {
      const found = find()
      if (found) {
        clearInterval(timer)
        resolve(found)
      }
    }, 100)
    const settle = () => {
      clearInterval(timer)
      const found = find()
      if (found) resolve(found)
      else reject(new Error(`codex exited without reporting a thread ID (see ${outFile})`))
    }
    exit.then(settle, settle)
  })
  // Callers that never ask for the ID must not crash the process with an unhandled rejection.
  id.catch(() => {})
  return id
}
