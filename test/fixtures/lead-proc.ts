// A lead runner in its own process, for crash and credential tests.
// usage: node lead-proc.ts <runDir> <crash|resume|again|models>
//   crash: deliver the brief; SIGKILL inside the second spawn, after the host recorded the call
//   resume: resume, redeliver the brief, wait for its report; again: resume and report nothing
//   models: print the errors of deliveries with an unknown provider and with no credential (real providers)
// The fake host appends every act and settled call to <runDir>/calls.jsonl and settled.jsonl.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createLeadRunner } from '../../src/lead/index.ts'
import { openLeadRunner } from '../../src/lead/runner.ts'
import type { LeadHost } from '../../src/types.ts'

const [runDir, phase] = process.argv.slice(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (phase === 'models') {
  const runner = createLeadRunner({ runDir, host: { act: () => '', settled: () => {} } })
  const errors: string[] = []
  for (const model of ['nope/x', 'ollama-cloud/deepseek-v4.1-flash']) {
    await runner.deliver(`lead-${errors.length}`, 'hi', { requestId: 'r', mode: 'queue', model })
      .then(() => errors.push('delivered'), (err) => errors.push(err.message))
  }
  await runner.close()
  console.log(JSON.stringify(errors))
  process.exit(0)
}

const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
const model = `${faux.provider.id}/${faux.getModel().id}`
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: 'toolUse' })
const spawn = (id: string) => call('spawn', { children: [{ id, kind: 'work', brief: `Do ${id}.` }] }, `call-${id}`)
const finish = [call('complete', { summary: 'a and b spawned' }, 'call-done'), fauxAssistantMessage([fauxText('Both children spawned; complete.')])]
// A resumed process makes only the requests after the last committed response: the replayed spawn needs none.
faux.setResponses(phase === 'crash' ? [spawn('a'), spawn('b'), ...finish] : phase === 'resume' ? finish : [])

let reported = 0
const host: LeadHost = {
  act(node, callId, call) {
    appendFileSync(join(runDir, 'calls.jsonl'), JSON.stringify({ phase, node, callId, call }) + '\n', { flush: true })
    if (phase === 'crash' && callId === 'call-b') process.kill(process.pid, 'SIGKILL')
    return `${call.tool} ok`
  },
  settled(node, turn) {
    appendFileSync(join(runDir, 'settled.jsonl'), JSON.stringify({ phase, node, turn }) + '\n', { flush: true })
    reported++
  },
}
const runner = openLeadRunner({ runDir, host, models })
const brief = ['lead', 'Goal: spawn a and b, then complete.', { requestId: 'lead:brief', mode: 'queue', model }] as const
if (phase === 'crash') {
  await runner.deliver(...brief)
  await new Promise(() => {}) // killed inside the second spawn
}
await runner.resume()
if (phase === 'resume') {
  await runner.deliver(...brief) // the supervisor may redeliver after a restart: same request, nothing new
  while (reported === 0) await sleep(10)
}
await sleep(300)
await runner.close()
process.exit(0)
