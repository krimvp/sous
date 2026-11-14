// Parsers against real recorded output: each fixture is one turn that reads note.txt
// ("The secret fruit is mango.") with one tool call and ends with a structured result.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getAdapter } from '../src/adapters/index.ts'
import type { HarnessName, ParsedTurn } from '../src/contracts/index.ts'
import { recording } from './conformance/harnesses.ts'

// The conformance recordings (`SOUS_RECORD=1 npm run certify` regenerates them), so these tests follow the real CLIs.
const fixture = (harness: HarnessName) => recording(harness, 'read-file')

/** Every tool call has exactly one result with its ID, after it. */
function assertPaired(turn: ParsedTurn) {
  const calls = turn.items.flatMap((item, at) => (item.kind === 'tool_call' ? [{ id: item.id, at }] : []))
  const results = turn.items.flatMap((item, at) => (item.kind === 'tool_result' ? [{ id: item.callId, at }] : []))
  assert.equal(results.length, calls.length)
  for (const call of calls) {
    const matching = results.filter((r) => r.id === call.id)
    assert.equal(matching.length, 1, `one result for ${call.id}`)
    assert.ok(matching[0]!.at > call.at)
  }
}

function readCall(turn: ParsedTurn, name: string) {
  const call = turn.items.find((item) => item.kind === 'tool_call' && item.name === name)
  assert.ok(call?.kind === 'tool_call', `a ${name} call`)
  const result = turn.items.find((item) => item.kind === 'tool_result' && item.callId === call.id)
  assert.ok(result?.kind === 'tool_result')
  assert.match(result.content, /The secret fruit is mango\./)
  assert.equal(result.isError, false)
  return call
}

/** Cut the stream inside its end-marker line, as a process killed mid-write leaves it. */
function truncated(raw: string, marker: string): string {
  const lines = raw.split('\n')
  const at = lines.findLastIndex((line) => line.includes(`"type":"${marker}"`))
  assert.ok(at > 0)
  return [...lines.slice(0, at), lines[at]!.slice(0, 40)].join('\n')
}

test('claude: parses a recorded stream-json turn', () => {
  const turn = getAdapter('claude').parse(fixture('claude'))
  assert.equal(turn.sessionId, 'c1c852f3-980d-47f7-86d1-9e8904e7bb80')
  assert.equal(turn.model, 'claude-haiku-5-5')
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, {
    status: 'done',
    summary: 'note.txt names the fruit mango. The file reads: "The secret fruit is mango."',
  })
  // input_tokens 8 + cache writes 6712 + cache reads 46131.
  assert.deepEqual(turn.usage, {
    inputTokens: 52851,
    outputTokens: 213,
    cachedTokens: 46131,
    cacheWriteTokens: 6712,
    costUsd: 0.0019110100000000003,
  })
  assert.match((readCall(turn, 'Read').arguments as { file_path: string }).file_path, /\/note\.txt$/)
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind === 'message' ? `${item.role} message` : item.kind), [
    'tool_call', 'tool_result', 'assistant message', 'user message', 'tool_call', 'tool_result',
  ])
  const said = turn.items[2]
  assert.ok(said?.kind === 'message')
  assert.match(said.text, /mango/)
  assert.equal(said.model, 'claude-haiku-5-5')
})

test('codex: parses a recorded --json turn', () => {
  const turn = getAdapter('codex').parse(fixture('codex'))
  assert.equal(turn.sessionId, '01a12eb0-4a58-7d93-9bca-bddd673facc0')
  assert.equal(turn.ended, true)
  // Codex's strict schema sends absent optional fields as null; they are dropped.
  assert.deepEqual(turn.result, { status: 'done', summary: 'The fruit is mango.' })
  assert.deepEqual(turn.usage, { inputTokens: 25793, outputTokens: 82, cachedTokens: 12672, cacheWriteTokens: 0 })
  assert.deepEqual(readCall(turn, 'shell').arguments, { command: "/bin/bash -lc 'cat note.txt'" })
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind), ['message', 'tool_call', 'tool_result', 'message'])
})

test('pi: parses a recorded --mode json turn', () => {
  const turn = getAdapter('pi').parse(fixture('pi'))
  assert.equal(turn.sessionId, '2bf541e9-9fc1-4ade-84ca-2b8e026ec867')
  assert.equal(turn.model, 'glm-5.2')
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, {
    status: 'done',
    summary: 'Read note.txt; it names the fruit mango.',
  })
  // Two model calls, input and cache reads summed. The provider reports no cost.
  assert.deepEqual(turn.usage, { inputTokens: 3014, outputTokens: 53, cachedTokens: 1542, cacheWriteTokens: 0 })
  assert.deepEqual(readCall(turn, 'read').arguments, { path: 'note.txt' })
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind), ['message', 'tool_call', 'tool_result', 'message'])
  const [thought, , , final] = turn.items
  assert.ok(thought?.kind === 'message' && final?.kind === 'message')
  assert.equal(thought.reasoning, 'Let me read the file.')
  assert.match(final.text, /```json/)
})

test('droid: parses a recorded stream-json turn', () => {
  const turn = getAdapter('droid').parse(fixture('droid'))
  assert.equal(turn.sessionId, 'b31ef143-a1e1-47ab-8090-8112d2b1a6a0')
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, { status: 'done', summary: 'Read note.txt; it names mango as the fruit.' })
  assert.deepEqual(turn.usage, { inputTokens: 13692, outputTokens: 69, cachedTokens: 6720, cacheWriteTokens: 0 })
  assert.match((readCall(turn, 'Read').arguments as { file_path: string }).file_path, /\/note\.txt$/)
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind), ['tool_call', 'tool_result', 'message'])
})

const droidFixture = (name: string) => readFileSync(new URL(`fixtures/droid/${name}.jsonl`, import.meta.url), 'utf8')

test('droid: repeated reasoning counts once, as its own step before a call or on the message it goes with', () => {
  // A recorded worker turn that waits for its sibling with sous's MCP receive tool.
  const turn = getAdapter('droid').parse(droidFixture('receive'))
  assert.equal(turn.ended, true)
  assert.equal(turn.result?.status, 'done')
  assertPaired(turn)
  const steps = turn.items.map((item) => item.kind === 'message' ? `${item.text ? 'says' : 'thinks'}${item.reasoning ? '+reasoning' : ''}` : item.kind === 'tool_call' ? item.name : 'result')
  assert.deepEqual(steps, [
    'thinks+reasoning', 'ToolSearch', 'result',
    'says+reasoning', 'sous___receive', 'result',
    'says+reasoning', 'Create', 'result', 'Execute', 'result',
    'says',
  ])
  const reasoning = turn.items.flatMap((item) => (item.kind === 'message' && item.reasoning ? [item.reasoning] : []))
  // Droid sends each reasoning event twice; a step holds it once.
  assert.equal(reasoning.length, 3)
  for (const r of reasoning) assert.equal(r.indexOf(r.slice(0, 40), 1), -1, r)
  const received = turn.items.find((item) => item.kind === 'tool_result' && item.content.startsWith('Message from a'))
  assert.ok(received)
})

test('droid: an exec that ends early has no end marker, and its reason is kept once', () => {
  // A recorded turn whose MCP call needed more autonomy than it had.
  const turn = getAdapter('droid').parse(droidFixture('ended-early'))
  assert.equal(turn.ended, false)
  assert.equal(turn.result, undefined)
  const failed = turn.items.find((item) => item.kind === 'tool_result' && item.isError)
  assert.ok(failed?.kind === 'tool_result')
  assert.match(failed.content, /requires higher autonomy/)
  const said = turn.items.filter((item) => item.kind === 'message' && /^Exec ended early/.test(item.text))
  assert.equal(said.length, 1)
})

test('droid: a final message that is the bare JSON object is the result', () => {
  const turn = getAdapter('droid').parse(droidFixture('bare-result'))
  assert.deepEqual(turn.result, { status: 'done', summary: 'noted' })
})

test('codex: a failed turn ends without a result, even after an assistant JSON message', () => {
  const raw = fixture('codex').replace(/^.*"type":"turn\.completed".*$/m,
    JSON.stringify({ type: 'turn.failed', error: { message: 'interrupted' } }))
  const turn = getAdapter('codex').parse(raw)
  assert.equal(turn.ended, true)
  assert.equal(turn.result, undefined)
  assert.deepEqual(turn.items.at(-1), { kind: 'message', role: 'system', text: 'interrupted' })
})

test("codex: a turn that searches the web, calls sous's MCP server and changes files pairs every call with its result", () => {
  // Hand-built after the item shapes of `codex exec --json`: the recording has only a command.
  const turn = getAdapter('codex').parse(readFileSync(new URL('./fixtures/codex/tools.jsonl', import.meta.url), 'utf8'))
  assertPaired(turn)
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, { status: 'done', summary: 'Wrote greet.js.' })
  const calls = turn.items.flatMap((item, at) => {
    if (item.kind !== 'tool_call') return []
    const result = turn.items.find((r) => r.kind === 'tool_result' && r.callId === item.id)
    assert.ok(result?.kind === 'tool_result')
    return [[at, item.id, item.name, item.arguments, result.content, result.isError]]
  })
  assert.deepEqual(calls.map(([, ...rest]) => rest), [
    ['item_0', 'web_search', { query: 'node test runner coverage flag' }, '', false],
    // The call is named by server and tool; its result is what the server answered, or the error it gave.
    ['item_1', 'sous.send', { to: 'b', body: 'Use greet(name).' }, '{"content":[{"type":"text","text":"Sent to b."}],"structured_content":null}', false],
    ['item_2', 'sous.send', { to: 'c', body: 'hi' }, '{"message":"user cancelled MCP tool call"}', true],
    ['item_3', 'file_change', { changes: [{ path: '/work/greet.js', kind: 'add' }, { path: '/work/old.js', kind: 'delete' }] }, 'completed', false],
    ['item_4', 'file_change', { changes: [{ path: '/work/locked.js', kind: 'update' }] }, 'failed', true],
  ])
  // A call is shown once however many of its events there are.
  assert.equal(turn.items.filter((item) => item.kind === 'tool_call').length, 5)
})

test('pi: an agent_end that will retry is not the end; the result comes from the final attempt', () => {
  // Pi's shape for a failed attempt it retries (agent-session.js adds willRetry to agent_end).
  const failed = { role: 'assistant', content: [{ type: 'text', text: '```json\n{"status":"done","summary":"stale"}\n```' }], stopReason: 'error', errorMessage: '429 rate limited' }
  const retry = [
    { type: 'message_end', message: failed },
    { type: 'agent_end', messages: [failed], willRetry: true },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '429 rate limited' },
  ].map((event) => JSON.stringify(event)).join('\n')
  const recorded = fixture('pi')
  const adapter = getAdapter('pi')

  const unfinished = adapter.parse(`${retry}\n${truncated(recorded, 'agent_end')}`)
  assert.equal(unfinished.ended, false)
  assert.equal(unfinished.result, undefined)

  const finished = adapter.parse(`${retry}\n${recorded}`)
  assert.equal(finished.ended, true)
  assert.deepEqual(finished.result, adapter.parse(recorded).result)
  assert.ok(finished.items.some((item) => item.kind === 'message' && item.role === 'system' && item.text === '429 rate limited'))
})

const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n')

/** A Pi turn whose one assistant message says `text` (with `usage`), then ends. */
const piTurn = (text: string, usage?: object) => lines([
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } },
  { type: 'agent_end' },
])

test('pi and droid: the result is the last fence that holds one, in any case, with or without a newline, else the bare object', () => {
  const result = '{"status": "done", "summary": "wrote it"}'
  const texts = [
    `Done.\n\n\`\`\`JSON\n${result}\n\`\`\``,
    `Done. \`\`\`json${result}\`\`\``,
    `Done.\r\n\r\n\`\`\`json  \r\n${result}\r\n\`\`\``,
    // The prompt's own wording, repeated in prose before the fence, is not a fence.
    `Done; here is my result in a \`\`\`json fenced block:\n\n\`\`\`json\n${result}\n\`\`\``,
    // An example after the result is not the result.
    `Done.\n\n\`\`\`json\n${result}\n\`\`\`\n\nOther agents can read it like this:\n\`\`\`json\n{"file": "a.txt"}\n\`\`\``,
    result,
  ]
  for (const text of texts) {
    assert.deepEqual(getAdapter('pi').parse(piTurn(text)).result, { status: 'done', summary: 'wrote it' }, `pi: ${text}`)
    assert.deepEqual(getAdapter('droid').parse(lines([{ type: 'completion', finalText: text }])).result, { status: 'done', summary: 'wrote it' }, `droid: ${text}`)
  }
  assert.equal(getAdapter('pi').parse(piTurn('Done, see above.')).result, undefined)
})

test('usage counts that are not numbers count as 0, and tool results are text', () => {
  const codex = getAdapter('codex').parse(lines([{ type: 'turn.completed', usage: { input_tokens: '12', output_tokens: 3, cached_input_tokens: null } }]))
  assert.deepEqual(codex.usage, { inputTokens: 0, outputTokens: 3, cachedTokens: 0 })

  const pi = getAdapter('pi').parse(`${piTurn('a', { input: '3', output: 2 })}\n${piTurn('b', { input: 4, output: 'x', cacheRead: 1 })}`)
  assert.deepEqual(pi.usage, { inputTokens: 5, outputTokens: 2, cachedTokens: 1, cacheWriteTokens: 0 })

  const claude = getAdapter('claude').parse(lines([{ type: 'result', usage: { input_tokens: '8', output_tokens: 5, cache_read_input_tokens: {} } }]))
  assert.deepEqual(claude.usage, { inputTokens: 0, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 })

  const droid = getAdapter('droid').parse(lines([
    { type: 'tool_call', id: 'c1', toolName: 'Read', parameters: {} },
    { type: 'tool_result', id: 'c1', value: { a: 1 } },
    { type: 'tool_call', id: 'c2', toolName: 'Read', parameters: {} },
    { type: 'tool_result', id: 'c2', isError: true, error: { message: ['denied'] } },
    { type: 'completion', usage: { input_tokens: '9', output_tokens: 1 } },
  ]))
  assert.deepEqual(droid.items.flatMap((item) => (item.kind === 'tool_result' ? [item.content] : [])), ['{"a":1}', '["denied"]'])
  assert.deepEqual(droid.usage, { inputTokens: 0, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0 })
})

test('a tool call without a string ID is left out, so no call has an undefined ID', () => {
  const claude = getAdapter('claude').parse(lines([{ type: 'assistant', message: { id: 'm1', content: [
    { type: 'tool_use', name: 'Read', input: {} },
    { type: 'tool_use', id: 7, name: 'Read', input: {} },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
  ] } }]))
  assert.deepEqual(claude.items.map((item) => item.kind === 'tool_call' && item.id), ['toolu_1'])
  const pi = getAdapter('pi').parse(lines([{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: {} }] } }]))
  assert.deepEqual(pi.items, [])
  const droid = getAdapter('droid').parse(lines([{ type: 'tool_call', toolName: 'Read', parameters: {} }]))
  assert.deepEqual(droid.items, [])
  const codex = getAdapter('codex').parse(lines([{ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: '' } }]))
  assert.deepEqual(codex.items, [])
})
