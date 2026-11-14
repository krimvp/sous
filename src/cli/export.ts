// `sous export atif|otlp`: a run's trace, written as an ATIF file in its run directory or posted to Langfuse as OTLP.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessName, ParsedTurn } from '../contracts/index.ts'
import { exportAtif, exportOtlp } from '../trace/index.ts'
import type { CliDeps } from './deps.ts'
import { findRun } from './lookup.ts'

export async function exportRun(format: 'atif' | 'otlp', workspace: string, deps: CliDeps, runId?: string): Promise<number> {
  const { runDir } = findRun(workspace, runId)
  const parse = (h: HarnessName, raw: string): ParsedTurn => deps.getAdapter(h).parse(raw)
  if (format === 'atif') {
    const file = join(runDir, 'trace.atif.json')
    writeFileSync(file, exportAtif(runDir, parse))
    console.log(file)
  } else {
    console.log(`trace ${await exportOtlp(runDir, parse)}`)
  }
  return 0
}
