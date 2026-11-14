// What a lead may do, enforced in code when it calls a tool: refusal() says why a call is refused, accepted() what an
// accepted one returns, with the limits they enforce. Also the notes and depth a node's brief states. Pure functions of
// RunState.
import { MAX_CHILDREN, PERSON } from '../contracts/index.ts'
import type { LeadCall } from '../contracts/index.ts'
import { childError, defineAgent, registry } from '../definitions/index.ts'
import { ancestors, childrenOf, failedChecks, isFinal } from '../run/index.ts'
import type { RunState } from '../run/index.ts'

export const notesFor = (state: RunState, id: string) => ancestors(state, id).flatMap((a) => a.notes)

export const depthOf = (state: RunState, id: string) => ({ at: ancestors(state, id).length + 1, max: state.maxDepth })

/** Why lead `node` may not make `call` now, if it may not. */
export function refusal(state: RunState, node: string, call: LeadCall): string | undefined {
  const lead = state.nodes.get(node)
  if (lead?.spec.kind !== 'lead') return `${node} is not a lead`
  if (isFinal(lead)) return `${node} is already ${lead.status}`
  const children = childrenOf(state, node)
  const parent = lead.spec.parent ?? PERSON
  const live = children.filter((c) => !isFinal(c)).map((c) => c.spec.id)
  const text = (value: unknown, what: string) => (typeof value === 'string' && value.trim() ? undefined : `${what} must be a non-empty string`)
  switch (call?.tool) {
    case 'spawn': {
      if (!Array.isArray(call.children) || !call.children.length) return 'spawn needs at least one child'
      if (children.length + call.children.length > MAX_CHILDREN) {
        return `a lead may have at most ${MAX_CHILDREN} children over its lifetime; ${node} has ${children.length}`
      }
      const siblings = children.map((c) => c.spec.id)
      // The run's agents with those defined by earlier children of this call, as the fold will have them.
      const agents = { ...state.agents, agents: registry(state.agents.agents) }
      for (const c of call.children) {
        const why = childError(c, (id) => state.nodes.has(id) || siblings.includes(id), siblings, agents, state.definitions)
          ?? (c.kind === 'lead' && ancestors(state, node).length + 2 > state.maxDepth ? `leads may nest at most ${state.maxDepth} deep` : undefined)
        if (why) return `child ${String(c?.id)}: ${why}`
        if (typeof c.agent === 'object') agents.agents[c.agent.name] = defineAgent(agents, c.agent)
        siblings.push(c.id)
      }
      return undefined
    }
    case 'send': {
      if (call.to !== parent && !children.some((c) => c.spec.id === call.to)) return `${node} may send only to its children or to ${parent}`
      const target = state.nodes.get(call.to)
      if (isFinal(target)) return `${call.to} is already ${target!.status}`
      if (target?.spec.kind === 'check') return `${call.to} is a check and takes no messages`
      if (target?.spec.kind === 'gate') return `${call.to} is a gate and takes no messages; the person approves it`
      if (call.mode !== 'queue' && call.mode !== 'interrupt') return 'mode must be queue or interrupt'
      return text(call.body, 'body')
    }
    case 'note':
      return text(call.text, 'text')
    case 'cancel':
      if (!live.includes(call.node)) return `${call.node} is not a running or pending child of ${node}`
      return undefined
    case 'complete':
    case 'fail':
      if (live.length) return `children still pending or running: ${live.join(', ')}`
      if (lead.inbox.length) return `messages for ${node} are waiting and will be delivered next`
      return call.tool === 'complete' ? text(call.summary, 'summary') : text(call.reason, 'reason')
    case 'escalate':
      return text(call.question, 'question')
    default:
      return `unknown tool ${String((call as { tool?: unknown })?.tool)}`
  }
}

export function accepted(state: RunState, node: string, call: LeadCall, parent: string): string {
  switch (call.tool) {
    case 'spawn': return `spawned ${call.children.map((c) => c.id).join(', ')}; their outcomes will be delivered to you`
    case 'send': return `sent to ${call.to}`
    case 'note': return 'noted'
    case 'cancel': return `cancelled ${call.node} and its subtree`
    case 'complete': {
      const failed = failedChecks(state, node)
      return failed.length ? `completed with failed checks: ${failed.join(', ')}` : 'completed'
    }
    case 'fail': return 'failed'
    case 'escalate': return `asked ${parent}; the answer will be delivered to you`
  }
}
