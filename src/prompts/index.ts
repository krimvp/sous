// Every text sous writes for a model, by audience: work nodes, leads, the integrator and the splitter. Harness-neutral:
// adapters add their own result mechanics.
export { INTEGRATOR_BRIEF, integratorPrompt, mergeRequest } from './integrator.ts'
export { HARNESS_LEAD_ROLE, idleReminder, leadBrief, leadMessageText, leadTurnPrompt, outcomeText, retryPrompt, splitApproval } from './lead.ts'
export { splitRequest, SPLITTER_BRIEF, splitterPrompt } from './splitter.ts'
export { composeBrief, fixPrompt, inboxPrompt, recoveryPrompt, resultReminder } from './worker.ts'
