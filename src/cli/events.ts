// The live event printer of `sous run` and `sous resume`: one line per event, and every question, gate approval and
// proposed split for the person with the command that answers it.
import { PERSON } from '../contracts/index.ts'
import type { Event } from '../contracts/index.ts'
import { eventMessage } from '../run/index.ts'
import { duration, lastLine, oneLine } from './text.ts'

/** Prints one line per event, every message to the person as a question to answer, and every gate's or proposed
 * split's request. `past` are the events already in the log, which this does not print. `ref` is what the commands in
 * those requests name the run with (see `runRef`). */
export function printer(past: Event[], ref: () => string): (e: Event) => void {
  const nodes = new Map<string, { parent?: string; kind: string }>()
  // Leads whose proposed split came before their brief: their message to the person asks for its approval.
  const proposed = new Set<string>()
  const track = (e: Event) => {
    if (e.type === 'node.added') nodes.set(e.node.id, e.node)
    if (e.type === 'lead.call' && e.ok && e.call.tool === 'spawn') for (const c of e.call.children) nodes.set(c.id, { parent: e.node, kind: c.kind })
    if (e.type === 'split.proposed') proposed.add(e.node)
    if (e.type === 'lead.delivered') proposed.delete(e.node)
  }
  past.forEach(track)
  return (e) => {
    track(e)
    printEvent(e)
    const m = eventMessage(e, (id) => nodes.get(id)?.parent)
    if (m?.to !== PERSON) return
    const r = ref()
    if (nodes.get(m.from)?.kind === 'gate') console.log(`\n${approvalText(m.from, m.body, r)}\n`)
    else if (proposed.has(m.from)) console.log(`\n${splitApprovalText(m.from, m.body, r)}\n`)
    else console.log(`\nQuestion from ${m.from}:\n${m.body}\nAnswer with: sous answer ${m.from} "<answer>"${r}\n`)
  }
}

const approvalText = (gate: string, body: string, r: string) =>
  `Approval requested by ${gate}:\n${body}\nApprove with: sous approve ${gate}${r}, or reject with: sous cancel ${gate}${r}`

const splitApprovalText = (lead: string, body: string, r: string) =>
  `${body}\nApprove with: sous approve ${lead}${r}, or give ${lead} changes with: sous answer ${lead} "<changes>"${r}`

function printEvent(e: Event): void {
  const time = e.at.slice(11, 19)
  let text: string
  switch (e.type) {
    case 'run.created': text = `goal: ${e.goal}`; break
    case 'node.added': text = `${e.node.id} (${e.node.kind}${e.node.agent ? `, ${e.node.agent}` : ''})`; break
    case 'turn.started': text = `${e.node} turn ${e.turn} ${e.mode}${e.agent ? ` on ${e.agent}` : ''} pid ${e.pid}`; break
    case 'turn.session': text = `${e.node} turn ${e.turn} session ${e.sessionId}`; break
    case 'turn.interrupted': text = `${e.node} turn ${e.turn} ${e.signal}: ${e.reason}`; break
    case 'turn.stalled': text = `${e.node} turn ${e.turn}: no output for ${duration(Date.parse(e.at) - Date.parse(e.since))}; it keeps running`; break
    case 'turn.ended':
      text = `${e.node} turn ${e.turn} ` + (e.result ? `${e.result.status}: ${e.result.summary}` : `exit ${e.exitCode ?? e.signal}, ${e.error}`)
      break
    case 'check.ended': text = `${e.node} exit ${e.exitCode}: ${lastLine(e.output)}`; break
    case 'node.completed': text = `${e.node}: ${e.summary}`; break
    case 'node.failed': text = `${e.node}: ${e.reason}`; break
    case 'message': text = `${e.from} -> ${e.to} (${e.mode})`; break
    case 'lead.delivered': text = `${e.node} <- ${e.requestId} (${e.mode})`; break
    case 'inbox.read': text = `${e.node} read its messages up to evt-${e.upTo}`; break
    case 'lead.call': text = `${e.node} ${e.call.tool}${e.ok ? '' : ' refused'}: ${e.result}`; break
    case 'lead.read': text = `${e.node} ${e.tool} ${e.path ?? '.'}${e.offset ? ` from ${e.offset}` : ''}: ${e.refused ? `refused: ${e.refused}` : `${e.bytes} bytes`}`; break
    case 'lead.turn': text = `${e.node} ${e.status}: ${e.text}`; break
    case 'node.cancelled': text = `${e.node} by ${e.by}`; break
    case 'command.refused': text = e.reason; break
    case 'run.resumed': text = 'unfinished turns and deliveries are recovered'; break
    case 'integration.created': text = `${e.branch} at ${e.path}`; break
    case 'worktree.created': text = `${e.node} ${e.branch} at ${e.path}`; break
    case 'merge.queued': text = `${e.node}${e.branch ? ` ${e.branch}` : ''}`; break
    case 'merge.withdrawn': text = `${e.node}: messages arrived; its worker resumes`; break
    case 'merge.conflict': text = `${e.node}: ${e.reason}`; break
    case 'merge.done': text = `${e.node}${e.commit ? ` ${e.commit}` : ''} by ${e.by}${e.files ? `, ${e.files.length} files` : ''}`; break
    case 'merge.failed': text = `${e.node}: ${e.reason}`; break
    case 'split.requested': text = `${e.node} waits for splitter ${e.agent}`; break
    case 'split.proposed': text = `${e.node}: ${e.parts.map((p) => p.id).join(', ')}: ${e.summary}`; break
    case 'split.failed': text = `${e.node}: ${e.reason}`; break
    case 'run.completed': text = e.summary; break
    case 'run.failed': text = e.reason; break
  }
  console.log(`${time} ${e.type.padEnd(16)} ${oneLine(text)}`)
}
