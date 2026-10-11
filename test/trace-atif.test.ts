import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
// The lead fixture: the top-level lead `lead` gets its brief, spawns `impl` (work) and `docs` (lead), notes a fact
// and answers. `docs` spawns `readme` (work), has a `complete` refused while readme runs, and answers. impl
// completes; while the lead answers that delivery, the person interrupts it, it cancels docs (readme's turn is
// stopped), a queued delivery of docs' failure follows, and the lead completes the run.
const LEAD_RUN_DIR = join(import.meta.dirname, 'fixtures', 'lead-run')
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

test('Harbor\'s validator accepts the ATIF documents', { skip: !hasHarbor && 'Harbor not installed (set HARBOR_PYTHON)' }, () => {
  for (const dir of [RUN_DIR, LEAD_RUN_DIR]) {
    const file = join(mkdtempSync(join(tmpdir(), 'murm-atif-')), 'trajectory.json')
    writeFileSync(file, JSON.stringify(toAtif(loadRun(dir, parseTurn))))
    const out = spawnSync(harborPython, ['-I', '-m', 'harbor.utils.trajectory_validator', file], { encoding: 'utf8' })
    assert.equal(out.status, 0, `${dir}: ${out.stdout}${out.stderr}`)
  }
})

test('a turn with no parsed items keeps its usage as step metrics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murm-atif-'))
  cpSync(RUN_DIR, dir, { recursive: true })
  const file = join(dir, 'nodes', 'impl', 'turn-1.jsonl')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), items: [] }))
  const out = toAtif(loadRun(dir, parseTurn)) as Obj
  assert.deepEqual(checkAtif(out), [])
  const impl = out.subagent_trajectories.find((t: Obj) => t.trajectory_id === `${out.session_id}/impl`)
  const prompt = impl.steps.filter((s: Obj) => s.metrics).reduce((n: number, s: Obj) => n + s.metrics.prompt_tokens, 0)
  assert.equal(prompt, impl.final_metrics.total_prompt_tokens)
})

const leadDoc = toAtif(loadRun(LEAD_RUN_DIR, parseTurn)) as Obj
const trajectories = (t: Obj): Obj[] => (t.subagent_trajectories ?? []).flatMap((s: Obj) => [s, ...trajectories(s)])
const leadSub = (node: string): Obj => trajectories(leadDoc).find((t) => t.trajectory_id === `lead-run/${node}`)!

test('the lead run\'s ATIF document passes the strict checker', () => {
  assert.deepEqual(checkAtif(leadDoc), [])
})

test('spawned nodes nest under their lead and are referenced from the spawn step', () => {
  const tree = (t: Obj): unknown => [t.trajectory_id, ...(t.subagent_trajectories ?? []).map(tree)]
  assert.deepEqual(tree(leadDoc), ['lead-run', ['lead-run/lead', ['lead-run/impl'], ['lead-run/docs', ['lead-run/readme']]]])
  const refs = (t: Obj) => t.steps.flatMap((s: Obj) => (s.observation?.results ?? [])
    .flatMap((r: Obj) => (r.subagent_trajectory_ref ?? []).map((ref: Obj) => [s.tool_calls[0].function_name, ref.trajectory_id])))
  assert.deepEqual(refs(leadDoc), [['run_node', 'lead-run/lead']])
  assert.deepEqual(refs(leadSub('lead')), [['spawn', 'lead-run/impl'], ['spawn', 'lead-run/docs']])
  assert.deepEqual(refs(leadSub('docs')), [['spawn', 'lead-run/readme']])
})

test('a lead trajectory has its deliveries, tool calls and answers in event order', () => {
  const lead = leadSub('lead')
  assert.deepEqual(lead.agent, { name: 'murmuration-lead', version: '0.0.0', model_name: 'ollama-cloud/deepseek-v4.1-flash' })
  assert.deepEqual(lead.steps.map((s: Obj) => [s.source, s.tool_calls?.[0].function_name ?? s.message, s.extra?.request_id, s.extra?.mode]), [
    ['user', 'Your brief: Add greet() with user docs', 'lead:brief', 'queue'],
    ['agent', 'spawn', undefined, undefined],
    ['agent', 'note', undefined, undefined],
    ['agent', 'Split into impl and docs.', 'lead:brief', undefined],
    ['user', 'Child impl completed: Added greet.js', 'evt-17', 'queue'],
    ['user', 'Message from person: Drop the docs; the README is generated elsewhere.', 'evt-19', 'interrupt'],
    ['agent', 'cancel', undefined, undefined],
    ['user', 'Child docs failed: cancelled by lead', 'evt-21', 'queue'],
    ['agent', 'Cancelled docs as the person asked.', 'evt-17', undefined],
    ['agent', 'complete', undefined, undefined],
    ['agent', 'Completed.', 'evt-21', undefined],
  ])
  const [, spawn, note] = lead.steps
  assert.deepEqual(note.tool_calls, [{ tool_call_id: 'call_2', function_name: 'note', arguments: { text: 'greet.js is an ES module.' } }])
  assert.deepEqual(note.observation.results, [{ source_call_id: 'call_2', content: 'Noted.' }])
  assert.deepEqual(spawn.tool_calls[0].arguments.children.map((c: Obj) => c.id), ['impl', 'docs'])
  // Tool calls are model output: no llm_call_count 0, and the answer's usage sits only on its lead.turn step.
  assert.ok(lead.steps.every((s: Obj) => s.llm_call_count === undefined))
  assert.deepEqual(lead.steps.filter((s: Obj) => s.metrics).map((s: Obj) => [s.step_id, s.model_name, s.metrics.prompt_tokens]), [
    [4, 'ollama-cloud/deepseek-v4.1-flash', 1200], [9, 'ollama-cloud/deepseek-v4.1-flash', 1500], [11, 'ollama-cloud/deepseek-v4.1-flash', 1600],
  ])
  assert.deepEqual([lead.extra.status, lead.extra.outcome], ['completed', 'greet() added; docs dropped at the person\'s request.'])
  // A lead's totals include its subtree, like the root's.
  assert.equal(lead.final_metrics.total_prompt_tokens, 1200 + 1500 + 1600 + 800 + 3000)
  assert.deepEqual(leadDoc.final_metrics, { ...lead.final_metrics, total_steps: 3 })
})

test('a refused lead call records its result with ok false and changes nothing', () => {
  const docs = leadSub('docs')
  const refused = docs.steps.find((s: Obj) => s.tool_calls?.[0].function_name === 'complete')
  assert.deepEqual(refused.observation.results, [{ source_call_id: 'call_d2', content: 'Refused: child readme is pending or running.', extra: { ok: false } }])
  assert.equal(docs.extra.outcome, 'cancelled by lead')
})

test('a cancelled subtree ends each unfinished node with a system step and a failure', () => {
  const docs = leadSub('docs')
  const readme = leadSub('readme')
  assert.deepEqual(docs.steps.at(-1), { step_id: 5, timestamp: '2026-10-11T11:00:18.000Z', source: 'system', message: 'Node cancelled by lead', extra: { cancelled_node: 'docs', by: 'lead' } })
  assert.deepEqual(readme.steps.map((s: Obj) => [s.source, s.message]), [
    ['user', 'Add a greet() section to README.md.\n\nNotes:\n- greet.js is an ES module.'],
    ['agent', ''],
    ['system', 'Node\'s ancestor docs cancelled by lead'],
    ['system', 'Turn 1 interrupted (SIGTERM): cancelled by lead'],
  ])
  for (const t of [docs, readme]) assert.deepEqual([t.extra.status, t.extra.cancelled_by], ['failed', 'lead'])
  assert.equal(leadSub('impl').extra.status, 'completed')
})

test('a cancellation by the person comes from node.cancelled, and the lead\'s later cancel call changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murm-atif-'))
  cpSync(LEAD_RUN_DIR, dir, { recursive: true })
  const file = join(dir, 'events.jsonl')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  lines.splice(20, 0, JSON.stringify({ seq: 99, at: '2026-10-11T11:00:17.000Z', type: 'node.cancelled', node: 'docs', by: 'person' }))
  writeFileSync(file, lines.join('\n') + '\n')
  const out = toAtif(loadRun(dir, parseTurn)) as Obj
  assert.deepEqual(checkAtif(out), [])
  const docs = trajectories(out).find((t) => t.trajectory_id.endsWith('/docs'))!
  const readme = trajectories(out).find((t) => t.trajectory_id.endsWith('/readme'))!
  assert.deepEqual(docs.steps.filter((s: Obj) => s.source === 'system').map((s: Obj) => s.message), ['Node cancelled by person'])
  assert.deepEqual(readme.steps.filter((s: Obj) => s.source === 'system').map((s: Obj) => s.message), [
    'Node\'s ancestor docs cancelled by person', 'Turn 1 interrupted (SIGTERM): cancelled by lead',
  ])
  assert.equal(readme.extra.outcome, 'cancelled by person')
})
