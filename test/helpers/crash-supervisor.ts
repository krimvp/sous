// A supervisor that SIGKILLs itself at a chosen point, for crash tests.
// usage: node crash-supervisor.ts <workspace> <runDir> event <type>   (killed right after that event is appended)
//        node crash-supervisor.ts <workspace> <runDir> rm <file name>  (killed right after that file is removed)
// With $FAKE_SESSIONS set, turns run on the fake adapter (its session files there); else no worker may run.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { runSupervisor } from '../../src/supervisor/index.ts'
import { fakeAdapter } from './fake-adapter.ts'

const [workspace, runDir, point, name] = process.argv.slice(2)
if (point === 'rm') {
  const rm = fs.rmSync
  fs.rmSync = (path, opts) => {
    rm(path, opts)
    if (String(path).endsWith(`/${name}`)) process.kill(process.pid, 'SIGKILL')
  }
  syncBuiltinESMExports()
}
await runSupervisor({
  workspace, runDir, resume: true,
  getAdapter: process.env.FAKE_SESSIONS ? () => fakeAdapter(process.env.FAKE_SESSIONS!) : () => { throw new Error('no workers in crash tests') },
  onEvent: (e) => { if (point === 'event' && e.type === name) process.kill(process.pid, 'SIGKILL') },
})
