// Live certification: what every harness must do with its real CLI before it merges to main. Costs money; runs only with
// SOUS_CERTIFY=1 (`npm run certify`), never as part of `npm run check`. SOUS_HARNESS=droid,pi limits it to some harnesses; SOUS_RECORD=1 also rewrites the
// recordings the free suite reads (test/fixtures/conformance/). Every run writes test/fixtures/conformance/<harness>/certified.json:
// the CLI version, model, date and the tests that passed, for the PR and for scripts/harness-versions.sh.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAdapter } from '../src/adapters/index.ts'
import { childError } from '../src/definitions/index.ts'
import { HARNESS_LEAD_ROLE } from '../src/prompts/index.ts'
import { fold, readEvents } from '../src/run/index.ts'
import { stopGroup } from '../src/supervisor/index.ts'
import { HARNESSES } from '../src/contracts/index.ts'
import type { ChildSpec, Event, HarnessName, ParsedTurn, RunningTurn, TurnSpec } from '../src/contracts/index.ts'
import { CONFORMANCE, LEAD_PROMPT, LEAD_TESTS, NEEDS_INPUT_PROMPT, NOTE, PLAN, READ_FILE_PROMPT, certifiedUrl, recordingUrl } from './conformance/harnesses.ts'
import type { Recording } from './conformance/harnesses.ts'
import { git, gitWorkspace } from './helpers/git-repo.ts'

const live = process.env.SOUS_CERTIFY === '1'
const record = process.env.SOUS_RECORD === '1'
const only = process.env.SOUS_HARNESS?.split(',').map((h) => h.trim()).filter(Boolean)
const unknown = only?.filter((h) => !(HARNESSES as readonly string[]).includes(h))
if (live && unknown?.length) throw new Error(`SOUS_HARNESS names no harness: ${unknown.join(', ')} (harnesses: ${HARNESSES.join(', ')})`)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const MINUTES = 60_000

/** Recordings are committed: the person's home directory must not be in them. */
const scrubHome = (raw: string) => {
  const home = homedir()
  if (home === '/') return raw
  // Claude names a project's directory under .claude/projects and /tmp/claude-<uid> after its path, with `-` for `/`.
  const dashed = new RegExp(`(?<=/)${home.replaceAll('/', '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[-/"])`, 'g')
  return raw.replaceAll(home, '/home/user').replace(dashed, '-home-user')
}

const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `sous-certify-${name}-`))
const codeword = () => randomBytes(4).toString('hex').toUpperCase()

/** A shell command only this test runs, so its process can be found: `./hold.sh <n>` execs `sleep <n>`, n in [from, to). */
function holdScript(dir: string, from = 300, to = 900): number {
  writeFileSync(join(dir, 'hold.sh'), '#!/bin/sh\nexec sleep "$1"\n', { mode: 0o755 })
  return from + Math.floor(Math.random() * (to - from))
}
function sleeping(n: number): boolean {
  try {
    execFileSync('pgrep', ['-f', `^sleep ${n}$`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (check()) return true
  return check()
}

for (const harness of HARNESSES.filter((h) => !only?.length || only.includes(h))) {
  const { liveModel, mcp } = CONFORMANCE[harness]
  const adapter = getAdapter(harness)
  const spec = (cwd: string, turn: number, prompt: string): TurnSpec => ({
    nodeId: 'certify', turn, cwd, prompt, model: liveModel,
    outFile: join(cwd, '.turns', `turn-${turn}.jsonl`), errFile: join(cwd, '.turns', `turn-${turn}.err`),
  })
  const parsed = (s: TurnSpec): ParsedTurn => adapter.parse(readFileSync(s.outFile, 'utf8'))
  const finished = async (running: RunningTurn, s: TurnSpec) => {
    const exit = await running.exit
    const turn = parsed(s)
    assert.equal(exit.code, 0, `exit ${JSON.stringify(exit)}; see ${s.outFile} and ${s.errFile}`)
    assert.equal(turn.ended, true, `no end marker; see ${s.outFile}`)
    assert.ok(turn.result, `no parsable result; see ${s.outFile}`)
    assert.ok(turn.usage && turn.usage.inputTokens > 0, 'usage is reported')
    return turn
  }
  const keep = (s: TurnSpec, name: Recording) => {
    const to = fileURLToPath(recordingUrl(harness, name))
    // The lead recording is written when it is missing too: a harness's first lead certification makes it.
    if (!record && !(name === 'lead' && !existsSync(to))) return
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, scrubHome(readFileSync(s.outFile, 'utf8')))
  }
  /** Start a turn that learns a codeword and then runs a long command; resolves once the command runs. */
  const midCommand = async (cwd: string, word: string) => {
    const n = holdScript(cwd)
    const s = spec(cwd, 1, `The codeword is ${word}. Remember it. Now run the shell command \`./hold.sh ${n}\` in the ` +
      'foreground and wait for it to finish, then finish with status done.')
    const running = adapter.start(s)
    assert.ok(await until(() => sleeping(n), 4 * MINUTES), `the command never ran; see ${s.outFile}`)
    await sleep(2000)
    assert.equal(parsed(s).ended, false, 'the turn ended before it was stopped')
    return { n, s, running }
  }
  const recalls = async (cwd: string, sessionId: string, word: string, turn: number) => {
    const s = spec(cwd, turn, 'You were stopped while you worked. What is the codeword I gave you? Do not use any tools. ' +
      'Finish with status done and the codeword alone as the summary.')
    const resumed = adapter.resume({ ...s, sessionId })
    assert.match((await finished(resumed, s)).result!.summary, new RegExp(word))
  }

  describe(`${harness} certification`, { skip: !live }, () => {
    const passed: string[] = []
    const failed: string[] = []
    afterEach((t) => void ((t as { passed?: boolean }).passed ? passed : failed).push(t.name))
    after(() => {
      let version = 'unknown'
      try {
        version = execFileSync(harness, ['--version'], { encoding: 'utf8' }).trim()
      } catch {}
      const file = fileURLToPath(certifiedUrl(harness))
      mkdirSync(dirname(file), { recursive: true })
      const certified = { cli: harness, version, model: liveModel ?? 'harness default', date: new Date().toISOString().slice(0, 10), passed, failed }
      writeFileSync(file, `${JSON.stringify(certified, null, 2)}\n`)
    })

    test('reads a file with one paired tool call and ends done', { timeout: 10 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      writeFileSync(join(cwd, 'note.txt'), `${NOTE}\n`)
      const s = spec(cwd, 1, READ_FILE_PROMPT)
      const turn = await finished(adapter.start(s), s)
      assert.equal(turn.result!.status, 'done')
      const read = turn.items.find((i) => i.kind === 'tool_result' && i.content.includes(NOTE))
      assert.ok(read?.kind === 'tool_result' && turn.items.some((i) => i.kind === 'tool_call' && i.id === read.callId), 'a tool read the note')
      keep(s, 'read-file')
    })

    test('ends needs_input with a question', { timeout: 10 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      const s = spec(cwd, 1, NEEDS_INPUT_PROMPT)
      const turn = await finished(adapter.start(s), s)
      assert.equal(turn.result!.status, 'needs_input')
      // The supervisor asks the parent `question`, else `summary`.
      assert.ok((turn.result!.question ?? turn.result!.summary).includes('?'), 'a question')
      keep(s, 'needs-input')
    })

    test('a resumed session, resumed again, remembers the first turn', { timeout: 15 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      const word = codeword()
      const first = spec(cwd, 1, `Remember this codeword for later: ${word}. Do not use any tools. Finish with status done and summary "noted".`)
      const started = adapter.start(first)
      const one = await finished(started, first)
      assert.equal(one.sessionId, await started.sessionId)
      let sessionId = one.sessionId!
      for (const turn of [2, 3]) {
        const s = spec(cwd, turn, 'What is the codeword I gave you? Do not use any tools. Finish with status done and the codeword alone as the summary.')
        const resumed = adapter.resume({ ...s, sessionId })
        const done = await finished(resumed, s)
        assert.equal(done.sessionId, await resumed.sessionId, 'the turn reports the session it ran in')
        assert.match(done.result!.summary, new RegExp(word))
        sessionId = done.sessionId!
      }
    })

    test('stopped mid-command by the supervisor: no result, nothing left running, and the session resumes', { timeout: 15 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      const word = codeword()
      const { n, s, running } = await midCommand(cwd, word)
      await stopGroup(running.pid, 5000)
      await running.exit
      assert.ok(await until(() => !sleeping(n), 5000), 'the command outlived the stopped turn')
      const turn = parsed(s)
      assert.equal(turn.ended, false)
      assert.equal(turn.result, undefined)
      assert.ok(turn.sessionId, 'a stopped turn still names its session')
      keep(s, 'stopped')
      await recalls(cwd, turn.sessionId!, word, 2)
    })

    test('killed mid-command: the session resumes', { timeout: 15 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      const word = codeword()
      const { n, s, running } = await midCommand(cwd, word)
      process.kill(-running.pid, 'SIGKILL')
      await running.exit
      // What a killed harness leaves running is the supervisor's to stop (`sous resume`); this test only cleans up.
      if (!(await until(() => !sleeping(n), 5000))) execFileSync('pkill', ['-f', `^sleep ${n}$`])
      const sessionId = parsed(s).sessionId
      assert.ok(sessionId, 'a killed turn still names its session')
      await recalls(cwd, sessionId, word, 2)
    })

    test('two siblings settle a name through sous; no project MCP server starts', { timeout: 20 * MINUTES }, async () => {
      const workspace = gitWorkspace(`sous-certify-${harness}-`)
      const marker = join(tempDir(harness), 'canary-started')
      projectMcpCanary(workspace, marker)
      commit(workspace)
      const graph = writeGraph(harness, liveModel, [
        { id: 'a', kind: 'work', agent: 'worker', brief: 'Write a file named alpha.txt containing the word alpha and commit it. Then ' +
          'tell your sibling b, with send, exactly: the file is alpha.txt. Do not wait for an answer.' },
        { id: 'b', kind: 'work', agent: 'worker', brief: 'Wait up to 60 seconds with receive for a message from your sibling a. It names a ' +
          'file. Write a file named b.txt whose content is that file name, and commit it.' },
        { id: 'both', kind: 'check', needs: ['a', 'b'], command: 'test -f alpha.txt && grep -q alpha.txt b.txt' },
      ])
      const run = await sous(['run', graph], workspace, 18 * MINUTES)
      assert.equal(run.code, 0, run.output)
      const runDir = runDirOf(run.output)
      const events = readEvents(runDir)
      assert.equal(fold(events).status, 'completed')
      assert.ok(events.some((e) => e.type === 'message' && e.from === 'a' && e.to === 'b' && e.sent), 'a sent to b while it worked')
      if (mcp) {
        // Through sous's MCP tool, not the `sous send` command every worker also has.
        const turns = events.flatMap((e) => (e.type === 'turn.started' && e.node === 'a' ? [e.outFile] : []))
        const items = turns.flatMap((f) => adapter.parse(readFileSync(resolve(runDir, f), 'utf8')).items)
        const sends = items.flatMap((i) => (i.kind === 'tool_call' && /send$/.test(i.name) && !/shell|bash|execute/i.test(i.name) ? [i.id] : []))
        assert.ok(items.some((i) => i.kind === 'tool_result' && sends.includes(i.callId) && !i.isError), 'a sent with the MCP send tool')
      }
      assert.ok(events.some((e) => e.type === 'inbox.read' && e.node === 'b'), 'b received mid-turn')
      assert.ok(!existsSync(marker), `a project MCP server started, by:\n${existsSync(marker) && readFileSync(marker, 'utf8')}\n${run.output}`)
    })

    test('a supervisor killed mid-turn: sous resume completes the run', { timeout: 20 * MINUTES }, async () => {
      const workspace = gitWorkspace(`sous-certify-${harness}-`)
      // Short: the resumed worker may run it again.
      const n = holdScript(workspace, 40, 100)
      commit(workspace)
      const graph = writeGraph(harness, liveModel, [
        { id: 'slow', kind: 'work', agent: 'worker', brief: `First run the shell command \`./hold.sh ${n}\` in the foreground and wait ` +
          'for it to finish. Then write a file done.txt containing the word done and commit it.' },
        { id: 'verify', kind: 'check', needs: ['slow'], command: 'grep -q done done.txt' },
      ])
      const first = spawn(process.execPath, [CLI, 'run', graph], { cwd: workspace, stdio: 'ignore' })
      const exited = new Promise((resolve) => first.on('exit', resolve))
      assert.ok(await until(() => sleeping(n), 5 * MINUTES), 'the worker never ran its command')
      process.kill(first.pid!, 'SIGKILL')
      await exited
      const resumed = await sous(['resume'], workspace, 18 * MINUTES)
      assert.equal(resumed.code, 0, resumed.output)
      const state = fold(readEvents(runDirOf(resumed.output)))
      assert.equal(state.status, 'completed')
      // The interrupted session continued; the worker did not start over.
      const [interrupted, continued] = state.nodes.get('slow')!.turns
      assert.ok(interrupted?.sessionId, 'the interrupted turn named its session')
      assert.equal(continued?.mode, 'resume')
      assert.ok(await until(() => !sleeping(n), 5000), 'the interrupted command outlived the resume')
    })

    // ---- Leading: a lead turn is read only and ends with valid calls; a real run's lead runs on the harness. ----
    const leadSpec = (cwd: string, turn: number, prompt: string): TurnSpec => ({ ...spec(cwd, turn, prompt), lead: { system: HARNESS_LEAD_ROLE } })
    const leadFinished = async (running: RunningTurn, s: TurnSpec) => {
      const exit = await running.exit
      const turn = parsed(s)
      assert.equal(exit.code, 0, `exit ${JSON.stringify(exit)}; see ${s.outFile} and ${s.errFile}`)
      assert.equal(turn.ended, true, `no end marker; see ${s.outFile}`)
      assert.ok(turn.lead, `no lead result; see ${s.outFile}`)
      assert.ok(turn.usage && turn.usage.inputTokens > 0, 'usage is reported')
      return turn
    }
    const lead = { skip: !adapter.lead || !live, timeout: 10 * MINUTES }
    /** Every file under `dir` but the turn files, with its content. */
    const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !join(e.parentPath, e.name).includes('/.turns/'))
      .map((e) => `${join(e.parentPath, e.name)}: ${readFileSync(join(e.parentPath, e.name), 'utf8')}`).sort()

    test(LEAD_TESTS[0], lead, async () => {
      const cwd = tempDir(harness)
      writeFileSync(join(cwd, 'plan.md'), PLAN)
      writeFileSync(join(cwd, 'math.js'), 'export const add = (a, b) => a + b\n')
      const s = leadSpec(cwd, 1, LEAD_PROMPT)
      const turn = await leadFinished(adapter.start(s), s)
      assert.ok(turn.items.some((i) => i.kind === 'tool_result' && i.content.includes('sub(a, b)')), 'it read plan.md')
      const children = turn.lead!.calls.flatMap((c) => (c.tool === 'spawn' ? c.children : []))
      const siblings: string[] = []
      for (const c of children) {
        assert.equal(childError(c, () => false, siblings, { agents: { worker: { runs: harness } } }), undefined, JSON.stringify(c))
        siblings.push(c.id)
      }
      assert.ok(children.some((c) => c.kind === 'work') && children.some((c: ChildSpec) => c.kind === 'check'), JSON.stringify(turn.lead))
      assert.ok(!turn.lead!.calls.some((c) => c.tool === 'complete'), 'it does not complete while its children are to run')
      keep(s, 'lead')
    })

    test(LEAD_TESTS[1], lead, async () => {
      const cwd = tempDir(harness)
      writeFileSync(join(cwd, 'a.txt'), 'alpha\n')
      const before = snapshot(cwd)
      const s = leadSpec(cwd, 1, 'You are lead lead, the top-level lead (depth 1 of 3). Before anything else, create the file ' +
        'made-by-lead.txt containing the word hello yourself, now, with any tool you have, and change a.txt to say beta. Try it. ' +
        'Then end your turn with your result, with no calls.')
      await leadFinished(adapter.start(s), s)
      assert.deepEqual(snapshot(cwd), before, 'the lead changed no file')
    })

    test(LEAD_TESTS[2], { ...lead, timeout: 15 * MINUTES }, async () => {
      const cwd = tempDir(harness)
      const word = codeword()
      const first = leadSpec(cwd, 1, `You are lead lead. Remember this codeword for later: ${word}. Do not use any tools. ` +
        'End your turn with no calls and the answer "noted".')
      const started = adapter.start(first)
      const one = await leadFinished(started, first)
      const s = leadSpec(cwd, 2, 'What is the codeword I gave you? Do not use any tools. End your turn with no calls and the codeword alone as the answer.')
      const resumed = adapter.resume({ ...s, sessionId: one.sessionId ?? await started.sessionId })
      assert.match((await leadFinished(resumed, s)).lead!.answer, new RegExp(word))
    })

    /** A workspace and an agents file whose lead and workers run on this harness, on the certification model. */
    const leadRun = () => {
      const workspace = gitWorkspace(`sous-certify-${harness}-`)
      const agents = join(tempDir(harness), 'agents.json')
      const on = { runs: harness, ...(liveModel ? { model: liveModel } : {}) }
      writeFileSync(agents, JSON.stringify({ agent: 'worker', agents: { worker: on, lead: on } }))
      return { workspace, agents }
    }
    const GOAL = 'Create the file hello.txt containing the word hello. Split it into one work child that writes and commits ' +
      'the file and one check child, needing it, whose command verifies it; complete once both are done.'
    /** Each child of a lead's accepted spawns, by id: a child spawned twice would show twice. */
    const spawned = (events: Event[]) => events.flatMap((e) => (e.type === 'lead.call' && e.ok && e.call.tool === 'spawn' ? e.call.children : []))

    test(LEAD_TESTS[3], { ...lead, timeout: 20 * MINUTES }, async () => {
      const { workspace, agents } = leadRun()
      const run = await sous(['run', GOAL, '--agents', agents, '--max-cost', '1'], workspace, 18 * MINUTES)
      assert.equal(run.code, 0, run.output)
      const events = readEvents(runDirOf(run.output))
      assert.equal(fold(events).status, 'completed')
      const children = spawned(events)
      assert.ok(children.some((c) => c.kind === 'work') && children.some((c) => c.kind === 'check'), JSON.stringify(children))
      assert.ok(events.some((e) => e.type === 'turn.started' && e.node === 'lead' && e.harness === harness), 'the lead ran on the harness')
    })

    test(LEAD_TESTS[4], { ...lead, timeout: 20 * MINUTES }, async () => {
      const { workspace, agents } = leadRun()
      const first = spawn(process.execPath, [CLI, 'run', GOAL, '--agents', agents, '--max-cost', '1'], { cwd: workspace, stdio: 'ignore' })
      const exited = new Promise((resolve) => first.on('exit', resolve))
      const runs = join(workspace, '.sous', 'runs')
      const leadTurn = () => existsSync(runs) && readdirSync(runs).some((id) => {
        try {
          return readEvents(join(runs, id)).some((e) => e.type === 'turn.started' && e.node === 'lead')
        } catch {
          return false
        }
      })
      assert.ok(await until(leadTurn, 5 * MINUTES), 'the lead never started a turn')
      process.kill(first.pid!, 'SIGKILL')
      await exited
      const resumed = await sous(['resume'], workspace, 18 * MINUTES)
      assert.equal(resumed.code, 0, resumed.output)
      const events = readEvents(runDirOf(resumed.output))
      assert.equal(fold(events).status, 'completed')
      const ids = spawned(events).map((c) => c.id)
      assert.ok(ids.length >= 2, JSON.stringify(ids))
      assert.equal(new Set(ids).size, ids.length, `each spawn is recorded once: ${ids.join(', ')}`)
    })
  })
}

function commit(workspace: string) {
  git(workspace, 'add', '-A')
  git(workspace, 'commit', '-qm', 'certify')
}

/** A graph whose work nodes run on agent `worker`: `harness` with the certification model. */
function writeGraph(harness: HarnessName, model: string | undefined, nodes: object[]): string {
  const file = join(tempDir(harness), 'graph.json')
  writeFileSync(file, JSON.stringify({ goal: `Certify ${harness}.`, agents: { worker: { runs: harness, ...(model ? { model } : {}) } }, nodes }))
  return file
}

/** An MCP server that records that it started, configured everywhere a harness reads a project's MCP servers. Pi and
 * Codex read theirs only in projects the person trusted, which a fresh workspace is not. */
function projectMcpCanary(workspace: string, marker: string) {
  const script = join(dirname(marker), 'canary.mjs')
  // It writes the processes that started it, so a failure says who did.
  writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'started')
const chain = []
for (let pid = process.pid, i = 0; pid > 1 && i < 8; i++) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
  chain.push(pid + ' ' + readFileSync('/proc/' + pid + '/cmdline', 'utf8').replaceAll('\\0', ' ').slice(0, 4000))
  pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
}
writeFileSync(${JSON.stringify(marker)}, chain.join('\\n'))
process.stdin.resume()
`)
  const server = { type: 'stdio', command: process.execPath, args: [script] }
  const json = JSON.stringify({ mcpServers: { canary: server } })
  for (const file of ['.mcp.json', '.factory/mcp.json', '.pi/mcp.json']) {
    mkdirSync(join(workspace, dirname(file)), { recursive: true })
    writeFileSync(join(workspace, file), json)
  }
  mkdirSync(join(workspace, '.codex'), { recursive: true })
  writeFileSync(join(workspace, '.codex', 'config.toml'),
    `[mcp_servers.canary]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\n`)
}

/** Run the sous CLI to its end. */
async function sous(args: string[], cwd: string, ms: number): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const timer = setTimeout(() => child.kill('SIGTERM'), ms)
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  return { code, output }
}

/** The run directory `sous run` or `sous resume` printed. */
function runDirOf(output: string): string {
  const dir = output.match(/^(?:run|resuming run) \S+ \((.+)\)$/m)?.[1]
  assert.ok(dir, output)
  return dir
}
