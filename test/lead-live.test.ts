// A real lead on Ollama Cloud with a fake host: it splits a tiny goal into two children, receives their outcomes
// and completes. Costs money; runs only with SOUS_LIVE=1.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLeadRunner } from '../src/lead/index.ts'
import { DEFAULT_LEAD_MODEL } from '../src/contracts/index.ts'
import type { LeadCall, LeadHost } from '../src/contracts/index.ts'

const live = process.env.SOUS_LIVE === '1'

test('live: a lead spawns two children, receives their outcomes and completes', { skip: !live, timeout: 300_000 }, async (t) => {
  const calls: LeadCall[] = []
  const turns: Parameters<LeadHost['settled']>[1][] = []
  const children: string[] = []
  let outcomesDelivered = false
  let completed: string | undefined
  // Children "complete" once the lead has answered its brief; their outcomes are delivered as the supervisor would.
  const host: LeadHost = {
    act(_node, _callId, call) {
      calls.push(call)
      if (call.tool === 'spawn') {
        if (children.length + call.children.length > 2) return 'refused: at most 2 children in this run'
        children.push(...call.children.map((c) => c.id))
        return `spawned ${call.children.map((c) => c.id).join(', ')}`
      }
      if (call.tool === 'complete') {
        if (!outcomesDelivered) return 'refused: children are still running'
        completed = call.summary
        return 'completed'
      }
      return 'ok'
    },
    read: () => 'refused: no files in this test',
    settled(node, turn) {
      turns.push(turn)
      if (turn.requestId !== 'lead:brief') return
      children.forEach((id, i) => runner.deliver(node, `Child ${id} completed. Summary: wrote the file exactly as briefed; its acceptance criteria are met.`, { requestId: `evt-${i + 1}`, mode: 'queue' }))
      outcomesDelivered = true
    },
  }
  const runner = createLeadRunner({ runDir: mkdtempSync(join(tmpdir(), 'sous-lead-live-')), host })
  await runner.deliver('lead', 'Goal: the workspace has a file a.txt containing "alpha" and a file b.txt containing "beta". ' +
    'Split it into exactly 2 independent work children in one spawn call, one per file. Then wait for their outcomes and complete.',
  { requestId: 'lead:brief', mode: 'queue' })
  const deadline = Date.now() + 240_000
  while (!(completed !== undefined && turns.length === 1 + children.length) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  await runner.close()
  t.diagnostic(`calls: ${JSON.stringify(calls)}`)
  t.diagnostic(`turns: ${JSON.stringify(turns)}`)

  assert.equal(children.length, 2)
  assert.ok(completed, 'the lead completed')
  assert.deepEqual(turns.map((turn) => turn.requestId).sort(), ['evt-1', 'evt-2', 'lead:brief'])
  for (const turn of turns) {
    assert.equal(turn.status, 'done')
    assert.equal(turn.model, DEFAULT_LEAD_MODEL)
    assert.ok(turn.usage && turn.usage.outputTokens > 0)
  }
})
