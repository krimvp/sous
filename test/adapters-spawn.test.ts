// The shared spawn helper with real processes: no harness, no model.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnTurn } from '../src/adapters/common.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'sous-spawn-'))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return
  assert.fail('timed out')
}

test('SIGKILL to -pid stops the turn and the grandchildren it started', async () => {
  const cwd = tempDir()
  const spec = { nodeId: 'n', turn: 1, cwd, prompt: '', outFile: join(cwd, 'out.jsonl'), errFile: join(cwd, 'err.txt') }
  // The grandchild ignores the parent dying, the way Codex's real process outlives its launcher.
  const turn = spawnTurn('sh', ['-c', 'sleep 300 & echo $! > grandchild.pid; wait'], spec)
  const file = join(cwd, 'grandchild.pid')
  await until(() => {
    try {
      return readFileSync(file, 'utf8').endsWith('\n')
    } catch {
      return false
    }
  })
  const grandchild = Number(readFileSync(file, 'utf8'))
  assert.ok(alive(grandchild))

  process.kill(-turn.pid, 'SIGKILL')
  assert.deepEqual(await turn.exit, { code: null, signal: 'SIGKILL' })
  await until(() => !alive(grandchild))
})

test('the prompt arrives on stdin and output reaches outFile after the starting process has exited', async () => {
  const cwd = tempDir()
  const spec = { nodeId: 'n', turn: 1, cwd, prompt: 'hello turn', outFile: join(cwd, 'out.jsonl'), errFile: join(cwd, 'err.txt') }
  // A stand-in supervisor starts a turn that writes after a delay, then exits at once.
  const helper = new URL('../src/adapters/common.ts', import.meta.url).href
  const script = `
    import { spawnTurn } from ${JSON.stringify(helper)}
    const spec = ${JSON.stringify(spec)}
    spawnTurn('sh', ['-c', 'read line; sleep 0.5; echo "got $line"; echo oops >&2'], spec)
    process.exit(0)
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script])
  await until(() => readFileSync(spec.outFile, 'utf8') === 'got hello turn\n')
  await until(() => readFileSync(spec.errFile, 'utf8') === 'oops\n')
})

test('workers load no MCP server but sous\'s and none of the person\'s own instructions; the project\'s stay', async () => {
  const bin = tempDir()
  const rec = join(bin, 'rec.jsonl')
  // Stand-ins that record their arguments and the identity in their environment; a Codex stand-in also lists the
  // user's MCP servers, as `codex mcp list --json` does.
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === 'mcp') { console.log(JSON.stringify([{ name: 'comitia' }, { name: 'docs' }])); process.exit(0) }
appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ cmd: require('node:path').basename(process.argv[1]), argv, node: process.env.SOUS_NODE ?? null }) + '\\n')
`
  for (const name of ['claude', 'codex', 'pi']) writeFileSync(join(bin, name), script, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const { claude, codex, pi } = await import('../src/adapters/index.ts').then((m) => ({ claude: m.getAdapter('claude'), codex: m.getAdapter('codex'), pi: m.getAdapter('pi') }))
    const cwd = tempDir()
    writeFileSync(join(cwd, 'AGENTS.md'), '# Project rules\n')
    const spec = (turn: number, env?: Record<string, string>) =>
      ({ nodeId: 'a', turn, cwd, prompt: 'p', outFile: join(cwd, `${turn}.jsonl`), errFile: join(cwd, `${turn}.err`), ...(env ? { env } : {}) })
    const env = { SOUS_RUN_DIR: '/run', SOUS_NODE: 'a' }
    for (const [i, turn] of [claude.start(spec(1, env)), claude.start(spec(2)), codex.start(spec(3, env)), pi.start(spec(4, env))].entries()) {
      await turn.exit
      await until(() => readFileSync(rec, 'utf8').trim().split('\n').length > i)
    }
    // The four turns run at once, so their records come in any order.
    const recs = readFileSync(rec, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const of = (cmd: string, node: string | null) => recs.find((r) => r.cmd === cmd && r.node === node)
    const [withSous, standing, cx, p] = [of('claude', 'a'), of('claude', null), of('codex', 'a'), of('pi', 'a')]
    const server = { command: process.execPath, args: [new URL('../src/mcp.ts', import.meta.url).pathname], env }
    const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]
    assert.ok(withSous.argv.includes('--strict-mcp-config'))
    assert.equal(after(withSous.argv, '--setting-sources'), 'project,local')
    assert.deepEqual(JSON.parse(after(withSous.argv, '--mcp-config')), { mcpServers: { sous: { type: 'stdio', ...server } } })
    assert.equal(withSous.node, 'a')
    assert.ok(standing.argv.includes('--strict-mcp-config') && !standing.argv.includes('--mcp-config'), 'a standing node gets no MCP server')
    const overrides = cx.argv.flatMap((a: string, i: number) => (cx.argv[i - 1] === '-c' ? [a] : []))
    assert.deepEqual(overrides.filter((o: string) => o.startsWith('features') || o.startsWith('skills')),
      ['features.hooks=false', 'skills.include_instructions=false', 'features.apps=false', 'features.plugins=false'])
    assert.ok(cx.argv.includes('--ignore-rules'))
    assert.deepEqual(overrides.filter((o: string) => o.startsWith('mcp_servers')), [
      'mcp_servers.comitia.enabled=false', 'mcp_servers.docs.enabled=false',
      `mcp_servers.sous={command=${JSON.stringify(server.command)},args=[${JSON.stringify(server.args[0])}],env={SOUS_RUN_DIR="/run",SOUS_NODE="a"},tool_timeout_sec=90}`,
    ])
    for (const flag of ['--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(p.argv.includes(flag), flag)
    assert.equal(after(p.argv, '--append-system-prompt'), join(cwd, 'AGENTS.md'))
    assert.equal(p.node, 'a')
  } finally {
    process.env.PATH = path
  }
})
