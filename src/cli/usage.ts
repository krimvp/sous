// The usage text of the sous command, one command's lines of it, and the usage error a command line that was not
// understood gets.
import { MAX_WAIT_SECONDS } from '../commands/index.ts'

const USAGE = `usage:
  sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--approve-splits] [--workspace <dir>]
  sous resume [run-id] [--workspace <dir>]
  sous status [run-id] [--workspace <dir>]
  sous runs [--workspace <dir>]  (the workspace's runs, newest first)
  sous answer <node> "text" [run-id] [--workspace <dir>]
  sous approve <node> [run-id] [--workspace <dir>]
  sous cancel <node> [run-id] [--workspace <dir>]
  sous send <to> 'text'          (a worker of a running run, to a sibling or its lead)
  sous receive [seconds]         (a worker: the messages waiting for it, waiting up to ${MAX_WAIT_SECONDS} seconds for one)
  sous export atif|otlp [run-id] [--workspace <dir>]
  sous --help | --version        (sous <command> --help shows one command)
  sous ui [--port <n>] [--workspace <dir>]   (a local page showing the workspace's runs, live or finished)
  sous doctor [--workspace <dir>]  (whether a run could start here: harnesses and versions, lead credentials, git state)`

/** The usage lines of `command`, or all of them when it names none. */
export function usageOf(command?: string): string {
  const own = USAGE.split('\n').filter((line) => line.startsWith(`  sous ${command} `))
  return command !== undefined && own.length ? `usage:\n${own.join('\n')}` : USAGE
}

/** One line saying what was wrong, then the usage, on stderr; the exit code for a command that was not understood. */
export function usageError(problem?: string): number {
  console.error(problem === undefined ? USAGE : `sous: ${problem}\n${USAGE}`)
  return 2
}
