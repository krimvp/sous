// Shared pieces of the worker adapters: starting a turn's process and reading harness output.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutIdentity } from '../send.ts'
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
    // Also a turn without an identity of its own (a standing node) gets none of an outer run's.
    child = spawn(cmd, args, { cwd: spec.cwd, detached: true, stdio: ['pipe', out, err], env: { ...withoutIdentity(), ...spec.env } })
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

/** A harness count as a number: 0 unless it is a finite number. */
export const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A harness field as text: a string as is, nothing as '', an object or array as its JSON. */
export const str = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

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
  const { status, summary, question } = value as Record<string, unknown>
  if (typeof status !== 'string' || !STATUSES.includes(status) || typeof summary !== 'string') return undefined
  const result: TurnResult = { status: status as TurnResult['status'], summary }
  // Codex's strict schemas send absent optional fields as null.
  if (typeof question === 'string') result.question = question
  return result
}

/** For harnesses without a structured-output flag (Pi, Droid): how to give the result, whose fields every worker prompt
 * describes; `resultFromText` reads it back from the final message. */
export const RESULT_INSTRUCTION = 'End your final message with your structured result as a JSON object with the keys "status", ' +
  '"summary" and, when it applies, "question", in a ```json fenced block.'

/** The result in a final message: the last ```json fence (any case; its tag ends the line, or the object follows at once)
 * that holds one, else the whole message as a bare object. A later fence that holds none, such as an example, is
 * skipped, and so is "```json" in prose. */
export function resultFromText(text: string): TurnResult | undefined {
  const fences = [...text.matchAll(/```json[ \t]*(?:\r?\n|(?=\{))([\s\S]*?)```/gi)]
  for (const fence of fences.reverse()) {
    const result = toTurnResult(fence[1]!.trim())
    if (result) return result
  }
  return toTurnResult(text.trim())
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
