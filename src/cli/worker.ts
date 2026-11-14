// `sous send` and `sous receive`: a worker inside a run messages a sibling or its lead, and reads the messages waiting
// for it. Their text is not parsed as options.
import { MAX_WAIT_SECONDS, workerReceive, workerSend } from '../commands/index.ts'
import { usageError, usageOf } from './usage.ts'

/** Run `sous send` or `sous receive` (`argv[0]`); returns the exit code. */
export async function worker(argv: string[]): Promise<number> {
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
    console.log(usageOf(argv[0]))
    return 0
  }
  const seconds = argv[0] === 'receive' && argv[1] !== undefined && /^\d+(\.\d+)?$/.test(argv[1]) ? Number(argv[1]) : argv[1] === undefined ? 0 : NaN
  if (argv[0] === 'send' && argv.length !== 3) return usageError('send takes a recipient and a text')
  if (argv[0] === 'receive' && argv.length > 2) return usageError('receive takes at most one argument: the seconds to wait')
  if (argv[0] === 'receive' && !(seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) return usageError(`receive waits from 0 to ${MAX_WAIT_SECONDS} seconds`)
  const { SOUS_RUN_DIR: runDir, SOUS_NODE: node, SOUS_TURN: turn } = process.env
  if (!runDir || !node || !turn) {
    console.error(`sous: sous ${argv[0]} is for a worker inside a run: SOUS_RUN_DIR, SOUS_NODE and SOUS_TURN are not set`)
    return 1
  }
  const r = argv[0] === 'send' ? workerSend(runDir, node, argv[1], argv[2]) : await workerReceive(runDir, node, Number(turn), seconds)
  ;(r.ok ? console.log : console.error)(r.text)
  return r.ok ? 0 : 1
}
