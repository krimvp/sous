#!/usr/bin/env node
// sous, the program: it gives the CLI (src/cli/) the real worker adapters and lead runner and runs the command line.
// What it takes is the usage text in src/cli/usage.ts.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from './cli/index.ts'

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ getAdapter, listCodexServers }, { createLeadRunner, leadCredential, loginProblem }] = await Promise.all([import('./adapters/index.ts'), import('./lead/index.ts')])
  process.exitCode = await main(process.argv.slice(2), { getAdapter, createLeadRunner, leadCredential, listCodexServers, loginProblem })
}
