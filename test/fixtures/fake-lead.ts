// A scripted stand-in for the lead runner. Each lead plays one step of the plan on the last
// `FAKE_LEAD: [...]` line of its brief per delivery, in delivery order, then settles. Every runner call
// and every tool result is appended to <runDir>/fake-lead.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateLeadRunner, LeadCall } from '../../src/types.ts'

export interface FakeLeadStep {
  /** Tool calls in order; `callId` defaults to <node>-<step>-<index>. */
  calls?: (LeadCall & { callId?: string })[]
}

/** The brief line that scripts a fake lead. */
export function fakeLeadPlan(steps: FakeLeadStep[]): string {
  return `FAKE_LEAD: ${JSON.stringify(steps)}`
}

export type FakeLeadRecord =
  | { op: 'deliver'; node: string; requestId: string; mode: string; model?: string }
  | { op: 'act'; node: string; callId: string; result: string }
  | { op: 'settled'; node: string; requestId: string }
  | { op: 'cancel'; node: string }
  | { op: 'close' }

export function fakeLeadRecords(runDir: string): FakeLeadRecord[] {
  const file = join(runDir, 'fake-lead.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
}

export const fakeLeadRunner: CreateLeadRunner = ({ runDir, host }) => {
  const record = (r: FakeLeadRecord) => appendFileSync(join(runDir, 'fake-lead.jsonl'), JSON.stringify(r) + '\n')
  const leads = new Map<string, { plan: FakeLeadStep[]; step: number; seen: Set<string>; queue: Promise<void>; cancelled: boolean }>()
  return {
    async deliver(node, text, { requestId, mode, model }) {
      record({ op: 'deliver', node, requestId, mode, model })
      let lead = leads.get(node)
      if (!lead) {
        const line = [...text.matchAll(/^FAKE_LEAD: (.*)$/gm)].at(-1)
        lead = { plan: line ? JSON.parse(line[1]) : [], step: 0, seen: new Set(), queue: Promise.resolve(), cancelled: false }
        leads.set(node, lead)
      }
      if (lead.cancelled || lead.seen.has(requestId)) return
      lead.seen.add(requestId)
      const l = lead
      l.queue = l.queue.then(() => new Promise((r) => setImmediate(r))).then(() => {
        if (l.cancelled) return
        const step = l.step++
        for (const [i, c] of (l.plan[step]?.calls ?? []).entries()) {
          const { callId = `${node}-${step}-${i}`, ...call } = c
          record({ op: 'act', node, callId, result: host.act(node, callId, call as LeadCall) })
        }
        host.settled(node, { requestId, status: 'done', text: `played step ${step}`, model: model ?? '' })
        record({ op: 'settled', node, requestId })
      })
    },
    async cancel(node) {
      record({ op: 'cancel', node })
      const lead = leads.get(node)
      if (lead) lead.cancelled = true
    },
    async resume() {},
    async close() {
      record({ op: 'close' })
    },
  }
}
