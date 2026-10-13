// The lead runner: leads as durable pi-durable conversations, with model access from API keys in the environment or
// the user's Pi login.
import type { CreateLeadRunner } from '../types.ts'
import { loginModels } from './providers.ts'
import { openLeadRunner } from './runner.ts'

export { leadCredential, loginProblem } from './providers.ts'

export const createLeadRunner: CreateLeadRunner = ({ runDir, host }) => openLeadRunner({ runDir, host, models: loginModels() })
