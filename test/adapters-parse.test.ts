// Parsers against real recorded output: each fixture is one turn that reads note.txt
// ("The secret fruit is mango.") with one tool call and ends with a structured result.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getAdapter } from '../src/adapters/index.ts'
import type { HarnessName, ParsedTurn } from '../src/types.ts'
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
  assert.deepEqual(turn.result, { status: 'done', summary: 'Read note.txt; it names mango as the fruit.', note_for_parent: '' })
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
