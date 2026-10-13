// `sous` with the fake adapter for every harness and the scripted fake lead runner, whose leads are always available:
// every lead provider has a credential, or only those $FAKE_LEAD_CREDENTIALS lists (comma-separated) when it is set.
// Session files go to $FAKE_SESSIONS.
import { main } from '../../src/cli.ts'
import { fakeAdapter } from './fake-adapter.ts'
import { fakeLeadRunner } from './fake-lead.ts'

const adapter = fakeAdapter(process.env.FAKE_SESSIONS!)
process.exitCode = await main(process.argv.slice(2), {
  getAdapter: () => adapter, createLeadRunner: fakeLeadRunner,
  leadCredential: async (provider) => (process.env.FAKE_LEAD_CREDENTIALS?.split(',').includes(provider) ?? true ? 'fake' : undefined),
})
