// The module structure of src/: every directory is a module whose index.ts is its only interface, and modules import
// only the modules this table allows. The entries cli.ts and mcp.ts are programs: nothing imports them.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** What each module, and each entry, may import. self.ts is a module of one file. */
const ALLOWED: Record<string, string[]> = {
  contracts: [],
  self: [],
  workspace: [],
  definitions: ['contracts'],
  run: ['contracts', 'definitions'],
  commands: ['contracts', 'run'],
  prompts: ['contracts', 'definitions', 'run', 'self'],
  trace: ['contracts', 'definitions', 'run', 'self'],
  adapters: ['contracts', 'commands', 'self'],
  lead: ['contracts', 'definitions'],
  ui: ['contracts', 'run', 'trace'],
  supervisor: ['contracts', 'definitions', 'run', 'workspace', 'commands', 'prompts'],
  cli: ['contracts', 'self', 'definitions', 'run', 'workspace', 'commands', 'supervisor', 'trace', 'ui'],
  'cli.ts': ['cli', 'adapters', 'lead'],
  'mcp.ts': ['contracts', 'run', 'commands', 'self'],
}
const ENTRIES = ['cli.ts', 'mcp.ts']

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))

/** A file's module: its directory under src/, or the file itself (`self.ts` is the module `self`). */
const moduleOf = (path: string) => {
  const [first, ...rest] = relative(SRC, path).split('/')
  return rest.length ? first : first === 'self.ts' ? 'self' : first
}

/** The relative specifiers a file imports or re-exports, statically or dynamically. */
const imports = (text: string) => [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'(\.[^']*)'/g)].map((m) => m[1])

test('every directory under src/ is a module with an index.ts and a row in the table', () => {
  for (const name of readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory())) {
    assert.ok(existsSync(join(SRC, name, 'index.ts')), `src/${name}/ has no index.ts`)
    assert.ok(name in ALLOWED, `src/${name}/ is not in the dependency table`)
  }
})

test('modules import each other only through index.ts, only as the table allows, and never an entry', () => {
  const problems: string[] = []
  for (const file of files(SRC).filter((f) => f.endsWith('.ts'))) {
    const from = moduleOf(file)
    for (const spec of imports(readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), spec)
      const to = moduleOf(target)
      const where = `${relative(SRC, file)} imports ${spec}`
      if (to === from) continue
      if (ENTRIES.includes(to)) problems.push(`${where}: an entry is a program, not a module`)
      else if (to !== 'self' && relative(SRC, target) !== `${to}/index.ts`) problems.push(`${where}: go through ../${to}/index.ts`)
      if (!(ALLOWED[from] ?? []).includes(to)) problems.push(`${where}: ${from} may not import ${to}`)
    }
  }
  assert.deepEqual(problems, [])
})
