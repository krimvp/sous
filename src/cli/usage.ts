// The usage text of the sous command, one command's lines of it, and the usage error a command line that was not
// understood gets.
import { MAX_WAIT_SECONDS } from '../commands/index.ts'

const USAGE = `usage:
  sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--max-cost <usd>] [--approve-splits] [--workspace <dir>]
  sous resume [run-id] [--max-cost <usd>] [--workspace <dir>]  (--max-cost: stop once the cost turns report reaches it)
  sous status [run-id] [--json] [--workspace <dir>]
  sous wait [run-id] [--timeout <seconds>] [--json] [--workspace <dir>]  (until the run needs you or is over; exit 0 completed, 3 failed, 4 waits for you, 5 stopped, 6 timeout)
  sous runs [--workspace <dir>]  (the workspace's runs, newest first)
  sous answer <node> "text" [run-id] [--workspace <dir>]
  sous approve <node> [run-id] [--workspace <dir>]
  sous cancel <node> [run-id] [--workspace <dir>]
  sous send <to> 'text'          (a worker of a running run, to a sibling or its lead)
  sous receive [seconds]         (a worker: the messages waiting for it, waiting up to ${MAX_WAIT_SECONDS} seconds for one)
  sous export atif|otlp [run-id] [--workspace <dir>]
  sous diff [run-id] [--stat] [--workspace <dir>]  (what the run changed: git diff of its branch, or its output files)
  sous clean [run-id] [--all] [--branches] [--unmerged] [--dry-run] [--workspace <dir>]  (remove a finished run's worktrees)
  sous --help | --version        (sous <command> --help shows one command)
  sous ui [--port <n>] [--workspace <dir>]   (a local page showing the workspace's runs, live or finished)
  sous doctor [--workspace <dir>]  (whether a run could start here: harnesses and versions, lead credentials and where leads run, git state)`

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
