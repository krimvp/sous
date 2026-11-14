// The command-file contract: what the CLI and workers write into `<runDir>/commands/`, and the supervisor reads.

/** A command file written by `sous answer`, `sous approve` or `sous cancel`, or by a worker's `send` or `receive`. */
export type Command =
  | { type: 'answer'; node: string; text: string }
  | { type: 'approve' | 'cancel'; node: string }
  | { type: 'send'; from: string; to: string; text: string }
  | { type: 'receive'; node: string; turn: number; upTo: number }

/** A person's command: an answer, an approval or a cancel. */
export type PersonCommand = Exclude<Command, { type: 'send' | 'receive' }>
