// Shared pieces of the worker adapters: starting a turn's process and reading harness output.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TURN_RESULT_SCHEMA } from '../types.ts'
import type { ParsedTurn, RunningTurn, TurnResult, TurnSpec } from '../types.ts'

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
    // A worker's identity comes from its own turn alone: an outer run's SOUS_* (sous running inside a sous worker) never
    // reaches it, also when the turn has none of its own (a standing node).
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SOUS_')))
    child = spawn(cmd, args, { cwd: spec.cwd, detached: true, stdio: ['pipe', out, err], env: { ...env, ...spec.env } })
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

/** sous's MCP server for a worker of the tree (one with `spec.env`), as the harness should start it. */
export function sousServer(spec: TurnSpec): { command: string; args: string[]; env: Record<string, string> } | undefined {
  if (!spec.env) return undefined
  // mcp.ts in the sources, mcp.js in the published package.
  return { command: process.execPath, args: [fileURLToPath(new URL(`../mcp${extname(import.meta.url)}`, import.meta.url))], env: spec.env }
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

/** For harnesses without a structured-output flag (Pi, Droid): the prompt asks for the result in a fence, and
 * `lastJsonFence` reads it back from the final message. */
export const RESULT_INSTRUCTION = [
  'When you finish, end your final message with your result as a JSON object in a ```json fenced block:',
  '{"status": "done" | "blocked" | "needs_input", "summary": "...", "question": "... (only when needs_input)",',
  '"note_for_parent": "... (optional)"}',
].join('\n')

export function lastJsonFence(text: string): string | undefined {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  return fences.at(-1)?.[1]
}

/** Poll a turn's output until `parse` finds its session ID; reject if the process exits first. For harnesses that
 * report the ID in the stream instead of taking it up front. */
export function sessionFromOutput(cmd: string, outFile: string, exit: Promise<Exit>, parse: (raw: string) => ParsedTurn): Promise<string> {
  const find = () => {
    try {
      return parse(readFileSync(outFile, 'utf8')).sessionId
    } catch {
      return undefined
    }
  }
  const id = new Promise<string>((resolve, reject) => {
    const timer = setInterval(() => {
      const found = find()
      if (found) {
        clearInterval(timer)
        resolve(found)
      }
    }, 100)
    const settle = () => {
      clearInterval(timer)
      const found = find()
      if (found) resolve(found)
      else reject(new Error(`${cmd} exited without reporting a session ID (see ${outFile})`))
    }
    exit.then(settle, settle)
  })
  // Callers that never ask for the ID must not crash the process with an unhandled rejection.
  id.catch(() => {})
  return id
}
