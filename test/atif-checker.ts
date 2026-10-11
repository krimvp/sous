// A strict checker for the subset of ATIF-v1.8 (Harbor RFC 0001) that sous emits.
// It rejects unknown keys like Harbor's models do, and adds the cross-reference rules the RFC states.

type Obj = Record<string, unknown>
type Fields = Record<string, 'req' | 'opt'>

const TRAJECTORY: Fields = {
  schema_version: 'req', session_id: 'opt', trajectory_id: 'opt', agent: 'req', steps: 'req', notes: 'opt',
  final_metrics: 'opt', continued_trajectory_ref: 'opt', extra: 'opt', subagent_trajectories: 'opt',
}
const AGENT: Fields = { name: 'req', version: 'req', model_name: 'opt', tool_definitions: 'opt', extra: 'opt' }
const FINAL_METRICS: Fields = {
  total_prompt_tokens: 'opt', total_completion_tokens: 'opt', total_cached_tokens: 'opt', total_cost_usd: 'opt',
  total_steps: 'opt', extra: 'opt',
}
const STEP: Fields = {
  step_id: 'req', timestamp: 'opt', source: 'req', model_name: 'opt', reasoning_effort: 'opt', message: 'req',
  reasoning_content: 'opt', tool_calls: 'opt', observation: 'opt', metrics: 'opt', extra: 'opt',
  llm_call_count: 'opt', is_copied_context: 'opt',
}
const TOOL_CALL: Fields = { tool_call_id: 'req', function_name: 'req', arguments: 'req', extra: 'opt' }
const OBSERVATION: Fields = { results: 'req' }
const RESULT: Fields = { source_call_id: 'opt', content: 'opt', subagent_trajectory_ref: 'opt', extra: 'opt' }
const REF: Fields = { trajectory_id: 'opt', trajectory_path: 'opt', session_id: 'opt', extra: 'opt' }
const METRICS: Fields = {
  prompt_tokens: 'opt', completion_tokens: 'opt', cached_tokens: 'opt', cost_usd: 'opt', prompt_token_ids: 'opt',
  completion_token_ids: 'opt', logprobs: 'opt', extra: 'opt',
}
const AGENT_ONLY = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics']
const INTEGERS = ['step_id', 'llm_call_count', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_prompt_tokens',
  'total_completion_tokens', 'total_cached_tokens', 'total_steps']

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function checkAtif(doc: unknown): string[] {
  const errors: string[] = []
  const fail = (path: string, msg: string) => errors.push(`${path}: ${msg}`)

  const shape = (v: unknown, fields: Fields, path: string): v is Obj => {
    if (!isObj(v)) return fail(path, 'not an object'), false
    for (const key of Object.keys(v)) if (!(key in fields)) fail(path, `unknown key ${key}`)
    for (const [key, need] of Object.entries(fields)) {
      if (need === 'req' && (v[key] === undefined || v[key] === null)) fail(path, `missing ${key}`)
    }
    for (const key of INTEGERS) if (key in v && !Number.isInteger(v[key])) fail(path, `${key} is not an integer`)
    if ('extra' in v && !isObj(v.extra)) fail(path, 'extra is not an object')
    return true
  }

  const trajectory = (t: unknown, path: string) => {
    if (!shape(t, TRAJECTORY, path)) return
    if (typeof t.schema_version !== 'string' || !t.schema_version.startsWith('ATIF-v')) fail(path, 'bad schema_version')
    shape(t.agent, AGENT, `${path}.agent`)
    if (t.final_metrics !== undefined) shape(t.final_metrics, FINAL_METRICS, `${path}.final_metrics`)
    const steps = Array.isArray(t.steps) ? t.steps : []
    if (!steps.length) fail(path, 'steps is empty')
    const subs = Array.isArray(t.subagent_trajectories) ? t.subagent_trajectories as Obj[] : []
    const ids = new Set<unknown>()
    subs.forEach((s, i) => {
      if (!s?.trajectory_id) fail(`${path}.subagent_trajectories[${i}]`, 'missing trajectory_id')
      if (ids.has(s?.trajectory_id)) fail(`${path}.subagent_trajectories[${i}]`, 'duplicate trajectory_id')
      ids.add(s?.trajectory_id)
      trajectory(s, `${path}.subagent_trajectories[${i}]`)
    })
    steps.forEach((s: unknown, i: number) => step(s, i, ids, `${path}.steps[${i}]`))
  }

  const step = (s: unknown, i: number, subIds: Set<unknown>, path: string) => {
    if (!shape(s, STEP, path)) return
    if (s.step_id !== i + 1) fail(path, `step_id ${s.step_id}, expected ${i + 1}`)
    if (!['system', 'user', 'agent'].includes(s.source as string)) fail(path, `bad source ${s.source}`)
    if (typeof s.message !== 'string') fail(path, 'message is not a string')
    if (s.timestamp !== undefined && Number.isNaN(Date.parse(s.timestamp as string))) fail(path, 'bad timestamp')
    if (s.source !== 'agent') for (const key of AGENT_ONLY) if (key in s) fail(path, `${key} on a ${s.source} step`)
    if (s.source === 'agent' && s.llm_call_count === 0) {
      for (const key of ['metrics', 'reasoning_content']) if (key in s) fail(path, `${key} with llm_call_count 0`)
    }
    if (s.metrics !== undefined) shape(s.metrics, METRICS, `${path}.metrics`)
    const callIds = new Set<unknown>()
    if (s.tool_calls !== undefined) {
      (s.tool_calls as unknown[]).forEach((c, j) => {
        if (!shape(c, TOOL_CALL, `${path}.tool_calls[${j}]`)) return
        if (!isObj(c.arguments)) fail(`${path}.tool_calls[${j}]`, 'arguments is not an object')
        callIds.add(c.tool_call_id)
      })
    }
    if (s.observation === undefined || !shape(s.observation, OBSERVATION, `${path}.observation`)) return
    ;(s.observation.results as unknown[]).forEach((r, j) => {
      const rp = `${path}.observation.results[${j}]`
      if (!shape(r, RESULT, rp)) return
      if (r.source_call_id !== undefined && !callIds.has(r.source_call_id)) fail(rp, `source_call_id ${r.source_call_id} has no tool call in this step`)
      ;((r.subagent_trajectory_ref ?? []) as unknown[]).forEach((ref, k) => {
        if (!shape(ref, REF, `${rp}.subagent_trajectory_ref[${k}]`)) return
        if (!ref.trajectory_id && !ref.trajectory_path) fail(rp, 'ref without trajectory_id or trajectory_path')
        if (ref.trajectory_id && !ref.trajectory_path && !subIds.has(ref.trajectory_id)) fail(rp, `ref ${ref.trajectory_id} does not resolve`)
      })
    })
  }

  trajectory(doc, '$')
  return errors
}
