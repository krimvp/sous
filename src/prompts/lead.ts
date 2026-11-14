// The texts delivered to leads: the brief, children's outcomes and messages, retries and reminders, and the person's
// approval request for a proposed split; for a lead on a CLI harness also its role and the prompt of each of its turns.
import { LEAD_RULES, LEAD_SPLIT_RULE, RUNTIMES } from '../contracts/index.ts'
import type { ChildSpec, LeadCall, ModelLimits, NodeSpec, RunMode } from '../contracts/index.ts'
import type { childAgents } from '../definitions/index.ts'
import { completedText } from '../run/index.ts'
import type { InboxMessage, NodeState, SplitState } from '../run/index.ts'
import { agentNames, folderPaths, fromLeads, kinds, list, standing } from './shared.ts'

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

/** The role of a lead on a CLI harness (`TurnSpec.lead.system`), which acts through the calls of its turn's result. A
 * lead runner's lead gets the role in src/lead/tools.ts; both share LEAD_SPLIT_RULE and LEAD_RULES. */
export const HARNESS_LEAD_ROLE = [
  'You are a lead in sous. You cannot do work yourself: you have no shell, web or way to write files, and you change no file.',
  '- You may look at files with your read tools before you decide how to split; keep it brief, your children do the work.',
  '- You act only through the calls in the result that ends each turn: {"answer": a short answer, "calls": [...]}. A call is',
  '  one of spawn {children}, send {to, body, mode}, note {text}, cancel {node}, complete {summary}, fail {reason} and',
  '  escalate {question}. They are applied in order once your turn ends; when one is refused, the calls after it are not',
  '  applied. Your next turn starts with the result of each call. Return no calls when nothing is to be done now.',
  LEAD_SPLIT_RULE,
  '- Never spawn and complete in one turn: complete waits until your children have finished. Each child\'s outcome, question or message starts your next turn.',
  ...LEAD_RULES,
].join('\n')

/** A lead's first delivery, with its agent's standing instructions, the agents its children may name (with their
 * runtime when it differs from their name), the runtimes and models it may define agents on, the roles it may give
 * a lead child, and its proposed split. `harness`: the lead runs on a CLI harness and reads with its own tools. */
export function leadBrief(goal: string, node: NodeSpec, notes: string[], agents: ReturnType<typeof childAgents>, depth: { at: number; max: number }, instructions?: string, split?: SplitState, roles: { splitter?: string; choices: string[] } = { choices: [] }, mode: RunMode = 'git', harness = false): string {
  const names = (list: string[]) => agentNames(agents, list)
  const parts = [`You are lead ${node.id}, one part of a larger goal.`]
  if (goal.trim() !== node.brief?.trim()) parts.push(`Goal: ${goal}`)
  parts.push(...standing(instructions), `Your task:\n${node.brief ?? ''}`)
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  const look = `Before you split, you may look at the files with ${harness ? 'your read tools' : 'list_files and read_file'}: ${mode === 'git' ? 'paths are relative to the workspace, which includes the work merged so far.' : folderPaths('your')}`
  parts.push(...fromLeads(notes), [
    `Split the task with spawn: ${kinds(mode)}`,
    'Their outcomes and questions arrive as messages. Answer a child with send; record',
    'facts every child should know with note; ask your parent with escalate. Finish with complete or fail once',
    'no child is still working. End each turn with a short answer: the next message wakes you.',
  ].join('\n'), look, [
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

const MAX_NAMED_FILES = 20

/** A child's outcome, delivered to its lead, with the files a work child added to the results. */
export function outcomeText(child: NodeState): string {
  if (child.status !== 'completed') return `Child ${child.spec.id} failed: ${child.reason}`
  const parts = [`Child ${child.spec.id} ${child.failedChecks?.length ? completedText(child) : `completed: ${child.summary}`}`]
  const files = child.files ?? []
  if (files.length) {
    const more = files.length > MAX_NAMED_FILES ? ` and ${files.length - MAX_NAMED_FILES} more` : ''
    parts.push(`Files: ${files.slice(0, MAX_NAMED_FILES).join(', ')}${more}`)
  }
  const renamed = Object.entries(child.renamed ?? {})
  for (const [from, to] of renamed.slice(0, MAX_NAMED_FILES)) parts.push(`${from} was saved as ${to}: the results already had a different ${from}.`)
  if (renamed.length > MAX_NAMED_FILES) parts.push(`${renamed.length - MAX_NAMED_FILES} more files were saved under new names.`)
  return parts.join('\n')
}

/** A message delivered to a lead; `fromChild` when it comes from a child: a question, or what it tells the lead or a
 * sibling while it works. */
export function leadMessageText(m: InboxMessage, fromChild: boolean): string {
  if (m.copyOf) return `Child ${m.from} told its sibling ${m.copyOf} (a copy for you; no answer needed):\n${m.body}`
  if (fromChild && m.sent) return `Child ${m.from} tells you while it works (no answer needed):\n${m.body}`
  if (m.sent) return `Your sibling ${m.from} tells you while it works (no answer needed; you cannot send to it):\n${m.body}`
  return fromChild
    ? `Child ${m.from} is waiting for your answer:\n${m.body}\n\nAnswer with send to ${m.from}.`
    : `Message from ${m.from}:\n${m.body}`
}

/** The first turn of a lead on a CLI harness after its turn `cut` was cut short or ended without a result. */
const CUT = (turn: number) => `Your turn ${turn} ended before its result: none of its calls were applied. Continue from here.`

/** The prompt of a lead turn on a CLI harness: the results of the calls of its last applied turn, in order (`results`,
 * with `skipped` calls after a refusal), and the deliveries it answers. When its last turn (`cut`) ended without a result,
 * it says so first, and the results are labelled with the turn that applied them (`applied`). */
export function leadTurnPrompt(deliveries: string[], results: { call: LeadCall; result: string }[], skipped: LeadCall[], cut?: number, applied?: number): string {
  const lines = [...results.map((r) => `${r.call.tool}: ${r.result}`), ...skipped.map((c) => `${c.tool}: not applied, since an earlier call was refused`)]
  const which = cut === undefined ? 'your last turn' : `your turn ${applied}, the last one applied`
  return [
    ...(cut !== undefined ? [CUT(cut)] : []),
    ...(lines.length ? [`Results of the calls of ${which}, in order:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`] : []),
    ...deliveries,
  ].join('\n\n') + '\n'
}

/** The one retry a lead gets when the runner could not get its last delivery answered. */
export function retryPrompt(reason: string): string {
  return `Your last turn was not answered (${reason}). Continue where you left off; a second failure ends your work with that reason.\n`
}

/** Sent to a lead that settled with nothing left to wait for; `refused` when a call of its last turn was refused (a lead
 * on a CLI harness, whose prompt starts with the results). */
export function idleReminder(node: string, k: number, max: number, waiting: string[], refused = false): string {
  const ask = waiting.length ? ` Children waiting for your answer: ${waiting.join(', ')}; answer them with send.` : ''
  const why = refused
    ? 'a call of your last turn was refused (see its result above) and the calls after it were not applied; no child'
    : 'no child'
  return `Reminder ${k} of ${max}: ${why} of ${node} is working and no message is waiting, but ${node} is not finished.${ask} ` +
    `Spawn children, cancel, complete, fail or escalate: a note or a send alone does not count. After ${max} reminders ` +
    `without one, ${node} fails.\n`
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
