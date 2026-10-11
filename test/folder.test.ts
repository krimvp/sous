// Folder mode (no git) end to end through real `sous` processes, and the leads' read-only file tools in both modes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { fakeBin, sous } from './fixtures/sous-proc.ts'
import type { FakeStep } from './fixtures/fake-worker.ts'

const done = (summary: string) => ({ status: 'done' as const, summary })
const work = (id: string, steps: FakeStep[], needs?: string[]) =>
  ({ id, kind: 'work' as const, brief: `Do ${id}.\n${fakePlan(steps)}`, ...(needs ? { needs } : {}) })
/** A PATH with a claude stand-in and the tools checks use, but no git: nothing in folder mode may run git. */
const NO_GIT = fakeBin(['claude'], ['sh', 'grep', 'mkdir'])
const plainDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
/** Every file under `dir`, relative, sorted. */
const tree = (dir: string): string[] => (readdirSync(dir, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
  .filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(dir.length + 1)).sort()
const results = (fake: { op: string; result?: string }[]) => fake.flatMap((r) => (r.op === 'act' ? [r.result!] : []))

test('folder mode without git: a lead looks first, workers write in their own folders, files are collected with a rename on a clash, and a check reads the results', async () => {
  const workspace = plainDir('sous-folder-')
  const sessions = plainDir('sous-sessions-')
  writeFileSync(join(workspace, 'input.txt'), 'three facts\n')
  const children = [
    work('a', [{ write: { 'summary.md': 'A\n', 'same.txt': 'same\n' }, sh: 'mkdir notes && echo n > notes/a.md', result: done('summarised') }]),
    work('b', [{ write: { 'summary.md': 'B\n', 'same.txt': 'same\n' }, result: done('summarised again') }], ['a']),
    { id: 'c', kind: 'check' as const, command: 'grep -qx A summary.md && grep -qx B summary.b.md && grep -qx same same.txt', needs: ['b'] },
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
  assert.deepEqual(tree(output), ['notes/a.md', 'same.txt', 'summary.b.md', 'summary.md'])
  assert.equal(readFileSync(join(output, 'summary.b.md'), 'utf8'), 'B\n')
  assert.deepEqual(readdirSync(workspace).sort(), ['.sous', 'graph.json', 'input.txt'], 'the workspace is only read')

  const events = readEvents(runDir)
  const state = fold(events)
  assert.equal(state.mode, 'folder')
  assert.equal(state.status, 'completed')
  assert.ok(!events.some((e) => e.type === 'integration.created' || e.type === 'worktree.created'))
  const merged = events.flatMap((e) => (e.type === 'merge.done' ? [[e.node, e.by, e.files, e.renamed]] : []))
  assert.deepEqual(merged, [
    ['a', 'supervisor', ['notes/a.md', 'same.txt', 'summary.md'], undefined],
    ['b', 'supervisor', ['same.txt', 'summary.b.md'], { 'summary.md': 'summary.b.md' }],
  ])
  // The lead is told which files each child produced, and about the rename.
  const told = (requestId: string) => events.find((e): e is Event & { type: 'lead.delivered' } => e.type === 'lead.delivered' && e.requestId === requestId)!.text
  const outcomeB = told(`evt-${state.nodes.get('b')!.endSeq}`)
  assert.equal(outcomeB, 'Child b completed: summarised again\nFiles: same.txt, summary.b.md\nsummary.md was saved as summary.b.md: the results already had a different summary.md.')
  assert.match(told('lead:brief'), /workspace\/ holds the inputs, results\/ the files your children produced so far/)

  // The worker ran in its own folder and was told where its inputs and the results are.
  const a = state.nodes.get('a')!
  const prompt = JSON.parse(readFileSync(join(sessions, `${a.turns[0].sessionId}.json`), 'utf8')).prompts[0]
  assert.match(prompt, new RegExp(`Inputs: the workspace ${workspace}\\. Read it; do not modify it\\.`))
  assert.match(prompt, new RegExp(`Results of earlier tasks so far: ${output}\\.`))
  assert.match(prompt, new RegExp(`Write your own output files in your current directory, ${join(runDir, 'work', 'a')};`))
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
  assert.match(JSON.stringify(doc), /2 files added to the results/)
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
