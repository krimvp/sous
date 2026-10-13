// Leads as durable conversations: one pi-durable Harness on JSONL storage per lead, in this process.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import { AssistantEntry, createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, UserEntry } from '@earendil-works/pi-durable'
import type { Cursor, ModelRef, SettledSubmissionRecord, Submission } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import type { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import { DEFAULT_LEAD_MODEL } from '../types.ts'
import type { LeadHost, LeadRunner, Usage } from '../types.ts'
import { modelName, resolveModel } from './providers.ts'
import { leadExtension } from './tools.ts'

const ctx = BACKGROUND_CONTEXT

// sous's own record in each lead's storage: the deliveries already reported to the host, and whether the lead
// was cancelled. A delivery is recorded right after `host.settled`, so a crash between the two reports it once more
// on resume; the host should ignore a requestId it already recorded.
const LeadDoc = defineDoc<{ reported: string[]; cancelled: boolean }>({
  kind: 'sous.lead', version: 1, scope: 'session', initial: () => ({ reported: [], cancelled: false }),
})

interface Lead {
  node: string
  storage: JsonlStorage
  harness: Harness
  /** The conversation's model, once its root exists. */
  model?: ModelRef
  reported: Set<string>
  /** Request IDs whose settlement this process is waiting for. */
  watching: Set<string>
  cancelled: boolean
  /** Admissions and cancellation run one at a time, so nothing is admitted after `cancel` resolves. */
  line: Promise<unknown>
}

/** The lead runner with an explicit model collection; `createLeadRunner` passes the Pi login's. */
export function openLeadRunner(opts: { runDir: string; host: LeadHost; models: MutableModels }): LeadRunner {
  const { runDir, host, models } = opts
  const leadsDir = join(runDir, 'leads')
  const leads = new Map<string, Promise<Lead>>()
  let closing = false

  const open = (node: string) => {
    let lead = leads.get(node)
    if (!lead) {
      lead = openLead(node)
      leads.set(node, lead)
      lead.catch(() => leads.delete(node))
    }
    return lead
  }

  async function openLead(node: string): Promise<Lead> {
    const dir = join(leadsDir, node)
    mkdirSync(dir, { recursive: true })
    const storage = await openNodeJsonlStorage(dir, ctx, { fsync: true })
    const registry = createRegistry()
    registry.install(leadExtension(node, host))
    const harness = await Harness.open(storage, { models, registry }, ctx)
    const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx)
    const model = root && (await root.agent(ctx)).model
    // Registers a reopened lead's model; a missing credential fails its next delivery or its resumed run.
    if (model) await resolveModel(models, modelName(model)).catch(() => {})
    const doc = await harness.snapshot(LeadDoc, ctx)
    return { node, storage, harness, model, reported: new Set(doc?.reported), watching: new Set(), cancelled: doc?.cancelled ?? false, line: Promise.resolve() }
  }

  function watch(lead: Lead, submission: Submission, requestId: string) {
    if (lead.watching.has(requestId)) return
    lead.watching.add(requestId)
    submission.wait(ctx).then((settled) => report(lead, settled, requestId)).catch(async (err) => {
      // A report that fails (the storage, the host's log) would leave the delivery unsettled for the host forever: it
      // hears the failure instead, and retries or fails the lead.
      if (closing || lead.cancelled || lead.reported.has(requestId)) return
      try {
        host.settled(lead.node, { requestId, status: 'unanswered', text: `reporting the answer failed: ${err?.message ?? err}`, model: modelName(lead.model!) })
        await recorded(lead, requestId)
      } catch (again) {
        console.error(`sous: lead ${lead.node}: reporting ${requestId} failed: ${(again as Error)?.stack ?? again}`)
      }
    })
  }

  async function report(lead: Lead, settled: SettledSubmissionRecord, requestId: string) {
    if (lead.cancelled || lead.reported.has(requestId)) return
    const { text, usage } = await describe(lead, settled)
    if (lead.cancelled || closing) return
    host.settled(lead.node, { requestId, status: settled.status, text, model: modelName(lead.model!), usage })
    await recorded(lead, requestId)
    if (settled.status === 'unanswered') await wake(lead)
  }

  async function recorded(lead: Lead, requestId: string) {
    lead.reported.add(requestId)
    await lead.harness.commit(async (tx) => { (await tx.doc(LeadDoc)).reported.push(requestId) }, ctx)
  }

  // A failed run leaves the deliveries queued behind it in the inbox until the next submission places them, so they
  // would never settle. Any submission to an idle conversation places them; this one writes an entry the model never
  // sees (it has no model message).
  async function wake(lead: Lead) {
    const root = await lead.harness.conversation(ROOT_CONVERSATION_ID, ctx)
    await root?.submit({ type: 'write', entry: { kind: 'sous.wake' } }, ctx)
  }

  // The answer text (or, for an unanswered delivery, the reason), and the usage of the model responses that followed
  // this delivery's own user entry until the answer or the next user entry (a steer that joined the run, or the next
  // run). So usage is split between the deliveries of one run and never counted twice. It covers committed model
  // responses only: a failed request that left no assistant entry, and compaction, count in pi.usage but not here.
  async function describe(lead: Lead, settled: SettledSubmissionRecord) {
    let text = ''
    if (settled.status === 'unanswered') {
      const { reason, detail } = settled
      text = detail === undefined ? reason : `${reason}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    }
    let usage: Usage | undefined
    if (settled.entry === undefined) return { text, usage }
    const root = (await lead.harness.conversation(ROOT_CONVERSATION_ID, ctx))!
    let cursor: Cursor | undefined
    let counting = true
    scan: do {
      const page = await root.entries({ minEntryId: settled.entry, order: 'ascending' }, 100, cursor, ctx)
      for (const entry of page.items) {
        if (entry.id !== settled.entry && UserEntry.is(entry)) {
          counting = false
          if (settled.status === 'done') continue
          break scan
        }
        if (!AssistantEntry.is(entry)) continue
        const message = entry.model![0] as AssistantMessage
        if (counting) {
          const u = message.usage
          usage ??= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
          // pi-ai's `input` excludes cache reads and writes; sous's inputTokens includes them.
          usage.inputTokens += u.input + u.cacheRead + u.cacheWrite
          usage.outputTokens += u.output
          usage.cachedTokens += u.cacheRead
          usage.cacheWriteTokens! += u.cacheWrite
          // pi-ai prices from its catalog; Ollama Cloud has no prices here, so a zero cost is left out as unknown.
          if (u.cost.total > 0) usage.costUsd = (usage.costUsd ?? 0) + u.cost.total
        }
        if (settled.status === 'done' && entry.id === settled.answer) {
          text = message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
          break scan
        }
      }
      cursor = page.next
    } while (cursor)
    return { text, usage }
  }

  // Re-attach to every delivery not yet reported, including one that settled just before a crash.
  async function attach(lead: Lead) {
    let cursor: Cursor | undefined
    do {
      const page = await lead.storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 100, cursor, ctx)
      for (const record of page.items) {
        if (record.type !== 'input' || record.requestId === undefined || lead.reported.has(record.requestId)) continue
        const submission = await lead.harness.submission(record.id, ctx)
        if (submission) watch(lead, submission, record.requestId)
      }
      cursor = page.next
    } while (cursor)
  }

  function serial<T>(lead: Lead, step: () => Promise<T>): Promise<T> {
    const done = lead.line.then(step)
    lead.line = done.catch(() => {})
    return done
  }

  async function abort(lead: Lead) {
    await (await lead.harness.conversation(ROOT_CONVERSATION_ID, ctx))?.abort(ctx)
  }

  return {
    async deliver(node, text, { requestId, mode, model }) {
      const lead = await open(node)
      await serial(lead, async () => {
        if (lead.cancelled || lead.reported.has(requestId)) return
        const ref = await resolveModel(models, lead.model ? modelName(lead.model) : model ?? DEFAULT_LEAD_MODEL)
        const root = await lead.harness.root(ctx, { agent: { model: ref } }) // the model applies when it creates the root
        lead.model ??= ref
        if (lead.cancelled) return
        const whenBusy = mode === 'interrupt' ? 'steer' : 'followUp'
        const submission = await root.submit({ type: 'input', content: text, requestId, whenBusy }, ctx)
        watch(lead, submission, requestId)
      })
    },

    async cancel(node) {
      if (!leads.has(node) && !existsSync(join(leadsDir, node))) return
      const lead = await open(node)
      lead.cancelled = true // an admission in progress sees it before it submits
      await serial(lead, async () => {
        await lead.harness.commit(async (tx) => { (await tx.doc(LeadDoc)).cancelled = true }, ctx)
        await abort(lead)
      })
    },

    async resume() {
      if (!existsSync(leadsDir)) return
      for (const entry of readdirSync(leadsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const lead = await open(entry.name)
        if (lead.cancelled) {
          await abort(lead) // finishes a cancel the last process may have left halfway
          continue
        }
        await attach(lead)
        lead.harness.resume()
        await wake(lead) // in case the last process stopped between a failed run and its wake
      }
    },

    // The openai-codex provider keeps a connection (and a timer) open for about 5 minutes after close (spike finding
    // 3), so a process that only ran leads can take that long to exit on its own. That is left visible here: a
    // one-shot caller exits explicitly; a long-running supervisor is unaffected.
    async close() {
      closing = true
      const opened = await Promise.allSettled(leads.values())
      for (const lead of opened) if (lead.status === 'fulfilled') await lead.value.harness.close(ctx)
    },
  }
}
