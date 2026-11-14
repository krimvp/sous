// The published package: compiled to JavaScript, because Node does not strip types from files under node_modules.
// Builds it into a temporary node_modules, as an install leaves it, and runs it from there.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('the package runs from node_modules, and its MCP server and send command are its own compiled files', async () => {
  const pkg = join(mkdtempSync(join(tmpdir(), 'sous-package-')), 'node_modules', '@krimvp', 'sous')
  mkdirSync(pkg, { recursive: true })
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist')])
  cpSync(join(ROOT, 'src', 'ui', 'page.html'), join(pkg, 'dist', 'ui', 'page.html'))
  cpSync(join(ROOT, 'package.json'), join(pkg, 'package.json'))
  symlinkSync(join(ROOT, 'node_modules'), join(pkg, 'node_modules'))
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  const bin = join(pkg, manifest.bin.sous)
  for (const file of manifest.files) if (file !== 'dist') assert.ok(existsSync(join(ROOT, file)), `${file} ships`)

  const usage = spawnSync(process.execPath, [bin], { encoding: 'utf8' })
  assert.match(usage.stderr + usage.stdout, /^usage:\n {2}sous run/m)
  assert.equal(spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).stdout, `${manifest.version}\n`)
  assert.equal(readFileSync(bin, 'utf8').split('\n')[0], '#!/usr/bin/env node')

  const { sousServer } = await import(pathToFileURL(join(pkg, 'dist', 'adapters', 'common.js')).href)
  const server = sousServer({ env: { SOUS_NODE: 'n' } })
  assert.equal(server.args[0], join(pkg, 'dist', 'mcp.js'))
  assert.ok(existsSync(server.args[0]))
  const { composeBrief } = await import(pathToFileURL(join(pkg, 'dist', 'prompts', 'index.js')).href)
  const brief: string = composeBrief('goal', { id: 'a', kind: 'work', brief: 'b' }, '/w', [], [], undefined, { lead: 'L', siblings: [], max: 5, maxWait: 60 })
  assert.ok(brief.includes(`'${join(pkg, 'dist', 'cli.js')}' send`), 'the send command runs the compiled CLI')
})
