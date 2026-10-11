// Real harness turns: start, then resume the same session and prove it kept context.
// Costs money; runs only with MURM_LIVE=1.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getAdapter } from '../src/adapters/index.ts'
import type { HarnessName, RunningTurn, TurnSpec } from '../src/types.ts'

const live = process.env.MURM_LIVE === '1'
// Claude also exercises --model with a cheap model; the others use their configured default.
const MODELS: Record<HarnessName, string | undefined> = { claude: 'haiku', codex: undefined, pi: undefined }

for (const harness of ['claude', 'codex', 'pi'] as const) {
  test(`${harness}: a resumed session remembers the first turn`, { skip: !live, timeout: 600_000 }, async () => {
    const adapter = getAdapter(harness)
    const cwd = mkdtempSync(join(tmpdir(), `murm-live-${harness}-`))
    const codeword = randomBytes(4).toString('hex').toUpperCase()
    const spec = (turn: number, prompt: string): TurnSpec => ({
      nodeId: 'live', turn, cwd, prompt, model: MODELS[harness],
      outFile: join(cwd, `turn-${turn}.jsonl`), errFile: join(cwd, `turn-${turn}.err`),
    })
    const finish = async (running: RunningTurn, outFile: string) => {
      const exit = await running.exit
      const turn = adapter.parse(readFileSync(outFile, 'utf8'))
      assert.equal(exit.code, 0, `exit ${JSON.stringify(exit)}; see ${outFile}`)
      assert.equal(turn.ended, true)
      assert.equal(turn.result?.status, 'done', JSON.stringify(turn.result))
      assert.ok(turn.usage && turn.usage.inputTokens > 0)
      return turn
    }

    const first = spec(1, `Remember this codeword for later: ${codeword}. Do not use any tools. Finish with status done and summary "noted".`)
    const started = adapter.start(first)
    const sessionId = await started.sessionId
    const one = await finish(started, first.outFile)
    assert.equal(one.sessionId, sessionId)

    const second = spec(2, 'What is the codeword I gave you? Do not use any tools. Finish with status done and the codeword alone as the summary.')
    const resumed = adapter.resume({ ...second, sessionId })
    assert.equal(await resumed.sessionId, sessionId)
    const two = await finish(resumed, second.outFile)
    assert.equal(two.sessionId, sessionId)
    assert.match(two.result!.summary, new RegExp(codeword))
  })
}
