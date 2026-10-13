// What the Codex adapter does when it cannot know which MCP servers Codex loads: `codex mcp list` fails or answers
// something else, or the project's own configuration holds a server table it cannot read or a name no override can
// address. (The servers it can disable are in adapters-spawn.test.ts.)

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TurnSpec, WorkerAdapter } from '../src/types.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'sous-codex-mcp-'))

let fresh = 0
/** A copy of the Codex adapter with its own memory of the listing, which the module keeps once per process. */
async function codexAdapter(): Promise<{ codex: WorkerAdapter; listCodexServers: () => Promise<void> }> {
  return await import(`../src/adapters/codex.ts?copy=${fresh++}`)
}

/** `body` is what the stand-in `codex mcp list --json` does; any other command records its arguments and ends. */
function standIn(body: string): { bin: string; record: string; listed: () => number } {
  const bin = tempDir()
  const [record, count] = [join(bin, 'argv.json'), join(bin, 'listed')]
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === 'mcp') {
  fs.appendFileSync(${JSON.stringify(count)}, 'x')
  ${body}
}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(argv))
`, { mode: 0o755 })
  return { bin, record, listed: () => { try { return readFileSync(count, 'utf8').length } catch { return 0 } } }
}

/** Runs `fn` with `bin` first on PATH and collects what sous says on stderr. */
async function said(bin: string, fn: () => Promise<void>): Promise<string[]> {
  const [path, error] = [process.env.PATH, console.error]
  const lines: string[] = []
  process.env.PATH = bin
  console.error = (...args: unknown[]) => lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    process.env.PATH = path
    console.error = error
  }
  return lines
}

async function turnArgv(codex: WorkerAdapter, stub: { record: string }, cwd: string): Promise<string[]> {
  const spec: TurnSpec = { nodeId: 'a', turn: 1, cwd, prompt: 'p', outFile: join(cwd, 'out.jsonl'), errFile: join(cwd, 'err.txt') }
  await codex.start(spec).exit
  return JSON.parse(readFileSync(stub.record, 'utf8'))
}

const overrides = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === '-c' && a.startsWith('mcp_servers') ? [a] : []))

test('a failing `codex mcp list` is said once at run start, and no turn lists again', async () => {
  const stub = standIn("process.stderr.write('not logged in\\n'); process.exit(1)")
  const { codex, listCodexServers } = await codexAdapter()
  const lines = await said(stub.bin, listCodexServers)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^sous: cannot list Codex's MCP servers \(.*not logged in.*\); Codex workers may load them$/s)
  const cwd = tempDir()
  const quiet = await said(stub.bin, async () => {
    assert.deepEqual(overrides(await turnArgv(codex, stub, cwd)), [])
  })
  assert.deepEqual(quiet, [], "nothing more is said")
  assert.equal(stub.listed(), 1)
})

test('a missing codex command, and an answer that is not a list of servers, are said too', async () => {
  const missing = await codexAdapter()
  const lines = await said(tempDir(), missing.listCodexServers)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^sous: cannot list Codex's MCP servers \(.*ENOENT.*\); Codex workers may load them$/)

  // Without a listing at run start, the first turn lists them (as when the adapter is used on its own).
  const stub = standIn("console.log('{\"servers\": []}'); process.exit(0)")
  const alone = await codexAdapter()
  const cwd = tempDir()
  const out = await said(stub.bin, async () => {
    await turnArgv(alone.codex, stub, cwd)
    await turnArgv(alone.codex, stub, cwd)
  })
  assert.deepEqual(out, ["sous: cannot list Codex's MCP servers (not a list); Codex workers may load them"])
  assert.equal(stub.listed(), 1, 'the second turn does not list again')
})

test("a project's inline mcp_servers table and a server name no override can address are said, and the readable ones are still disabled", async () => {
  const stub = standIn("console.log('[]'); process.exit(0)")
  const { codex, listCodexServers } = await codexAdapter()
  const cwd = tempDir()
  mkdirSync(join(cwd, '.codex'))
  const file = join(cwd, '.codex', 'config.toml')
  writeFileSync(file, [
    'mcp_servers = { inline = { command = "i" } }',
    '[mcp_servers."bad name"]', 'command = "b"',
    '[mcp_servers.fine]', 'command = "f"',
  ].join('\n'))
  let argv: string[] = []
  const lines = await said(stub.bin, async () => {
    await listCodexServers()
    argv = await turnArgv(codex, stub, cwd)
  })
  assert.deepEqual(lines, [
    `sous: cannot read the inline mcp_servers table of ${file}; Codex workers may load its servers`,
    `sous: cannot disable Codex's MCP server "bad name" of ${file}; Codex workers may load it`,
  ])
  assert.deepEqual(overrides(argv), ['mcp_servers.fine={command="false",args=[],enabled=false}'])
})
