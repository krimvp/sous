#!/usr/bin/env node
// sous's MCP server for one worker: a stdio server (newline-delimited JSON-RPC 2.0) with the tools `send` and `receive`,
// the same as `sous send` and `sous receive`. Its harness starts it for the worker's turn with SOUS_RUN_DIR and SOUS_NODE set; it
// writes command files and never the log, so the supervisor stays the only writer.
import { createInterface } from 'node:readline'
import { readEvents } from './log.ts'
import { MAX_SENDS, MAX_WAIT_SECONDS, sendTargets, workerReceive, workerSend } from './send.ts'
import { fold } from './state.ts'

const { SOUS_RUN_DIR: runDir, SOUS_NODE: node, SOUS_TURN: turn } = process.env
if (!runDir || !node || !turn) {
  console.error('sous mcp: SOUS_RUN_DIR, SOUS_NODE and SOUS_TURN must be set')
  process.exit(2)
}

/** The `send` tool, with the worker's current lead and siblings in its description. */
function sendTool() {
  const { lead, siblings } = sendTargets(fold(readEvents(runDir!)), node!)
  const whom = [lead && `your lead ${lead}`, siblings.length && `your siblings ${siblings.join(', ')}`].filter(Boolean).join(' or ')
  return {
    name: 'send',
    description: `Tell ${whom || 'nobody (you have no lead or siblings)'} something they must know while you work: an interface you ` +
      `settled, a file you moved, a change of plan. ${lead ? 'Your lead sees every message. ' : ''}At most ${MAX_SENDS} messages; ` +
      'they are read when the recipient\'s turn ends, so do not wait for an answer.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'body'],
      properties: { to: { type: 'string', description: 'The node ID of your lead or of a sibling' }, body: { type: 'string' } },
    },
  }
}

const RECEIVE_TOOL = {
  name: 'receive',
  description: 'Read the messages waiting for you from your lead, your siblings or sous, without ending your turn; they are not ' +
    `delivered again. With wait_seconds (at most ${MAX_WAIT_SECONDS}), wait that long for one when none is waiting: use it when a ` +
    'sibling must tell you something before you can go on.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'Default 0: do not wait' } },
  },
}

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, any> }

/** MCP protocol versions this server speaks, the latest first. */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: VERSIONS.includes(req.params?.protocolVersion) ? req.params!.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sous', version: '0.0.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: [sendTool(), RECEIVE_TOOL] }
    case 'tools/call': {
      const { name, arguments: args } = req.params ?? {}
      if (name !== 'send' && name !== 'receive') throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 })
      // An argument the tool does not take is refused, so the model corrects the call instead of trusting an empty answer.
      const takes = name === 'send' ? ['to', 'body'] : ['wait_seconds']
      const unknown = Object.keys(args ?? {}).filter((k) => !takes.includes(k))
      if (unknown.length) {
        return { content: [{ type: 'text', text: `not done: ${name} takes ${takes.join(' and ')}, not ${unknown.join(', ')}` }], isError: true }
      }
      const r = name === 'send'
        ? workerSend(runDir!, node!, String(args?.to ?? ''), String(args?.body ?? ''))
        : await workerReceive(runDir!, node!, Number(turn), Number(args?.wait_seconds ?? 0) || 0)
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 })
  }
}

const reply = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req: Request
  try {
    req = JSON.parse(line)
  } catch {
    return reply({ id: null, error: { code: -32700, message: 'parse error' } })
  }
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return reply({ id: null, error: { code: -32600, message: 'invalid request' } })
  if (req.id === undefined) return // a notification
  try {
    reply({ id: req.id, result: await handle(req) })
  } catch (err) {
    reply({ id: req.id, error: { code: (err as { code?: number }).code ?? -32603, message: (err as Error).message } })
  }
})
