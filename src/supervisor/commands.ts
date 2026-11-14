// Command files in `<runDir>/commands/`: reading them and applying each once. The person's `sous answer`, `sous approve`
// and `sous cancel`, and a worker's `sous send` and `sous receive`, each checked again against the run as it is now.
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { commandRefusal, sendRefusal } from '../commands/index.ts'
import { PERSON } from '../contracts/index.ts'
import type { Command } from '../contracts/index.ts'
import { isFinal } from '../run/index.ts'
import { SUPERVISOR } from './context.ts'
import type { Context } from './context.ts'

/** The body of the message `sous approve <lead>` sends to a lead whose split waits for approval. */
const SPLIT_APPROVED = 'The person approved the proposed split.'

// A command's effect is appended with the command file's name before the file is removed, so a crash in between
// neither loses the command nor applies it twice.
export const readCommands = (ctx: Context) => {
  const { commandsDir, log } = ctx
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.json')).sort()) {
    const path = join(commandsDir, file)
    if (!log.events.some((e) => 'command' in e && e.command === file)) apply(ctx, path, file)
    rmSync(path, { force: true })
  }
}

const apply = (ctx: Context, path: string, command: string) => {
  const { log, current } = ctx
  let cmd: Command | undefined
  try {
    cmd = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  if (cmd?.type === 'send') {
    // Checked again now: the run may have moved on since the worker sent it. A refusal reaches the sender instead.
    const why = sendRefusal(current(), cmd.from, cmd.to, cmd.text)
    if (!why) return void log.append({ type: 'message', from: cmd.from, to: cmd.to, body: cmd.text, mode: 'queue', command, sent: true })
    // A sender waiting to merge is not told: the message would take it out of the merge queue.
    const sender = current().nodes.get(cmd.from)
    if (sender?.spec.kind === 'work' && !isFinal(sender) && sender.status !== 'merging') {
      log.append({ type: 'message', from: SUPERVISOR, to: cmd.from, body: `Your message to ${cmd.to} was not delivered: ${why}`, mode: 'queue', command })
    }
    return
  }
  if (cmd?.type === 'receive') {
    const n = current().nodes.get(cmd.node)
    // Only the node's current turn reads: a process left over from an earlier turn takes nothing.
    if (n?.spec.kind === 'work' && !n.spec.standing && !isFinal(n) && Number.isInteger(cmd.upTo) && n.turns.at(-1)?.number === cmd.turn) {
      log.append({ type: 'inbox.read', node: cmd.node, turn: cmd.turn, upTo: cmd.upTo, command })
    }
    return
  }
  // A command that does not apply is recorded, so the person sees it was not delivered.
  if (cmd?.type !== 'answer' && cmd?.type !== 'approve' && cmd?.type !== 'cancel') {
    return void log.append({ type: 'command.refused', command, reason: `${command} is not a valid command` })
  }
  const why = commandRefusal(current(), cmd)
  if (why) return void log.append({ type: 'command.refused', command, reason: `sous ${cmd.type} ${cmd.node}: ${why}` })
  if (cmd.type === 'answer') {
    log.append({ type: 'message', from: PERSON, to: cmd.node, body: cmd.text, mode: 'queue', command })
  } else if (cmd.type === 'approve' && current().nodes.get(cmd.node)!.spec.kind === 'gate') {
    log.append({ type: 'node.completed', node: cmd.node, summary: 'approved by person', command })
  } else if (cmd.type === 'approve') {
    log.append({ type: 'message', from: PERSON, to: cmd.node, body: SPLIT_APPROVED, mode: 'queue', command })
  } else {
    log.append({ type: 'node.cancelled', node: cmd.node, by: PERSON, command })
  }
}
