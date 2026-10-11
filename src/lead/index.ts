// The lead runner: leads as durable pi-durable conversations, using the user's Pi login for model access.
import type { CreateLeadRunner } from '../types.ts'
import { loginModels } from './providers.ts'
import { openLeadRunner } from './runner.ts'

export { hasLeadCredential } from './providers.ts'

export const createLeadRunner: CreateLeadRunner = ({ runDir, host }) => openLeadRunner({ runDir, host, models: loginModels() })
