// Harness-neutral prompts for work nodes and the texts delivered to leads. Adapters add their own result mechanics.
import type { InboxMessage, NodeState } from './state.ts'
import type { NodeSpec } from './types.ts'

const RESULT = [
  'When you finish, end your turn with the structured result:',
  '- status: "done" when the task is complete, "blocked" when you cannot proceed,',
  '  or "needs_input" when you need an answer before you can continue;',
  '- summary: one or two sentences on what you did or what stops you;',
  '- question: the question to answer, when the status is "needs_input" or "blocked".',
].join('\n')

const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n')

const fromLeads = (notes: string[]) => (notes.length ? [`Notes from your leads:\n${list(notes)}`] : [])

const messages = (inbox: InboxMessage[]) => inbox.map((m) => `Message from ${m.from}:\n${m.body}`)

/** The first prompt of a work node, with its ancestors' notes and any messages already waiting. */
export function composeBrief(goal: string, node: NodeSpec, cwd: string, notes: string[] = [], inbox: InboxMessage[] = []): string {
  const parts = [
    `You are one worker on a larger goal.\n\nGoal: ${goal}`,
    `Your task (node ${node.id}):\n${node.brief ?? ''}`,
  ]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  if (node.command) parts.push(`After you report done, this check runs in ${cwd} and must exit 0:\n${node.command}`)
  parts.push(...fromLeads(notes), ...messages(inbox), `Work in the directory ${cwd}. Do only this task.`, RESULT)
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

/** Resume prompt after a turn ended without a usable structured result. */
export function resultReminder(): string {
  return `Your last turn ended without the required structured result. If the task is not finished, finish it first.\n\n${RESULT}\n`
}

// ---- Leads -------------------------------------------------------------------------------------

/** A lead's first delivery. */
export function leadBrief(goal: string, node: NodeSpec, notes: string[]): string {
  const parts = [`You are lead ${node.id}, one part of a larger goal.`]
  if (goal.trim() !== node.brief?.trim()) parts.push(`Goal: ${goal}`)
  parts.push(`Your task:\n${node.brief ?? ''}`)
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  parts.push(...fromLeads(notes), [
    'Split the task with spawn: work children are coding agents in the workspace, check children are shell',
    'commands that must exit 0, lead children split a large part further. Children with needs start after',
    'those siblings complete. Their outcomes and questions arrive as messages. Answer a child with send; record',
    'facts every child should know with note; ask your parent with escalate. Finish with complete or fail once',
    'no child is still working. End each turn with a short answer: the next message wakes you.',
  ].join('\n'))
  return parts.join('\n\n') + '\n'
}

/** A child's outcome, delivered to its lead. */
export function outcomeText(child: NodeState): string {
  return child.status === 'completed' ? `Child ${child.spec.id} completed: ${child.summary}` : `Child ${child.spec.id} failed: ${child.reason}`
}

/** A message delivered to a lead; `fromChild` when a child asks. */
export function leadMessageText(m: InboxMessage, fromChild: boolean): string {
  return fromChild
    ? `Child ${m.from} is waiting for your answer:\n${m.body}\n\nAnswer with send to ${m.from}.`
    : `Message from ${m.from}:\n${m.body}`
}

/** Sent to a lead that settled with nothing left to wait for. */
export function idleReminder(node: string, k: number, max: number, waiting: string[]): string {
  const ask = waiting.length ? ` Children waiting for your answer: ${waiting.join(', ')}; answer them with send.` : ''
  return `Reminder ${k} of ${max}: no child of ${node} is working and no message is waiting, but ${node} is not finished.${ask} ` +
    `Spawn children, complete, fail or escalate. After ${max} reminders without a tool call, ${node} fails.\n`
}
