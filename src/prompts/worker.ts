// The prompts of a work node's turns: its brief, and what resumes it.
import type { NodeSpec } from '../contracts/index.ts'
import type { InboxMessage } from '../run/index.ts'
import { CLI_PROGRAM } from '../self.ts'
import { fromLeads, list, messages, RESULT, standing } from './shared.ts'

/** Folder mode: the workspace a worker reads its inputs from, and the output folder with the results so far. */
export interface Folders {
  workspace: string
  output: string
}

/** The command a worker runs to send or receive messages, when its harness has no MCP tool for it. */
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const SOUS_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(CLI_PROGRAM)}`

/** Whom a worker may message while it works, how, and how it reads what others tell it. */
function contactsSection(contacts: { lead?: string; siblings: string[]; max: number; maxWait: number }): string[] {
  if (!contacts.lead && !contacts.siblings.length) return []
  const whom = [contacts.lead && `your lead ${contacts.lead}`, contacts.siblings.length && `your siblings ${contacts.siblings.join(', ')}`]
  return [[
    `When you learn something ${contacts.lead ? 'your lead or ' : ''}a sibling must know while you work (an interface you settled, a file you`,
    `moved, a change of plan), tell them: with the send tool if you have it, else run ${SOUS_COMMAND} send <to> '<text>'`,
    '(single quotes, so the shell leaves the text alone).',
    `You may send to ${whom.filter(Boolean).join(' and ')}${contacts.lead ? '; your lead sees every message' : ''}. At most ${contacts.max} messages.`,
    `Read what others tell you with the receive tool, else run ${SOUS_COMMAND} receive [seconds]: it returns the messages`,
    `waiting for you and can wait up to ${contacts.maxWait} seconds for one, so when a sibling must tell you something before you`,
    'can go on, wait for it there instead of guessing. Messages you do not read reach you when your turn ends.',
    'Talk to the other agents of this run only this way, not through other tools or services.',
  ].join(' ')]
}

/** The first prompt of a work node, with its agent's standing instructions, its ancestors' notes, any messages already
 * waiting, and whom it may message while it works. `folders` in folder mode, where `cwd` is the node's own folder;
 * `branch` in git mode, the branch of the node's worktree `cwd`. */
export function composeBrief(goal: string, node: NodeSpec, cwd: string, notes: string[] = [], inbox: InboxMessage[] = [], instructions?: string, contacts?: { lead?: string; siblings: string[]; max: number; maxWait: number }, folders?: Folders, branch?: string): string {
  const parts = [
    `You are one worker on a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
    `Your task (node ${node.id}):\n${node.brief ?? ''}`,
  ]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  if (node.command) parts.push(`After you report done, this check runs in ${cwd} and must exit 0:\n${node.command}`)
  const where = folders
    ? [
      `You work in your own folder, ${cwd}. It has two read-only links: workspace/ holds the inputs (${folders.workspace})`,
      `and results/ the results of earlier tasks so far (${folders.output}). Read them; do not modify them.`,
      'Write your own output files at the top of your folder, not inside workspace/ or results/; they are added to the',
      'results when you finish. Do only this task.',
    ].join('\n')
    : branch
      ? [
        `Work in the directory ${cwd}, a git worktree on branch ${branch}; sous commits your changes there when you finish.`,
        'Do not switch branches, commit elsewhere, stash, reset or push. Do only this task.',
      ].join('\n')
      : `Work in the directory ${cwd}. Do only this task.`
  parts.push(...fromLeads(notes), ...messages(inbox), where, ...(contacts ? contactsSection(contacts) : []), RESULT)
  return parts.join('\n\n') + '\n'
}

/** Resume prompt carrying the messages that arrived for a worker. */
export function inboxPrompt(inbox: InboxMessage[]): string {
  return [...messages(inbox), 'Continue your task with this in mind.', RESULT].join('\n\n') + '\n'
}

/** Resume prompt after the node's acceptance check failed. */
export function fixPrompt(command: string, exitCode: number | null, output: string): string {
  return [
    `You reported done, but the acceptance check failed (exit code ${exitCode ?? 'none'}).`,
    `Command: ${command}`,
    `Last output:\n${output.trimEnd() || '(no output)'}`,
    'Fix the problem so the check passes.',
    RESULT,
  ].join('\n\n') + '\n'
}

/** Resume prompt after a supervisor stop cut the last turn short, with the messages that arrived meanwhile. */
export function recoveryPrompt(inbox: InboxMessage[]): string {
  return [
    'You were interrupted: sous stopped while you worked. Re-check your files, since some of your last',
    'steps may not have happened, then continue your task.',
  ].join(' ') + '\n\n' + [...messages(inbox), RESULT].join('\n\n') + '\n'
}

/** Resume prompt after a turn ended without a usable structured result. */
export function resultReminder(): string {
  return `Your last turn ended without the required structured result. If the task is not finished, finish it first.\n\n${RESULT}\n`
}
