// Codex: `codex exec --json`. The structured result is the last `agent_message`, constrained by
// `--output-schema`. The session (thread) ID appears in the first `thread.started` event. A lead turn (`TurnSpec.lead`)
// runs in Codex's read-only sandbox with the lead's role before its first prompt (no flag known to sous replaces
// Codex's system prompt) and the lead result's schema; not yet certified to lead (LEAD_HARNESSES).

import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LEAD_RESULT_SCHEMA, TURN_RESULT_SCHEMA } from '../contracts/index.ts'
import type { ParsedTurn, TurnSpec, Usage, WorkerAdapter } from '../contracts/index.ts'
import { jsonLines, leadFromText, num, resultFromText, sessionFromOutput, sousServer, spawnTurn, str, strictSchema } from './common.ts'
import type { Json } from './common.ts'

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

/** A name an override can address (`mcp_servers.<name>…`): others cannot be disabled, and some would not parse. */
const OVERRIDABLE = /^[A-Za-z0-9_-]+$/

/** The servers in `codex mcp list --json` output that an override can disable; each other one, or a listing that failed,
 * is said on stderr. */
function serversIn(stdout: string, err?: Error): string[] {
  let names: string[]
  try {
    const list: unknown = JSON.parse(stdout)
    if (!Array.isArray(list)) throw new Error('not a list')
    names = list.map((s) => s?.name).filter((n): n is string => typeof n === 'string')
  } catch (e) {
    console.error(`sous: cannot list Codex's MCP servers (${(err ?? (e as Error)).message}); Codex workers may load them`)
    return []
  }
  return names.filter((name) => {
    if (OVERRIDABLE.test(name)) return true
    console.error(`sous: cannot disable Codex's MCP server ${JSON.stringify(name)}; Codex workers may load it`)
    return false
  })
}

const LIST = ['mcp', 'list', '--json']
let configured: string[] | undefined

/** List the MCP servers the user's Codex configuration loads, once per process and without blocking: `sous run` and
 * `sous resume` do it at run start, so no turn waits for it. */
export async function listCodexServers(): Promise<void> {
  if (configured) return
  const listed = await new Promise<string[]>((resolve) =>
    execFile('codex', LIST, { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => resolve(serversIn(stdout, err ?? undefined))))
  configured ??= listed
}

/** The servers `listCodexServers` found; without it (the adapter used on its own), the first turn lists them. */
function configuredServers(): string[] {
  if (!configured) {
    const r = spawnSync('codex', LIST, { encoding: 'utf8', timeout: 15_000 })
    configured = serversIn(r.stdout ?? '', r.error)
  }
  return configured
}

/** The MCP servers the project's own `.codex/config.toml` defines, and whether each has a URL. Codex reads its configuration
 * once before it records its trust in the project (its first `exec` there does), without the project's file, and once
 * after, with it; `codex mcp list` may have run before. So each is replaced by a whole disabled server, valid on its own. */
function projectServers(cwd: string): Map<string, boolean> {
  const file = join(cwd, '.codex', 'config.toml')
  let toml: string
  try {
    toml = readFileSync(file, 'utf8')
  } catch {
    return new Map()
  }
  const servers = new Map<string, boolean>()
  const add = (name: string, url: boolean) => servers.set(name, (servers.get(name) ?? false) || url)
  // A TOML key: bare, "basic" or 'literal'.
  const KEY = String.raw`(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))`
  const keyOf = (m: RegExpMatchArray) => m[1] ?? m[2] ?? m[3]!
  const URL_KEY = String.raw`(?:url|"url"|'url')\s*=`
  // Where each line is: in a server's table, in the [mcp_servers] table, in another table, or at the top.
  let at: { server: string } | 'servers' | 'other' | 'top' = 'top'
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    const header = line.match(/^\[\s*([^\]]+?)\s*\]/)
    if (header) {
      const server = header[1]!.match(new RegExp(String.raw`^mcp_servers\s*\.\s*${KEY}`))
      at = server ? { server: keyOf(server) } : header[1] === 'mcp_servers' ? 'servers' : 'other'
      if (typeof at === 'object') add(at.server, false)
    } else if (typeof at === 'object') {
      if (new RegExp(`^${URL_KEY}`).test(line)) add(at.server, true)
    } else if (at === 'top' && /^mcp_servers\s*=/.test(line)) {
      console.error(`sous: cannot read the inline mcp_servers table of ${file}; Codex workers may load its servers`)
    } else if (at === 'servers' || at === 'top') {
      const entry = line.match(new RegExp(String.raw`^${at === 'top' ? String.raw`mcp_servers\s*\.\s*` : ''}${KEY}\s*(\.\s*${URL_KEY}|[.=])`))
      if (entry) add(keyOf(entry), entry[4]!.length > 1 || new RegExp(`[{,]\\s*${URL_KEY}`).test(line))
    }
  }
  for (const name of servers.keys()) {
    if (OVERRIDABLE.test(name)) continue
    console.error(`sous: cannot disable Codex's MCP server ${JSON.stringify(name)} of ${file}; Codex workers may load it`)
    servers.delete(name)
  }
  return servers
}

/** Config overrides that disable every MCP server the user or the project configured, and Codex's apps and plugins (which bring tools
 * of their own), and add sous's server for a worker of the tree: Codex merges `-c mcp_servers=…` into its
 * configuration rather than replacing it. */
function mcpConfig(spec: TurnSpec): string[] {
  const q = (value: string) => JSON.stringify(value) // a TOML basic string
  const server = sousServer(spec)
  const project = projectServers(spec.cwd)
  const env = server && Object.entries(server.env).map(([k, v]) => `${k}=${q(v)}`).join(',')
  return [
    // The person's rules, hooks and skills stay out too; their global AGENTS.md cannot be left out without moving
    // CODEX_HOME, which would put the login at risk.
    '--ignore-rules', '-c', 'features.hooks=false', '-c', 'skills.include_instructions=false',
    '-c', 'features.apps=false', '-c', 'features.plugins=false',
    // A server of the person's named sous is replaced by sous's own, or disabled when the node gets none.
    ...configuredServers().filter((name) => !project.has(name) && !(server && name === 'sous')).flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ...[...project].filter(([name]) => !(server && name === 'sous')).flatMap(([name, url]) =>
      ['-c', `mcp_servers.${name}={${url ? 'url="http://127.0.0.1:9/"' : 'command="false",args=[]'},enabled=false}`]),
    // receive may wait up to a minute.
    ...(server ? ['-c', `mcp_servers.sous={command=${q(server.command)},args=[${server.args.map(q).join(',')}],env={${env}},tool_timeout_sec=90}`] : []),
  ]
}

const STRICT_LEAD_SCHEMA = strictSchema(LEAD_RESULT_SCHEMA)

/** Workers run with full permissions in their working directory (workspace-write cannot write .git and has no
 * network); a lead turn in the read-only sandbox. `exec resume` has no -s flag; the config key sets the same mode. */
const sandbox = (spec: TurnSpec) => (spec.lead ? 'read-only' : 'danger-full-access')

function run(spec: TurnSpec, args: string[]) {
  // Absolute, because Codex runs in spec.cwd.
  const schemaFile = resolve(`${spec.outFile.replace(/\.jsonl$/, '')}.schema.json`)
  mkdirSync(dirname(schemaFile), { recursive: true })
  writeFileSync(schemaFile, JSON.stringify(spec.lead ? STRICT_LEAD_SCHEMA : STRICT_SCHEMA))
  return spawnTurn('codex', [
    ...args, ...mcpConfig(spec), '--json', '--skip-git-repo-check', '--output-schema', schemaFile,
    ...(spec.model ? ['-m', spec.model] : []),
    '-',
  ], spec)
}

export const codex: WorkerAdapter = {
  name: 'codex',
  lead: true,

  start(spec) {
    // A lead's role goes before its first prompt; a resumed session has it already.
    const prompt = spec.lead ? `${spec.lead.system}\n\n${spec.prompt}` : spec.prompt
    const turn = run({ ...spec, prompt }, ['exec', '-s', sandbox(spec)])
    return { ...turn, sessionId: sessionFromOutput('codex', spec.outFile, turn.exit, (raw) => codex.parse(raw)) }
  },

  resume(spec) {
    const turn = run(spec, ['exec', 'resume', spec.sessionId, '-c', `sandbox_mode="${sandbox(spec)}"`])
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
          // A call without an ID cannot be paired with its result; it is left out.
          if (!tool || typeof item.id !== 'string') continue
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
    if (succeeded && last !== undefined) {
      turn.result = resultFromText(last)
      const lead = leadFromText(last)
      if (lead) turn.lead = lead
    }
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
        content: str(item.aggregated_output),
        isError: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0),
      }
    case 'file_change':
      return { name: 'file_change', arguments: { changes: item.changes }, content: str(item.status), isError: failed }
    case 'mcp_tool_call':
      return {
        name: `${str(item.server)}.${str(item.tool)}`,
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
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cachedTokens: num(usage.cached_input_tokens),
    ...(typeof usage.cache_write_input_tokens === 'number' ? { cacheWriteTokens: num(usage.cache_write_input_tokens) } : {}),
  }
}
