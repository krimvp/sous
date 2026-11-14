// The splitter's prompts: its role, its first prompt, and each request for a split.
import type { NodeSpec, RunMode } from '../contracts/index.ts'
import { RUNTIMES } from '../definitions/index.ts'
import type { childAgents } from '../definitions/index.ts'
import type { InboxMessage } from '../run/index.ts'
import { agentNames, folderPaths, kinds, list, messages, RESULT, standing } from './shared.ts'

/** The splitter's role, its node's brief. */
export const SPLITTER_BRIEF = 'Propose how each lead of the run splits its task into children. The leads decide; you do no work on the task.'

/** The splitter's first prompt: its role, its standing instructions (the splitting strategy), and its first request. */
export function splitterPrompt(goal: string, node: NodeSpec, inbox: InboxMessage[], instructions?: string, mode: RunMode = 'git'): string {
  return [
    `You are the splitter of a larger goal.\n\nGoal: ${goal}`,
    ...standing(instructions),
    `Your role (node ${node.id}):\n${node.brief ?? ''}`,
    [
      ...(mode === 'git'
        ? ['Each request names one lead and a worktree that holds the run\'s merged work at that point. Read the code there',
          'to split well, but change nothing: the worktree is reset before every request. Write the proposal to the file']
        : ['Each request names one lead and your folder, where workspace/ holds the inputs and results/ the results so far.',
          'Read them to split well, but change nothing there. Write the proposal to the file']),
      'the request names, then report done with a one-line summary of how you split the task, or blocked when you cannot',
      'propose a split.',
    ].join(' '),
    ...messages(inbox),
    RESULT,
  ].join('\n\n') + '\n'
}

/** One request to the splitter: everything lead `node` will know about its task, and where the proposal goes. */
export function splitRequest(node: NodeSpec, notes: string[], agents: ReturnType<typeof childAgents>, depth: { at: number; max: number }, opts: { cwd: string; commit?: string; file: string; used: string[]; maxParts: number; roleChoices: string[] }): string {
  const parts = [`Propose a split for lead ${node.id}.`, `Its task:\n${node.brief ?? ''}`]
  if (node.acceptance?.length) parts.push(`Acceptance criteria:\n${list(node.acceptance)}`)
  if (notes.length) parts.push(`Notes from its leads:\n${list(notes)}`)
  const limits = agents.models
  const runtimes = RUNTIMES.filter((r) => limits[r]?.length).map((r) => `${r} (models ${limits[r]!.join(', ')})`)
  parts.push(
    opts.commit
      ? `The worktree ${opts.cwd} holds the run's merged work at commit ${opts.commit}.`
      : `Your folder ${opts.cwd} has workspace/ and results/: ${folderPaths("the lead's")}`,
    `Parts are the lead's children: ${kinds(opts.commit ? 'git' : 'folder')}`,
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
