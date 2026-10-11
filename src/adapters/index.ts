import type { HarnessName, WorkerAdapter } from '../types.ts'

// Filled in by the adapters track: one module per harness.
const adapters: Partial<Record<HarnessName, WorkerAdapter>> = {}

export function getAdapter(name: HarnessName): WorkerAdapter {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`no adapter for harness ${name}`)
  return adapter
}
