// `sous` with the fake adapter for every harness and the scripted fake lead runner, whose leads are always available.
// Session files go to $FAKE_SESSIONS.
import { main } from '../../src/cli.ts'
import { fakeAdapter } from './fake-adapter.ts'
import { fakeLeadRunner } from './fake-lead.ts'

const adapter = fakeAdapter(process.env.FAKE_SESSIONS!)
process.exitCode = await main(process.argv.slice(2), {
  getAdapter: () => adapter, createLeadRunner: fakeLeadRunner, leadCredential: async () => 'fake',
})
