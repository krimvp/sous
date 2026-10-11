// Shared pieces of the worker adapters: starting a turn's process and reading harness output.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { TURN_RESULT_SCHEMA } from '../types.ts'
import type { RunningTurn, TurnResult, TurnSpec } from '../types.ts'

export type Exit = Awaited<RunningTurn['exit']>

/**
 * Start `cmd` as the leader of its own process group. The prompt goes on stdin; stdout and stderr go
 * straight to the turn's files through file descriptors, so the output survives the supervisor.
 */
export function spawnTurn(cmd: string, args: string[], spec: TurnSpec): { pid: number; exit: Promise<Exit> } {
  mkdirSync(dirname(spec.outFile), { recursive: true })
  mkdirSync(dirname(spec.errFile), { recursive: true })
  const out = openSync(spec.outFile, 'w')
  const err = openSync(spec.errFile, 'w')
  let child
  try {
    child = spawn(cmd, args, { cwd: spec.cwd, detached: true, stdio: ['pipe', out, err] })
  } finally {
    // The child holds its own copies of the descriptors.
    closeSync(out)
    closeSync(err)
  }
  const exit = new Promise<Exit>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', reject)
  })
  if (child.pid === undefined) {
    exit.catch(() => {})
    throw new Error(`could not start ${cmd} in ${spec.cwd}`)
  }
  // A process that exits without reading its prompt closes the pipe; that is not our error to raise.
  child.stdin?.on('error', () => {})
  child.stdin?.end(spec.prompt)
  return { pid: child.pid, exit }
}

// Harness output is data from another program: every field is optional and may have any type.
export type Json = Record<string, any>

/** The JSON objects of a JSON-lines stream. Skips blank, truncated or otherwise unparsable lines. */
export function jsonLines(raw: string): Json[] {
  const found: Json[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value as Json)
    } catch {
      // A truncated last line, or noise.
    }
  }
  return found
}

/** A harness content field as text: a string, or the text parts of an array of blocks. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

const STATUSES: readonly string[] = TURN_RESULT_SCHEMA.properties.status.enum

/** A TurnResult from a parsed object or a JSON string, or undefined when it does not match the schema. */
export function toTurnResult(value: unknown): TurnResult | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const { status, summary, question, note_for_parent } = value as Record<string, unknown>
  if (typeof status !== 'string' || !STATUSES.includes(status) || typeof summary !== 'string') return undefined
  const result: TurnResult = { status: status as TurnResult['status'], summary }
  // Codex's strict schemas send absent optional fields as null.
  if (typeof question === 'string') result.question = question
  if (typeof note_for_parent === 'string') result.note_for_parent = note_for_parent
  return result
}
