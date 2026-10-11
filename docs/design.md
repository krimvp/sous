# sous design

sous runs a task, or a set of tasks, to completion on one machine. A tree of agents does the work:
lead agents plan and split, worker agents (Claude Code, Codex, Pi or a custom agent) do it, and plain
code keeps everything moving. It is local only, keeps runtime dependencies to the lead runner, and keeps its
whole state in files you can read.

The name comes from the kitchen brigade: you call the order, the sous chef splits it across stations (leads),
cooks do it (workers), and plates are checked at the pass (merges and checks).

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
product; sous shares no code with it. **Orchy** (`~/workspace/orchy`) runs declared, fixed flows;
sous focuses on trees that leads grow at runtime. A fixed graph file is supported only so the
engine can be tested without a lead.

## Concepts

| Term | Meaning |
|---|---|
| **Run** | One invocation of `sous run`: a goal, a tree of nodes, an event log in `<workspace>/.sous/runs/<run-id>/`. |
| **Node** | One unit of work in the tree. Has a kind, a brief, acceptance criteria, a parent and an agent. |
| **Turn** | One execution of a node: a worker process from start to exit, or one lead call. Numbered per node. |
| **Inbox** | Messages addressed to a node that have not yet been delivered to a turn. |
| **Notes** | Short facts a lead records for its subtree. Every brief in that subtree includes its ancestors' notes. |

### Node kinds

| Kind | Run by | Purpose |
|---|---|---|
| `lead` | an LLM with orchestration tools only | splits its node into children, reacts to events, completes itself |
| `work` | a worker adapter (Claude, Codex, Pi, custom) | does the work in a git worktree |
| `check` | a shell command | deterministic gate; exit code 0 passes |
| `review` (later) | a worker adapter, read-only brief | independent verdict, ideally from another harness |
| `gate` | the person running sous | approval via `sous approve`, rejection via `sous cancel` |

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
sous CLI ──▶ supervisor ──▶ adapters (claude | codex | pi | custom) ──▶ worker processes
               │   ▲                                                        │
               │   └──────────── turn output files (.sous/runs/<id>/nodes/) ◀┘
               ├──▶ lead runner (LLM + orchestration tools; tool calls become events)
               ├──▶ .sous/runs/<id>/events.jsonl  (the only state)
               └──▶ trace exporters (ATIF file, OTLP/HTTP to Langfuse)
```

### Supervisor

One process per run, holding `.sous/runs/<id>/lock` (pid and start time), created exclusively. A lock left
by a stopped supervisor is taken over only by `sous resume` (see Recovery); `sous run` never takes one over. Its loop:

1. Fold the event log into state.
2. For each ready node with no running turn: start a turn (new brief, or resume with the inbox).
3. Wait for any running turn to end, a CLI command (answer, approve, cancel) or a timeout.
4. Append the outcome as events; apply policy (retries, budgets, escalation); repeat.

The run ends when the root node completes, fails, or is cancelled.

### Worker adapters

```ts
interface WorkerAdapter {
  name: HarnessName
  start(turn: TurnSpec): RunningTurn        // new session with a brief
  resume(turn: TurnSpec): RunningTurn       // existing session with a message
  parse(raw: string): ParsedTurn            // a turn output file: trace items, usage, end marker, result
}
interface RunningTurn {
  pid: number                                // process-group leader
  sessionId: Promise<string>                 // known up front for Claude and Pi; parsed from the stream for Codex
  exit: Promise<{ code, signal }>            // the process exited; the outcome is parsed from the output file
}
```

Each adapter starts the CLI as the leader of a new process group, sends stdout to
`nodes/<n>/turn-<k>.jsonl` and stderr to `turn-<k>.err`, and asks for a structured final result:
`{status: done|blocked|needs_input, summary, question?, note_for_parent?}`.

### Lead runner

Leads run on **pi-durable** (`@earendil-works/pi-durable`, decided 2026-10-11 after
[the spike](../spikes/pi-durable/RESULTS.md)). Each lead node is one durable conversation, stored with the
JSONL backend in `.sous/runs/<id>/leads/<node>/`. The conversation and its tool calls survive a crash: a
reopened lead continues where it stopped.

- **Events reach a lead as submissions:** a follow-up when it is idle, a steer when it must change course
  now (its own `queue` and `interrupt`). Each carries a `requestId` derived from the event's `seq`, so
  redelivery after a crash is ignored.
- **Its only tools are the orchestration tools below**, offered through one extension. Each is
  `replay: "safe"`, keyed by the model's tool call ID, and **returns the original result on replay**: in
  the spike, a different replay result made the model stop early.
- **Model:** the node's `model`, else its agent's, as `provider/model`, default `ollama-cloud/deepseek-v4.1-flash`
  (cheap; passed the spike, as did `ollama-cloud/glm-5.3` and `openai-codex/gpt-5.5`). Credentials come
  from the user's Pi login in `~/.pi/agent/auth.json`, read only: sous never refreshes them (a
  refresh rotates Pi's token; an expired login is refreshed by running `pi` once). Ollama Cloud needs a
  small provider definition, because pi-ai has none built in.

Its tools:

| Tool | Effect |
|---|---|
| `spawn(children[])` | add child nodes under this node (kind, brief, acceptance, needs, agent, model) |
| `send(node, body, mode)` | message a child or the parent; `mode` is `queue` or `interrupt` |
| `note(text)` | add a note for this subtree |
| `cancel(node)` | cancel a child subtree |
| `complete(summary)` / `fail(reason)` | finish this node |
| `escalate(question)` | ask the parent (the root's parent is the person) |

A lead ends its turn by answering, not with a tool; the next delivery wakes it. Each tool call is
validated against policy and appended as an event before the supervisor acts on it. The
supervisor's event log stays the source of truth for the tree; pi-durable holds only lead transcripts.

## Messaging across levels

Agents address nodes, not processes, and the supervisor is the only router.

- **Workers have no send tool.** Their only outgoing message is the turn result. Incoming messages arrive
  through `resume`.
- **Leads may message their children and their parent.** Anything crossing branches goes up to the nearest
  shared ancestor and back down.
- **Delivery:** append a `message` event, add it to the recipient's inbox, then wake the recipient: start a
  lead turn, resume an idle worker, queue for a running worker, or interrupt it.
- **Escalation goes up a level.** The person is the root's parent: `sous answer <node> "…"`.

Comitia is not used: the supervisor is the only writer and already wakes everyone, which are the two
things a message service would provide. An `onEvent` hook is the seam for mirroring events to Comitia
later, when an agent the supervisor did not launch needs to take part.

## Leads

The contracts are `ChildSpec`, `LeadCall`, `LeadHost`, `LeadRunner` and the `lead.*` and `node.cancelled`
events in `src/types.ts`.

**Starting.** `sous run <graph.json | "goal">`: an argument naming an existing file is a graph file (its
top-level nodes may be of any kind, `lead` included); anything else is a goal, which becomes one top-level
`lead` node with id `lead` and the goal as its brief (`--agents <file>` gives a goal run agent definitions; see
Agents). A lead's first delivery is its brief, with request ID `<node>:brief`.

**Deliveries.** The supervisor composes every text a lead receives and records it as `lead.delivered`
before calling `LeadRunner.deliver`, with request ID `evt-<seq>` of the event that caused it:

- a child's outcome: completed with its summary, failed with its reason;
- a question from a child (a worker's `needs_input` or `blocked` result, or a child lead's `escalate`);
- a message sent to it by its parent or by the person (`sous answer`).

`interrupt` deliveries steer a running lead; everything else is queued.

**Tool calls.** `LeadHost.act` validates a call, appends one `lead.call` event and returns its result. The
fold applies the effects. A repeated `callId` returns the recorded result. Limits are constants, not
settings:

| Rule | Value |
|---|---|
| Lead depth (a top-level lead is depth 1) | at most 3 by default, or `sous run --max-depth <n>` (1–8) for the run; each lead's brief states its depth and the limit |
| Children per lead, over its lifetime | at most 12 |
| `send` targets | the lead's own children, its parent lead, or `person` for a top-level lead |
| `cancel` targets | the lead's own children |
| `complete` / `fail` | refused while any child is pending or running, or a message for the lead waits to be delivered |
| Lead `command` | none: a lead's own acceptance is its judgment against its acceptance criteria; deterministic gates are `check` children |
| Child defaults | a work child: the default worker agent (see Agents); a child lead: its parent's agent and model |
| Child agents and models | a known agent, or a new one on a runtime the run lists `models` for; a `model` override only with a named agent and from the run's `models` for its runtime (see Agents) |
| `needs` | earlier siblings only, as in graph files |

**Workers under a lead.** A worker's `needs_input` or `blocked` result goes to its parent (a lead, or the
person for top-level nodes) and the worker waits. The next message in its inbox resumes the same session
with the message. An `interrupt` message to a running worker stops its process group, records
`turn.interrupted`, and resumes the session with the message. Notes from every ancestor lead are added to a
child's brief.

**Idle leads.** A lead is idle once it has answered every delivery (it may answer an earlier one after a later
one was delivered, and the runner may report one twice after a crash; the second report is ignored). When it settles idle with no running or pending children, no undelivered
messages, and without completing, it receives a reminder to spawn, complete, fail or escalate. After two
reminders without progress the lead fails.

**The person.** Messages to `person` are printed by `sous run` and listed by `sous status`. `sous answer
<node> "text"`, `sous approve <gate>` and `sous cancel <node>` (from another terminal) write a command file in
`<runDir>/commands/`; the supervisor turns it into a `message` from `person` or a `node.cancelled` event.
The supervisor stays the only writer of the log.

**Gates.** A `gate` node (in a graph file, or a lead's child) has a `brief` saying what the person approves and
no command. Once its `needs` complete, the supervisor sends its brief to `person` as a message; `sous run` prints
it as an approval request and `sous status` lists it. `sous approve <gate>` completes it with summary "approved
by person"; `sous cancel <gate>` rejects it (it fails as cancelled, so nodes that need it fail, and its lead is
told). A gate takes no messages, and a lead waiting only on a gate is not reminded.

**Completion.** A run whose top-level nodes include a lead completes when every top-level node completes.
Cancelling a node fails its subtree with reason `cancelled by <who>`, stops its running processes, and
calls `LeadRunner.cancel` for every lead in it; the supervisor delivers nothing more to a cancelled node.

## Agents

An **agent** is what does work; a harness is only how an agent runs. An agent has a name, a runtime (`claude`,
`codex`, `pi` as CLIs, or `lead` in process), an optional model, and optional standing instructions added to
every brief it receives (`AgentSpec` in `src/types.ts`).

- **Built-in agents** `claude`, `codex`, `pi` and `lead` exist without being defined. A graph file may define
  more under `agents`, by name, and a name may shadow a built-in. Nodes and lead children name an `agent`.
- **Availability decides defaults.** An agent is available when its CLI is on `PATH` (for `lead`: when the Pi
  login has a credential for its provider). A work node that names no agent gets the graph's `agent`, else the
  first available of `claude`, `codex`, `pi`. Naming an unavailable agent fails the node with a clear reason.
  Availability is checked once when a run starts or resumes, and printed (`agents: …; not available: …`); each
  turn records the agent it ran on (`turn.started.agent`). A lead's brief lists the available agents its
  children may name, those leads defined so far included, with each one's runtime when it differs from its name.
- **Agents leads define.** A lead's child may define a new agent instead of naming one: `ChildSpec.agent` is then
  `{ name, runs, model?, instructions? }` (`NewAgent`). The constraint is the runtime: `runs` must be a runtime
  the run lists models for (see Model limits), and `model` one of them, by default the first. The agent has exactly
  the instructions the lead gives; nothing is inherited. `name` is a valid id that no built-in, defined or
  lead-defined agent has, and not `integrator`. The accepted `lead.call` spawn defines it in the fold, atomically
  with its child, and it exists for the rest of the run: any later spawn, by any lead, may name it. Kind rules are
  unchanged: a lead child needs `runs: 'lead'`, a work child another runtime, and the runtime must be available.
  Leads may still name any existing agent as it is. Status, ATIF and OTLP show the agent by its name.
- **Model limits.** A graph file or agents file may set `models: { claude?, codex?, pi?, lead? }`, lists of
  models by runtime (`provider/model` for `pi` and `lead`, checked at load). They bound what leads choose: the
  runtimes they may define agents on and those agents' models, and a child's `model` override. An override needs
  a child that names its agent (a string); it must be listed for that agent's runtime. A child with no agent, or
  one that defines an agent (whose model is in its definition), may not set `model`, so a resumed run never moves
  a chosen model to another runtime. Refusals name the allowed models, or say none are allowed. Agent definitions
  and node models the person writes are not limited. A lead's brief lists the runtimes it may define agents on,
  with their models.
- **Agents for goal runs.** `sous run "goal" --agents <file>` reads a JSON file with optional `agent`, `agents`
  and `models`, under the same rules as a graph file (unknown keys are rejected). `run.created.definitions` records
  it, so resume and traces see it; a graph run's definitions stay in `run.created.graph`, and `--agents` with a
  graph file is an error (put agents in the graph file).
- **Flow agents and independent agents.** Most nodes are flow agents: created for a node, done with it. A
  **standing** node is an independent agent of the run: it takes requests through its inbox, goes idle
  between them, and never completes on its own. The integrator is the first one; later, agents outside the
  run (for example over Comitia) can take this role.

## Merging

Every `work` node runs in its own git worktree, so work nodes run in parallel (up to 4 at a time). The workspace
must be a git repository with at least one commit; when it is not, the run fails with that reason before the first
work or check node starts.

1. **Integration branch.** Before the first work or check node starts, the supervisor creates branch
   `sous/<run>` from the workspace's `HEAD` and its worktree in `.sous/runs/<run>/integration/`
   (`integration.created`). `.sous/` is added to the repository's `.git/info/exclude`. The person's own
   checkout is never touched.
2. **Node worktrees.** A work node gets branch `sous/<run>.<node>` (git cannot hold `sous/<run>/<node>` beside
   `sous/<run>`) and worktree `.sous/runs/<run>/worktrees/<node>/`, created from the integration branch's
   current commit when the node starts (`worktree.created`). Its worker runs there and its acceptance check
   runs there. Nodes with `needs` start only after their dependencies are merged, so they build on that work.
3. **Merge queue.** When a work node is done and its acceptance check passed in its own worktree, the
   supervisor commits any uncommitted changes there and queues the branch (`merge.queued`). Merges happen one
   at a time, in queue order, in the integration worktree, by plain `git merge --no-ff`. A branch with no
   changes is `merge.done` by `nothing`. After a clean merge the node's acceptance command (if any) runs
   again in the integration worktree; if it passes, `merge.done` by `supervisor`. A message to a queued node
   waits until its turn to merge; if its inbox is not empty then, it leaves the queue (`merge.withdrawn`) and
   its worker resumes its session in its own worktree with the messages, and it queues again when done. Once
   its merge has started, a message waits; after `merge.done` the node is completed, and messages to it are
   refused like those to any finished node.
4. **The integrator.** A conflict, or a failing check after a clean merge, goes to the integrator
   (`merge.conflict`, with the commit the merge started from). On a conflict the merge is left in progress in
   the integration worktree; after a failing check the merge commit stays and the integrator fixes on top.
   Nothing else merges while the integrator works: the queue waits. The integrator is a standing node with id
   `integrator`, run by the graph's `integrator` agent if defined, else the first available of `codex`,
   `claude`, `pi`. It is created on the first conflict, with a short role brief, and resumed in the same
   session for later requests. Each request is a message in its inbox naming the node, its branch, the
   conflicted files or the failing check's output, and the briefs of the node and of the nodes already merged.
   It works in the integration worktree, resolves, commits the merge (or its fix), and reports. A `done` is
   verified: no merge in progress, no uncommitted change to tracked files, the node's branch is an ancestor of
   the integration branch, no conflict marker lines left in the files that conflicted, and the node's check
   passes in the integration worktree; then `merge.done` by `integrator`. A failed verification goes back to the integrator
   once. `blocked`, `needs_input` or a second failed verification is `merge.failed`: the integration branch
   is reset to where the merge started, the node fails and its parent is told. The integrator never completes,
   does not count toward the run's completion, and shows in `sous status` (`idle` between requests).
5. **Completion.** A work node completes only on `merge.done` (and fails on `merge.failed`). `check` nodes run
   in the integration worktree, so they check the merged result; they and merges take turns there. A lead's
   children are therefore merged before the lead hears they completed.
6. **The result** is branch `sous/<run>`. Merging it into the person's own branch is their decision; `sous
   status` and the end of `sous run` name the branch.
7. **Traces.** Worktree and merge events are system steps in the node's ATIF trajectory and spans under the
   node in Langfuse; the integrator is its own trajectory under the root.

Recovery: worktrees, branches and queue state survive a crash. `integration.created` and `worktree.created`
are appended only when the branch was newly created; on resume the existing worktree is used. On `sous
resume`, a merge in progress with no integrator request pending is aborted and retried (a merge that already
committed is not repeated, its check runs again); with a request pending, the integrator's session resumes as
usual; queued merges continue in order.

## Recovery

The supervisor, not any lead, owns recovery. `sous resume [run-id]` (latest run by default) continues a run
whose supervisor stopped, whether it was stopped with Ctrl-C or killed.

1. **Intent before effect.** `turn.started {node, turn, pid, startTime}` is appended immediately after
   spawning (`startTime` is field 22 of `/proc/<pid>/stat`); `turn.session` once a session ID is known;
   `turn.ended {result}` after.
2. **Output goes to files**, so a turn that finishes while the supervisor is down leaves its result on disk.
3. **The lock.** `sous resume` removes a lock whose holder is gone (pid plus start time) and refuses a live
   one. It appends `run.resumed`; a run that already completed or failed is not resumed.
4. **Unfinished worker turns.** For each turn without `turn.ended`:
   - its output file has an end marker with a result → record `turn.ended` from it; the turn is not run again;
   - its process group is still alive (the leader's pid with the recorded start time, or a group whose leader
     is gone, since a pid is not reused while its group has members) → record `turn.interrupted`, stop the
     group, record `turn.ended`;
   - otherwise → record `turn.ended` without a result. A turn recorded without a start time is never signalled.

   A node whose last turn has no result then resumes its session with a recovery turn
   (`turn.started {recovery: true}`): "you were interrupted; re-check the workspace", plus any messages in its
   inbox. A node without a session ID starts again from its brief. A node whose last turn ended `done` runs
   its acceptance check (again, if it was running), and a worker's question that was not yet sent to its
   parent is sent.
5. **Checks** (`check` nodes and acceptance checks) that were running are simply run again; one whose
   `check.ended` was recorded settles from it. Their processes are not recorded, so one left running by a
   killed supervisor finishes on its own.
6. **Leads recover through pi-durable.** The supervisor calls `LeadRunner.resume()`, which reopens every
   lead's storage and resumes its unfinished run, replaying interrupted tool calls (they find their effects in
   the event log by tool call ID). Then it delivers again every `lead.delivered` without a `lead.turn`; the
   runner ignores a request ID it already has, so this is safe.
7. **Person commands** waiting in `<runDir>/commands/` are processed as usual. The event a command produces
   carries its file name (`command`) and is appended before the file is removed, so a crash in between neither
   loses it nor applies it twice.
8. **Recovery spends budget.** Each recovery turn counts as an attempt: a node that would need a fourth
   fails with "a supervisor stop cut its turn short after 3 recoveries" (a constant, not a setting).

Pi runs its tool commands in their own session, outside the turn's process group. In the v2 real run (Roadmap),
after `sous run` was killed with SIGKILL, Pi and its running `sleep` survived (reparented); `sous resume`
sent SIGTERM to Pi's group and Pi stopped its tool command before exiting. Had Pi needed SIGKILL, its tool
command could have outlived it.

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
- Workers run with full permissions in their worktree: Claude `--permission-mode bypassPermissions`,
  Codex `-s danger-full-access`, Pi's default tools.

## Traces: ATIF and Langfuse

The event log plus the raw turn output files are the canonical record. Exporters derive standard formats
from them, so traces can move between tools later.

### ATIF (Harbor RFC 0001, ATIF-v1.8)

`sous export atif [run-id]` writes one ATIF document per run, to `.sous/runs/<id>/trace.atif.json`:

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
- sous-specific data goes only in `extra` fields, because ATIF rejects unknown keys. Tokens map to
  `metrics` (`prompt_tokens` includes cached tokens; Anthropic cache-creation tokens go in `metrics.extra`).
- Tests check every document with a strict checker of the subset sous emits (`test/atif-checker.ts`),
  and with Harbor's validator (`python -m harbor.utils.trajectory_validator`) when Harbor is installed
  (`HARBOR_PYTHON`).

### Langfuse (OTLP/HTTP)

`sous export otlp [run-id]` posts OTLP JSON to
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
<workspace>/.sous/runs/<run-id>/
  run.json             goal, workspace, graph or agents file, created at
  events.jsonl         the event log (append-only; fsync per event)
  lock                 supervisor pid and start time
  commands/            command files from sous answer, approve and cancel, until processed
  nodes/<node-id>/
    turn-<k>.jsonl     raw harness stdout for turn k
    turn-<k>.err       raw stderr
  leads/<node-id>/     a lead's pi-durable conversation (JSONL storage)
  integration/         git worktree of branch sous/<run-id>, where merges and check nodes run
  worktrees/<node-id>/ git worktree of branch sous/<run-id>.<node-id> for a work node
  trace.atif.json      written by sous export atif
```

## Implementation

Node 22.19 or later runs the TypeScript sources directly (type stripping). Only the lead runner has
runtime dependencies: `@earendil-works/pi-durable`, `pi-ai` and `chord`, pinned to exact versions because
the API is experimental. The supervisor, adapters and exporters use Node built-ins only.
Development dependency: `typescript` for type checking. Tests use `node:test`.

## Roadmap

| Version | Scope | Done when |
|---|---|---|
| **v0** (done) | Fixed graph file; `work` and `check` nodes run in the workspace directory, writing nodes one at a time; Claude, Codex and Pi adapters; event log; `sous run`, `status`; ATIF and OTLP exporters | a two-node graph (work, then check) runs to completion on each harness and exports a valid ATIF file and a Langfuse trace |
| **v1** (done) | `lead` nodes and their tools; inboxes; `queue` and `interrupt`; notes; `answer`, `cancel` | a goal given to a root lead is split into children that complete, with one interrupt exercised |
| **v2** (done) | `sous resume` and crash recovery; `gate` nodes | killing the supervisor mid-run and resuming completes the run without repeating finished turns |
| **v3** (done) | Agents as the unit of work (definitions, availability defaults, standing agents); worktrees, merge queue and the integrator | parallel writing children of a lead are merged into `sous/<run>`, one real conflict resolved by the integrator |
| **v4** (done) | Agents leads define on runtimes the run lists `models` for; model limits; `--agents` for goal runs; `--max-depth` | a lead defines an agent in a real run, and its worker runs with that agent's model and instructions |
| **Later** | Separate `review` nodes (meanwhile a lead can spawn a work node on another harness to review); cost budgets (Ollama reports no prices) | |

v1 was verified on 2026-10-11 with real runs: leads on `ollama-cloud/deepseek-v4.1-flash`, workers on Pi
(its default `ollama-cloud/glm-5.2`). A goal split into two work children and a check completed and exported a valid
ATIF file with the children nested under the lead; a lead escalated a choice and finished with the answer
given by `sous answer` from another process; `sous cancel` of a running worker, and of the lead, stopped the
processes (Pi's tool command included) and failed the subtree; a lead told to interrupt its running worker
did, and the worker resumed its session with the message. Limitations found:

- The interrupt was exercised only when the goal told the lead to send it, and it reached the worker before
  its first tool call; an interrupt mid-command is covered by the fake-harness tests only.
- Pi runs its tool commands in their own session, outside the turn's process group. Pi stops them on
  SIGTERM; if a turn needs SIGKILL, they can outlive it.
- Ollama Cloud reports no prices, so lead and Pi worker usage is in tokens only.

v2 was verified on 2026-10-11 with real runs (lead on `ollama-cloud/deepseek-v4.1-flash`, workers on Pi). A
goal split into two Pi work children and a check; `sous run` was killed with SIGKILL while the second child ran
`sleep 30`; `sous resume` stopped the orphaned Pi turn and resumed its session, and the run completed with one
spawn call, the first child's single turn, and an ATIF file that Harbor's validator accepted. In a second run the
supervisor was killed just after a child's outcome was delivered to the lead and before the lead answered or the
check ran; after `sous resume` the lead answered that delivery once, the check ran, and the run completed with
no turn repeated. The 3-recovery limit, a reused pid, a turn finished while the supervisor was down, and gates
are covered by fake-harness tests with real processes.

v3 merging was verified on 2026-10-11 with a real run (lead on `ollama-cloud/deepseek-v4.1-flash`, workers on
Pi, the integrator on its default, Codex). The goal told the lead to spawn two parallel Pi children that both
rewrite line 1 of a seeded file. The first merged cleanly; the second conflicted, and Codex, as the integrator,
resolved it in the integration worktree; `sous/<run>` held both lines, the person's checkout was untouched, and
Harbor's validator accepted the exported ATIF file. Codex first committed the merge with the conflict markers
still in it (its edit command failed) and fixed the file in a second commit. Verification checks the final
state, not each commit; since that run it also rejects marker lines left in the conflicted files. Agent
definitions and availability defaults were verified in two real runs: a graph agent's instructions reached its
Pi worker, and a lead spawned a child naming agent `pi`.

v4 was verified on 2026-10-11 with a real run (lead on `ollama-cloud/deepseek-v4.1-flash`, `--agents` with
`{"models": {"pi": ["ollama-cloud/glm-5.2"]}}`): the lead defined `lowercase-poet` on `pi`, its worker ran on
Pi with the lead's instructions in its prompt, the work merged, the check passed, and Harbor's validator
accepted the ATIF file. A lead choosing a non-default listed model, and `--max-depth`, are covered by
fake-runner tests only.

## Open questions

- Whether workers run with full permissions in their worktree (current assumption) or a narrower set.
