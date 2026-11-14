// The worker adapters: one per CLI harness, each starting and resuming a worker's turns and parsing their output.
import type { HarnessName, WorkerAdapter } from '../contracts/index.ts'
import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { droid } from './droid.ts'
import { pi } from './pi.ts'

export { listCodexServers } from './codex.ts'

const adapters: Record<HarnessName, WorkerAdapter> = { claude, codex, pi, droid }

export function getAdapter(name: HarnessName): WorkerAdapter {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`no adapter for harness ${name}`)
  return adapter
}
