// What every harness must declare to take part in the conformance suite. A harness added to HARNESSES (src/contracts/workers.ts)
// fails type checking until it has an entry here, and the suite until its recordings exist and pass.
//
// test/conformance.test.ts runs free, on every `npm run check`: recordings and a stand-in CLI.
// test/conformance-live.test.ts runs the real CLI (`npm run certify`, costs money). A harness merges to main only with
// a passing certification recorded in its PR.

import { readFileSync } from 'node:fs'
import type { HarnessName } from '../../src/contracts/index.ts'

export interface Conformance {
  /** The `type` of the event that ends a turn in the harness's output. */
  endMarker: string
  /** Whether workers get sous's MCP server (else they run `sous send` / `sous receive`). */
  mcp: boolean
  /** Model for live certification; undefined uses the harness's configured default. */
  liveModel?: string
}

export const CONFORMANCE: Record<HarnessName, Conformance> = {
  claude: { endMarker: 'result', mcp: true, liveModel: 'haiku' },
  codex: { endMarker: 'turn.completed', mcp: true },
  pi: { endMarker: 'agent_end', mcp: false },
  droid: { endMarker: 'completion', mcp: true },
}

/** Recordings every harness keeps under test/fixtures/conformance/<harness>/, made by `SOUS_RECORD=1 npm run certify`:
 * - `read-file`: reads note.txt ("The secret fruit is mango.") with one tool call and ends `done`;
 * - `needs-input`: ends `needs_input` with a question;
 * - `stopped`: stopped by the supervisor while running a shell command, so it never reaches its end marker. */
export const RECORDINGS = ['read-file', 'needs-input', 'stopped'] as const
export type Recording = (typeof RECORDINGS)[number]

export const recordingUrl = (harness: HarnessName, name: Recording) =>
  new URL(`../fixtures/conformance/${harness}/${name}.jsonl`, import.meta.url)

/** Written by every live certification: the CLI version, model, date and the tests that passed. */
export const certifiedUrl = (harness: HarnessName) => new URL(`../fixtures/conformance/${harness}/certified.json`, import.meta.url)

export const recording = (harness: HarnessName, name: Recording) => readFileSync(recordingUrl(harness, name), 'utf8')

export const NOTE = 'The secret fruit is mango.'
export const READ_FILE_PROMPT = 'Read note.txt with your file-reading tool and tell me which fruit it names. Finish with status done.'
export const NEEDS_INPUT_PROMPT = 'Before doing anything you must ask me which colour to paint the button. Do not use any tools. ' +
  'Finish with status needs_input and that question.'
