// The conformance suite every harness passes without its real CLI: its recordings (test/fixtures/conformance/) parse as
// the supervisor needs, and its adapter drives a stand-in CLI as the supervisor needs. See test/conformance/harnesses.ts.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAdapter } from '../src/adapters/index.ts'
import { HARNESS_LEAD_ROLE } from '../src/prompts/index.ts'
import { fold, openLog, readEvents } from '../src/run/index.ts'
import { runSupervisor, stopGroup } from '../src/supervisor/index.ts'
import { HARNESSES, LEAD_HARNESSES } from '../src/contracts/index.ts'
import type { HarnessName, ParsedTurn, TurnSpec } from '../src/contracts/index.ts'
import { CONFORMANCE, certifiedUrl, LEAD_TESTS, NOTE, recording, recordingsOf, recordingUrl } from './conformance/harnesses.ts'
import { gitWorkspace } from './helpers/git-repo.ts'

const tempDir = () => mkdtempSync(join(realpathSync(tmpdir()), 'sous-conformance-'))
const MCP_SERVER = fileURLToPath(new URL('../src/mcp.ts', import.meta.url))

// Stand-ins for every harness CLI, first on PATH. Each records how it was started, then replays a recording
// (FAKE_REPLAY), or starts a long-lived child and waits (FAKE_HANG). Codex's adapter first lists the person's MCP servers.
const bin = tempDir()
const STAND_IN = `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === 'mcp') { console.log('[]'); process.exit(0) }
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const named = argv.filter((a) => { try { return fs.statSync(a).isFile() } catch { return false } }).map((f) => fs.readFileSync(f, 'utf8'))
  const env = Object.fromEntries(['SOUS_RUN_DIR', 'SOUS_NODE', 'SOUS_TURN'].filter((k) => k in process.env).map((k) => [k, process.env[k]]))
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, named, stdin, cwd: process.cwd(), env }))
  if (process.env.FAKE_REPLAY) process.stdout.write(fs.readFileSync(process.env.FAKE_REPLAY))
  if (process.env.FAKE_HANG) {
    const child = require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.FAKE_HANG, String(child.pid))
    setInterval(() => {}, 1000)
  }
})
`
for (const name of HARNESSES) writeFileSync(join(bin, name), STAND_IN, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
// A worker's identity must come from its turn alone, also when these tests run inside a sous worker.
for (const key of Object.keys(process.env)) if (key.startsWith('SOUS_')) delete process.env[key]

type Started = { argv: string[]; named: string[]; stdin: string; cwd: string; env: Record<string, string> }

/** Every tool call has exactly one result with its ID, after it. */
function assertPaired(turn: ParsedTurn) {
  turn.items.forEach((item, at) => {
    if (item.kind !== 'tool_call') return
    const results = turn.items.flatMap((r, i) => (r.kind === 'tool_result' && r.callId === item.id ? [i] : []))
    assert.equal(results.length, 1, `one result for call ${item.id}`)
    assert.ok(results[0]! > at, `the result of ${item.id} comes after it`)
  })
  assert.ok(turn.items.every((i) => i.kind !== 'tool_result' || turn.items.some((c) => c.kind === 'tool_call' && c.id === i.callId)), 'no result without a call')
}

for (const harness of HARNESSES) {
  const adapter = getAdapter(harness)
  const { endMarker, mcp } = CONFORMANCE[harness]

  describe(`${harness} conformance`, () => {
    test('has every recording', () => {
      for (const name of recordingsOf(harness)) assert.ok(existsSync(recordingUrl(harness, name)), `test/fixtures/conformance/${harness}/${name}.jsonl`)
    })

    test('lead: its session, its end, a lead result whose calls spawn work and a check, after reading the plan', { skip: !CONFORMANCE[harness].lead }, () => {
      const turn = adapter.parse(recording(harness, 'lead'))
      assert.ok(turn.sessionId)
      assert.equal(turn.ended, true)
      assert.equal(turn.result, undefined, 'a lead result is no worker result')
      assertPaired(turn)
      assert.ok(turn.items.some((i) => i.kind === 'tool_result' && i.content.includes('sub(a, b)') && !i.isError), 'a tool result holds the plan')
      const children = turn.lead!.calls.flatMap((c) => (c.tool === 'spawn' ? c.children : []))
      assert.ok(children.some((c) => c.kind === 'work' && c.brief) && children.some((c) => c.kind === 'check' && c.command), JSON.stringify(turn.lead))
      assert.ok(turn.usage && turn.usage.inputTokens > 0)
    })

    test('read-file: its session, its end, a done result, paired tool calls that read the note, usage and times', () => {
      const turn = adapter.parse(recording(harness, 'read-file'))
      assert.ok(turn.sessionId)
      assert.equal(turn.ended, true)
      assert.equal(turn.result?.status, 'done')
      assertPaired(turn)
      assert.ok(turn.items.some((i) => i.kind === 'tool_result' && i.content.includes(NOTE) && !i.isError), 'a tool result holds the note')
      const usage = turn.usage
      assert.ok(usage && usage.inputTokens > 0 && usage.outputTokens > 0, 'usage')
      assert.ok(usage.cachedTokens >= 0 && usage.cachedTokens <= usage.inputTokens, 'cached tokens are part of the input')
      for (const item of turn.items) if (item.at !== undefined) assert.ok(!Number.isNaN(Date.parse(item.at)), item.at)
    })

    test('needs-input: a needs_input result with a question (in question, else summary, as the supervisor asks)', () => {
      const turn = adapter.parse(recording(harness, 'needs-input'))
      assert.equal(turn.ended, true)
      assert.equal(turn.result?.status, 'needs_input')
      assert.ok((turn.result!.question ?? turn.result!.summary).includes('?'))
    })

    test('stopped: no end marker and no result, but its session is known, so it can be resumed', () => {
      const turn = adapter.parse(recording(harness, 'stopped'))
      assert.equal(turn.ended, false)
      assert.equal(turn.result, undefined)
      assert.ok(turn.sessionId)
      const system = turn.items.flatMap((i) => (i.kind === 'message' && i.role === 'system' ? [i.text] : []))
      assert.equal(new Set(system).size, system.length, 'no error is told twice')
    })

    test('any cut of a recording parses: ended only from its end marker, the session never changes, tool calls only accumulate', () => {
      for (const name of recordingsOf(harness)) {
        const raw = recording(harness, name)
        const full = adapter.parse(raw)
        const lines = raw.split('\n')
        const markers = lines.flatMap((l, i) => {
          try {
            return JSON.parse(l).type === endMarker ? [i] : []
          } catch {
            return []
          }
        })
        if (name !== 'stopped') assert.ok(markers.length, `${name} has its end marker ${endMarker}`)
        let ended = false
        let calls = new Set<string>()
        for (let k = 0; k <= lines.length; k++) {
          const whole = lines.slice(0, k).join('\n')
          const cuts = [whole, ...(k < lines.length && lines[k]!.length > 2 ? [`${whole}${k ? '\n' : ''}${lines[k]!.slice(0, lines[k]!.length >> 1)}`] : [])]
          for (const [c, cut] of cuts.entries()) {
            const turn = adapter.parse(cut)
            const where = `${name} cut at line ${k}${c ? ' (mid-line)' : ''}`
            if (c === 0) {
              if (ended) assert.equal(turn.ended, true, `${where}: still ended`)
              ended = turn.ended
              if (markers.length && k <= markers[0]!) assert.equal(turn.ended, false, `${where}: ended before its end marker`)
              if (markers.length && k > markers.at(-1)!) assert.equal(turn.ended, full.ended, `${where}: ended after its end marker`)
            } else if (!ended) assert.equal(turn.ended, false, `${where}: ended mid-line`)
            if (!turn.ended) assert.equal(turn.result, undefined, `${where}: a result before the end`)
            if (!turn.ended) assert.equal(turn.lead, undefined, `${where}: a lead result before the end`)
            if (turn.sessionId !== undefined) assert.equal(turn.sessionId, full.sessionId, `${where}: session`)
            const now = new Set(turn.items.flatMap((i) => (i.kind === 'tool_call' ? [i.id] : [])))
            if (c === 0) {
              for (const id of calls) assert.ok(now.has(id), `${where}: call ${id} disappeared`)
              calls = now
            }
          }
        }
      }
    })

    const turnSpec = (cwd: string, extra: Partial<TurnSpec> = {}): TurnSpec => ({
      nodeId: 'n', turn: 1, cwd, prompt: 'Do the task.\nSecond line.', outFile: join(cwd, 'out', 'turn-1.jsonl'), errFile: join(cwd, 'out', 'turn-1.err'), ...extra,
    })
    const standIn = async (start: (spec: TurnSpec) => ReturnType<typeof adapter.start>, extra: Partial<TurnSpec>, replay?: string) => {
      const cwd = tempDir()
      const spec = turnSpec(cwd, extra)
      process.env.FAKE_RECORD = join(cwd, 'started.json')
      if (replay) process.env.FAKE_REPLAY = replay
      else delete process.env.FAKE_REPLAY
      const running = start(spec)
      const exit = await running.exit
      return { cwd, spec, running, exit, started: JSON.parse(readFileSync(join(cwd, 'started.json'), 'utf8')) as Started }
    }
    const mcpServers = (s: Started) => [...s.argv, ...s.named].join('\n').split(MCP_SERVER).length - 1

    test('a stand-in CLI runs in the turn\'s directory, gets the whole prompt, and its output reaches the turn\'s file', async () => {
      const replay = fileURLToPath(recordingUrl(harness, 'read-file'))
      const { cwd, spec, running, exit, started } = await standIn((s) => adapter.start(s), { model: 'model-x7' }, replay)
      assert.equal(exit.code, 0)
      assert.equal(started.cwd, cwd)
      assert.ok(started.stdin.includes(spec.prompt) || started.argv.some((a) => a.includes(spec.prompt)), 'the whole prompt')
      assert.ok(started.argv.includes('model-x7'), 'the model')
      assert.equal(readFileSync(spec.outFile, 'utf8'), readFileSync(replay, 'utf8'))
      assert.ok(existsSync(spec.errFile))
      assert.ok(await running.sessionId, 'the session')
      assert.deepEqual(adapter.parse(readFileSync(spec.outFile, 'utf8')).result, adapter.parse(readFileSync(replay, 'utf8')).result)
    })

    test(`a worker of the tree gets its identity${mcp ? ' and sous\'s MCP server once' : ''}; a standing node gets neither`, async () => {
      const env = { SOUS_RUN_DIR: '/run', SOUS_NODE: 'n', SOUS_TURN: '1' }
      const worker = (await standIn((s) => adapter.start(s), { env })).started
      assert.deepEqual(worker.env, env)
      assert.equal(mcpServers(worker), mcp ? 1 : 0)
      const standing = (await standIn((s) => adapter.start(s), {})).started
      assert.deepEqual(standing.env, {})
      assert.equal(mcpServers(standing), 0)
    })

    test('a lead turn gets the role, the prompt and the model, and neither an identity nor an MCP server; resume names the session', { skip: !adapter.lead }, async () => {
      const lead = { system: HARNESS_LEAD_ROLE }
      for (const [k, start] of [(s: TurnSpec) => adapter.start(s), (s: TurnSpec) => adapter.resume({ ...s, sessionId: 'session-l3' })].entries()) {
        const { spec, started } = await standIn(start, { lead, model: 'model-x7' })
        const all = [...started.argv, ...started.named, started.stdin].join('\n')
        assert.ok(started.stdin.includes(spec.prompt), 'the whole prompt')
        if (k === 0) assert.ok(all.includes(HARNESS_LEAD_ROLE), 'the role')
        else assert.ok(started.argv.includes('session-l3'))
        assert.ok(started.argv.includes('model-x7'), 'the model')
        assert.deepEqual(started.env, {})
        assert.equal(mcpServers(started), 0)
      }
    })

    test('resume names the session it continues; a turn that exits silently settles its session promise', async () => {
      const { started, running } = await standIn((s) => adapter.resume({ ...s, sessionId: 'session-r9' }), {})
      assert.ok(started.argv.includes('session-r9'))
      // Whether it resolves (an ID given up front) or rejects (none was printed), it must settle once the turn exits.
      const settled = await Promise.race([running.sessionId.then(() => true, () => true), sleep(5000).then(() => false)])
      assert.ok(settled)
    })

    test('stopping the turn\'s group stops what its CLI started', async () => {
      const cwd = tempDir()
      const pidFile = join(cwd, 'child.pid')
      process.env.FAKE_RECORD = join(cwd, 'started.json')
      process.env.FAKE_HANG = pidFile
      delete process.env.FAKE_REPLAY
      try {
        const running = adapter.start(turnSpec(cwd))
        for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50)
        const child = Number(readFileSync(pidFile, 'utf8'))
        await stopGroup(running.pid, 1000)
        await running.exit
        assert.throws(() => process.kill(child, 0), 'the child is gone')
      } finally {
        delete process.env.FAKE_HANG
      }
    })

    test('the supervisor completes a work node with this adapter', async () => {
      const workspace = gitWorkspace('sous-conformance-')
      const runDir = join(workspace, 'run')
      mkdirSync(runDir)
      const log = openLog(runDir)
      log.append({ type: 'run.created', goal: 'conformance', workspace })
      log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'Read the note.', agent: harness }, by: 'graph' })
      log.close()
      const replay = fileURLToPath(recordingUrl(harness, 'read-file'))
      process.env.FAKE_RECORD = join(workspace, 'started.json')
      process.env.FAKE_REPLAY = replay
      const outcome = await runSupervisor({ workspace, runDir, getAdapter: (h: HarnessName) => getAdapter(h), graceMs: 500 })
      const events = readEvents(runDir)
      assert.equal(outcome, 'completed')
      assert.equal(fold(events).nodes.get('w')!.status, 'completed')
      const ended = events.find((e) => e.type === 'turn.ended')
      assert.deepEqual(ended?.type === 'turn.ended' && ended.result, adapter.parse(readFileSync(replay, 'utf8')).result)
      assert.ok(events.some((e) => e.type === 'turn.session' && e.node === 'w'))
    })

    test('a turn cut before its harness had a conversation starts again in a new session on resume; one cut after output resumes it', async () => {
      const raw = recording(harness, 'stopped')
      const lines = raw.split('\n')
      // The stopped recording up to the line that names its session: what a turn stopped in its first moments leaves.
      const named = lines.findIndex((_, i) => adapter.parse(lines.slice(0, i + 1).join('\n')).sessionId)
      const sessionId = adapter.parse(raw).sessionId!
      for (const [cut, resumes] of [[`${lines.slice(0, named + 1).join('\n')}\n`, false], [raw, true]] as const) {
        const workspace = gitWorkspace('sous-conformance-')
        const runDir = join(workspace, 'run')
        const dir = join(runDir, 'nodes', 'w')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'turn-1.jsonl'), cut)
        const log = openLog(runDir)
        log.append({ type: 'run.created', goal: 'conformance', workspace })
        log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'Read the note.', agent: harness }, by: 'graph' })
        // A turn the stopped supervisor left open; no process runs it any more.
        log.append({ type: 'turn.started', node: 'w', turn: 1, mode: 'start', harness, pid: 1, outFile: join(dir, 'turn-1.jsonl'), errFile: join(dir, 'turn-1.err') })
        log.append({ type: 'turn.session', node: 'w', turn: 1, sessionId })
        log.close()
        process.env.FAKE_RECORD = join(workspace, 'started.json')
        process.env.FAKE_REPLAY = fileURLToPath(recordingUrl(harness, 'read-file'))
        const outcome = await runSupervisor({ workspace, runDir, resume: true, getAdapter: (h: HarnessName) => getAdapter(h), graceMs: 500 })
        const w = fold(readEvents(runDir)).nodes.get('w')!
        const where = resumes ? 'cut after output' : 'cut before output'
        assert.equal(outcome, 'completed', where)
        assert.deepEqual(w.turns.map((t) => [t.mode, t.recovery ?? false]), [['start', false], [resumes ? 'resume' : 'start', true]], where)
        const started = JSON.parse(readFileSync(join(workspace, 'started.json'), 'utf8')) as Started
        assert.equal(started.argv.includes(sessionId), resumes, `${where}: the old session is ${resumes ? '' : 'not '}named`)
        if (!resumes) assert.notEqual(w.turns[1]!.sessionId, sessionId, 'a new session')
      }
    })
  })
}

describe('leading', () => {
  test('every harness that may lead has a lead mode, a lead recording and a certification that passed the lead tests', () => {
    for (const harness of LEAD_HARNESSES) {
      assert.equal(getAdapter(harness).lead, true, `${harness} has a lead mode`)
      assert.equal(CONFORMANCE[harness].lead, true, `${harness} has a lead recording`)
      const certified = JSON.parse(readFileSync(certifiedUrl(harness), 'utf8')) as { passed: string[]; failed: string[] }
      for (const name of LEAD_TESTS) assert.ok(certified.passed.includes(name), `${harness}'s certified.json lists "${name}" as passed`)
    }
  })

  test('a harness without a lead mode refuses a lead turn rather than run one that could change files', () => {
    for (const harness of HARNESSES.filter((h) => !getAdapter(h).lead)) {
      const cwd = tempDir()
      assert.throws(() => getAdapter(harness).start({ nodeId: 'l', turn: 1, cwd, prompt: 'p', outFile: join(cwd, 'o.jsonl'), errFile: join(cwd, 'o.err'), lead: { system: 'role' } }), /cannot run a lead turn/)
    }
  })
})
