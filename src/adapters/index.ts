import type { HarnessName, WorkerAdapter } from '../types.ts'
import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { pi } from './pi.ts'

const adapters: Record<HarnessName, WorkerAdapter> = { claude, codex, pi }

export function getAdapter(name: HarnessName): WorkerAdapter {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`no adapter for harness ${name}`)
  return adapter
}
