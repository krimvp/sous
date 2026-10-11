import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessName, ParsedTurn } from '../src/types.ts'
import { exportAtif, toAtif } from '../src/trace/atif.ts'
import { loadRun } from '../src/trace/run.ts'
import { checkAtif } from './atif-checker.ts'

// The fixture run: `impl` (Claude) starts, fails its acceptance check, is resumed and completes; `verify` is a
// check node; `docs` (Codex) is interrupted and fails; the log ends in a line cut off mid-append. Parsing raw
// harness output is the adapters' job, so the turn files hold ParsedTurn JSON and the parser just reads it.
const RUN_DIR = join(import.meta.dirname, 'fixtures', 'trace-run')
const parsedBy: HarnessName[] = []
const parseTurn = (harness: HarnessName, raw: string): ParsedTurn => {
  parsedBy.push(harness)
  return JSON.parse(raw)
}

type Obj = Record<string, any>
const doc = JSON.parse(exportAtif(RUN_DIR, parseTurn)) as Obj
const sub = (node: string): Obj => doc.subagent_trajectories.find((t: Obj) => t.trajectory_id === `trace-run/${node}`)

test('loadRun skips the truncated final event line and parses each turn with its harness', () => {
  parsedBy.length = 0
  const run = loadRun(RUN_DIR, parseTurn)
  assert.equal(run.runId, 'trace-run')
  assert.equal(run.events.length, 22)
  assert.deepEqual(parsedBy, ['claude', 'claude', 'codex'])
  assert.deepEqual(Object.keys(run.turns), ['impl#1', 'impl#2', 'docs#1'])
})

test('loadRun rejects a corrupt line that is not the last one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murm-trace-'))
  writeFileSync(join(dir, 'events.jsonl'), '{"seq":1,"at":"2026-10-11T10:00:00Z","type":"run.cr\n{"seq":2}\n')
  assert.throws(() => loadRun(dir, parseTurn), /events\.jsonl:1/)
})

test('the ATIF document passes the strict checker', () => {
  assert.deepEqual(checkAtif(doc), [])
})

test('the strict checker catches unknown keys and dangling call and trajectory references', () => {
  const bad = structuredClone(doc)
  bad.steps[0].murm_node = 'impl'
  bad.steps[1].observation.results[0].source_call_id = 'nope'
  bad.steps[2].observation.results[0].subagent_trajectory_ref[0].trajectory_id = 'trace-run/missing'
  bad.subagent_trajectories[0].steps[1].step_id = 7
  const errors = checkAtif(bad)
  assert.equal(errors.length, 4, errors.join('\n'))
})

test('the root trajectory dispatches each node to an embedded subagent trajectory', () => {
  assert.equal(doc.schema_version, 'ATIF-v1.8')
  assert.equal(doc.session_id, 'trace-run')
  assert.deepEqual(doc.steps.map((s: Obj) => [s.source, s.llm_call_count, s.message]), [
    ['user', undefined, 'Add a greeting module with a passing test'],
    ['agent', 0, 'Run work node impl'],
    ['agent', 0, 'Run check node verify'],
    ['agent', 0, 'Run work node docs'],
    ['agent', 0, 'Run failed: node docs failed'],
  ])
  assert.ok(doc.steps.every((s: Obj) => s.metrics === undefined))
  const refs = doc.steps.slice(1, 4).map((s: Obj) => s.observation.results[0])
  assert.deepEqual(refs.map((r: Obj) => [r.subagent_trajectory_ref[0].trajectory_id, r.extra.status]), [
    ['trace-run/impl', 'completed'], ['trace-run/verify', 'completed'], ['trace-run/docs', 'failed'],
  ])
  assert.ok(doc.subagent_trajectories.every((t: Obj) => t.session_id === 'trace-run'))
  assert.deepEqual(doc.final_metrics, {
    total_prompt_tokens: 9300, total_completion_tokens: 430, total_cached_tokens: 7200,
    total_cost_usd: 0.0123 + 0.0061, total_steps: 5, extra: { total_cache_creation_input_tokens: 1100 },
  })
})

test('a resumed work node continues one trajectory with the check failure and the delivered message', () => {
  const impl = sub('impl')
  assert.deepEqual(impl.agent, { name: 'claude-code', version: 'unknown', model_name: 'claude-sonnet-4-5' })
  assert.deepEqual(impl.steps.map((s: Obj) => [s.step_id, s.source, s.tool_calls?.map((c: Obj) => c.function_name)]), [
    [1, 'user', undefined],
    [2, 'agent', ['Write', 'Bash']],
    [3, 'agent', undefined],
    [4, 'system', undefined],
    [5, 'user', undefined],
    [6, 'agent', ['Edit']],
    [7, 'agent', undefined],
    [8, 'system', undefined],
  ])
  const [brief, tools, , check, resume] = impl.steps
  assert.match(brief.message, /^Create greet\.js/)
  assert.equal(tools.reasoning_content, 'The test imports greet from ./greet.js.')
  assert.deepEqual(tools.observation.results.map((r: Obj) => [r.source_call_id, r.extra]), [
    ['toolu_01', undefined], ['toolu_02', { is_error: true }],
  ])
  assert.equal(check.message, 'Acceptance check exited 1: node test.js')
  assert.match(resume.message, /^The acceptance check `node test.js` failed/)
  assert.deepEqual(resume.extra, { turn: 2, mode: 'resume', harness: 'claude', session_id: '3df9cda7-cba8-49aa-b743-232bec523140' })
  // Turn usage is per turn, so it sits on each turn's last agent step.
  assert.deepEqual(impl.steps.filter((s: Obj) => s.metrics).map((s: Obj) => [s.step_id, s.metrics]), [
    [3, { prompt_tokens: 4200, completion_tokens: 310, cached_tokens: 3000, cost_usd: 0.0123, extra: { scope: 'turn', cache_creation_input_tokens: 800 } }],
    [7, { prompt_tokens: 5100, completion_tokens: 120, cached_tokens: 4200, cost_usd: 0.0061, extra: { scope: 'turn', cache_creation_input_tokens: 300 } }],
  ])
  assert.equal(impl.final_metrics.total_steps, 8)
  assert.equal(impl.extra.status, 'completed')
})

test('a check node is a deterministic agent step and an interrupted node ends in system steps', () => {
  const verify = sub('verify')
  assert.equal(verify.steps.length, 1)
  assert.equal(verify.steps[0].llm_call_count, 0)
  assert.deepEqual(verify.steps[0].observation.results, [{ source_call_id: 'check', content: 'ok\n', extra: { exit_code: 0 } }])

  const docs = sub('docs')
  assert.equal(docs.agent.name, 'codex')
  assert.deepEqual(docs.steps.map((s: Obj) => [s.source, s.message]), [
    ['user', 'Document greet() in README.md.'],
    ['agent', ''],
    ['system', 'Turn 1 interrupted (SIGTERM): run cancelled by the person'],
    ['system', 'Node failed: interrupted before finishing'],
  ])
  assert.deepEqual(docs.steps[1].tool_calls[0].arguments, { input: 'cat README.md' })
  assert.equal(docs.extra.turns[0].error, 'no turn result: interrupted')
})

const harborPython = process.env.HARBOR_PYTHON ?? 'python3'
const hasHarbor = spawnSync(harborPython, ['-I', '-c', 'import harbor.utils.trajectory_validator']).status === 0

test('Harbor\'s validator accepts the ATIF document', { skip: !hasHarbor && 'Harbor not installed (set HARBOR_PYTHON)' }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'murm-atif-')), 'trajectory.json')
  writeFileSync(file, JSON.stringify(toAtif(loadRun(RUN_DIR, parseTurn))))
  const out = spawnSync(harborPython, ['-I', '-m', 'harbor.utils.trajectory_validator', file], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stdout + out.stderr)
})
