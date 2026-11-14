// Leads on a CLI harness through real `sous` processes (fake harness): the fallback when no lead provider has a
// credential, the refusal of a harness not certified to lead, and recovery of lead turns after a SIGKILLed supervisor.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fold, readEvents } from '../src/run/index.ts'
import type { Event, LeadCall } from '../src/contracts/index.ts'
import { gitWorkspace } from './helpers/git-repo.ts'
import { fakePlan } from './helpers/fake-adapter.ts'
import type { FakeStep } from './helpers/fake-worker.ts'
import { runDirOf, sous, waitFor } from './helpers/sous-proc.ts'

const CRASH = new URL('./helpers/crash-supervisor.ts', import.meta.url).pathname

const lead = (answer: string, ...calls: LeadCall[]): FakeStep => ({ lead: { answer, calls } })
const work = (id: string) => ({ id, kind: 'work' as const, brief: `Write ${id}.txt.\n${fakePlan([{ write: { [`${id}.txt`]: id }, result: { status: 'done', summary: `wrote ${id}` } }])}` })
const split = (...ids: string[]): LeadCall => ({ tool: 'spawn', children: [...ids.map(work), { id: 'check', kind: 'check', command: ids.map((i) => `test -f ${i}.txt`).join(' && '), needs: ids }] })
/** The lead's steps after its split: whatever the outcomes' coalescing, the third turn completes. */
const AFTER: FakeStep[] = [lead('Waiting.'), lead('Done.', { tool: 'complete', summary: 'split and checked' })]
/** A graph whose one lead plays `steps` (a goal would put the lead's plan in every worker's brief too). */
const graph = (workspace: string, steps: FakeStep[]) => {
  const file = join(workspace, 'graph.json')
  writeFileSync(file, JSON.stringify({ goal: 'Write the files.', nodes: [{ id: 'lead', kind: 'lead', brief: `Write the files.\n${fakePlan(steps)}` }] }))
  return file
}

function setup() {
  const workspace = gitWorkspace('sous-harness-lead-cli-')
  return { workspace, sessions: join(workspace, 'sessions') }
}
const leadCalls = (events: Event[]) => events.flatMap((e) => (e.type === 'lead.call' && e.node === 'lead' ? [[e.callId, e.call.tool, e.ok] as const] : []))
const leadPrompts = (sessions: string, runDir: string): string[] => {
  const session = fold(readEvents(runDir)).nodes.get('lead')!.turns.find((t) => t.sessionId)!.sessionId!
  return JSON.parse(readFileSync(join(sessions, `${session}.json`), 'utf8')).prompts
}
/** Waits until the lead's fake harness turn `turn` has taken its prompt. */
async function leadTurnRuns(workspace: string, sessions: string, turn: number) {
  const e = await waitFor(workspace, (e) => e.type === 'turn.session' && e.node === 'lead' && e.turn === turn)
  const file = join(sessions, `${e.type === 'turn.session' ? e.sessionId : ''}.json`)
  for (let i = 0; i < 200; i++) {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).prompts.length >= turn) return
    } catch {}
    await sleep(25)
  }
  throw new Error(`lead turn ${turn} did not start`)
}

test('with no lead credential, sous run leads on the first lead-certified harness on PATH, on its small model, and says so', async () => {
  const { workspace, sessions } = setup()
  process.env.FAKE_LEAD_CREDENTIALS = ''
  const run = sous(['run', graph(workspace, [lead('Split.', split('a')), ...AFTER])], workspace, sessions)
  delete process.env.FAKE_LEAD_CREDENTIALS
  assert.equal(await run.exitWithin(), 0, run.output())
  assert.match(run.output(), /^agents: .*\blead \(haiku on claude: no lead provider had a credential\)/m)
  const events = readEvents(runDirOf(workspace)!)
  const created = events[0]
  assert.ok(created.type === 'run.created' && created.leadRuns === 'claude' && created.leadModel === 'haiku', JSON.stringify(created))
  assert.ok(events.filter((e) => e.type === 'turn.started' && e.node === 'lead').every((e) => e.type === 'turn.started' && e.harness === 'claude' && e.model === 'haiku'))
  assert.deepEqual(leadCalls(events), [['t1.0', 'spawn', true], ['t3.0', 'complete', true]])
  assert.equal(fold(events).status, 'completed')
})

test('a lead named on a harness not certified to lead is refused before the run starts, with how to certify it', async () => {
  const { workspace, sessions } = setup()
  const agents = join(workspace, 'agents.json')
  writeFileSync(agents, JSON.stringify({ agents: { lead: { runs: 'codex' } } }))
  const run = sous(['run', 'Plan it.', '--agents', agents], workspace, sessions)
  assert.equal(await run.exitWithin(), 1)
  assert.match(run.output(), /sous: node lead: agent lead runs codex, which is not certified to lead \(leads run on lead, or on claude\); a harness leads once its adapter has a lead mode and SOUS_HARNESS=codex npm run certify passes its lead tests/)
  assert.equal(runDirOf(workspace), undefined)
})

test('a lead turn cut short by a SIGKILLed supervisor applied nothing; sous resume runs it again with a note, and spawns once', async () => {
  const { workspace, sessions } = setup()
  process.env.FAKE_LEAD_CREDENTIALS = ''
  const run = sous(['run', graph(workspace, [{ say: 'Reading.', sleepMs: 60_000, ...lead('Never seen.', split('never')) }, lead('Split.', split('a')), ...AFTER])], workspace, sessions)
  delete process.env.FAKE_LEAD_CREDENTIALS
  await leadTurnRuns(workspace, sessions, 1)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const events = readEvents(runDir)
  const turns = fold(events).nodes.get('lead')!.turns
  assert.deepEqual(turns.slice(0, 2).map((t) => [t.interrupted?.reason, t.recovery, t.lead?.answer]), [
    ['still running when the run was resumed', undefined, undefined],
    [undefined, true, 'Split.'],
  ])
  assert.deepEqual(leadCalls(events), [['t2.0', 'spawn', true], ['t4.0', 'complete', true]])
  assert.equal(fold(events).nodes.has('never'), false)
  assert.match(leadPrompts(sessions, runDir)[1], /^Your turn 1 ended before its result: none of its calls were applied\. Continue from here\.\n\nYou are lead lead,/)
})

/** Runs `steps` as the lead on the fake harness until a step's `stopEarly` marker appears, then SIGKILLs the supervisor
 * and resumes the run to its end. Returns the events and the lead's turns. */
async function stoppedEarly(steps: FakeStep[], marker: string) {
  const { workspace, sessions } = setup()
  process.env.FAKE_LEAD_CREDENTIALS = ''
  const run = sous(['run', graph(workspace, steps)], workspace, sessions)
  delete process.env.FAKE_LEAD_CREDENTIALS
  for (let i = 0; i < 400 && !existsSync(marker); i++) await sleep(25)
  assert.ok(existsSync(marker), 'the lead turn never started')
  run.child.kill('SIGKILL')
  await run.exit
  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const events = readEvents(runDirOf(workspace)!)
  const prompts = (sessionId: string): string[] => JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), 'utf8')).prompts
  return { events, turns: fold(events).nodes.get('lead')!.turns, prompts, sessions }
}
const earlyMarker = () => join(mkdtempSync(join(tmpdir(), 'sous-early-')), 'stopped')

test('a lead turn killed before its harness saved the session: sous resume starts it again from its brief, and spawns once', async () => {
  const marker = earlyMarker()
  const { events, turns, prompts, sessions } = await stoppedEarly([{ stopEarly: marker, ...lead('Split.', split('a')) }, ...AFTER], marker)
  assert.equal(fold(events).status, 'completed')
  assert.deepEqual(turns.slice(0, 2).map((t) => [t.mode, t.interrupted?.reason, t.recovery, t.lead?.answer]), [
    ['start', 'still running when the run was resumed', undefined, undefined],
    ['start', undefined, true, 'Split.'],
  ])
  assert.ok(turns[1]!.sessionId && turns[1]!.sessionId !== turns[0]!.sessionId, 'a new session')
  assert.equal(existsSync(join(sessions, `${turns[0]!.sessionId}.json`)), false, 'the cut session was never saved')
  assert.deepEqual(leadCalls(events), [['t2.0', 'spawn', true], ['t4.0', 'complete', true]])
  // The brief, with no note about a turn the session never had.
  assert.match(prompts(turns[1]!.sessionId!)[0]!, /^You are lead lead,/)
})

test('a lead turn cut before it began after an earlier turn applied: sous resume continues that session with a note', async () => {
  const marker = earlyMarker()
  const { events, turns, prompts } = await stoppedEarly([
    lead('Split.', split('a')), { stopEarly: marker, ...lead('Waiting.') }, lead('Done.', { tool: 'complete', summary: 'split and checked' }),
  ], marker)
  assert.equal(fold(events).status, 'completed')
  assert.deepEqual(turns.slice(0, 3).map((t) => [t.mode, t.recovery, t.lead?.answer]), [
    ['start', undefined, 'Split.'], ['resume', undefined, undefined], ['resume', true, 'Waiting.'],
  ])
  assert.equal(new Set(turns.map((t) => t.sessionId)).size, 1, 'one session')
  assert.deepEqual(leadCalls(events).filter(([, tool]) => tool === 'spawn'), [['t1.0', 'spawn', true]])
  assert.match(prompts(turns[0]!.sessionId!)[1]!, /^Your turn 2 ended before its result: none of its calls were applied\.[\s\S]*Child a completed/)
})

test('a lead turn that finished while the supervisor was down is settled from its output, its calls applied once', async () => {
  const { workspace, sessions } = setup()
  process.env.FAKE_LEAD_CREDENTIALS = ''
  const run = sous(['run', graph(workspace, [{ sleepMs: 700, ...lead('Split.', split('a')) }, ...AFTER])], workspace, sessions)
  delete process.env.FAKE_LEAD_CREDENTIALS
  await leadTurnRuns(workspace, sessions, 1)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  const started = readEvents(runDir).find((e) => e.type === 'turn.started' && e.node === 'lead')!
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(started.type === 'turn.started' ? started.pid : 0, 0)
      await sleep(50)
    } catch {
      break
    }
  }

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const events = readEvents(runDir)
  const turn1 = fold(events).nodes.get('lead')!.turns[0]
  assert.equal(turn1.interrupted, undefined)
  assert.equal(turn1.lead?.answer, 'Split.')
  assert.deepEqual(leadCalls(events), [['t1.0', 'spawn', true], ['t3.0', 'complete', true]])
  assert.equal(leadPrompts(sessions, runDir).length, 3, 'the finished turn was not run again')
})

test('a supervisor killed between two calls of one lead turn: resume applies the rest once, and the run completes', async () => {
  const { workspace, sessions } = setup()
  // The lead names its harness agent explicitly here (no fallback needed).
  const two: LeadCall[] = [{ tool: 'note', text: 'Write plain text.' }, split('a', 'b')]
  const file = graph(workspace, [{ sleepMs: 700, ...lead('Split.', ...two) }, ...AFTER])
  const g = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...g, agents: { boss: { runs: 'claude', model: 'haiku' } }, nodes: [{ ...g.nodes[0], agent: 'boss' }] }))
  const run = sous(['run', file], workspace, sessions)
  await leadTurnRuns(workspace, sessions, 1)
  run.child.kill('SIGKILL')
  await run.exit
  const runDir = runDirOf(workspace)!
  await sleep(1500) // the turn finishes while no supervisor runs

  // A supervisor that settles the turn and is killed right after its first call is recorded.
  const crash = spawn(process.execPath, [CRASH, workspace, runDir, 'event', 'lead.call'], { stdio: 'ignore', env: { ...process.env, FAKE_SESSIONS: sessions } })
  await new Promise((resolve) => crash.on('exit', resolve))
  assert.deepEqual(leadCalls(readEvents(runDir)), [['t1.0', 'note', true]])

  const resumed = sous(['resume'], workspace, sessions)
  assert.equal(await resumed.exitWithin(), 0, resumed.output())
  const events = readEvents(runDir)
  assert.deepEqual(leadCalls(events), [['t1.0', 'note', true], ['t1.1', 'spawn', true], ['t3.0', 'complete', true]])
  assert.deepEqual(fold(events).nodes.get('lead')!.notes, ['Write plain text.'])
  assert.equal(events.filter((e) => e.type === 'lead.turn' && e.requestId === 'lead:brief').length, 1)
})
