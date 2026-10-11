// Folder mode (no git) end to end through real `sous` processes, and the leads' read-only file tools in both modes.
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog, readEvents } from '../src/log.ts'
import { fold } from '../src/state.ts'
import { toAtif } from '../src/trace/atif.ts'
import { toOtlp } from '../src/trace/otlp.ts'
import { loadRun } from '../src/trace/run.ts'
import { runSupervisor } from '../src/supervisor.ts'
import type { Event, NodeSpec } from '../src/types.ts'
import { checkAtif } from './atif-checker.ts'
import { fakeAdapter, fakePlan } from './fixtures/fake-adapter.ts'
import { fakeLeadPlan, fakeLeadRecords, fakeLeadRunner } from './fixtures/fake-lead.ts'
import type { FakeLeadStep } from './fixtures/fake-lead.ts'
import { gitWorkspace } from './fixtures/git-repo.ts'
import { fakeBin, runDirOf, sous, waitFor } from './fixtures/sous-proc.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, steps: FakeStep[], needs?: string[]) =>
  ({ id, kind: 'work' as const, brief: `Do ${id}.\n${fakePlan(steps)}`, ...(needs ? { needs } : {}) })
/** A PATH with a claude stand-in and the tools checks use, but no git: nothing in folder mode may run git. */
const NO_GIT = fakeBin(['claude'], ['sh', 'grep', 'mkdir', 'sleep'])
const plainDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
/** Every file under `dir`, relative, sorted. */
const tree = (dir: string): string[] => (readdirSync(dir, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
  .filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(dir.length + 1)).sort()
const results = (fake: { op: string; result?: string }[]) => fake.flatMap((r) => (r.op === 'act' ? [r.result!] : []))

test('folder mode without git: a lead looks first, workers and checks see workspace/ and results/ as the lead does, files are collected with a rename on a clash', async () => {
  const workspace = plainDir('sous-folder-')
  const sessions = plainDir('sous-sessions-')
  writeFileSync(join(workspace, 'input.txt'), 'three facts\n')
  const children = [
    work('a', [{ write: { 'summary.md': 'A\n', 'same.txt': 'same\n' }, sh: 'mkdir notes && echo n > notes/a.md && grep three workspace/input.txt > facts.txt', result: done('summarised') }]),
    work('b', [{ write: { 'summary.md': 'B\n', 'same.txt': 'same\n' }, sh: 'grep -x A results/summary.md > seen.txt', result: done('summarised again') }], ['a']),
    { id: 'c', kind: 'check' as const, command: 'grep -qx A results/summary.md && grep -qx B results/summary.b.md && grep -qx A results/seen.txt && grep -q three workspace/input.txt', needs: ['b'] },
  ]
  const lead: FakeLeadStep[] = [
    { calls: [{ tool: 'list_files' }, { tool: 'read_file', path: 'workspace/input.txt' }, { tool: 'spawn', children }] },
    {}, {},
    { calls: [{ tool: 'complete', summary: 'all summarised' }] },
  ]
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'summarise', agent: 'claude', nodes: [{ id: 'lead', kind: 'lead', brief: fakeLeadPlan(lead) }] }))
  const run = sous(['run', graph], workspace, sessions, NO_GIT)
  assert.equal(await run.exit, 0, run.output())

  const runDir = join(workspace, '.sous', 'runs', readdirSync(join(workspace, '.sous', 'runs'))[0])
  const output = join(runDir, 'output')
  assert.match(run.output(), new RegExp(`folder mode \\(not a git repository\\): results go to ${output}`))
  assert.match(run.output(), new RegExp(`^result: folder ${output}$`, 'm'))
  // The workspace/ and results/ links of the workers' folders are not collected.
  assert.deepEqual(readdirSync(output).sort(), ['facts.txt', 'notes', 'same.txt', 'seen.txt', 'summary.b.md', 'summary.md'])
  assert.deepEqual(tree(output), ['facts.txt', 'notes/a.md', 'same.txt', 'seen.txt', 'summary.b.md', 'summary.md'])
  assert.equal(readFileSync(join(output, 'facts.txt'), 'utf8'), 'three facts\n')
  for (const node of ['a', 'c']) {
    for (const [name, target] of [['workspace', workspace], ['results', output]]) assert.equal(readlinkSync(join(runDir, 'work', node, name)), target)
  }
  assert.equal(readFileSync(join(output, 'summary.b.md'), 'utf8'), 'B\n')
  assert.deepEqual(readdirSync(workspace).sort(), ['.sous', 'graph.json', 'input.txt'], 'the workspace is only read')

  const events = readEvents(runDir)
  const state = fold(events)
  assert.equal(state.mode, 'folder')
  assert.equal(state.status, 'completed')
  assert.ok(!events.some((e) => e.type === 'integration.created' || e.type === 'worktree.created'))
  const merged = events.flatMap((e) => (e.type === 'merge.done' ? [[e.node, e.by, e.files, e.renamed]] : []))
  assert.deepEqual(merged, [
    ['a', 'supervisor', ['facts.txt', 'notes/a.md', 'same.txt', 'summary.md'], undefined],
    ['b', 'supervisor', ['same.txt', 'seen.txt', 'summary.b.md'], { 'summary.md': 'summary.b.md' }],
  ])
  // The lead is told which files each child produced, and about the rename.
  const told = (requestId: string) => events.find((e): e is Event & { type: 'lead.delivered' } => e.type === 'lead.delivered' && e.requestId === requestId)!.text
  const outcomeB = told(`evt-${state.nodes.get('b')!.endSeq}`)
  assert.equal(outcomeB, 'Child b completed: summarised again\nFiles: same.txt, seen.txt, summary.b.md\nsummary.md was saved as summary.b.md: the results already had a different summary.md.')
  assert.match(told('lead:brief'), /workspace\/ holds the inputs, results\/ the\nfiles your children produced so far\. These names mean the same for your tools, your work children and your checks/)

  // The worker ran in its own folder and was told where its inputs and the results are.
  const a = state.nodes.get('a')!
  const prompt = JSON.parse(readFileSync(join(sessions, `${a.turns[0].sessionId}.json`), 'utf8')).prompts[0]
  assert.match(prompt, new RegExp(`You work in your own folder, ${join(runDir, 'work', 'a')}\\. It has two read-only links: workspace/ holds the inputs \\(${workspace}\\)\nand results/ the results of earlier tasks so far \\(${output}\\)\\.`))
  assert.match(prompt, /Write your own output files at the top of your folder, not inside workspace\/ or results\//)
  assert.doesNotMatch(prompt, /worktree/)

  // What the lead looked at is recorded, without the text.
  const [listing, read] = results(fakeLeadRecords(runDir))
  assert.match(listing, /^workspace\/\nworkspace\/graph\.json \(\d+ bytes\)\nworkspace\/input\.txt \(12 bytes\)\nresults\/$/)
  assert.equal(read, 'three facts\n')
  const reads = events.flatMap((e) => (e.type === 'lead.read' ? [[e.tool, e.path, e.bytes]] : []))
  assert.deepEqual(reads, [['list_files', undefined, Buffer.byteLength(listing)], ['read_file', 'workspace/input.txt', 12]])

  // Traces show the reads and the collections.
  const loaded = loadRun(runDir, (_, raw) => fakeAdapter(sessions).parse(raw))
  const doc = toAtif(loaded)
  assert.deepEqual(checkAtif(doc), [])
  assert.match(JSON.stringify(doc), /"function_name":"read_file","arguments":\{"path":"workspace\/input.txt"\}/)
  assert.match(JSON.stringify(doc), /3 files added to the results/)
  assert.match(JSON.stringify(toOtlp(loaded)), /"stringValue":"read_file"|"name":"read_file"/)
})

test('sous resume collects a node again without git: files already collected are not doubled', async () => {
  const workspace = plainDir('sous-folder-')
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  const output = join(runDir, 'output')
  // Node w finished; the supervisor stopped while collecting it: one file is in, and its renamed copy too.
  mkdirSync(join(runDir, 'work', 'w', 'sub'), { recursive: true })
  mkdirSync(output, { recursive: true })
  writeFileSync(join(runDir, 'work', 'w', 'r.txt'), 'mine\n')
  writeFileSync(join(runDir, 'work', 'w', 'sub', 'x.txt'), 'x\n')
  writeFileSync(join(runDir, 'work', 'w', 'y.txt'), 'y\n')
  writeFileSync(join(output, 'r.txt'), 'theirs\n')
  writeFileSync(join(output, 'r.w.txt'), 'mine\n')
  mkdirSync(join(output, 'sub'))
  writeFileSync(join(output, 'sub', 'x.txt'), 'x\n')
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace, mode: 'folder' })
  log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'w', agent: 'claude' }, by: 'graph' })
  log.append({ type: 'merge.queued', node: 'w' })
  log.close()
  const resumed = sous(['resume'], workspace, plainDir('sous-sessions-'), NO_GIT)
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.deepEqual(tree(output), ['r.txt', 'r.w.txt', 'sub/x.txt', 'y.txt'])
  assert.equal(readFileSync(join(output, 'r.txt'), 'utf8'), 'theirs\n')
  const merged = readEvents(runDir).flatMap((e) => (e.type === 'merge.done' ? [e] : []))
  assert.deepEqual(merged.map((e) => [e.files, e.renamed, e.commit]), [[['r.w.txt', 'sub/x.txt', 'y.txt'], { 'r.txt': 'r.w.txt' }, undefined]])
  assert.match(resumed.output(), new RegExp(`^result: folder ${output}$`, 'm'))
})

/** Runs one lead that plays `steps`, in `workspace`, in the given mode; returns the read results and events. */
async function lookAround(workspace: string, steps: FakeLeadStep[], mode?: 'folder') {
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  mkdirSync(runDir, { recursive: true })
  const log = openLog(runDir)
  const node: NodeSpec = { id: 'lead', kind: 'lead', brief: fakeLeadPlan(steps) }
  log.append({ type: 'run.created', goal: 'look', workspace, ...(mode ? { mode } : {}) })
  log.append({ type: 'node.added', node, by: 'graph' })
  log.close()
  const adapter = fakeAdapter(plainDir('sous-sessions-'))
  const outcome = await runSupervisor({ workspace, runDir, getAdapter: () => adapter, createLeadRunner: fakeLeadRunner })
  return { outcome, runDir, results: results(fakeLeadRecords(runDir)), events: readEvents(runDir) }
}

test('lead file tools refuse paths outside the run, symbolic links out included; they cap listings and reads and refuse binary files', async () => {
  const workspace = plainDir('sous-look-')
  const outside = plainDir('sous-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret\n')
  symlinkSync(outside, join(workspace, 'link'))
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'secret-link.txt'))
  writeFileSync(join(workspace, 'big.txt'), 'é'.repeat(20_000)) // 40000 bytes of two-byte characters
  writeFileSync(join(workspace, 'bin.dat'), Buffer.from([104, 105, 0, 1]))
  for (const skipped of ['.git', 'node_modules']) {
    mkdirSync(join(workspace, skipped))
    writeFileSync(join(workspace, skipped, 'hidden.txt'), 'x')
  }
  mkdirSync(join(workspace, 'many'))
  for (let i = 0; i < 250; i++) writeFileSync(join(workspace, 'many', `f${String(i).padStart(3, '0')}.txt`), '')
  const { outcome, results: r, events } = await lookAround(workspace, [{
    calls: [
      { tool: 'list_files', path: 'workspace' },
      { tool: 'list_files', path: 'workspace/many' },
      { tool: 'read_file', path: 'workspace/big.txt' },
      { tool: 'read_file', path: 'workspace/big.txt', offset: 32_768 },
      { tool: 'read_file', path: 'workspace/bin.dat' },
      { tool: 'read_file', path: 'workspace/../../etc/hostname' },
      { tool: 'read_file', path: 'workspace/link/secret.txt' },
      { tool: 'read_file', path: 'workspace/secret-link.txt' },
      { tool: 'list_files', path: 'workspace/link' },
      { tool: 'read_file', path: 'secret.txt' },
      { tool: 'read_file', path: 'workspace/many' },
      { tool: 'complete', summary: 'looked' },
    ],
  }], 'folder')
  assert.equal(outcome, 'completed')
  const [list, many, first, rest, binary, dotdot, linked, fileLink, linkedDir, unrooted, directory] = r
  // .git, node_modules and .sous are left out; links are listed but not followed.
  assert.doesNotMatch(list, /\.git|node_modules|\.sous|hidden/)
  assert.match(list, /^workspace\/big\.txt \(40000 bytes\)\nworkspace\/bin\.dat \(4 bytes\)\nworkspace\/link\nworkspace\/many\/\nworkspace\/many\/f000\.txt \(0 bytes\)\n/)
  assert.match(list, /\n\(listing stopped at 200 entries; list a subdirectory to see more\)$/)
  assert.equal(many.split('\n').length, 201)
  assert.match(many, /^workspace\/many\/f000\.txt \(0 bytes\)\n[\s\S]*workspace\/many\/f199\.txt \(0 bytes\)\n\(listing stopped at 200 entries/)
  // 32 KB per read, cut at a character boundary, with the offset to read on.
  assert.equal(first, `${'é'.repeat(16_384)}\n\n[bytes 0-32768 of 40000; read on with offset 32768]`)
  assert.equal(rest, 'é'.repeat(3_616))
  assert.equal(binary, 'refused: workspace/bin.dat is not a text file (it has NUL bytes)')
  assert.equal(dotdot, 'refused: workspace/../../etc/hostname is outside the run\'s files')
  assert.equal(linked, 'refused: workspace/link/secret.txt is outside the run\'s files')
  assert.equal(fileLink, 'refused: workspace/secret-link.txt is outside the run\'s files')
  assert.equal(linkedDir, 'refused: workspace/link is outside the run\'s files')
  assert.equal(unrooted, 'refused: secret.txt is not in the run\'s files: paths start with workspace/ or results/')
  assert.equal(directory, 'refused: workspace/many is a directory: use list_files')
  const reads = events.flatMap((e) => (e.type === 'lead.read' ? [[e.path, e.offset, e.bytes, e.refused !== undefined]] : []))
  assert.deepEqual(reads.slice(2, 5), [['workspace/big.txt', undefined, 32_768, false], ['workspace/big.txt', 32_768, 7_232, false], ['workspace/bin.dat', undefined, 0, true]])
})

test('git mode: a lead reads the workspace as committed plus merged work, and a child outcome names its changed files', async () => {
  const workspace = gitWorkspace('sous-look-git-')
  const files = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, `${i}\n`]))
  const { outcome, results: r, events } = await lookAround(workspace, [
    { calls: [{ tool: 'list_files' }, { tool: 'read_file', path: 'README.md' }, { tool: 'spawn', children: [work('w', [{ write: files, result: done('wrote') }])] }] },
    { calls: [{ tool: 'read_file', path: 'f21.txt' }, { tool: 'complete', summary: 'done' }] },
  ])
  assert.equal(outcome, 'completed')
  assert.deepEqual(r.slice(0, 2), ['README.md (5 bytes)', 'test\n'])
  assert.equal(r[3], '21\n', 'merged work is readable')
  const delivered = events.flatMap((e) => (e.type === 'lead.delivered' ? [e.text] : []))
  assert.match(delivered[0], /work children are agents \(for code, research, writing or analysis\), each in its own git\nworktree/)
  assert.match(delivered[0], /paths are relative to the workspace, which includes the work merged so far/)
  assert.equal(delivered[1], `Child w completed: wrote\nFiles: ${Object.keys(files).slice(0, 20).join(', ')} and 2 more`)
})

test('a lead may complete over a failed check, and sous run and sous status say so; a check that passed later supersedes an earlier failure', async () => {
  const workspace = plainDir('sous-folder-')
  const sessions = plainDir('sous-sessions-')
  const check = (id: string, command: string) => ({ id, kind: 'check' as const, command })
  const lead: FakeLeadStep[] = [
    { calls: [{ tool: 'spawn', children: [check('v1', 'false')] }] },
    // v1 failed; v2 passes after it, so v1 no longer counts; v3 fails and nothing passes after it.
    { calls: [{ tool: 'spawn', children: [check('v2', 'true'), check('v3', 'false')] }] },
    {},
    { calls: [{ tool: 'complete', summary: 'checked' }] },
  ]
  const graph = join(workspace, 'graph.json')
  writeFileSync(graph, JSON.stringify({ goal: 'check', nodes: [{ id: 'lead', kind: 'lead', brief: fakeLeadPlan(lead) }, check('ok', 'true')] }))
  const run = sous(['run', graph], workspace, sessions, NO_GIT)
  assert.equal(await run.exit, 0, run.output())
  assert.match(run.output(), /lead\.call +lead complete: completed with failed checks: v3$/m)
  // With several top-level nodes, the run's summary still names a top-level lead's failed checks.
  assert.match(run.output(), /run\.completed +2 nodes completed; lead completed with failed checks: v3$/m)
  const status = sous(['status'], workspace, sessions, NO_GIT)
  assert.equal(await status.exit, 0)
  assert.match(status.output(), /^ {2}lead completed: completed with failed checks: v3\. checked$/m)
})

/** Writes a folder-mode run whose node `w` finished with `files` in its folder and is queued for collection. */
function queuedRun(files: Record<string, string>) {
  const workspace = plainDir('sous-folder-')
  const runDir = join(workspace, '.sous', 'runs', 'r1')
  mkdirSync(join(runDir, 'work', 'w'), { recursive: true })
  mkdirSync(join(runDir, 'output'), { recursive: true })
  for (const [path, content] of Object.entries(files)) writeFileSync(join(runDir, 'work', 'w', path), content)
  const log = openLog(runDir)
  log.append({ type: 'run.created', goal: 'g', workspace, mode: 'folder' })
  log.append({ type: 'node.added', node: { id: 'w', kind: 'work', brief: 'w', agent: 'claude' }, by: 'graph' })
  log.append({ type: 'merge.queued', node: 'w' })
  log.close()
  return { workspace, runDir, output: join(runDir, 'output') }
}

test('collecting never replaces a file in the results: a taken alternate name moves on, and a temp-looking file or link stays as it is', async () => {
  const { workspace, runDir, output } = queuedRun({ 'report.txt': 'mine\n', 'keep.txt': 'k\n' })
  const outside = join(plainDir('sous-outside-'), 'target.txt')
  writeFileSync(outside, 'outside\n')
  writeFileSync(join(output, 'report.txt'), 'theirs\n')
  writeFileSync(join(output, 'report.w.txt'), 'other\n')
  symlinkSync(outside, join(output, 'keep.txt.sous-tmp'))
  const resumed = sous(['resume'], workspace, plainDir('sous-sessions-'), NO_GIT)
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.equal(readFileSync(join(output, 'report.w.txt'), 'utf8'), 'other\n')
  assert.equal(readFileSync(join(output, 'report.w-2.txt'), 'utf8'), 'mine\n')
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'k\n')
  assert.ok(lstatSync(join(output, 'keep.txt.sous-tmp')).isSymbolicLink())
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n')
  const done = readEvents(runDir).flatMap((e) => (e.type === 'merge.done' ? [e] : []))
  assert.deepEqual(done.map((e) => [e.files, e.renamed]), [[['keep.txt', 'report.w-2.txt'], { 'report.txt': 'report.w-2.txt' }]])
})

test('folder mode: a message to a worker waiting to be collected withdraws it, and its worker resumes with the message first', async () => {
  const workspace = plainDir('sous-folder-')
  const sessions = plainDir('sous-sessions-')
  const graph = join(workspace, 'graph.json')
  // The slow check holds the collection queue while the message arrives.
  writeFileSync(graph, JSON.stringify({ goal: 'g', agent: 'claude', nodes: [
    work('w', [{ write: { 'a.txt': 'a\n' }, result: done('wrote a') }, { write: { 'extra.txt': 'x\n' }, result: done('wrote extra') }]),
    { id: 'slow', kind: 'check', command: 'sleep 3' },
  ] }))
  const run = sous(['run', graph], workspace, sessions, NO_GIT)
  await waitFor(workspace, (e) => e.type === 'merge.queued' && e.node === 'w')
  const answer = sous(['answer', 'w', 'Also write extra.txt.'], workspace, sessions, NO_GIT)
  assert.equal(await answer.exit, 0, answer.output())
  assert.equal(await run.exit, 0, run.output())
  const events = readEvents(runDirOf(workspace)!)
  assert.deepEqual(events.flatMap((e) => ('node' in e && e.node === 'w' && e.type.startsWith('merge.') ? [e.type] : [])),
    ['merge.queued', 'merge.withdrawn', 'merge.queued', 'merge.done'])
  const collected = events.find((e) => e.type === 'merge.done')!
  assert.deepEqual(collected.type === 'merge.done' && collected.files, ['a.txt', 'extra.txt'])
  const w = fold(events).nodes.get('w')!
  assert.match(JSON.parse(readFileSync(join(sessions, `${w.turns[0].sessionId}.json`), 'utf8')).prompts[1], /Message from person:\nAlso write extra\.txt\./)
})

test('read_file refuses a FIFO without blocking the supervisor', async () => {
  const workspace = plainDir('sous-folder-')
  execFileSync('mkfifo', [join(workspace, 'pipe')])
  const graph = join(workspace, 'graph.json')
  const lead: FakeLeadStep[] = [{ calls: [{ tool: 'read_file', path: 'workspace/pipe' }, { tool: 'complete', summary: 'looked' }] }]
  writeFileSync(graph, JSON.stringify({ goal: 'g', nodes: [{ id: 'lead', kind: 'lead', brief: fakeLeadPlan(lead) }] }))
  const run = sous(['run', graph], workspace, plainDir('sous-sessions-'), NO_GIT)
  const timer = setTimeout(() => run.child.kill('SIGKILL'), 15_000)
  const code = await run.exit
  clearTimeout(timer)
  assert.equal(code, 0, `the run did not finish: ${run.output()}`)
  assert.deepEqual(results(fakeLeadRecords(runDirOf(workspace)!)), ['refused: workspace/pipe is not a regular file', 'completed'])
})

test('collecting renames around a file or link in the way of a directory, and a directory in the way of a file; nothing outside is touched, and collecting again picks the same names', async () => {
  const { workspace, runDir, output } = queuedRun({})
  for (const dir of ['notes', 'link/new', 'sub']) mkdirSync(join(runDir, 'work', 'w', dir), { recursive: true })
  writeFileSync(join(runDir, 'work', 'w', 'notes', 'report.md'), 'r\n')
  writeFileSync(join(runDir, 'work', 'w', 'link', 'new', 'r.md'), 'n\n')
  writeFileSync(join(runDir, 'work', 'w', 'sub', 'x'), 'x\n')
  writeFileSync(join(runDir, 'work', 'w', 'top'), 't\n')
  const outside = plainDir('sous-outside-')
  writeFileSync(join(outside, 'collect.tmp'), 'keep\n')
  writeFileSync(join(output, 'notes'), 'a file from an earlier node\n') // a file where w has a directory
  const linked = plainDir('sous-outside-')
  symlinkSync(linked, join(output, 'link')) // a link where w has a directory
  mkdirSync(join(output, 'top')) // a directory where w has a file
  symlinkSync(outside, join(runDir, 'staging')) // an old staging link is never used
  // As if a stopped supervisor had collected notes/report.md already.
  mkdirSync(join(output, 'notes.w'))
  writeFileSync(join(output, 'notes.w', 'report.md'), 'r\n')
  const resumed = sous(['resume'], workspace, plainDir('sous-sessions-'), NO_GIT)
  assert.equal(await resumed.exit, 0, resumed.output())
  assert.deepEqual(readdirSync(linked), [])
  assert.deepEqual(readdirSync(outside), ['collect.tmp'])
  assert.equal(readFileSync(join(outside, 'collect.tmp'), 'utf8'), 'keep\n')
  assert.deepEqual(tree(output), ['link.w/new/r.md', 'notes', 'notes.w/report.md', 'sub/x', 'top.w'])
  assert.ok(!readdirSync(runDir).some((f) => f.startsWith('.collect-')), 'nothing staged is left behind')
  const done = readEvents(runDir).flatMap((e) => (e.type === 'merge.done' ? [e] : []))
  assert.deepEqual(done.map((e) => [e.files, e.renamed]), [[
    ['link.w/new/r.md', 'notes.w/report.md', 'sub/x', 'top.w'],
    { 'link/new/r.md': 'link.w/new/r.md', 'notes/report.md': 'notes.w/report.md', top: 'top.w' },
  ]])
})
