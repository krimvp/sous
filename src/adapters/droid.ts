// Factory Droid: `droid exec -o stream-json`. Droid's exec has no structured-output flag, so the prompt asks for the
// result as a JSON object in a ```json fence at the end of the final message, as for Pi. The session ID appears in the
// stream. A resumed turn forks the session (`--fork`): `-s` loads the session from Factory's servers and fails without
// a Factory login (custom models need none), while a fork continues it locally under a new ID.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ParsedTurn, TurnSpec, Usage, WorkerAdapter } from '../types.ts'
import { jsonLines, num, RESULT_INSTRUCTION, resultFromText, sessionFromOutput, sousServer, spawnTurn, str } from './common.ts'
import type { Json } from './common.ts'

function readJson(file: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

const serversIn = (file: string) => Object.keys(readJson(file)?.mcpServers ?? {})

/** The names of the skills in `dir` (one directory with a SKILL.md each), as their frontmatter names them. */
function skillsIn(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    try {
      const skill = readFileSync(join(dir, entry, 'SKILL.md'), 'utf8')
      return [skill.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? entry]
    } catch {
      return []
    }
  })
}

let personal: { servers: string[]; skills: string[] } | undefined
/** The person's own MCP servers and skills (their skill directories and installed plugins), read once per process. */
function personalSetup() {
  if (!personal) {
    const factory = join(homedir(), '.factory')
    const installed: Json = readJson(join(factory, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
    const plugins: Json[] = Object.values(installed).flat()
    personal = {
      servers: serversIn(join(factory, 'mcp.json')),
      skills: [
        ...skillsIn(join(factory, 'skills')),
        ...skillsIn(join(homedir(), '.agents', 'skills')),
        ...plugins.flatMap((p) => (typeof p?.installPath === 'string' ? skillsIn(join(p.installPath, 'skills')) : [])),
      ],
    }
  }
  return personal
}

/** Runtime settings (`--settings`, merged over the person's and the project's for this process only): sous's MCP server
 * for a worker of the tree and every other configured server disabled by name (a disabled stub replaces the server's
 * whole entry, so none of its configuration is copied), hooks off (the project's too), and the person's skills off by
 * name. The project's own skills and instructions still apply. */
function settings(spec: TurnSpec) {
  const { servers, skills } = personalSetup()
  const server = sousServer(spec)
  const others = [...servers, ...serversIn(join(spec.cwd, '.factory', 'mcp.json')), ...serversIn(join(spec.cwd, '.mcp.json'))]
  const mcpServers: Record<string, Json> = Object.fromEntries(others.map((name) => [name, { type: 'stdio', command: 'false', args: [], disabled: true }]))
  // receive may wait up to a minute.
  if (server) mcpServers.sous = { type: 'stdio', ...server, timeout: 90_000 }
  return { mcp: { mcpServers }, hooks: { hooksDisabled: true }, disabledSkills: [...new Set(skills)] }
}

function run(spec: TurnSpec, session: string[]) {
  // Absolute, because Droid runs in spec.cwd.
  const settingsFile = resolve(`${spec.outFile.replace(/\.jsonl$/, '')}.settings.json`)
  mkdirSync(dirname(settingsFile), { recursive: true })
  writeFileSync(settingsFile, JSON.stringify(settings(spec)))
  const turn = spawnTurn('droid', [
    'exec', ...session, '-o', 'stream-json', '--settings', settingsFile, '--disable-builtin-skills',
    // Workers run with full permissions in their working directory (an open design question); `--auto high` still ends
    // the turn at a command it rates riskier.
    '--skip-permissions-unsafe',
    ...(spec.model ? ['-m', spec.model] : []),
  ], { ...spec, prompt: `${spec.prompt}\n\n${RESULT_INSTRUCTION}` })
  return { ...turn, sessionId: sessionFromOutput('droid', spec.outFile, turn.exit, (raw) => droid.parse(raw)) }
}

export const droid: WorkerAdapter = {
  name: 'droid',

  start(spec) {
    return run(spec, [])
  },

  resume(spec) {
    return run(spec, ['--fork', spec.sessionId])
  },

  parse(raw) {
    const turn: ParsedTurn = { items: [], ended: false }
    // Droid repeats a reasoning event; one per ID is kept.
    const reasoned = new Set<string>()
    let reasoning: string | undefined
    let last: string | undefined
    for (const event of jsonLines(raw)) {
      if (typeof event.session_id === 'string') turn.sessionId ??= event.session_id
      const at = typeof event.timestamp === 'number' ? new Date(event.timestamp).toISOString() : undefined
      if (event.type === 'reasoning') {
        if (reasoned.has(event.id)) continue
        reasoned.add(event.id)
        reasoning = reasoning ? `${reasoning}\n${event.text}` : String(event.text ?? '')
      } else if (event.type === 'message' && event.role === 'assistant') {
        last = String(event.text ?? '')
        turn.items.push({ kind: 'message', role: 'assistant', text: last, at, ...(reasoning ? { reasoning } : {}) })
        reasoning = undefined
      } else if (event.type === 'tool_call') {
        // Reasoning before a call is its own step, ahead of the call.
        if (reasoning) turn.items.push({ kind: 'message', role: 'assistant', text: '', reasoning, at })
        reasoning = undefined
        // A call without an ID cannot be paired with its result; it is left out.
        if (typeof event.id === 'string') turn.items.push({ kind: 'tool_call', id: event.id, name: str(event.toolName), arguments: event.parameters, at })
      } else if (event.type === 'tool_result') {
        const content = str(event.isError ? event.error?.message ?? event.value : event.value)
        turn.items.push({ kind: 'tool_result', callId: str(event.id), content, isError: event.isError === true, at })
      } else if (event.type === 'error') {
        // An exec that ends early says why in an assistant message, then again as an error.
        if (event.message === last) continue
        turn.items.push({ kind: 'message', role: 'system', text: String(event.message ?? ''), at })
      } else if (event.type === 'completion') {
        turn.ended = true
        if (event.usage) turn.usage = usageOf(event.usage)
        last = typeof event.finalText === 'string' ? event.finalText : last
      }
      // The init event names the exec default model even when the person's settings choose another, so no model is
      // taken from it. User messages are the prompt Droid echoes back; the supervisor already has it.
    }
    if (reasoning) turn.items.push({ kind: 'message', role: 'assistant', text: '', reasoning })
    if (turn.ended && last) turn.result = resultFromText(last)
    return turn
  },
}

/** Droid's `input_tokens` excludes cache reads (and, assumed, writes, never seen nonzero); the Usage convention includes
 * them. Its `factory_credits` are not a price. */
function usageOf(usage: Json): Usage {
  const read = num(usage.cache_read_input_tokens)
  const write = num(usage.cache_creation_input_tokens)
  return { inputTokens: num(usage.input_tokens) + read + write, outputTokens: num(usage.output_tokens), cachedTokens: read, cacheWriteTokens: write }
}
