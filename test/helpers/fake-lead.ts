// A scripted stand-in for the lead runner. Each lead plays one step of the plan on the last
// `FAKE_LEAD: [...]` line of its brief per delivery, in delivery order, then settles. Every runner call
// and every tool result is appended to <runDir>/fake-lead.jsonl. Like the real runner it survives a restart:
// <runDir>/fake-lead/<node>.json keeps each lead's plan, the steps it settled and the requests it reported.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CreateLeadRunner, LeadCall, LeadRead } from '../../src/contracts/index.ts'

export interface FakeLeadStep {
  /** Tool calls in order, reads included; `callId` defaults to <node>-<step>-<index>. */
  calls?: ((LeadCall | LeadRead) & { callId?: string })[]
  /** Wait before playing the step, leaving the delivery unanswered meanwhile. */
  sleepMs?: number
  /** Settle the delivery `unanswered` with this reason (a model error) instead of playing calls. */
  unanswered?: string
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
  const leads = new Map<string, { plan: FakeLeadStep[]; step: number; reported: string[]; seen: Set<string>; queue: Promise<void>; cancelled: boolean }>()
  const saved = (node: string) => join(runDir, 'fake-lead', `${node}.json`)
  const save = (node: string, l: { plan: FakeLeadStep[]; step: number; reported: string[] }) => {
    mkdirSync(join(runDir, 'fake-lead'), { recursive: true })
    writeFileSync(saved(node), JSON.stringify({ plan: l.plan, step: l.step, reported: l.reported }))
  }
  return {
    async deliver(node, text, { requestId, mode, model }) {
      record({ op: 'deliver', node, requestId, mode, model })
      let lead = leads.get(node)
      if (!lead) {
        const line = [...text.matchAll(/^FAKE_LEAD: (.*)$/gm)].at(-1)
        const before = existsSync(saved(node)) ? JSON.parse(readFileSync(saved(node), 'utf8')) : undefined
        const plan = before?.plan ?? (line ? JSON.parse(line[1]) : [])
        lead = { plan, step: before?.step ?? 0, reported: before?.reported ?? [], seen: new Set(before?.reported), queue: Promise.resolve(), cancelled: false }
        leads.set(node, lead)
        save(node, lead)
      }
      if (lead.cancelled || lead.seen.has(requestId)) return
      lead.seen.add(requestId)
      const l = lead
      l.queue = l.queue.then(() => new Promise((r) => setImmediate(r))).then(async () => {
        if (l.cancelled) return
        const step = l.step++
        if (l.plan[step]?.sleepMs) await sleep(l.plan[step].sleepMs)
        const unanswered = l.plan[step]?.unanswered
        for (const [i, c] of (unanswered === undefined ? l.plan[step]?.calls ?? [] : []).entries()) {
          const { callId = `${node}-${step}-${i}`, ...call } = c
          const read = call.tool === 'list_files' || call.tool === 'read_file'
          record({ op: 'act', node, callId, result: read ? host.read(node, callId, call as LeadRead) : host.act(node, callId, call as LeadCall) })
        }
        if (unanswered === undefined) host.settled(node, { requestId, status: 'done', text: `played step ${step}`, model: model ?? '' })
        else host.settled(node, { requestId, status: 'unanswered', text: unanswered, model: model ?? '' })
        record({ op: 'settled', node, requestId })
        l.reported.push(requestId)
        save(node, l)
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
