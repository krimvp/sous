// What a person sees when they ask for help, mistype a command, start in a dirty or nested checkout, or list runs.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { git, gitWorkspace } from './fixtures/git-repo.ts'
import { fakeLeadPlan } from './fixtures/fake-lead.ts'
import { fakeBin, sous, runDirOf } from './fixtures/sous-proc.ts'
import { fakePlan } from './fixtures/fake-adapter.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'sous-usage-'))
const complete = (goal: string) => `${goal}\n${fakeLeadPlan([{ calls: [{ tool: 'complete', summary: 'done' }] }])}`

/** Runs sous with `args` and returns its exit code and its output. */
async function ran(args: string[], cwd = tmp()) {
  const r = sous(args, cwd, join(cwd, 'sessions'))
  const code = await r.exit
  return { code, output: r.output() }
}

test('--help, -h, help and <command> --help print the usage and exit 0; --version and -v print the package version', async () => {
  for (const args of [['--help'], ['-h'], ['help'], ['run', '--help'], ['status', '-h'], ['help', 'ui'], ['send', '--help'], ['receive', '-h']]) {
    const { code, output } = await ran(args)
    assert.equal(code, 0, `${args}: ${output}`)
    assert.match(output, /^usage:\n {2}sous /, args.join(' '))
  }
  // A command's help is its own line; plain --help lists them all.
  const one = await ran(['export', '--help'])
  assert.equal(one.output.split('\n').filter((l) => l.startsWith('  sous ')).length, 1)
  assert.match(one.output, /sous export atif\|otlp/)
  assert.match((await ran(['run', '--help'])).output, /^ {2}sous run .*\[--max-cost <usd>\]/m)
  assert.match((await ran(['resume', '--help'])).output, /^ {2}sous resume \[run-id\] \[--max-cost <usd>\]/m)
  const all = await ran(['--help'])
  for (const command of ['run', 'resume', 'status', 'wait', 'runs', 'answer', 'approve', 'cancel', 'send', 'receive', 'export', 'diff', 'clean', 'doctor', 'ui']) assert.match(all.output, new RegExp(`^ {2}sous ${command} `, 'm'))

  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const flag of ['--version', '-v']) assert.deepEqual(await ran([flag]), { code: 0, output: `${version}\n` })
})

test('a command that was not understood prints one diagnosis line before the usage and exits 2', async () => {
  const cases: [string[], string][] = [
    [['frobnicate'], 'unknown command frobnicate'],
    [['run', 'a', 'b'], 'run takes one argument'],
    [['run'], 'run takes one argument'],
    [['run', 'g', '--max-depth', '9'], '--max-depth must be a whole number from 1 to 8'],
    [['run', 'g', '--max-cost', '0'], '--max-cost must be a positive number of US dollars'],
    [['resume', '--max-cost', '$5'], '--max-cost must be a positive number of US dollars'],
    [['status', '--max-cost', '5'], '--max-cost is for run and resume'],
    [['export', 'csv'], 'unknown exporter csv'],
    [['export'], 'export takes an exporter'],
    [['ui', '--port', 'abc'], '--port must be a number from 0 to 65535'],
    [['ui', '--port', '70000'], '--port must be a number from 0 to 65535'],
    [['ui', 'extra'], 'ui takes no arguments'],
    [['status', 'a', 'b'], 'status takes at most one argument: a run id'],
    [['runs', 'a'], 'runs takes no arguments'],
    [['wait', 'a', 'b'], 'wait takes at most one argument: a run id'],
    [['wait', '--timeout', 'soon'], '--timeout must be a number of seconds'],
    [['status', '--timeout', '5'], '--timeout is for wait'],
    [['runs', '--json'], '--json is for status and wait'],
    [['status', '--stat'], '--stat is for diff'],
    [['status', '--unmerged'], '--unmerged is for clean'],
    [['diff', '--all'], '--all is for clean'],
    [['run', 'g', '--branches'], '--branches is for clean'],
    [['resume', '--dry-run'], '--dry-run is for clean'],
    [['doctor', 'a'], 'doctor takes no arguments'],
    [['diff', 'a', 'b'], 'diff takes at most one argument: a run id'],
    [['clean', 'a', 'b'], 'clean takes at most one argument: a run id'],
    [['clean', 'a', '--all'], 'clean takes a run id or --all, not both'],
    [['answer', 'lead'], 'answer takes a node, the answer and optionally a run id'],
    [['approve'], 'approve takes a node and optionally a run id'],
    [['cancel', 'w', 'r1', 'extra'], 'cancel takes a node and optionally a run id'],
    [['status', '--watch'], "unknown option '--watch'"],
    [['-x'], "unknown option '-x'"],
    [['status', '--workspace'], "option '--workspace <value>' argument missing"],
    [['run', 'g', '--approve-splits=yes'], "option '--approve-splits' does not take an argument"],
    [['send', 'a'], 'send takes a recipient and a text'],
    [['receive', '1', '2'], 'receive takes at most one argument'],
    [['receive', 'soon'], 'receive waits from 0 to'],
  ]
  for (const [args, diagnosis] of cases) {
    const { code, output } = await ran(args)
    assert.equal(code, 2, `${args}: ${output}`)
    const [first, second] = output.split('\n')
    assert.ok(first.startsWith(`sous: ${diagnosis}`), `${args}: ${first}`)
    assert.equal(second, 'usage:', args.join(' '))
    assert.doesNotMatch(output.split('usage:')[0], /place it at the end/, 'Node\'s explanation of -- is not repeated')
  }
  // Nothing at all is not a mistake to name, only the usage.
  const bare = await ran([])
  assert.equal(bare.code, 2)
  assert.match(bare.output, /^usage:\n/)
})

test('sous export otlp against an unreachable host names the URL and the cause', async () => {
  const workspace = gitWorkspace('sous-usage-')
  const sessions = join(workspace, 'sessions')
  const run = sous(['run', complete('Say hi.')], workspace, sessions)
  assert.equal(await run.exit, 0, run.output())
  // A port nothing listens on: one that was just free.
  const closed = await new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
  const saved = { ...process.env }
  Object.assign(process.env, { LANGFUSE_HOST: `http://127.0.0.1:${closed}/`, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })
  try {
    const exported = sous(['export', 'otlp'], workspace, sessions)
    assert.equal(await exported.exit, 1)
    assert.match(exported.output(), new RegExp(`^sous: cannot reach http://127\\.0\\.0\\.1:${closed}/api/public/otel/v1/traces: .*ECONNREFUSED`, 'm'))
  } finally {
    for (const key of ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('sous status shows the first line of a multi-line goal, and sous runs lists the runs newest first with their state', async () => {
  const workspace = gitWorkspace('sous-usage-')
  const sessions = join(workspace, 'sessions')
  assert.match((await ran(['runs'], workspace)).output, /^no runs in .*\.sous\/runs\n$/)

  const first = sous(['run', complete('Write the notes\nin three parts,\nsecond line.')], workspace, sessions)
  assert.equal(await first.exit, 0, first.output())
  const firstId = runDirOf(workspace)!.split('/').at(-1)!
  const status = await ran(['status'], workspace)
  assert.match(status.output, new RegExp(`^run ${firstId} completed: Write the notes\\.\\.\\.\\n`))
  assert.doesNotMatch(status.output, /three parts/)

  // Run ids order by the second they start in.
  await sleep(1100)
  const asking = `Pick a database\nand explain.\n${fakeLeadPlan([{ calls: [{ tool: 'escalate', question: 'Which?' }] }, { calls: [{ tool: 'complete', summary: 'picked' }] }])}`
  const second = sous(['run', asking], workspace, sessions)
  for (let i = 0; i < 200 && !/Question from lead/.test(second.output()); i++) await sleep(50)
  assert.match(second.output(), /Question from lead/)
  const listing = (await ran(['runs'], workspace)).output.trimEnd().split('\n')
  const secondId = listing[0].split(' ')[0]
  assert.notEqual(secondId, firstId)
  assert.match(listing[0], /^\S+ {2}running {4}\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ {2}Pick a database\.\.\.$/)
  assert.match(listing[1], new RegExp(`^${firstId} {2}completed {2}\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ {2}Write the notes\\.\\.\\.$`))
  assert.equal(listing.length, 2)

  const answer = sous(['answer', 'lead', 'Postgres.'], workspace, sessions)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await second.exit, 0, second.output())
  assert.match((await ran(['runs'], workspace)).output, /^\S+ {2}completed {2}/)
  assert.equal(existsSync(join(workspace, '.sous', 'runs', secondId, 'lock')), false)
})

test('a run in a checkout with uncommitted changes warns that workers see HEAD only; a clean one does not', async () => {
  const workspace = gitWorkspace('sous-usage-')
  const sessions = join(workspace, 'sessions')
  const clean = sous(['run', complete('Look around.')], workspace, sessions)
  assert.equal(await clean.exit, 0, clean.output())
  assert.doesNotMatch(clean.output(), /uncommitted/, 'sous\'s own .sous/ is not a change')

  writeFileSync(join(workspace, 'notes.md'), 'notes\n')
  const one = sous(['run', complete('Use notes.md.')], workspace, sessions)
  assert.equal(await one.exit, 0, one.output())
  assert.match(one.output(), /^workspace has 1 uncommitted change; workers see HEAD only$/m)

  writeFileSync(join(workspace, 'README.md'), 'edited\n')
  const two = sous(['run', complete('Use both.')], workspace, sessions)
  assert.equal(await two.exit, 0, two.output())
  assert.match(two.output(), /^workspace has 2 uncommitted changes; workers see HEAD only$/m)
})

test('started in a subdirectory of a git repository, a run uses the repository root as its workspace and says so; folder mode is unchanged', async () => {
  const repo = gitWorkspace('sous-usage-')
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'keep.txt'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'sub')
  const sessions = join(repo, 'sessions')
  const brief = `Write a file.\n${fakePlan([{ write: { 'sub/hello.txt': 'hello\n' }, result: { status: 'done', summary: 'wrote' } }])}`
  const graph = join(tmp(), 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'g', agent: 'claude', nodes: [
    { id: 'write', kind: 'work', brief },
    { id: 'test', kind: 'check', command: 'test -f sub/hello.txt', needs: ['write'] },
  ] }))
  const run = sous(['run', graph], sub, sessions)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), new RegExp(`^workspace is the git repository root ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, not ${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'm'))
  assert.ok(runDirOf(repo), '.sous/ is at the root')
  assert.equal(existsSync(join(sub, '.sous')), false)
  // The other commands find the run from the same folder.
  const status = await ran(['status'], sub)
  assert.match(status.output, /^run \S+ completed: g\n/)
  assert.match((await ran(['runs'], sub)).output, /completed/)

  // Not a git repository: the folder it is started in stays the workspace.
  const folder = tmp()
  mkdirSync(join(folder, 'inner'))
  const inFolder = sous(['run', complete('Anything.')], join(folder, 'inner'), sessions, fakeBin([]))
  assert.equal(await inFolder.exit, 0, inFolder.output())
  assert.doesNotMatch(inFolder.output(), /git repository root/)
  assert.ok(runDirOf(join(folder, 'inner')))
})

test('a graph run lists only the agents its work nodes use; a goal run lists every agent', async () => {
  const workspace = gitWorkspace('sous-usage-')
  const sessions = join(workspace, 'sessions')
  const graph = join(tmp(), 'graph.json')
  const brief = `Do it.\n${fakePlan([{ result: { status: 'done', summary: 'done' } }])}`
  writeFileSync(graph, JSON.stringify({ goal: 'g', nodes: [{ id: 'a', kind: 'work', agent: 'codex', brief }, { id: 'b', kind: 'work', agent: 'claude', brief }, { id: 'c', kind: 'check', command: 'true' }] }))
  const named = sous(['run', graph], workspace, sessions, fakeBin(['claude', 'codex'], ['git', 'sh']))
  assert.equal(await named.exit, 0, named.output())
  assert.match(named.output(), /^agents: claude \(haiku\), codex \(harness default\)$/m)

  const goal = sous(['run', complete('Anything.')], workspace, sessions, fakeBin(['claude']))
  assert.equal(await goal.exit, 0, goal.output())
  assert.match(goal.output(), /^agents: claude \(haiku\), lead \(ollama-cloud\/deepseek-v4\.1-flash\); not available: codex \(codex not found\), pi \(pi not found\), droid \(droid not found\)$/m)
})

test('a graph that can merge also lists the agent that resolves conflicts, so a missing one shows', async () => {
  const workspace = gitWorkspace('sous-usage-')
  const sessions = join(workspace, 'sessions')
  const dir = tmp()
  const brief = `Do it.\n${fakePlan([{ result: { status: 'done', summary: 'done' } }])}`
  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, kind: 'work', agent: 'claude', brief }))
  let files = 0
  const start = async (extra: object, count: number, bin: string) => {
    const graph = join(dir, `graph-${files++}.json`)
    writeFileSync(graph, JSON.stringify({ goal: 'g', ...extra, nodes: nodes(count) }))
    const r = sous(['run', graph], workspace, sessions, bin)
    assert.equal(await r.exit, 0, r.output())
    return r.output()
  }
  const only = fakeBin(['claude'], ['git', 'sh'])
  // One work node cannot conflict; two can, and the integrator is then the first available worker.
  assert.match(await start({}, 1, only), /^agents: claude \(haiku\)$/m)
  assert.match(await start({}, 2, only), /^agents: claude \(haiku\)$/m)
  assert.match(await start({}, 2, fakeBin(['claude', 'codex'], ['git', 'sh'])), /^agents: claude \(haiku\), codex \(harness default\)$/m)
  const droid = { agents: { integrator: { runs: 'droid' } } }
  assert.match(await start(droid, 2, only), /^agents: claude \(haiku\); not available: integrator \(droid not found\)$/m)
  assert.match(await start(droid, 1, only), /^agents: claude \(haiku\)$/m)
})

test('--workspace is used exactly as given, even inside a git repository; only the current directory becomes the root', async () => {
  const repo = gitWorkspace('sous-usage-')
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  const run = sous(['run', complete('Anything.'), '--workspace', sub], tmp(), join(repo, 'sessions'))
  assert.equal(await run.exit, 0, run.output())
  assert.doesNotMatch(run.output(), /git repository root/)
  assert.ok(runDirOf(sub), '.sous/ is in the folder that was named')
  assert.equal(existsSync(join(repo, '.sous', 'runs')), false)
})

test('sous runs shows a run whose log has no first event yet as starting', async () => {
  const workspace = tmp()
  const runs = join(workspace, '.sous', 'runs')
  mkdirSync(join(runs, '20261013T100000Z-aaaa'), { recursive: true })
  mkdirSync(join(runs, '20261013T100001Z-bbbb'), { recursive: true })
  writeFileSync(join(runs, '20261013T100000Z-aaaa', 'events.jsonl'), '')
  writeFileSync(join(runs, '20261013T100001Z-bbbb', 'events.jsonl'), '{"type":"run.crea')
  const { code, output } = await ran(['runs'], workspace)
  assert.equal(code, 0, output)
  assert.equal(output, '20261013T100001Z-bbbb  starting\n20261013T100000Z-aaaa  starting\n')
})
