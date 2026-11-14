// The integrator's prompts: its role, its first prompt, and each merge request.
import type { NodeSpec } from '../contracts/index.ts'
import type { InboxMessage } from '../run/index.ts'
import { list, messages, RESULT, standing } from './shared.ts'

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
