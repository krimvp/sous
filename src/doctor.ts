// sous doctor: what a run here would find, so that a person sees before `sous run` why it could not start. Each harness
// on PATH with its version, the lead's credentials and the model a run would use, the workspace's git state, and whether
// a run could start: a lead and at least one worker, in a repository with a commit or outside git.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { agentModel, checkAgents, defaultLeadModel } from './agents.ts'
import { repoState } from './git.ts'
import { ANY_LEAD_CREDENTIAL_FIX, BUILTIN_AGENTS, HARNESSES, LEAD_PROVIDERS } from './types.ts'

/** How long `<cli> --version` may take; a harness that answers later counts as on PATH with an unknown version. */
const VERSION_TIMEOUT_MS = 5000

/** Print the report; returns the exit code: 0 when a run could start here, 1 with what to do otherwise. `loginProblem`
 * says what is wrong with the Pi login file, if anything. */
export async function doctor(workspace: string, leadCredential: (provider: string) => Promise<string | undefined>, loginProblem?: () => string | undefined): Promise<number> {
  const sources = new Map(await Promise.all(LEAD_PROVIDERS.map(async (p) => [p.id, await leadCredential(p.id)] as const)))
  const unavailable = await checkAgents(undefined, async (provider) => sources.get(provider))
  const versions = await Promise.all(HARNESSES.map((cli) => (unavailable.commands.includes(cli) ? 'not on PATH' : version(cli))))
  HARNESSES.forEach((cli, i) => console.log(`${cli}: ${versions[i]}`))
  const workers = HARNESSES.filter((cli) => !unavailable.commands.includes(cli))
  // The model a work node on each built-in worker agent runs on when nothing names one.
  const onModel = (cli: (typeof HARNESSES)[number]) => `${cli} (${agentModel(BUILTIN_AGENTS[cli], unavailable) ?? 'harness default'})`

  const credentials = LEAD_PROVIDERS.filter((p) => sources.get(p.id) !== undefined).map((p) => `${p.id} (${sources.get(p.id)})`)
  console.log(`lead credentials: ${credentials.join(', ') || 'none'}`)
  const problem = loginProblem?.()
  if (problem) console.log(`Pi login: ${problem}`)
  const model = defaultLeadModel(unavailable)
  console.log(`lead model: ${model ?? 'none'}`)
  console.log(`worker models: ${workers.map(onModel).join(', ') || 'none'}`)

  const repo = repoState(workspace)
  const changes = repo && (repo.changes ? `${repo.changes} uncommitted change${repo.changes === 1 ? '' : 's'} (workers see HEAD only)` : 'no uncommitted changes')
  const where = repo && (realpathSync(workspace) === realpathSync(repo.top) ? 'git repository at its top level'
    : `inside git repository ${repo.top}, not at its top level (--workspace is used as given: .sous/ lands here; workers and checks run at the top level)`)
  console.log(`workspace: ${workspace}, ${repo ? `${where}${repo.commit ? '' : ', without a commit'}, ${changes}` : 'not a git repository (folder mode)'}`)

  const problems = [
    ...(model ? [] : [`no lead provider has a credential: ${ANY_LEAD_CREDENTIAL_FIX}`]),
    ...(workers.length ? [] : [`no worker CLI on PATH: install ${HARNESSES.join(', ')}`]),
    ...(repo && !repo.commit ? ['the repository has no commit: make one'] : []),
  ]
  if (problems.length) {
    console.log(`not ready: ${problems.join('; ')}`)
    return 1
  }
  console.log(`ready: lead on ${model}, workers on ${workers.join(', ')}`)
  return 0
}

/** The first line `cli --version` prints, or why there is none. Whether the CLI is logged in is not checked. */
function version(cli: string): Promise<string> {
  return new Promise((resolve) => {
    // The command leads its own process group, so that a timeout kills whatever it started as well: a grandchild
    // left behind would hold the output open, and `close` would wait for it.
    const child = spawn(cli, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch {}
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(`on PATH; --version gave nothing in ${VERSION_TIMEOUT_MS / 1000} s; login not checked`)
    }, VERSION_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(`on PATH; --version failed (${err.message}); login not checked`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.trim().split('\n')[0].slice(0, 80)
      resolve(`${code === 0 && line ? line : `on PATH; --version exited ${code}${line ? `: ${line}` : ' with nothing'}`}; login not checked`)
    })
  })
}
