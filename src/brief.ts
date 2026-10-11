// Harness-neutral prompts for work nodes and the texts delivered to leads. Adapters add their own result mechanics.
import { RUNTIMES } from './agents.ts'
import type { childAgents } from './agents.ts'
import type { InboxMessage, NodeState } from './state.ts'
import type { ModelLimits, NodeSpec } from './types.ts'

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

const standing = (instructions?: string) => (instructions?.trim() ? [`Your standing instructions:\n${instructions.trim()}`] : [])

/** The first prompt of a work node, with its agent's standing instructions, its ancestors' notes and any messages
 * already waiting. */
export function composeBrief(goal: string, node: NodeSpec, cwd: string, notes: string[] = [], inbox: InboxMessage[] = [], instructions?: string): string {
  const parts = [
    `You are one worker on a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
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

/** Resume prompt after a supervisor stop cut the last turn short, with the messages that arrived meanwhile. */
export function recoveryPrompt(inbox: InboxMessage[]): string {
  return [
    'You were interrupted: Murmuration stopped while you worked. Re-check the workspace, since some of your last',
    'steps may not have happened, then continue your task.',
  ].join(' ') + '\n\n' + [...messages(inbox), RESULT].join('\n\n') + '\n'
}

/** Resume prompt after a turn ended without a usable structured result. */
export function resultReminder(): string {
  return `Your last turn ended without the required structured result. If the task is not finished, finish it first.\n\n${RESULT}\n`
}

// ---- Leads -------------------------------------------------------------------------------------

/** The runtimes a lead may define agents on, with their models, and the model overrides it may choose. */
function models(limits: ModelLimits): string {
  const allowed = RUNTIMES.filter((r) => limits[r]?.length).map((r) => `${r} (models ${limits[r]!.join(', ')})`)
  if (!allowed.length) return 'The run lists no models, so you may not define agents or set a child\'s model.'
  return [
    `You may define a new agent for a work or lead child with agent {name, runs, model?, instructions?}, on these runtimes:`,
    `${allowed.join('; ')}. It runs on runs with model (default: the first listed) and exactly your instructions; once`,
    'spawned, any later child in the run may name it. A child that names an agent may set model to one listed for that',
    'agent\'s runtime.',
  ].join(' ')
}

/** A lead's first delivery, with its agent's standing instructions, the agents its children may name (with their
 * runtime when it differs from their name), and the runtimes and models it may define agents on. */
export function leadBrief(goal: string, node: NodeSpec, notes: string[], agents: ReturnType<typeof childAgents>, depth: { at: number; max: number }, instructions?: string): string {
  const names = (list: string[]) => list.map((n) => (agents.runs[n] === n ? n : `${n} (runs ${agents.runs[n]})`)).join(', ')
  const parts = [`You are lead ${node.id}, one part of a larger goal.`]
  if (goal.trim() !== node.brief?.trim()) parts.push(`Goal: ${goal}`)
  parts.push(...standing(instructions), `Your task:\n${node.brief ?? ''}`)
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  parts.push(...fromLeads(notes), [
    'Split the task with spawn: work children are coding agents, each in its own git worktree, run in parallel',
    'and merged into the run\'s branch when done; check children are shell commands that must exit 0 on the merged',
    'result; lead children split a large part further; gate children wait for the person to approve what their',
    'brief describes. Children with needs start after those siblings complete (work children: once merged).',
    'Their outcomes and questions arrive as messages. Answer a child with send; record',
    'facts every child should know with note; ask your parent with escalate. Finish with complete or fail once',
    'no child is still working. End each turn with a short answer: the next message wakes you.',
  ].join('\n'), [
    `Agents a child may name: for work children ${names(agents.work) || 'none'}` +
      (agents.defaultWork ? ` (default ${agents.defaultWork})` : ''),
    `for lead children ${names(agents.lead) || 'none'} (default: your own agent).`,
  ].join('; '), models(agents.models), depth.at < depth.max
    ? `You are a lead at depth ${depth.at}; leads may nest ${depth.max} deep, so your lead children are at depth ${depth.at + 1}.`
    : `You are a lead at depth ${depth.at}, the deepest allowed: spawn no lead children.`)
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

// ---- The integrator ----------------------------------------------------------------------------

/** The integrator's role, its node's brief. */
export const INTEGRATOR_BRIEF = 'Merge the work of the run\'s other agents into the integration branch: resolve merge conflicts, and fix checks that fail after a merge.'

/** The integrator's first prompt: its role, how to work in the integration worktree, and its first request. */
export function integratorPrompt(goal: string, node: NodeSpec, cwd: string, branch: string, inbox: InboxMessage[], instructions?: string): string {
  return [
    `You are the integrator of a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
    `Your role (node ${node.id}):\n${node.brief ?? ''}`,
    [
      `You work in ${cwd}, the integration worktree on branch ${branch}. Each request names one node whose branch did`,
      'not merge cleanly. When it conflicts, the merge is in progress: resolve every conflicted file so the result keeps',
      'the intent of both sides, git add them and finish the merge with git commit --no-edit. When the check failed',
      'after a clean merge, the merge is committed: fix the problem on top and commit the fix. If the request names a',
      'check command, run it; it must exit 0. Do not switch branches, reset, rebase or start other merges. Report done',
      'once everything is committed, or blocked when you cannot merge it.',
    ].join(' '),
    ...messages(inbox),
    RESULT,
  ].join('\n\n') + '\n'
}

/** One merge request for the integrator. `check` is set when the node's check failed after a clean merge. */
export function mergeRequest(node: NodeSpec, branch: string, into: string, files: string[], merged: NodeSpec[], check?: { exitCode: number | null; output: string }): string {
  const parts = [`Merge node ${node.id} (branch ${branch}) into ${into}.`]
  if (check) {
    parts.push(`The merge is committed, but the node's check failed after it (exit code ${check.exitCode ?? 'none'}).`,
      `Command: ${node.command}`, `Last output:\n${check.output.trimEnd() || '(no output)'}`)
  } else {
    parts.push(`The merge stopped with conflicts in:\n${list(files)}`)
    if (node.command) parts.push(`After the merge, this check must pass in the integration worktree:\n${node.command}`)
  }
  parts.push(`Brief of ${node.id}:\n${node.brief ?? ''}`)
  if (merged.length) parts.push(`Already merged, in order:\n${merged.map((n) => `- ${n.id}: ${n.brief ?? ''}`).join('\n')}`)
  return parts.join('\n\n')
}
