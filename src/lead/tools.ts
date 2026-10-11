// A lead's only tools, one per LeadCall variant, and its system prompt.
import { StringEnum, Type } from '@earendil-works/pi-ai'
import type { TSchema } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import type { LeadCall, LeadHost } from '../types.ts'

const strict = { additionalProperties: false }
const Child = Type.Object({
  id: Type.String({ description: 'Unique id for the child in the whole run, e.g. "api-tests"' }),
  kind: StringEnum(['work', 'check', 'lead', 'gate'] as const, {
    description: 'work: an agent does it; check: a shell command; lead: splits further; gate: the person must approve before dependants start',
  }),
  brief: Type.Optional(Type.String({ description: 'What to do, self-contained (work, lead), or what the person approves (gate)' })),
  command: Type.Optional(Type.String({ description: 'Shell command; exit code 0 passes (check)' })),
  acceptance: Type.Optional(Type.Array(Type.String(), { description: 'Criteria the result must meet' })),
  needs: Type.Optional(Type.Array(Type.String(), { description: 'Ids of earlier siblings that must complete first' })),
  agent: Type.Optional(Type.String({ description: 'Agent that does a work or lead child, from the agents your brief lists; default: the first available worker for work, your own agent for leads' })),
  model: Type.Optional(Type.String({ description: "Overrides the agent's model: the harness's model name for work, provider/model for a lead" })),
}, strict)

const schemas = {
  spawn: Type.Object({ children: Type.Array(Child, { minItems: 1 }) }, strict),
  send: Type.Object({
    to: Type.String({ description: 'A child id, your parent, or "person" if you are a top-level lead' }),
    body: Type.String(),
    mode: StringEnum(['queue', 'interrupt'] as const, { description: 'queue: read at its next turn; interrupt: now' }),
  }, strict),
  note: Type.Object({ text: Type.String() }, strict),
  cancel: Type.Object({ node: Type.String({ description: 'A child id' }) }, strict),
  complete: Type.Object({ summary: Type.String() }, strict),
  fail: Type.Object({ reason: Type.String() }, strict),
  escalate: Type.Object({ question: Type.String() }, strict),
} satisfies Record<LeadCall['tool'], TSchema>

const descriptions: Record<LeadCall['tool'], string> = {
  spawn: 'Add children under your node. They start once their needs are met; their outcomes are delivered to you.',
  send: 'Message one of your children or your parent.',
  note: 'Record a short fact that every brief in your subtree will include.',
  cancel: 'Cancel one of your children and its whole subtree.',
  complete: 'Finish your node: your goal is met. Refused while a child is pending or running.',
  fail: 'Finish your node as failed: the goal cannot be met. Refused while a child is pending or running.',
  escalate: 'Ask your parent (or the person) a question you cannot answer yourself.',
}

const role = `You are a lead in Murmuration. You cannot do work yourself: you have no files, shell or web, only the tools below.
- Split your goal into children with spawn. Give each a self-contained brief and acceptance criteria; use a check child for anything a command can verify.
- After acting, end your turn by answering briefly. Each child's outcome, question or message wakes you as a new message.
- Complete only when your own goal is met, not merely because every child finished. Fail when it cannot be met.
- Answer your children's questions; escalate the ones you cannot answer.
- Limits: at most 12 children over your lifetime; leads nest no deeper than your brief says; needs name earlier siblings only; send only to your children, your parent, or "person" if you are top-level; cancel only your children; complete and fail are refused while a child is pending or running.`

/** The orchestration extension of lead `node`. Every call goes to the host, which is idempotent per call ID, so a call
 * replayed after a crash returns exactly the original result: a different replay text made a model stop early. */
export function leadExtension(node: string, host: LeadHost): Extension {
  const tool = (name: LeadCall['tool']) => defineTool({
    name,
    description: descriptions[name],
    parameters: schemas[name] as TSchema,
    replay: 'safe',
    execute: async (args, api) => {
      const call = { tool: name, ...(args as object) } as LeadCall
      return { content: [{ type: 'text', text: host.act(node, api.callId, call) }] }
    },
  })
  const names = Object.keys(schemas) as LeadCall['tool'][]
  return defineExtension({
    name: 'murmuration-lead',
    tools: names.map(tool),
    sections: [section('role', () => role, { tag: false })],
  })
}
