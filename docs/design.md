# Murmuration design

Murmuration runs a task, or a set of tasks, to completion on one machine. A tree of agents does the work:
lead agents plan and split, worker agents (Claude Code, Codex, Pi or a custom agent) do it, and plain
code keeps everything moving. It is local only, has no runtime dependencies beyond Node, and keeps its
whole state in files you can read.

A murmuration is a flock of starlings that moves as one without a central conductor. Here there is a
small conductor after all: the supervisor.

## Principles

1. **Code guarantees progress; models make decisions.** The supervisor is plain code. It owns the graph,
   starts every process, delivers messages, enforces budgets and recovers after a crash. Leads are LLM
   turns that decide what to do through a small set of tools and then exit. Nothing depends on a model
   remembering to keep going.
2. **Everything runs in turns.** A turn is one process invocation (or one lead call) that ends with a
   structured result. Agents never talk to a running process; messages wait in an inbox and are delivered
   when the next turn starts. Urgent messages interrupt the current turn and resume it.
3. **One writer, one log.** The supervisor is the only process that writes state. The append-only event
   log is the source of truth, and everything else (status, inboxes, traces) is derived from it.
4. **Workers are not framework agents.** A worker sits behind a small adapter interface. Claude, Codex,
   Pi and in-process agents all look the same to the supervisor.
5. **Enforce in code, not in prompts.** Depth, fan-out, budgets, who may message whom and which worker
   kinds a node may use are checked by the supervisor when a lead calls a tool.

## Out of scope for now

No sandbox (workers run as the user's own CLIs, in a git worktree), no web UI, no multi-host execution,
no remote pushes or PRs, no message service. These can come later behind the seams below.

Related projects: **Taskweave** (`~/workspace/taskweave`) is the heavy, durable, evidence-oriented
product; Murmuration shares no code with it. **Orchy** (`~/workspace/orchy`) runs declared, fixed flows;
Murmuration focuses on trees that leads grow at runtime. A fixed graph file is supported only so the
engine can be tested without a lead.

## Concepts

| Term | Meaning |
|---|---|
| **Run** | One invocation of `murm run`: a goal, a tree of nodes, an event log in `<workspace>/.murm/runs/<run-id>/`. |
| **Node** | One unit of work in the tree. Has a kind, a brief, acceptance criteria, a parent and a budget. |
| **Turn** | One execution of a node: a worker process from start to exit, or one lead call. Numbered per node. |
| **Inbox** | Messages addressed to a node that have not yet been delivered to a turn. |
| **Notes** | Short facts a lead records for its subtree. Every brief in that subtree includes its ancestors' notes. |

### Node kinds

| Kind | Run by | Purpose |
|---|---|---|
| `lead` | an LLM with orchestration tools only | splits its node into children, reacts to events, completes itself |
| `work` | a worker adapter (Claude, Codex, Pi, custom) | does the work in a git worktree |
| `check` | a shell command | deterministic gate; exit code 0 passes |
| `review` | a worker adapter, read-only brief | independent verdict, ideally from another harness |
| `gate` | the person running Murmuration | approval via `murm approve` |

A node may list `needs` (sibling node IDs that must complete first). The graph is a tree with
dependency edges between siblings; it stays acyclic because a lead can only add children under itself and
`needs` may only reference earlier siblings.

### Node lifecycle

```
pending ──(needs complete)──▶ ready ──▶ running turn ──▶ turn result
   ▲                                         │ interrupt: stop the process group, resume with a note
   │                                         ▼
   └──── inbox not empty: resume ◀── result: done | blocked | needs_input
                                         │ inbox empty
                                         ▼
                      done → run the node's acceptance check → completed / failed (parent is told)
                      needs_input / blocked → message to the parent
```

A node's `done` is accepted only when its inbox is empty and its acceptance check (if any) passes. A
parent completes only through its own acceptance check, never just because every child completed.

## Architecture

```
murm CLI ──▶ supervisor ──▶ adapters (claude | codex | pi | custom) ──▶ worker processes
               │   ▲                                                        │
               │   └──────────── turn output files (.murm/runs/<id>/nodes/) ◀┘
               ├──▶ lead runner (LLM + orchestration tools; tool calls become events)
               ├──▶ .murm/runs/<id>/events.jsonl  (the only state)
               └──▶ trace exporters (ATIF file, OTLP/HTTP to Langfuse)
```

### Supervisor

One process per run, holding `.murm/runs/<id>/lock` (pid and start time), created exclusively. A lock left
by a stopped supervisor is removed by hand until `murm resume` exists (v2). Its loop:

1. Fold the event log into state.
2. For each ready node with no running turn: start a turn (new brief, or resume with the inbox).
3. Wait for any running turn to end, a CLI command (answer, approve, cancel) or a timeout.
4. Append the outcome as events; apply policy (retries, budgets, escalation); repeat.

The run ends when the root node completes, fails, or is cancelled.

### Worker adapters

```ts
interface WorkerAdapter {
  start(turn: TurnSpec): RunningTurn        // new session with a brief
  resume(turn: TurnSpec): RunningTurn       // existing session with a message
}
interface RunningTurn {
  sessionId: Promise<string>                 // known up front for Claude and Pi; parsed from the stream for Codex
  pid: number                                // process-group leader
  done: Promise<TurnResult>                  // structured result, parsed from the turn output file
}
```

Each adapter starts the CLI as the leader of a new process group, sends stdout to
`nodes/<n>/turn-<k>.jsonl` and stderr to `turn-<k>.err`, and asks for a structured final result:
`{status: done|blocked|needs_input, summary, question?, note_for_parent?}`.

### Lead runner

A lead turn is built fresh from a snapshot: its brief, its children's state, its inbox and the notes. It
has no long-lived conversation, so recovery is trivial and context stays small. Its tools:

| Tool | Effect |
|---|---|
| `spawn(children[])` | add child nodes under this node (kind, brief, acceptance, needs, harness) |
| `send(node, body, mode)` | message a child or the parent; `mode` is `queue` or `interrupt` |
| `note(text)` | add a note for this subtree |
| `cancel(node)` | cancel a child subtree |
| `complete(summary)` / `fail(reason)` | finish this node |
| `escalate(question)` | ask the parent (the root's parent is the person) |
| `wait()` | end the turn; the lead is woken by the next event |

Each tool call is validated against policy and appended as an event before the supervisor acts on it. The
model behind leads is chosen in v1 (candidates: Pi's `agent-core`, Google ADK, OpenAI Agents SDK, plain
`fetch` to a provider API). It needs an API key; workers keep using the CLIs' own logins.

## Messaging across levels

Agents address nodes, not processes, and the supervisor is the only router.

- **Workers have no send tool.** Their only outgoing message is the turn result. Incoming messages arrive
  through `resume`.
- **Leads may message their children and their parent.** Anything crossing branches goes up to the nearest
  shared ancestor and back down.
- **Delivery:** append a `message` event, add it to the recipient's inbox, then wake the recipient: start a
  lead turn, resume an idle worker, queue for a running worker, or interrupt it.
- **Escalation goes up a level.** The person is the root's parent: `murm answer <node> "…"`.

Comitia is not used in v1: the supervisor is the only writer and already wakes everyone, which are the two
things a message service would provide. An `onEvent` hook is the seam for mirroring events to Comitia
later, when an agent the supervisor did not launch needs to take part.

## Recovery

The supervisor, not any lead, owns recovery.

1. **Intent before effect.** `turn.started {node, turn, sessionId?, pid, pgid, startTime}` is appended
   immediately after spawning; `turn.session` once a session ID is known; `turn.ended {result}` after.
2. **Output goes to files**, so a turn that finishes while the supervisor is down leaves its result on disk.
3. **On start**, `murm resume <run>` takes the lock, folds the log and, for each turn without `turn.ended`:
   - its output file has a final result → record it;
   - its process group is still alive (pid plus start time from `/proc`) → stop the group, then resume;
   - otherwise → resume with "you were interrupted, re-check the worktree".
4. **Lead tool calls are events**, so a lead turn that crashed halfway keeps its recorded effects and is
   simply run again from a fresh snapshot.
5. **Recovery spends budget.** Each resumed turn counts as an attempt, so crash loops stop and escalate.

## Harness facts (spike, 2026-10-11)

`spikes/resume-after-kill.sh` stops each CLI while it runs a foreground command, with SIGTERM and with
SIGKILL, then resumes the session and asks for a codeword given before the stop. All six combinations
passed on Claude Code 2.1.296, Codex 0.160.0 and Pi 0.80.6. What the spike established:

- **Signal the process group, not the pid.** With a plain `kill -KILL <pid>`, Codex's launcher died but its
  real process kept running, finished the turn, and held the session ("thread … already has an active
  writer"), so the resume failed. Starting each CLI with `setsid` and signalling `-pgid` fixed it.
- **Session IDs:** Claude takes `--session-id <uuid>` and Pi `--session-id <id>` up front. Codex's
  `thread_id` appears in the first `thread.started` event of `--json` output.
- **Turn end is the result event, not process exit.** Claude moved a `sleep` it considered long into the
  background, emitted its `result` event and kept the process alive. Codex exited 0 after SIGTERM. The
  supervisor must use its own record of whether it interrupted a turn, and the end markers `result`
  (Claude), `turn.completed` (Codex) and `agent_end` (Pi).
- **Prompts go on stdin.** Claude's `--allowedTools <tools...>` is variadic and swallows a positional
  prompt. Codex reads stdin when it is not a TTY, so give it `</dev/null` or the prompt.
- Claude `-p` runs the user's global hooks and plugins unless told otherwise; decide per adapter whether
  to isolate with `--setting-sources` and `--strict-mcp-config`.
- Codex's `--output-schema` uses OpenAI strict mode: every property must be required, so the adapter sends
  a copy of the result schema with optional fields required but nullable, and drops the nulls.
- A Codex `turn.failed` ends a turn without a result. A Pi `agent_end` with `willRetry: true` is not the end
  of the turn; only the final one is.
- v0 workers run with full permissions in the workspace: Claude `--permission-mode bypassPermissions`,
  Codex `-s danger-full-access`, Pi's default tools.

## Traces: ATIF and Langfuse

The event log plus the raw turn output files are the canonical record. Exporters derive standard formats
from them, so traces can move between tools later.

### ATIF (Harbor RFC 0001, ATIF-v1.8)

`murm export atif <run>` writes one ATIF document per run:

- The root trajectory is the supervisor's view of the root node. Supervisor decisions and lead tool
  calls are `agent` steps with `llm_call_count: 0` when no model was involved; lead model calls carry
  `model_name` and `metrics`.
- Each child node is a trajectory in `subagent_trajectories[]` (unique `trajectory_id` = run ID plus node
  ID; `session_id` = run ID), referenced from the parent step's observation through
  `subagent_trajectory_ref`. Nesting follows the node tree.
- A worker node's steps come from parsing its turn output files: Claude stream-json, Codex `--json` items,
  Pi `--mode json` events. A tool call and its result must share one step (`source_call_id` matches a
  `tool_call_id` in the same step). Resumed turns continue the same trajectory; an interrupt is a `system`
  step.
- Murmuration-specific data goes only in `extra` fields, because ATIF rejects unknown keys. Tokens map to
  `metrics` (`prompt_tokens` includes cached tokens; Anthropic cache-creation tokens go in `metrics.extra`).
- Validate with Harbor's validator (`python -m harbor.utils.trajectory_validator`) in a test that is skipped
  when Harbor is not installed. Harbor emits `ATIF-v1.7` itself; target v1.8 and fall back if needed.

### Langfuse (OTLP/HTTP)

`murm export otlp <run>` (and optionally live export during a run) posts OTLP JSON to
`$LANGFUSE_HOST/api/public/otel/v1/traces` with plain `fetch`:

- Header `Authorization: Basic base64(pk:sk)` and `x-langfuse-ingestion-version: 4`.
- One trace per run (32-hex trace ID derived from the run ID); a root span for the run.
- Spans: node → `agent` observation, turn → `chain`, model call → `generation`, tool call → `tool`, check →
  `span`; type set explicitly with `langfuse.observation.type`.
- `session.id` = run ID on every span; input and output in `langfuse.observation.input`/`output`;
  usage in `langfuse.observation.usage_details` (JSON, taken as is, avoiding Langfuse's cache-token
  arithmetic on `gen_ai.usage.input_tokens`); model in `gen_ai.request.model`.
- Attributes use the OTLP list form `[{key, value: {stringValue|intValue|…}}]`; a plain object fails the batch.
- Langfuse's native `/api/public/ingestion` endpoint is deprecated and is not used.

Both exporters are pure functions from the event log and turn files, so they can also run on a finished
run or an older one.

## Storage layout

```
<workspace>/.murm/runs/<run-id>/
  run.json             goal, settings, created at
  events.jsonl         the event log (append-only; fsync per event)
  lock                 supervisor pid and start time
  nodes/<node-id>/
    turn-<k>.jsonl     raw harness stdout for turn k
    turn-<k>.err       raw stderr
  worktrees/<node-id>/ git worktree for writing nodes (v2; v0 uses the workspace directory)
```

## Implementation

Node 22.18 or later runs the TypeScript sources directly (type stripping). Runtime dependencies: none.
Development dependency: `typescript` for type checking. Tests use `node:test`.

## Roadmap

| Version | Scope | Done when |
|---|---|---|
| **v0** (done) | Fixed graph file; `work` and `check` nodes run in the workspace directory, writing nodes one at a time; Claude, Codex and Pi adapters; event log; `murm run`, `status`; ATIF and OTLP exporters | a two-node graph (work, then check) runs to completion on each harness and exports a valid ATIF file and a Langfuse trace |
| **v1** | `lead` nodes and their tools; inboxes; `queue` and `interrupt`; notes; `answer`, `cancel` | a goal given to a root lead is split into children that complete, with one interrupt exercised |
| **v2** | `murm resume` and crash recovery; worktree merge; `review` and `gate` nodes; budgets | killing the supervisor mid-run and resuming completes the run without repeating finished turns |

## Open questions

- Which library runs leads, and with which model and API key.
- Whether workers run with full permissions in their worktree (current assumption) or a narrower set.
- How merges between sibling worktrees are ordered and who resolves conflicts (v2).
