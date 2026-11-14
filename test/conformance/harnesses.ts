// What every harness must declare to take part in the conformance suite. A harness added to HARNESSES (src/types.ts)
// fails type checking until it has an entry here, and the suite until its recordings exist and pass.
//
// test/conformance.test.ts runs free, on every `npm run check`: recordings and a stand-in CLI.
// test/conformance-live.test.ts runs the real CLI (`npm run certify`, costs money). A harness merges to main only with
// a passing certification recorded in its PR.

import { readFileSync } from 'node:fs'
import type { HarnessName } from '../../src/types.ts'

export interface Conformance {
  /** The `type` of the event that ends a turn in the harness's output. */
  endMarker: string
  /** Whether workers get sous's MCP server (else they run `sous send` / `sous receive`). */
  mcp: boolean
  /** Model for live certification; undefined uses the harness's configured default. */
  liveModel?: string
  /** Whether the harness has a `lead` recording, made by a passing lead certification, which the free suite checks. A
   * harness whose adapter has a lead mode (`WorkerAdapter.lead`) runs the lead tests whenever it is certified; it may
   * join LEAD_HARNESSES (src/types.ts) once those passed and this is true. */
  lead: boolean
}

export const CONFORMANCE: Record<HarnessName, Conformance> = {
  claude: { endMarker: 'result', mcp: true, liveModel: 'haiku', lead: true },
  codex: { endMarker: 'turn.completed', mcp: true, lead: false },
  pi: { endMarker: 'agent_end', mcp: false, lead: false },
  droid: { endMarker: 'completion', mcp: true, lead: false },
}

/** Recordings every harness keeps under test/fixtures/conformance/<harness>/, made by `SOUS_RECORD=1 npm run certify`:
 * - `read-file`: reads note.txt ("The secret fruit is mango.") with one tool call and ends `done`;
 * - `needs-input`: ends `needs_input` with a question;
 * - `stopped`: stopped by the supervisor while running a shell command, so it never reaches its end marker.
 * A harness with `lead` also keeps `lead`: a lead turn (LEAD_PROMPT) that reads plan.md and ends with a lead result
 * whose calls spawn work and a check; a lead certification writes it when it is missing. */
export const RECORDINGS = ['read-file', 'needs-input', 'stopped'] as const
export type Recording = (typeof RECORDINGS)[number] | 'lead'

/** The recordings of `harness`. */
export const recordingsOf = (harness: HarnessName): Recording[] => [...RECORDINGS, ...(CONFORMANCE[harness].lead ? ['lead' as const] : [])]

export const recordingUrl = (harness: HarnessName, name: Recording) =>
  new URL(`../fixtures/conformance/${harness}/${name}.jsonl`, import.meta.url)

/** Written by every live certification: the CLI version, model, date and the tests that passed. */
export const certifiedUrl = (harness: HarnessName) => new URL(`../fixtures/conformance/${harness}/certified.json`, import.meta.url)

export const recording = (harness: HarnessName, name: Recording) => readFileSync(recordingUrl(harness, name), 'utf8')

/** The tests whose passing, in certified.json, lets a harness lead. */
export const LEAD_TESTS = [
  'a lead turn reads the files and returns valid calls',
  'a lead asked to create a file creates none',
  'a resumed lead remembers its earlier turn',
  'a sous run whose lead runs on the harness splits into work and a check and completes',
  'a supervisor killed during a lead turn: sous resume completes the run, each spawn recorded once',
] as const

export const NOTE = 'The secret fruit is mango.'
export const PLAN = 'Add a function sub(a, b) to math.js next to add, and a test file math.test.js for both, run with node --test.\n'
export const LEAD_PROMPT = 'You are lead lead, the top-level lead (depth 1 of 3). Your task: carry out the plan in plan.md. Read it first. ' +
  'Split it into work children and end with a check child whose command verifies the result. Agents a child may name: ' +
  'for work children worker (default worker).'
export const READ_FILE_PROMPT = 'Read note.txt with your file-reading tool and tell me which fruit it names. Finish with status done.'
export const NEEDS_INPUT_PROMPT = 'Before doing anything you must ask me which colour to paint the button. Do not use any tools. ' +
  'Finish with status needs_input and that question.'
