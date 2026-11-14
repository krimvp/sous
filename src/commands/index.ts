// What the person and workers ask of a running supervisor, through command files: whether a person's answer, approval
// or cancel applies, and a worker's `send` and `receive`.
export { commandRefusal } from './person.ts'
export { MAX_SENDS, MAX_WAIT_SECONDS, sendRefusal, sendTargets, workerReceive, workerSend } from './worker.ts'
