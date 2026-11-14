// Pieces of text that prompts for more than one audience share.
import type { RunMode } from '../contracts/index.ts'
import type { childAgents } from '../definitions/index.ts'
import type { InboxMessage } from '../run/index.ts'

export const RESULT = [
  'When you finish, end your turn with the structured result:',
  '- status: "done" when the task is complete, "blocked" when you cannot proceed,',
  '  or "needs_input" when you need an answer before you can continue;',
  '- summary: one or two sentences on what you did or what stops you;',
  '- question: the question to answer, when the status is "needs_input" or "blocked".',
].join('\n')

export const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n')

export const fromLeads = (notes: string[]) => (notes.length ? [`Notes from your leads:\n${list(notes)}`] : [])

export const messages = (inbox: InboxMessage[]) => inbox.map((m) => `Message from ${m.from}:\n${m.body}`)

export const standing = (instructions?: string) => (instructions?.trim() ? [`Your standing instructions:\n${instructions.trim()}`] : [])

/** What each kind of child is, in this run's mode. */
export const kinds = (mode: RunMode) => (mode === 'git'
  ? [
    'work children are agents (for code, research, writing or analysis), each in its own git worktree, run in parallel',
    'and merged into the run\'s branch when done; check children are shell commands that must exit 0 on the merged',
    'result; lead children split a large part further; gate children wait for the person to approve what their',
    'brief describes. Children with needs start after those siblings complete (work children: once merged).',
  ]
  : [
    'work children are agents (for code, research, writing or analysis), each writing its files in its own folder, run',
    'in parallel; when one is done its files are added to the run\'s results. Check children are shell commands that must',
    'exit 0; lead children split a large part further; gate children wait for the person to approve what their brief',
    'describes. Children with needs start after those siblings complete (work children: once their files are in the results).',
  ]).join('\n')

/** Folder mode: what workspace/ and results/ mean, the same for a lead's tools, its workers and its checks; `whose` is
 * "your" for the lead itself, "the lead's" for its splitter. */
export const folderPaths = (whose: string) => [
  `workspace/ holds the inputs, results/ the files ${whose === 'your' ? 'your' : 'its'} children produced so far. These names mean the same`,
  `for ${whose} tools, work children and checks: workers and checks run in a folder of their own where workspace/ and`,
  'results/ are read-only links, so a check of a result is, say, test -s results/report.md. Tell workers which file',
  'names to write; they write them at the top of their folder, and those files appear at the top of results/.',
].join('\n')

export const agentNames = (agents: ReturnType<typeof childAgents>, list: string[]) =>
  list.map((n) => (agents.runs[n] === n ? n : `${n} (runs ${agents.runs[n]})`)).join(', ')
