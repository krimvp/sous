// Parsers against real recorded output: each fixture is one turn that reads note.txt
// ("The secret fruit is mango.") with one tool call and ends with a structured result.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getAdapter } from '../src/adapters/index.ts'
import type { HarnessName, ParsedTurn } from '../src/types.ts'

const fixture = (harness: HarnessName) =>
  readFileSync(new URL(`fixtures/${harness}/read-file.jsonl`, import.meta.url), 'utf8')

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
  assert.equal(turn.sessionId, '4b58326a-25e8-41c4-8480-ee2d79ef5369')
  assert.equal(turn.model, 'claude-haiku-5-5')
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, {
    status: 'done',
    summary: 'I read note.txt. The secret fruit it names is mango ("The secret fruit is mango.").',
  })
  // input_tokens 8 + cache writes 30614 + cache reads 60905.
  assert.deepEqual(turn.usage, {
    inputTokens: 91527,
    outputTokens: 262,
    cachedTokens: 60905,
    cacheWriteTokens: 30614,
    costUsd: 0.006863650000000001,
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
  assert.equal(turn.sessionId, '01a129e0-7f63-7ed0-a34a-343ac9a8f30a')
  assert.equal(turn.ended, true)
  // Codex's strict schema sends absent optional fields as null; they are dropped.
  assert.deepEqual(turn.result, { status: 'done', summary: 'The fruit is mango.' })
  assert.deepEqual(turn.usage, { inputTokens: 31117, outputTokens: 83, cachedTokens: 15360, cacheWriteTokens: 0 })
  assert.deepEqual(readCall(turn, 'shell').arguments, { command: "/bin/bash -lc 'cat note.txt'" })
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind), ['message', 'tool_call', 'tool_result', 'message'])
})

test('pi: parses a recorded --mode json turn', () => {
  const turn = getAdapter('pi').parse(fixture('pi'))
  assert.equal(turn.sessionId, '7a69514d-8215-42c1-90b8-90732a88f704')
  assert.equal(turn.model, 'glm-5.2')
  assert.equal(turn.ended, true)
  assert.deepEqual(turn.result, {
    status: 'done',
    summary: 'The file note.txt contains the message: "The secret fruit is mango." The fruit named is a mango.',
  })
  // Two model calls: input 806 + cache reads 50, then 32 + 855. The provider reports no cost.
  assert.deepEqual(turn.usage, { inputTokens: 1743, outputTokens: 105, cachedTokens: 905, cacheWriteTokens: 0 })
  assert.deepEqual(readCall(turn, 'read').arguments, { path: 'note.txt' })
  assertPaired(turn)
  assert.deepEqual(turn.items.map((item) => item.kind), ['message', 'tool_call', 'tool_result', 'message'])
  const [thought, , , final] = turn.items
  assert.ok(thought?.kind === 'message' && final?.kind === 'message')
  assert.equal(thought.reasoning, 'Let me read the note.txt file first.')
  assert.match(final.text, /```json/)
})

const END_MARKERS = { claude: 'result', codex: 'turn.completed', pi: 'agent_end' } as const

for (const [harness, marker] of Object.entries(END_MARKERS) as [HarnessName, string][]) {
  test(`${harness}: a stream cut before its end marker has no result and keeps earlier items`, () => {
    const adapter = getAdapter(harness)
    const raw = fixture(harness)
    const turn = adapter.parse(truncated(raw, marker))
    assert.equal(turn.ended, false)
    assert.equal(turn.result, undefined)
    assert.ok(turn.items.some((item) => item.kind === 'tool_result'))
    assert.equal(turn.sessionId, adapter.parse(raw).sessionId)
  })
}
