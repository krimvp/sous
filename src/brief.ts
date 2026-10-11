// Harness-neutral prompts for work nodes and the texts delivered to leads. Adapters add their own result mechanics.
import { fileURLToPath } from 'node:url'
import { RUNTIMES } from './agents.ts'
import type { childAgents } from './agents.ts'
import type { InboxMessage, NodeState, SplitState } from './state.ts'
import type { ChildSpec, ModelLimits, NodeSpec } from './types.ts'

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

/** The command a worker runs to send a message, when its harness has no MCP tool for it. */
const SEND_COMMAND = `${process.execPath} ${fileURLToPath(new URL('./cli.ts', import.meta.url))} send`

/** Whom a worker may message while it works, and how. */
function contactsSection(contacts: { lead?: string; siblings: string[]; max: number }): string[] {
  if (!contacts.lead && !contacts.siblings.length) return []
  const whom = [contacts.lead && `your lead ${contacts.lead}`, contacts.siblings.length && `your siblings ${contacts.siblings.join(', ')}`]
  return [[
    `When you learn something ${contacts.lead ? 'your lead or ' : ''}a sibling must know while you work (an interface you settled, a file you`,
    `moved, a change of plan), tell them: with the send tool if you have it, else run ${SEND_COMMAND} <to> "<text>".`,
    `You may send to ${whom.filter(Boolean).join(' and ')}${contacts.lead ? '; your lead sees every message' : ''}. At most ${contacts.max}`,
    'messages; they are read when the recipient\'s turn ends, so do not wait for an answer. Messages to you arrive the same way.',
  ].join(' ')]
}

/** The first prompt of a work node, with its agent's standing instructions, its ancestors' notes, any messages already
 * waiting, and whom it may message while it works. */
export function composeBrief(goal: string, node: NodeSpec, cwd: string, notes: string[] = [], inbox: InboxMessage[] = [], instructions?: string, contacts?: { lead?: string; siblings: string[]; max: number }): string {
  const parts = [
    `You are one worker on a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
    `Your task (node ${node.id}):\n${node.brief ?? ''}`,
  ]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  if (node.command) parts.push(`After you report done, this check runs in ${cwd} and must exit 0:\n${node.command}`)
  parts.push(...fromLeads(notes), ...messages(inbox), `Work in the directory ${cwd}. Do only this task.`, ...(contacts ? contactsSection(contacts) : []), RESULT)
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
    'You were interrupted: sous stopped while you worked. Re-check the workspace, since some of your last',
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

const KINDS = [
  'work children are coding agents, each in its own git worktree, run in parallel',
  'and merged into the run\'s branch when done; check children are shell commands that must exit 0 on the merged',
  'result; lead children split a large part further; gate children wait for the person to approve what their',
  'brief describes. Children with needs start after those siblings complete (work children: once merged).',
].join('\n')

const agentNames = (agents: ReturnType<typeof childAgents>, list: string[]) =>
  list.map((n) => (agents.runs[n] === n ? n : `${n} (runs ${agents.runs[n]})`)).join(', ')

/** The splitter's proposal (or why there is none), in a lead's brief. */
function splitSection(split: SplitState): string {
  if (split.status !== 'proposed') return `The run's splitter proposed no split (${split.reason}). Split the task yourself.`
  return [
    `The run's splitter proposed this split of your task: ${split.summary}`,
    `\`\`\`json\n${JSON.stringify(split.parts, null, 2)}\n\`\`\``,
    'Spawn these children as they are, adjust them, or split differently: you decide, under the usual limits.',
  ].join('\n')
}

/** The roles a lead may give a lead child's subtree, when the run defines agents for them. */
function rolesSection(roles: { splitter?: string; choices: string[] }): string[] {
  if (!roles.choices.length) return []
  return [[
    `A lead child may take roles {"splitter": "<agent>"}: that agent then proposes how every lead in the child's subtree`,
    `splits its task (yours: ${roles.splitter ?? 'none'}; without roles a child keeps yours). Agents for roles: ${roles.choices.join(', ')}.`,
  ].join(' ')]
}

/** A lead's first delivery, with its agent's standing instructions, the agents its children may name (with their
 * runtime when it differs from their name), the runtimes and models it may define agents on, the roles it may give
 * a lead child, and its proposed split. */
export function leadBrief(goal: string, node: NodeSpec, notes: string[], agents: ReturnType<typeof childAgents>, depth: { at: number; max: number }, instructions?: string, split?: SplitState, roles: { splitter?: string; choices: string[] } = { choices: [] }): string {
  const names = (list: string[]) => agentNames(agents, list)
  const parts = [`You are lead ${node.id}, one part of a larger goal.`]
  if (goal.trim() !== node.brief?.trim()) parts.push(`Goal: ${goal}`)
  parts.push(...standing(instructions), `Your task:\n${node.brief ?? ''}`)
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  parts.push(...fromLeads(notes), [
    `Split the task with spawn: ${KINDS}`,
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
  if (depth.at < depth.max) parts.push(...rolesSection(roles))
  if (split) parts.push(splitSection(split))
  return parts.join('\n\n') + '\n'
}

/** A child's outcome, delivered to its lead. */
export function outcomeText(child: NodeState): string {
  return child.status === 'completed' ? `Child ${child.spec.id} completed: ${child.summary}` : `Child ${child.spec.id} failed: ${child.reason}`
}

/** A message delivered to a lead; `fromChild` when it comes from a child: a question, or what it tells the lead or a
 * sibling while it works. */
export function leadMessageText(m: InboxMessage, fromChild: boolean): string {
  if (m.copyOf) return `Child ${m.from} told its sibling ${m.copyOf} (a copy for you; no answer needed):\n${m.body}`
  if (fromChild && m.sent) return `Child ${m.from} tells you while it works (no answer needed):\n${m.body}`
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

// ---- The splitter ------------------------------------------------------------------------------

/** The splitter's role, its node's brief. */
export const SPLITTER_BRIEF = 'Propose how each lead of the run splits its task into children. The leads decide; you do no work on the task.'

/** The splitter's first prompt: its role, its standing instructions (the splitting strategy), and its first request. */
export function splitterPrompt(goal: string, node: NodeSpec, inbox: InboxMessage[], instructions?: string): string {
  return [
    `You are the splitter of a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
    `Your role (node ${node.id}):\n${node.brief ?? ''}`,
    [
      'Each request names one lead and a worktree that holds the run\'s merged work at that point. Read the code there',
      'to split well, but change nothing: the worktree is reset before every request. Write the proposal to the file',
      'the request names, then report done with a one-line summary of how you split the task, or blocked when you cannot',
      'propose a split.',
    ].join(' '),
    ...messages(inbox),
    RESULT,
  ].join('\n\n') + '\n'
}

/** One request to the splitter: everything lead `node` will know about its task, and where the proposal goes. */
export function splitRequest(node: NodeSpec, notes: string[], agents: ReturnType<typeof childAgents>, depth: { at: number; max: number }, opts: { cwd: string; commit: string; file: string; used: string[]; maxParts: number; roleChoices: string[] }): string {
  const parts = [`Propose a split for lead ${node.id}.`, `Its task:\n${node.brief ?? ''}`]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  if (notes.length) parts.push(`Notes from its leads:\n${list(notes)}`)
  const limits = agents.models
  const runtimes = RUNTIMES.filter((r) => limits[r]?.length).map((r) => `${r} (models ${limits[r]!.join(', ')})`)
  parts.push(
    `The worktree ${opts.cwd} holds the run's merged work at commit ${opts.commit}.`,
    `Parts are the lead's children: ${KINDS}`,
    [
      `A work part may name an agent of ${agentNames(agents, agents.work) || 'none'}` + (agents.defaultWork ? ` (default ${agents.defaultWork})` : ''),
      `a lead part one of ${agentNames(agents, agents.lead) || 'none'} (default: the lead's own agent).`,
    ].join('; '),
    runtimes.length
      ? `A work or lead part may instead define a new agent {name, runs, model?, instructions?} on: ${runtimes.join('; ')}.`
      : 'Parts may not define agents or set a model: the run lists no models.',
    depth.at < depth.max
      ? `Lead ${node.id} is at depth ${depth.at} of at most ${depth.max}, so it may have lead parts.` + (opts.roleChoices.length
        ? ` A lead part may set roles {"splitter": "<agent>"} to give its subtree another splitter, one of ${opts.roleChoices.join(', ')}; without it, the subtree keeps this split's splitter.`
        : '')
      : `Lead ${node.id} is at the deepest level allowed: propose no lead parts.`,
    [
      `Propose at most ${opts.maxParts} parts. Ids must be new in the run (taken: ${opts.used.join(', ')}); make them specific to`,
      'this task, since other leads take ids too. needs may name only earlier parts. Give every work and lead part a',
      'self-contained brief and acceptance criteria; use a check part for anything a command can verify.',
    ].join(' '),
    [
      `Write the proposal as a JSON object to ${opts.file} (its directory exists):`,
      '{"parts": [{"id": "...", "kind": "work" | "check" | "lead" | "gate", "brief": "...", "acceptance": ["..."], "needs": ["..."],',
      '"command": "... (check parts only)", "agent": "... (optional)"}]}',
    ].join('\n'),
  )
  return parts.join('\n\n')
}

/** The person's approval request for a proposed split. */
export function splitApproval(node: string, parts: ChildSpec[], summary: string): string {
  const line = (c: ChildSpec) => {
    const agent = typeof c.agent === 'string' ? c.agent : c.agent?.name
    const about = [c.kind, agent, c.needs?.length ? `needs ${c.needs.join(', ')}` : undefined].filter(Boolean).join(', ')
    return `- ${c.id} (${about}): ${(c.kind === 'check' ? c.command : c.brief)?.trim().split('\n')[0] ?? ''}`
  }
  return [`Proposed split for ${node}: ${summary}`, ...parts.map(line)].join('\n')
}
