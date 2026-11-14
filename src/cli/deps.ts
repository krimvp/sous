// CliDeps: what the program gives the CLI, the adapters and the lead runner (src/cli.ts gives the real ones, tests
// give fakes), so that the CLI never imports them itself.
import type { SupervisorOptions } from '../supervisor/index.ts'

export interface CliDeps {
  getAdapter: SupervisorOptions['getAdapter']
  createLeadRunner?: SupervisorOptions['createLeadRunner']
  /** Where lead agents on `provider` get their credential (an environment variable, or the Pi login), if anywhere. */
  leadCredential: (provider: string) => Promise<string | undefined>
  /** Lists the person's Codex MCP servers for the Codex adapter, at run start when Codex is available. */
  listCodexServers?: () => Promise<void>
  /** What is wrong with the Pi login file, if anything (`sous doctor` says so). */
  loginProblem?: () => string | undefined
}
