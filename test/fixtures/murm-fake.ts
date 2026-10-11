// `murm` with the fake adapter for every harness. Session files go to $FAKE_SESSIONS.
import { main } from '../../src/cli.ts'
import { fakeAdapter } from './fake-adapter.ts'

const adapter = fakeAdapter(process.env.FAKE_SESSIONS!)
process.exitCode = await main(process.argv.slice(2), { getAdapter: () => adapter })
