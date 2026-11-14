#!/usr/bin/env node
// sous: run a graph file or a goal, resume a stopped run, show a run's status, answer, approve and cancel nodes of a
// running run.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from './cli/index.ts'

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ getAdapter, listCodexServers }, { createLeadRunner, leadCredential, loginProblem }] = await Promise.all([import('./adapters/index.ts'), import('./lead/index.ts')])
  process.exitCode = await main(process.argv.slice(2), { getAdapter, createLeadRunner, leadCredential, listCodexServers, loginProblem })
}
