// The life of a work node (runWork): its turns in its own worktree or folder, messages, result reminders, recoveries,
// its acceptance check with fix rounds, and queueing it for merging. The life of a check node (runCheckNode).
import { MAX_SENDS, MAX_WAIT_SECONDS, sendTargets } from '../commands/index.ts'
import type { NodeSpec, TurnResult } from '../contracts/index.ts'
import { composeBrief, fixPrompt, inboxPrompt, recoveryPrompt, resultReminder } from '../prompts/index.ts'
import { isFinal } from '../run/index.ts'
import type { CheckState } from '../run/index.ts'
import { commitAll, createNodeWorktree, currentBranch, head, linkedFolder } from '../workspace/index.ts'
import { readCommands } from './commands.ts'
import type { Context } from './context.ts'
import { notesFor } from './policy.ts'
import { ask, check, exitedText, MAX_RECOVERIES, runTurn } from './turns.ts'
import type { Exited } from './turns.ts'

const MAX_FIX_ROUNDS = 2

/** Turns of a work node, in its own worktree or folder, until it is queued for merging, fails, or waits for a message.
 * Messages that arrive meanwhile are delivered by resuming the session; a `done` counts only with an empty inbox.
 * A node still `running` after a restart continues from its last turn: a `done` is checked, and a turn
 * without a result is resumed with a recovery note (or started again from the brief without a session). */
export const runWork = async (ctx: Context, spec: NodeSpec) => {
  const { workspace, runDir, runId, folder, log, current, nodeNow, agentOf, fail, nodeFolder, integrationTree, resultsDir } = ctx
  const state = current()
  const node = state.nodes.get(spec.id)!
  // A recorded result settles without the agent; only a new turn needs it to be available.
  const agent = agentOf(state, node)
  let sessionId = node.turns.findLast((t) => t.sessionId)?.sessionId
  const instructions = typeof agent === 'string' ? undefined : agent.instructions
  let cwd = nodeFolder(spec.id)
  let branch: string | undefined
  if (folder) linkedFolder(cwd, workspace, resultsDir())
  else {
    const tree = createNodeWorktree(workspace, runId, runDir, spec.id, head(integrationTree().path))
    if (tree.base) log.append({ type: 'worktree.created', node: spec.id, branch: tree.branch, path: tree.path, base: tree.base })
    ;({ path: cwd, branch } = tree)
  }
  const folders = folder ? { workspace, output: resultsDir() } : undefined
  const contacts = spec.standing ? undefined : { ...sendTargets(state, spec.id), max: MAX_SENDS, maxWait: MAX_WAIT_SECONDS }
  const brief = () => composeBrief(state.goal, spec, cwd, notesFor(state, spec.id), node.inbox, instructions, contacts, folders, branch)
  let prompt = node.turns.length ? inboxPrompt(node.inbox) : brief()
  let recovery = false
  let recorded: { result?: TurnResult; sessionId?: string; check?: CheckState } | undefined
  const last = node.turns.at(-1)
  if (node.status === 'running' && last) {
    if (last.result) recorded = { result: last.result, sessionId, check: last.check }
    else {
      const recoveries = node.turns.filter((t) => t.recovery).length
      if (recoveries >= MAX_RECOVERIES) return fail(spec.id, `a supervisor stop cut its turn short after ${MAX_RECOVERIES} recoveries`)
      recovery = true
      prompt = sessionId ? recoveryPrompt(node.inbox) : brief()
    }
  }
  let fixRounds = 0
  let reminded = false
  for (;;) {
    const turn = nodeNow(spec.id).turns.length + (recorded ? 0 : 1)
    let t: { result?: TurnResult; sessionId?: string; check?: CheckState; exited?: Exited }
    if (recorded) t = recorded
    else if (typeof agent === 'string') return fail(spec.id, agent)
    else t = await runTurn(ctx, spec, agent, turn, prompt, cwd, sessionId, recovery)
    // Messages the worker read during the turn must not resume it: take its last commands before looking at its inbox.
    if (!ctx.stopping) readCommands(ctx)
    recorded = undefined
    recovery = false
    if (ctx.stopping || isFinal(nodeNow(spec.id))) return
    sessionId = t.sessionId ?? sessionId
    if (t.exited?.quiet) return fail(spec.id, exitedText(turn, t.exited))
    if (t.result && t.result.status !== 'done') ask(ctx, spec, t.result)
    let inbox = nodeNow(spec.id).inbox
    if (inbox.length || t.result?.status !== 'done') {
      if (!sessionId) return fail(spec.id, `turn ${turn} cannot be resumed: the session is unknown`)
      if (inbox.length) {
        prompt = inboxPrompt(inbox)
        continue
      }
    }
    if (!t.result) {
      if (reminded) return fail(spec.id, `turn ${turn} ended without a structured result${t.exited ? `; ${t.exited.stderr}` : ''}`)
      reminded = true
      prompt = resultReminder()
      continue
    }
    if (t.result.status !== 'done') return // waits for a message to resume it
    if (spec.command) {
      const c = t.check ?? await check(ctx, spec.id, spec.command, cwd)
      if (ctx.stopping || isFinal(nodeNow(spec.id))) return
      // Messages that arrived during the check come first (an urgent one stopped the check); no fix round is spent.
      inbox = nodeNow(spec.id).inbox
      if (inbox.length) {
        prompt = inboxPrompt(inbox)
        continue
      }
      if (c.exitCode !== 0) {
        if (fixRounds === MAX_FIX_ROUNDS) {
          return fail(spec.id, `acceptance check still fails after ${MAX_FIX_ROUNDS} fix rounds (exit ${c.exitCode})`)
        }
        fixRounds++
        prompt = fixPrompt(spec.command, c.exitCode, c.output)
        continue
      }
    }
    if (folder) return void log.append({ type: 'merge.queued', node: spec.id })
    // The worker must leave its worktree on its branch: what is committed elsewhere would never be merged.
    const on = currentBranch(cwd)
    if (on !== branch) {
      return fail(spec.id, `the worker left branch ${branch}: its worktree ${cwd} is on ${on ? `branch ${on}` : 'a detached HEAD'}, so its work is not committed or merged`)
    }
    commitAll(cwd, `${spec.id}: ${t.result.summary}`)
    return void log.append({ type: 'merge.queued', node: spec.id, branch })
  }
}

export const runCheckNode = async (ctx: Context, spec: NodeSpec) => {
  const { workspace, folder, nodeNow, complete, fail, nodeFolder, resultsDir } = ctx
  // After a restart, a check whose outcome was recorded settles from it (a check node runs its command once).
  // Folder mode: a check runs in its own folder, where workspace/ and results/ are links, as they are for workers.
  const cwd = () => (folder ? linkedFolder(nodeFolder(spec.id), workspace, resultsDir()) : resultsDir())
  const c = nodeNow(spec.id).checks.at(-1) ?? await check(ctx, spec.id, spec.command!, cwd())
  if (ctx.stopping || isFinal(nodeNow(spec.id))) return
  if (c.exitCode === 0) complete(spec.id, 'check passed')
  else fail(spec.id, `check exited ${c.exitCode}`)
}
