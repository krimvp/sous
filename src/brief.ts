// Harness-neutral prompts for work nodes. Adapters add their own result mechanics.
import type { NodeSpec } from './types.ts'

const RESULT = [
  'When you finish, end your turn with the structured result:',
  '- status: "done" when the task is complete, "blocked" when you cannot proceed,',
  '  or "needs_input" when you need an answer before you can continue;',
  '- summary: one or two sentences on what you did or what stops you;',
  '- question: the question to answer, when the status is "needs_input" or "blocked".',
].join('\n')

/** The first prompt of a work node. */
export function composeBrief(goal: string, node: NodeSpec, cwd: string): string {
  const parts = [
    `You are one worker on a larger goal.\n\nGoal: ${goal}`,
    `Your task (node ${node.id}):\n${node.brief ?? ''}`,
  ]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${node.acceptance.map((a) => `- ${a}`).join('\n')}`)
  if (node.command) parts.push(`After you report done, this check runs in ${cwd} and must exit 0:\n${node.command}`)
  parts.push(`Work in the directory ${cwd}. Do only this task.`, RESULT)
  return parts.join('\n\n') + '\n'
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
