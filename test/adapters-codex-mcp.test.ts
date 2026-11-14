// What the Codex adapter does when it cannot know which MCP servers Codex loads: `codex mcp list` fails or answers
// something else, or the project's own configuration holds a server table it cannot read or a name no override can
// address. (The servers it can disable are in adapters-spawn.test.ts.) Each case runs in a process of its own, because
// the adapter lists the servers once per process.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const TURNS = new URL('./helpers/codex-turns.ts', import.meta.url).pathname
const tempDir = () => mkdtempSync(join(tmpdir(), 'sous-codex-mcp-'))

/** `body` is what a stand-in `codex mcp list --json` does; any other command records its arguments and ends. */
function standIn(body: string) {
  const bin = tempDir()
  const [record, count] = [join(bin, 'argv'), join(bin, 'listed')]
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === 'mcp') {
  fs.appendFileSync(${JSON.stringify(count)}, 'x')
  ${body}
}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(argv) + '\\n')
`, { mode: 0o755 })
  const read = (file: string) => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  return {
    bin,
    listed: () => read(count).length,
    /** The `mcp_servers…` overrides of each turn started. */
    turns: () => read(record).split('\n').filter(Boolean).map((l) => {
      const argv: string[] = JSON.parse(l)
      return argv.filter((a, i) => argv[i - 1] === '-c' && a.startsWith('mcp_servers'))
    }),
  }
}

/** Starts `turns` Codex turns in `cwd` with only `bin` on PATH; returns what sous said on stderr, line by line. */
function said(bin: string, cwd: string, turns: number, list: boolean): string[] {
  const r = spawnSync(process.execPath, [TURNS, cwd, String(turns), ...(list ? ['list'] : [])], { encoding: 'utf8', env: { ...process.env, PATH: bin } })
  assert.equal(r.status, 0, r.stderr)
  return r.stderr.split('\n').filter(Boolean)
}

test('a failing `codex mcp list` is said once at run start, and no turn lists again', () => {
  const stub = standIn("process.stderr.write('not logged in\\n'); process.exit(1)")
  const lines = said(stub.bin, tempDir(), 2, true)
  // One message, with what the command said on stderr in it.
  assert.match(lines.join('\n'), /^sous: cannot list Codex's MCP servers \(.*not logged in\n\); Codex workers may load them$/s)
  assert.deepEqual(stub.turns(), [[], []])
  assert.equal(stub.listed(), 1)
})

test('a missing codex command, and an answer that is not a list of servers, are said too', () => {
  const lines = said(tempDir(), tempDir(), 0, true)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^sous: cannot list Codex's MCP servers \(.*ENOENT.*\); Codex workers may load them$/)

  // Without a listing at run start, the first turn lists them (as when the adapter is used on its own).
  const stub = standIn("console.log('{\"servers\": []}'); process.exit(0)")
  assert.deepEqual(said(stub.bin, tempDir(), 2, false), ["sous: cannot list Codex's MCP servers (not a list); Codex workers may load them"])
  assert.equal(stub.listed(), 1, 'the second turn does not list again')
})

test("a project's inline mcp_servers table and a server name no override can address are said, and the readable ones are still disabled", () => {
  const stub = standIn("console.log('[]'); process.exit(0)")
  const cwd = tempDir()
  mkdirSync(join(cwd, '.codex'))
  const file = join(cwd, '.codex', 'config.toml')
  writeFileSync(file, [
    'mcp_servers = { inline = { command = "i" } }',
    '[mcp_servers."bad name"]', 'command = "b"',
    '[mcp_servers.fine]', 'command = "f"',
  ].join('\n'))
  assert.deepEqual(said(stub.bin, cwd, 1, true), [
    `sous: cannot read the inline mcp_servers table of ${file}; Codex workers may load its servers`,
    `sous: cannot disable Codex's MCP server "bad name" of ${file}; Codex workers may load it`,
  ])
  assert.deepEqual(stub.turns(), [['mcp_servers.fine={command="false",args=[],enabled=false}']])
})
