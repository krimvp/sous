// The supervisor: the only writer of a run's state. Starts every process, runs leads through the lead
// runner, routes messages and records every outcome.
export { stopGroup } from './processes.ts'
export { runSupervisor } from './supervisor.ts'
export type { SupervisorOptions } from './context.ts'
export type { SupervisorOutcome } from './supervisor.ts'
