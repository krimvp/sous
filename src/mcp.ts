#!/usr/bin/env node
// sous's MCP server for one worker: a stdio server (newline-delimited JSON-RPC 2.0) whose only tool is `send`, the
// same message as `sous send`. Its harness starts it for the worker's turn with SOUS_RUN_DIR and SOUS_NODE set; it
// writes command files and never the log, so the supervisor stays the only writer.
import { createInterface } from 'node:readline'
import { readEvents } from './log.ts'
import { MAX_SENDS, sendTargets, workerSend } from './send.ts'
import { fold } from './state.ts'

const { SOUS_RUN_DIR: runDir, SOUS_NODE: node } = process.env
if (!runDir || !node) {
  console.error('sous mcp: SOUS_RUN_DIR and SOUS_NODE must be set')
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

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, any> }

/** MCP protocol versions this server speaks, the latest first. */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

function handle(req: Request): unknown {
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
      return { tools: [sendTool()] }
    case 'tools/call': {
      const { name, arguments: args } = req.params ?? {}
      if (name !== 'send') throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 })
      const r = workerSend(runDir!, node!, String(args?.to ?? ''), String(args?.body ?? ''))
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 })
  }
}

const reply = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
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
    reply({ id: req.id, result: handle(req) })
  } catch (err) {
    reply({ id: req.id, error: { code: (err as { code?: number }).code ?? -32603, message: (err as Error).message } })
  }
})
