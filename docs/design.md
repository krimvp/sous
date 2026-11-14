# sous design

sous runs a task, or a set of tasks, to completion on one machine. A tree of agents does the work: lead agents plan
and split, worker agents (Claude Code, Codex, Pi, Factory Droid or a custom agent) do the work, and plain code keeps
everything moving. sous is local only. Only the lead runner has runtime dependencies. The whole state is in files
that you can read.

The name comes from the kitchen brigade: the sous chef splits an order across the stations (leads), cooks do the
work (workers), and each plate is inspected before it leaves (merges and checks).

This document is the reference for contributors. It uses "the person" for the human who runs sous.

**Contents:** [Principles](#principles) · [Out of scope](#out-of-scope-for-now) · [Concepts](#concepts) · [Architecture](#architecture) ·
[Messaging across levels](#messaging-across-levels) · [Leads](#leads) · [Roles](#roles) · [Splitting](#splitting) ·
[Agents](#agents) · [Merging](#merging) · [Recovery](#recovery) · [Harness conformance](#harness-conformance) ·
[Harness facts](#harness-facts-spike-2026-10-11) · [Traces](#traces-atif-and-langfuse) · [The UI](#the-ui) ·
[Storage layout](#storage-layout) · [Implementation](#implementation) · [Roadmap](#roadmap) ·
[Open questions](#open-questions)

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
   Pi, Droid and in-process agents all look the same to the supervisor.
5. **Enforce in code, not in prompts.** Depth, fan-out, budgets, who may message whom and which worker
   kinds a node may use are checked by the supervisor when a lead calls a tool.

## Out of scope for now

No sandbox (workers run as the user's own CLIs, in a git worktree or their own folder), no multi-host execution,
no remote pushes or PRs, no message service. These can come later behind the seams below. The UI (`sous ui`) only
reads runs for now; steering a run from it is #60.

sous focuses on trees that leads grow at runtime. Fixed graph files also run: they test the engine without a lead,
and they fix the steps around leads when the person wants that.

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
| `lead` | an LLM with orchestration tools and read-only file tools | splits its node into children, reacts to events, completes itself |
| `work` | a worker adapter (Claude, Codex, Pi, Droid, custom) | does the work (code, research, writing, analysis) in a git worktree or its own folder |
| `check` | a shell command | deterministic gate; exit code 0 passes. It ends when the command exits: what it left running (a server, a watcher) is stopped |
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
sous CLI ──▶ supervisor ──▶ adapters (claude | codex | pi | droid | custom) ──▶ worker processes
               │   ▲                                                        │
               │   └──────────── turn output files (.sous/runs/<id>/nodes/) ◀┘
               ├──▶ lead runner (LLM + orchestration tools; tool calls become events)
               ├──▶ .sous/runs/<id>/events.jsonl  (the only state)
               └──▶ trace exporters (ATIF file, OTLP/HTTP to Langfuse)
```

Where each part lives in `src/`, and which module may import which, is in the code map,
[architecture.md](architecture.md).

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
  sessionId: Promise<string>                 // known up front for Claude and Pi; parsed from the stream for Codex and Droid
  exit: Promise<{ code, signal }>            // the process exited; the outcome is parsed from the output file
}
```

Each adapter starts the CLI as the leader of a new process group, sends stdout to
`nodes/<n>/turn-<k>.jsonl` and stderr to `turn-<k>.err`, and asks for a structured final result:
`{status: done|blocked|needs_input, summary, question?}`. What each field means is said once, in every worker prompt;
Pi and Droid, which have no structured-output flag, are also told to give it as JSON in a ```` ```json ```` fence, and
their parsers take the last fence that holds a result, else a bare JSON object.

**A turn without a result.** A turn whose output has no end-of-turn marker, or no parsable result, is resumed once with
a reminder to give one; a second miss fails the node. A turn that exits non-zero before its end marker, on its own (not
stopped by sous), says why on stderr: the last non-empty lines of its `.err` file (at most 5 lines and 600 characters)
and the file's path go into `turn.ended.error` and the node's failure reason. When it wrote no output (no message or
tool call), another turn would fail the same way, so the node fails at once without the reminder; an integrator's or
splitter's turn like it fails the merge or the split.

**Stalls.** There is no turn timeout yet (budgets, #39), so a hung harness must at least show. The supervisor watches each
turn's output file; once it has not grown for 10 minutes (a constant), it records `turn.stalled {since}`, once per turn:
a warning that changes nothing in the run's state, since a long command is silent too. `sous status` shows each running
turn's age and how long ago its output last grew (the output file's modification time); the UI's tree shows both.

### Lead runner

Leads run on **pi-durable** (`@earendil-works/pi-durable`, decided 2026-10-11 after
a spike that killed a lead in the middle of a spawn and reopened it without spawning anything twice). Each lead node is one durable conversation, stored with the
JSONL backend in `.sous/runs/<id>/leads/<node>/`. The conversation and its tool calls survive a crash: a
reopened lead continues where it stopped.

- **Events reach a lead as submissions:** a follow-up when it is idle, a steer when it must change course
  now (its own `queue` and `interrupt`). Each carries a `requestId` derived from the event's `seq`, so
  redelivery after a crash is ignored.
- **Its only tools are the orchestration tools and two read-only file tools below**, offered through one
  extension. Each is `replay: "safe"`, keyed by the model's tool call ID. An orchestration tool **returns the
  original result on replay**: in the spike, a different replay result made the model stop early. A read
  changes nothing, so a replayed read simply reads again.
- **Model:** the node's `model`, else its agent's, as `provider/model`, else the default: the first provider in
  `LEAD_PROVIDERS` (`src/contracts/agents.ts`) with a credential, on that provider's default model, decided with availability
  when the run starts and printed on the `agents:` line. The providers, in that order, are Ollama Cloud
  (`ollama-cloud/deepseek-v4.1-flash`: cheap; passed the spike, as did `ollama-cloud/glm-5.3`), Anthropic
  (`anthropic/claude-haiku-5-5`), OpenAI (`openai/gpt-6-luna`) and the ChatGPT login (`openai-codex/gpt-5.5`, which
  passed the spike); the first keeps its place so that nothing changes for a person who has it. The Anthropic and
  OpenAI leads have not been run live yet. The choice is recorded in `run.created.leadModel` and kept on resume (see
  Agents). Credentials come from the environment (`OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, as pi-ai
  reads them) or the user's Pi login in `~/.pi/agent/auth.json`, read only: sous never refreshes the login (a refresh
  rotates Pi's token; an expired login is refreshed by running `pi` once), so an OAuth token that has expired, or will
  within pi-ai's refresh margin, is left out, and a key in the environment is used instead; a login file that is not
  JSON is ignored and `sous doctor` says so. A lead that cannot run says what gets a credential for its provider. An
  Anthropic or OpenAI key in the environment also reaches Claude Code and Codex workers, which inherit it (the README
  says so). Ollama Cloud needs a small provider definition, because pi-ai has none built in; the others are pi-ai's.

Its tools:

| Tool | Effect |
|---|---|
| `spawn(children[])` | add child nodes under this node (kind, brief, acceptance, needs, agent, model) |
| `send(node, body, mode)` | message a child or the parent; `mode` is `queue` or `interrupt` |
| `note(text)` | add a note for this subtree |
| `cancel(node)` | cancel a child subtree |
| `complete(summary)` / `fail(reason)` | finish this node |
| `escalate(question)` | ask the parent (the root's parent is the person) |
| `list_files(path?)` / `read_file(path, offset?)` | look at the workspace and the results so far before splitting (read only) |

**Reading files.** Leads do no work, but they may look before they split. The files are the results worktree in git
mode (the workspace as committed plus the work merged so far; paths relative to it) and, in folder mode, `workspace/`
(the inputs) and `results/` (the output folder). Real paths are checked: anything outside these roots, through `..` or
a symbolic link, is refused. Listings are recursive, leave out `.git`, `.sous` and `node_modules`, and stop at 200
entries; a read takes regular files only (a FIFO or device is refused without opening it blocking) and returns at most 32 KB of text (`offset` reads on) and refuses files with NUL bytes. Each read is
recorded as `lead.read` with its path and byte count, not its text, and shows in the traces as a tool call.

A lead ends its turn by answering, not with a tool; the next delivery wakes it. Each tool call is
validated against policy and appended as an event before the supervisor acts on it. The
supervisor's event log stays the source of truth for the tree; pi-durable holds only lead transcripts.

## Messaging across levels

Agents address nodes, not processes, and the supervisor is the only router.

- **Workers send sideways and up, never down or across.** A worker's turn result is its answer to its lead; while it
  works it may also `send` to a sibling or to its own lead (see Worker messages). Incoming messages arrive through
  `resume`.
- **Leads may message their children and their parent.** Anything crossing branches goes up to the nearest
  shared ancestor and back down.
- **Delivery:** append a `message` event, add it to the recipient's inbox, then wake the recipient: start a
  lead turn, resume an idle worker, queue for a running worker, or interrupt it.
- **Escalation goes up a level.** The person is the root's parent: `sous answer <node> "…"`.

No message service is used: the supervisor is the only writer and already wakes everyone, which are the two
things a message service would provide. An `onEvent` hook is the seam for mirroring events to such a service
later, when an agent the supervisor did not launch needs to take part.

### Worker messages

A worker that learns something a sibling or its lead must know while it works (an interface it settled, a file it
moved, a change of plan) tells them with `send`, without stopping, and reads what others tell it with `receive`.

- **Two ways in, one way through.** Claude, Codex and Droid workers have `send` and `receive` tools from sous's MCP server
  (`src/mcp.ts`, stdio JSON-RPC on Node built-ins), which their harness starts for the turn; every worker can also run
  `sous send <to> 'text'`, whose full command its brief gives (Pi workers use only this). Both check the message and
  write a command file `{type: "send", from, to, text}`; the supervisor checks it again when it applies it and appends
  a `message` with `sent: true`. It stays the only writer.
- **Identity.** The supervisor starts each worker turn of the tree with `SOUS_RUN_DIR`, `SOUS_NODE` and `SOUS_TURN`
  (`TurnSpec.env`), which both ways read; no other `SOUS_*` variable of the supervisor's environment reaches a turn or a
  check, so a standing node, which gets none, or a check does not take on the identity of an outer run's worker when
  sous runs inside one.
  This is attribution, not authentication: workers run as the person.
- **Policy** (`src/commands/worker.ts`): only a work node of the tree sends (not a standing node); to its lead or a sibling (same
  parent), not to itself, a check, a gate, a finished node, or a node waiting to merge (its work is done: tell the
  lead instead); non-empty text; at most 5 messages per worker over the run. Messages are `queue`, never `interrupt`:
  only a lead stops a worker.
- **Receiving mid-turn.** `receive` (the tool, or `sous receive [seconds]`) returns the messages waiting for the worker
  (from its lead, its siblings or `supervisor`), waiting up to 60 seconds for one if asked, so a worker can wait within
  its turn for what a sibling must tell it. It writes a command `{type: "receive", node, turn, upTo}`, applied as
  `inbox.read`. Messages read in a turn count as read once that turn ends with a result, and are not delivered
  again; a turn cut short (interrupted, stopped, or ended without a result) gets them again when it resumes, since the
  model may never have seen them. Only the node's current turn reads (`SOUS_TURN`): a receive from a process left over
  from an earlier turn takes nothing, and an urgent message already read does not interrupt the turn. A second
  `receive` before the supervisor applies the first skips them too (it reads pending commands). When a turn ends, the
  supervisor applies the worker's pending commands before looking at its inbox, so a worker that read its messages
  and finished is not resumed with them.
- **Delivery** of what a worker does not `receive` follows the usual rules: the recipient reads it when its current
  turn ends, and a worker's `done`
  counts only with an empty inbox, so a sibling cannot finish without having read it; a waiting worker resumes with
  it; a pending one gets it in its brief. The sender's lead gets every message: what it is told ("Child a tells you
  while it works (no answer needed)") and a copy of what its children tell each other. A message refused when the
  supervisor applies it (the run moved on) comes back to its sender from `supervisor`, unless the sender is already
  waiting to merge (telling it would take it out of the merge queue). A sibling lead gets a worker's message too, as
  something it cannot answer (its `send` reaches only its own children and parent).
- **Only through sous.** Workers load no MCP server but sous's (Droid workers: none the person configured, but those
  their plugins bring still load), and as little of the person's own setup as each
  harness allows, while the project's instructions still apply; their brief tells them to talk to the run's
  other agents only with `send` and `receive`. Per harness (checked with `claude -p` init events and answers,
  `codex debug prompt-input`, and Droid runs with a project hook, a project MCP server and the person's skills):

  | Harness | MCP | The person's own setup |
  |---|---|---|
  | Claude | `--strict-mcp-config`, `--mcp-config` for sous's server | `--setting-sources project`: no user settings (so no user default model, `env`, permission rules or hooks: guardrails such as a hook that blocks `git push` do not apply), CLAUDE.md, skills or plugins. **Claude still reads `CLAUDE.md` and `CLAUDE.local.md` in the directories above the worktree**, the workspace's own included, since worktrees live in `<workspace>/.sous/` |
  | Codex | the person's servers disabled by name (`codex mcp list --json`, listed once without blocking when `sous run` or `sous resume` starts, not on a turn; `-c mcp_servers=…` merges); each server the worktree's `.codex/config.toml` names (as a table, a quoted table, a `[mcp_servers]` entry or a dotted key) replaced by a whole disabled server (Codex reads its configuration once without the project's file, before its first `exec` in a workspace records the workspace as trusted in `~/.codex/config.toml`, and once with it, so a bare `enabled=false` is invalid in the first read and the listing may predate the trust); sous's added | `--ignore-rules` and hooks off (the project's rules and hooks too), apps, plugins and the skills section off; **the global `~/.codex/AGENTS.md` still loads**, since leaving it out means moving `CODEX_HOME`, which would put the login at risk |
  | Pi | `--no-mcp` | `--no-skills`, `--no-prompt-templates`, `--no-context-files`, with the worktree's own `AGENTS.md` and `CLAUDE.md` appended (none in a folder-mode node's folder) |
  | Droid | a runtime settings file (`--settings`, merged for the process) adds sous's server and replaces every other server named in `~/.factory/mcp.json` and the worktree's `.factory/mcp.json` and `.mcp.json` with a disabled stub, so none of their configuration is copied | in the same file, hooks off (`hooks.hooksDisabled`, the project's too) and, by name in `disabledSkills`, the skills in `~/.factory/skills`, `~/.agents/skills` and the person's installed plugins; `--disable-builtin-skills`. Droid reads the worktree's own `AGENTS.md`, not files above the git root. **The person's custom droids (subagents) and any MCP servers or droids their plugins bring still load** |

  A project skill named like one of the person's is disabled too. sous's MCP server refuses an argument a tool does not
  take (Claude once called `receive` with `{"seconds": "60"}` and read the immediate "No messages." as a minute's wait),
  or one of the wrong type (an object `body` is not sent as text). If Codex's servers cannot be listed, sous says so on
  stderr and Codex workers may load them; a Codex server, the person's or the project's, whose name is outside
  `A-Za-z0-9_-` (a dot, a space) cannot be named in an override, so sous says so on stderr and does not disable it.
  So the channels a worker is offered all go through the run's log. A worker still has a shell and the person's files
  and network, so this keeps honest workers inside sous rather than preventing a determined one from reaching another
  service; that needs sandboxed workers.

## Leads

The contracts are `ChildSpec`, `LeadCall`, `LeadRead`, `LeadHost` and `LeadRunner` in `src/contracts/leads.ts`, and the
`lead.*` and `node.cancelled` events in `src/contracts/events.ts`.

**Starting.** `sous run <graph.json | "goal">`: an argument naming an existing file is a graph file (its
top-level nodes may be of any kind, `lead` included); anything else is a goal, which becomes one top-level
`lead` node with id `lead` and the goal as its brief (`--agents <file>` gives a goal run agent definitions; see
Agents). A single word that ends in `.json` or holds a path separator but names no file is refused as a likely
mistyped file name, not run as a goal. A lead's first delivery is its brief, with request ID `<node>:brief`; in a run with a splitter, the brief
waits for the lead's proposed split and carries it (see Splitting).

**Deliveries.** The supervisor composes every text a lead receives and records it as `lead.delivered`
before calling `LeadRunner.deliver`, with request ID `evt-<seq>` of the event that caused it:

- a child's outcome: completed with its summary and the files it added to the results (at most 20 named, and any
  renamed in folder mode), failed with its reason;
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
reminders without progress the lead fails. A delivery the runner could not get answered (a model error, an
expired login: `lead.turn` is `unanswered` with the reason) is retried once with the reason, where an idle
lead would be reminded (so a working child's outcome reaches the lead first, and the retry is not a
reminder); when the retry goes unanswered too, the lead fails with that reason, not as idle. A settlement the
runner cannot report (its storage, the host's log) reaches the host the same way, as `unanswered` with the error.

**The person.** Messages to `person` are printed by `sous run` and listed by `sous status`. `sous answer
<node> "text"`, `sous approve <gate>` and `sous cancel <node>` (from another terminal) write a command file in
`<runDir>/commands/`; the supervisor turns it into a `message` from `person` or a `node.cancelled` event
(`sous approve` also releases a lead whose proposed split waits for the person; see Splitting).
The supervisor stays the only writer of the log. Each command takes an optional run id after its arguments; without
one it goes to the workspace's one running run (its lock held by a live supervisor), not the newest run, and with
several running it is refused with their ids. The commands sous prints for the person name the run when the workspace
has more than one. A command that does not apply is refused by the CLI, and checked again when the supervisor reads it,
as the run may have moved on or another process may have written the file: one that is not valid, names no node or a
finished one, approves a gate not yet waiting or a node that is neither a gate nor a lead with a proposed split,
answers a check or a gate, or cancels a standing node (the integrator or a splitter, which the run would lose for good:
cancel the node it works for instead) is recorded as `command.refused` with the command's file name and the reason,
printed by `sous run` and listed by `sous status`.

**Gates.** A `gate` node (in a graph file, or a lead's child) has a `brief` saying what the person approves and
no command. Once its `needs` complete, the supervisor sends its brief to `person` as a message; `sous run` prints
it as an approval request and `sous status` lists it. `sous approve <gate>` completes it with summary "approved
by person"; `sous cancel <gate>` rejects it (it fails as cancelled, so nodes that need it fail, and its lead is
told). A gate takes no messages, and a lead waiting only on a gate (or on a child lead whose split awaits the person's
approval) is not reminded. Nothing checks who wrote a command file: workers run as the person with full permissions
and get `SOUS_RUN_DIR`, so a worker, or anything it runs, can write one too and approve a gate or a split, answer as
the person or cancel a node. Until workers are sandboxed (#43), a gate protects only as far as the person trusts the
run's agents.

**Completion.** A run whose top-level nodes include a lead completes when every top-level node completes; with
several top-level nodes its summary names each top-level lead that completed with failed checks.
A lead may complete over a failed check child (its judgment), but it is recorded: a check child counts as failed
when it failed (not cancelled) and no check child added after it passed. The fold keeps these on the lead
(`failedChecks`, derived from the `complete` call's place in the log), the call's result says "completed with failed
checks: …", and so do the lead's outcome for its parent, `run.completed` and `sous status`.
Cancelling a node fails its subtree with reason `cancelled by <who>`, stops its running processes, and
calls `LeadRunner.cancel` for every lead in it; the supervisor delivers nothing more to a cancelled node.

## Roles

A **role** is a job an agent does for every lead of a subtree, rather than a node of its own. `ROLES` in
`src/contracts/nodes.ts` lists them; `splitter` is the first. The pattern is meant for later ones (a reviewer, say).

- **Assigning.** A lead node in a graph file may set `roles: { "<role>": "<agent>" }`, naming any agent of the graph
  or a built-in. A lead may set `roles` on a lead child it spawns, naming only agents the person defined (in the
  graph or `--agents` file), so the strategies stay the person's. Either way the agent must run a CLI harness, is
  not the integrator, and has a name of letters, digits, `_` and `-` (it names a node and a git branch).
- **Resolving.** A lead's agent for a role is the nearest `roles` entry from the lead up through its ancestors, else
  the run's agent named after the role (an agent named `splitter`), if it defines one. A sub-lead keeps its lead's
  agent unless it sets its own, so a subtree can have a different strategy, harness or model.
- **Running.** Each agent in a role is one standing node: `<role>` for the agent named after the role, else
  `<role>.<agent>` (both reserved as node IDs). It keeps one session for the run, and different agents in a role work
  in parallel, outside the limit of 4 work nodes at a time.
- **Telling leads.** When the person defined agents, a lead's brief says which agent is its splitter and which
  agents it may give a lead child, and a splitter may propose `roles` for the lead parts it proposes.

## Splitting

A lead both plans (splits its task into children) and coordinates (reacts to their outcomes). A run may give the
planning to a **splitter**: the agent in the `splitter` role (see Roles), on a CLI harness (`claude`, `codex`, `pi` or
`droid`; an agent named `splitter` on `lead` is rejected at load). Its `instructions` are the splitting strategy ("one
part per module", "tests first") and its model may differ from the leads': a strong splitter with cheap leads.
Without a splitter, leads split on their own, as before.

- **When.** A lead that becomes ready (its `needs` complete), top-level or not, with a splitter gets `split.requested`
  (naming the splitter agent) instead of its brief. A splitter takes its requests one at a time, in that order;
  different splitters work in parallel.
- **A splitter** is a standing node (see Roles): created on its first request, resumed in the same session for later
  ones, never completing, not counted toward the run's completion. Each request is a `message` from `supervisor`
  with what the lead will know: its task, acceptance criteria and notes, the agents and models its children may use,
  its depth, the IDs already taken, and the file to write.
- **It reads the code.** It works in its own worktree `worktrees/<its node>/` (branch `sous/<run>.<its node>`), reset to
  the head of the integration branch before each request (`git reset --hard`, `git clean -fd`). It sees the work
  merged so far, and nothing it writes reaches the run: it is told to change nothing, and the reset makes that safe
  without per-agent tool limits. In folder mode it works in its own folder `work/<its node>/`, whose links `workspace`
  and `results` show the inputs and the current results (see Folder mode); its folder is never collected, and nothing
  runs git.
- **The proposal** is `{"parts": [ChildSpec, …]}`, written to `<runDir>/splits/<lead>.json`, then a `done` result
  whose summary describes the split. The supervisor checks it exactly as it checks the lead's `spawn` (kinds,
  briefs, IDs, `needs`, agents, models, depth, children per lead); an invalid proposal goes back to the splitter
  once, with the reason. A valid one is recorded as `split.proposed` (parts and summary). Otherwise `split.failed`
  records why: no valid proposal after the retry, the splitter `blocked` or `needs_input`, its agent not available,
  or (git mode) the workspace a git repository without a commit.
- **Advisory.** The lead's brief ends with the proposal as JSON ("spawn these children as they are, adjust them,
  or split differently") or with why there is none. The lead acts through its normal `spawn` calls, under every
  usual limit; nothing is spawned for it. Proposals for sibling leads are each checked when made, so their IDs may
  collide; the later `spawn` is refused and that lead adjusts.
- **Approval.** With `sous run --approve-splits` (`run.created.approveSplits`; an error when the run defines no agent
  that could split: no `splitter`, no `roles`, no worker agent a lead could give the role), a
  proposed split goes to the person as a message from its lead, and the lead is `waiting` until the person
  answers: `sous approve <lead>` sends "The person approved the proposed split.", `sous answer <lead> "…"` sends
  changes. Either releases the brief, followed by the person's message; `sous cancel <lead>` cancels the lead. A
  failed split needs no approval. Its parent lead waits for the person with it: like a lead waiting only on a gate,
  it is not reminded.
- **Recovery** is the integrator's: a splitter turn a supervisor stop cut short resumes its session with a recovery
  note that repeats the split's request (the cut turn may have stopped before the splitter read it); a turn that ended
  before the stop is settled from its result and its file without running again. Cancelling a lead stops the
  splitter turn working on its split.
- **Traces.** `split.requested`, `split.proposed` (with its parts) and `split.failed` are system steps in the lead's
  ATIF trajectory, before its brief, and a `split` span under the lead in Langfuse, so a run shows what was proposed
  beside what the lead spawned. The splitter is its own trajectory under the root.

## Agents

An **agent** is what does work; a harness is only how an agent runs. An agent has a name, a runtime (`claude`,
`codex`, `pi`, `droid` as CLIs, or `lead` in process), an optional model, and optional standing instructions added to
every brief it receives (`AgentSpec` in `src/contracts/agents.ts`).

- **Built-in agents** `claude`, `codex`, `pi`, `droid` and `lead` exist without being defined. A graph file may define
  more under `agents`, by name, and a name may shadow a built-in. Nodes and lead children name an `agent`.
- **Availability decides defaults.** An agent is available when its CLI is on `PATH` (for `lead`: when its model's
  provider has a credential, or, for a lead agent with no model, when any lead provider has one; such an agent runs
  on the first with a credential, see Lead runner). A work node that names no agent gets the graph's `agent`, else the
  first available of `claude`, `codex`, `pi`, `droid`. Availability is checked once when a run starts or resumes,
  and printed (`agents: …; not available: …`, each lead agent with the model it runs on; for a graph without lead nodes only the agents its work nodes use, as no lead can pick another). The model chosen for lead
  agents that name none is recorded in `run.created.leadModel`; a resumed run resolves such leads to it, whatever
  credentials are present then (a lead whose recorded provider lost its credential is unavailable, with the fix,
  rather than moved to another provider). `sous doctor` runs the same
  check without a run and prints it (each harness on `PATH` with its `--version`, not whether it is logged in; the
  lead credentials present, never their values, and the lead model a run would use), with the workspace's git state (repository or folder mode, a
  commit, uncommitted changes, which workers do not see, and whether an explicit `--workspace` is below the top level, which `sous run` would take as given), and exits 0
  when a run could start: a lead, a worker, and a commit when in git. A run is refused before it exists, naming the node and the agent and
  what to do, when the agent any of its work or lead nodes resolves to (the one it names, else the default: the
  graph's `agent` or first available worker for work, `lead` for a lead, a goal run's root lead included) is not
  available, or when no default worker is. What a lead decides at runtime cannot be checked then: an unavailable
  agent a lead's child names later fails that node with a clear reason. Each
  turn records the agent it ran on (`turn.started.agent`). A lead's brief lists the available agents its
  children may name, those leads defined so far included (the splitter is not one), with each one's runtime when it differs from its name.
- **Agents leads define.** A lead's child may define a new agent instead of naming one: `ChildSpec.agent` is then
  `{ name, runs, model?, instructions? }` (`NewAgent`). The constraint is the runtime: `runs` must be a runtime
  the run lists models for (see Model limits), and `model` one of them, by default the first. The agent has exactly
  the instructions the lead gives; nothing is inherited. `name` is a valid id that no built-in, defined or
  lead-defined agent has, and not `integrator` or `splitter`. The accepted `lead.call` spawn defines it in the fold, atomically
  with its child, and it exists for the rest of the run: any later spawn, by any lead, may name it. Kind rules are
  unchanged: a lead child needs `runs: 'lead'`, a work child another runtime, and the runtime must be available.
  Leads may still name any existing agent as it is. Status, ATIF and OTLP show the agent by its name.
- **Model limits.** A graph file or agents file may set `models: { claude?, codex?, pi?, droid?, lead? }`, lists of
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
  between them, and never completes on its own. The integrator and the splitter are the first ones; later, agents outside the
  run (for example over a message service) can take this role.

## Merging

A run's mode is decided once, when it is created, and recorded in `run.created.mode` so `sous resume` keeps it (a log
without it is git mode). **Git mode** applies when `git` runs and the workspace is inside a git work tree; otherwise the
run uses **folder mode** (below), with no setting either way.

In git mode every `work` node runs in its own git worktree, so work nodes run in parallel (up to 4 at a time). The
workspace must be a git repository with at least one commit; when it is not, the run fails with that reason before the
first work or check node starts. The workspace is the repository's top level even when sous starts in a subdirectory
(an explicit `--workspace` is used as given)
(worktrees cover the whole repository, so workers and checks work from the root, and `.sous/` lives there for every command to find);
`sous run` says so. Workers and checks see `HEAD` only: at run start `sous run` prints
`workspace has N uncommitted changes; workers see HEAD only` when `git status` shows any (a warning; `.sous/` does not count).

1. **Integration branch.** Before the first work or check node starts (or the first split), the supervisor creates branch
   `sous/<run>` from the workspace's `HEAD` and its worktree in `.sous/runs/<run>/integration/`
   (`integration.created`). `.sous/` is added to the repository's `.git/info/exclude`. The person's own
   checkout is never touched.
2. **Node worktrees.** A work node gets branch `sous/<run>.<node>` (git cannot hold `sous/<run>/<node>` beside
   `sous/<run>`) and worktree `.sous/runs/<run>/worktrees/<node>/`, created from the integration branch's
   current commit when the node starts (`worktree.created`). Its worker runs there and its acceptance check
   runs there. Its brief names the branch, says sous commits its changes, and tells it not to switch branches, commit
   elsewhere, stash, reset or push. Nodes with `needs` start only after their dependencies are merged, so they build on that work.
3. **Merge queue.** When a work node is done and its acceptance check passed in its own worktree, the
   supervisor checks that the worktree is still on the node's branch (a worker that switched branches or detached
   `HEAD` fails its node, and nothing is committed), commits any uncommitted changes there and queues the branch
   (`merge.queued`). Merges happen one
   at a time, in queue order, in the integration worktree, by plain `git merge --no-ff`. A branch with no
   changes is `merge.done` by `nothing`. After a clean merge the node's acceptance command (if any) runs
   again in the integration worktree; if it passes, `merge.done` by `supervisor`. The worktree is reset to its
   head (`git reset --hard`, `git clean -fd`; ignored files stay) before each merge and after each check run
   there, so what a check leaves behind (a formatter's edits, a generated file) never refuses the next merge
   or counts as the integrator's. A message to a queued node
   waits until its turn to merge; if its inbox is not empty then, it leaves the queue (`merge.withdrawn`) and
   its worker resumes its session in its own worktree with the messages, and it queues again when done. Once
   its merge has started, a message waits; after `merge.done` the node is completed, and messages to it are
   refused like those to any finished node.
4. **The integrator.** A conflict, or a failing check after a clean merge, goes to the integrator
   (`merge.conflict`, with the commit the merge started from). On a conflict the merge is left in progress in
   the integration worktree; after a failing check the merge commit stays and the integrator fixes on top.
   Nothing else merges while the integrator works: the queue waits. The integrator is a standing node with id
   `integrator`, run by the graph's `integrator` agent if defined, else the first available of `codex`,
   `claude`, `pi`, `droid`. It is created on the first conflict, with a short role brief, and resumed in the same
   session for later requests. Each request is a message in its inbox naming the node, its branch, the
   conflicted files or the failing check's output, and the briefs of the node and of the nodes already merged.
   It works in the integration worktree, resolves, commits the merge (or its fix), and reports. A `done` is
   verified: no merge in progress, no uncommitted change and no untracked file (ignored files aside), the node's branch is an ancestor of
   the integration branch, no conflict marker lines left in the files that conflicted, and the node's check
   passes in the integration worktree; then `merge.done` by `integrator`. A failed verification goes back to the integrator
   once. `blocked`, `needs_input` or a second failed verification is `merge.failed`: the integration branch
   is reset to where the merge started, the node fails and its parent is told. The integrator never completes,
   does not count toward the run's completion, and shows in `sous status` (`idle` between requests). A node
   cancelled while its merge runs (a clean merge's check, or the integrator's work) gets no `merge.done`: the
   integration branch is reset to where its merge started.
5. **Completion.** A work node completes only on `merge.done` (and fails on `merge.failed`). `check` nodes run
   in the integration worktree, so they check the merged result; they and merges take turns there. A lead's
   children are therefore merged before the lead hears they completed.
6. **The result** is branch `sous/<run>`. Merging it into the person's own branch is their decision; `sous
   status` and the end of `sous run` name the branch. `merge.done.files` lists the files the node's commits changed,
   so its lead hears them with its outcome.
7. **Traces.** Worktree and merge events are system steps in the node's ATIF trajectory and spans under the
   node in Langfuse; the integrator is its own trajectory under the root.

Recovery: worktrees, branches and queue state survive a crash. `integration.created` and `worktree.created`
are appended only when the branch was newly created; on resume the existing worktree is used, whatever it has checked out (a node's then fails at its branch check, and an integration worktree not on `sous/<run>` fails the run). On `sous
resume`, a merge in progress with no integrator request pending is aborted and retried (a merge that already
committed is not repeated, its check runs again); with a request pending, the integrator's session resumes as
usual; queued merges continue in order. A merge of a node cancelled before the stop that is still on the integration
branch (the stop came before its reset) is dropped from it, once, on resume.

### Folder mode

For non-code work and machines without git. Nothing runs git.

1. **Folders.** The results gather in `.sous/runs/<run>/output/`. Each work node, each `check` node and each splitter gets a
   folder of its own, `.sous/runs/<run>/work/<node>/`, as its working directory, holding two links: `workspace` (to
   the workspace, the inputs) and `results` (to the output folder). So `workspace/` and `results/` mean the same to a
   lead's read tools, its workers and its checks; a check of a result reads, say, `results/report.md`. A worker's
   brief says both are read only and to write its own files at the top of its folder. Its acceptance check runs in
   its folder too. A link that cannot be created (a system without symbolic links) fails the node; there is no
   fallback. Worker messages work as in git mode: `send` and `receive` find the run through the turn's environment,
   not its directory, and a node waiting to be collected takes no worker messages (a lead's or the person's message
   withdraws it, see below).
2. **Collecting.** A done node joins the same queue (`merge.queued` without a branch). One at a time, its regular files
   (not `.git`, `.sous`, `node_modules` or symbolic links, so not the two links) are copied into the output folder by relative path. A file
   that is already there with the same content is skipped, so collecting again after a crash changes nothing. When a
   different file, a directory or a link is in the way, both are kept: the new one gets the first of
   `<name>.<node>.<ext>`, `<name>.<node>-2.<ext>`, … that is free or already holds the same content. A file or link in
   the way of a directory is renamed around the same way, at the first segment that clashes (`notes/report.md` lands
   in `notes.<node>/report.md`). So nothing in the results is ever replaced or followed, every rename is listed, and
   resume picks the same names. Each copy is staged under a unique name in the run directory (`.collect-<uuid>`, created
   exclusively) and renamed into place. Then
   `merge.done` (no commit; `nothing` when the folder is empty) records `files` and `renamed`, and the node's lead
   hears both. As in git mode, a node with messages waiting when its turn comes leaves the queue (`merge.withdrawn`),
   its worker resumes with them, and it queues again when done.
3. **Nothing else git-specific applies:** no integrator, no conflict markers, no reset. A collection that fails (for
   example, a full disk) is `merge.failed`.
4. **The result** is the output folder; `sous status` and the end of `sous run` name it.

## Recovery

The supervisor, not any lead, owns recovery. `sous resume [run-id]` (latest run by default) continues a run
whose supervisor stopped, whether it was stopped with Ctrl-C, killed, or ended by an error of its own. Ctrl-C
stops every running turn and check and waits for them (a second Ctrl-C kills what still runs); an unexpected
error does the same before the supervisor exits with it. Either way `sous run` and `sous resume` end with the
`sous resume` hint whenever the run is not over.

1. **Intent before effect.** `turn.started {node, turn, pid, startTime}` is appended immediately after
   spawning (`startTime` is field 22 of `/proc/<pid>/stat` on Linux, `ps -o lstart` in UTC, to the second, without `/proc`, as
   on macOS); `turn.session` once a session ID is known;
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

## Harness conformance

Every harness in `HARNESSES` (`src/contracts/workers.ts`) passes one suite, so a new one works the way the supervisor relies on. Its
entry in `test/conformance/harnesses.ts` (`Record<HarnessName, …>`: end marker, whether workers get sous's MCP server,
the certification model) is required by the type checker.

- **Free, in `npm run check`** (`test/conformance.test.ts`). Its recordings in `test/fixtures/conformance/<harness>/`
  (`read-file`, `needs-input`, `stopped`) parse to a session, an end only at the end marker, a `done` result with paired
  tool calls that read the note, usage with cached tokens inside the input, a `needs_input` question (in `question`,
  else `summary`, as the supervisor asks), and a stopped turn that names its session; every cut of them parses without a
  result before the end, with the same session and growing tool calls. A stand-in CLI checks that a turn runs in its
  directory with the whole prompt and the model, writes its output, settles its session, gets `SOUS_*` and sous's MCP
  server exactly once as a worker and neither as a standing node, names the session it resumes, and stops with its
  process group; and that the supervisor completes a work node with the adapter.
- **Live certification** (`npm run certify`, `SOUS_HARNESS=<names>`, costs money; `test/conformance-live.test.ts`).
  With the real CLI: a file read; a `needs_input` turn; a session resumed twice; a turn stopped mid-command by the
  supervisor's stop (no result, nothing left running, resumes); a turn killed with SIGKILL (resumes); two siblings that
  settle a name with `send` and `receive` in a real `sous run` while an MCP canary configured in every project location
  a harness reads (`.mcp.json`, `.factory/mcp.json`, `.pi/mcp.json`, `.codex/config.toml`) must not start; and a
  supervisor killed mid-turn whose run `sous resume` completes. `SOUS_RECORD=1` rewrites the recordings (with the
  home directory scrubbed from them). Every run writes `certified.json` beside them: CLI version, model, date, tests
  passed and failed. Pi reads a
  project's MCP servers only in projects the person trusted; Codex records trust itself (see the isolation table), and
  so each certification adds entries for its temporary workspaces to `~/.codex/config.toml`.
- **Merging a harness requires a passing certification**, its output in the PR. Isolation from the person's own setup
  (user-level servers, skills, hooks) is not certified, since it would need another home directory and so another login;
  each harness's isolation is a written fact in the isolation table.

Certification on 2026-10-12 (Claude Code 2.1.296 on `haiku`, Codex 0.160.0, Pi 1.1.0, Droid 0.210.0; Pi and Droid on
Ollama Cloud models) found two faults, both fixed: a Codex worker's first run in a workspace started the project's own
MCP server, and Claude's `receive` with a misnamed argument returned at once.

## Harness facts (spike, 2026-10-11)

Two spikes fed the decisions in this document: the pi-durable lead runner and a script that
stops each harness CLI mid-command and resumes it. Both have been removed from the
tree, since the facts they established are written down here and `npm run certify` supersedes the second.

The resume-after-kill script stopped each CLI while it runs a foreground command, with SIGTERM and with
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
  Codex `-s danger-full-access`, Pi's default tools, Droid `--skip-permissions-unsafe` (`--auto high` still ends
  the turn at a command it rates riskier, and an MCP tool needs at least `--auto medium`).

### Droid (Factory Droid 0.210.0, 2026-10-12)

- `droid exec -o stream-json` takes the prompt on stdin and writes `system`/`init`, `message`, `reasoning` (each
  reasoning event twice, same ID), `tool_call`, `tool_result` (`value`, or `error.message` when `isError`), `error`
  and a final `completion` with `finalText` and `usage` (`input_tokens` excludes cache reads; cache writes were 0 in
  every run seen, so whether it excludes them too is assumed; `factory_credits` are not a price). A failed exec
  writes `error` events (one ending early repeats its assistant message as one) and exits 1 without `completion`.
- The resume-after-kill spike on Droid passed with SIGTERM and SIGKILL. On SIGTERM Droid sees its command killed,
  may start it again, and exits 0 without `completion`. Like Pi, it runs tool commands in their own process group,
  with a watcher that kills that group once Droid is gone; on SIGTERM it stops the command itself.
- No session ID up front: every event carries `session_id`. **Resume forks.** `exec -s <id>` loads the session
  from Factory's servers and exits 1 with nothing on stdout without a Factory login (a person on custom models, such
  as Ollama Cloud, has none); `exec --fork <id>` continues it locally under a new ID, which the turn records. A fork
  can be forked again; each fork copies the session's file.
- No structured-output flag in `exec` (Droid has one only in its JSON-RPC mode), so the result is a fenced JSON
  block, as for Pi; a final message that is the bare object is accepted too.
- The init event names the exec default model even when the person's settings choose another, so no model is read
  from it.
- Runtime settings (`--settings`) take general settings at the top level plus `mcp`, `hooks`, `skills`, `droids`,
  `commands` and `outputStyles`; an MCP server named there replaces the same name's entry from every other source.
  `enabledPlugins` there does not turn a plugin's skills off. MCP tools appear as `<server>___<tool>`, deferred behind
  Droid's `ToolSearch`.

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
  Pi `--mode json` events, Droid stream-json. A tool call and its result must share one step (`source_call_id` matches a
  `tool_call_id` in the same step). Resumed turns continue the same trajectory; an interrupt, or a stall, is a
  `system` step.
- sous-specific data goes only in `extra` fields, because ATIF rejects unknown keys. Tokens map to
  `metrics` (`prompt_tokens` includes cached tokens; Anthropic cache-creation tokens go in `metrics.extra`).
- Tests check every document with a strict checker of the subset sous emits (`test/helpers/atif-checker.ts`),
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

## The UI

`sous ui [--port <n>]` (`src/ui/server.ts`, `src/ui/page.html`) serves one static page and a small JSON API with Node's `http`
server, on `127.0.0.1` only. It prints its address with a random token; every request needs the token, and a Host
header naming this machine, so other sites in the browser (or a rebound DNS name) cannot read runs. It reads, and
never writes: the supervisor stays the only writer, and the person's commands still go through `sous answer`, `approve`
and `cancel`.

- **Same model as status and export.** A run's tree and node statuses come from `fold`, the one behind `sous status`;
  its timing, usage and per-node events from `viewRun`, the one behind `sous export`.
- **Lazy.** The run list and a run's tree come from the log alone (`loadRun` told to parse no turn file); a node's turn
  files are read and parsed with its adapter only when the node is opened, and every string the page gets is cut at
  20,000 characters, marked with how many more there were.
- **Live.** One server-sent event stream per page sends every run's log size and lock whenever one changes (polled
  every 500 ms); the page refetches the run, or the node, that changed. A finished run is a log that stopped growing,
  so live and finished runs share every view. A worker's output does not grow the log, so while a turn runs the page
  fetches the run every 10 seconds, and the tree shows the turn's age and when its output last grew.
- **Timeline.** Worker turns, merge-queue waits and checks per node; a lead is busy from a delivery until it has
  answered every queued one (an interrupt joins the stretch it steers). A lead's row also shows its team's span and
  totals (nodes, turns, tokens, merges, failures), so a folded team still reads at a glance.

## Storage layout

```
<workspace>/.sous/runs/<run-id>/
  run.json             goal, workspace, graph or agents file, created at
  events.jsonl         the event log (append-only; fsync per event)
  lock                 supervisor pid and start time
  commands/            command files from sous answer, approve and cancel, and from workers' send and receive
                       (the commands or sous's MCP tools), until processed
  nodes/<node-id>/
    turn-<k>.jsonl     raw harness stdout for turn k
    turn-<k>.err       raw stderr
    turn-<k>.schema.json    Codex: the result schema passed with --output-schema
    turn-<k>.settings.json  Droid: the runtime settings passed with --settings (MCP servers, hooks, skills)
  leads/<node-id>/     a lead's pi-durable conversation (JSONL storage)
  integration/         git mode: git worktree of branch sous/<run-id>, where merges and check nodes run
  worktrees/<node-id>/ git mode: git worktree of branch sous/<run-id>.<node-id> for a work node (and the splitter)
  output/              folder mode: the results, where collected files land
  work/<node-id>/      folder mode: a work, check or splitter node's own folder, with links workspace and results
  .collect-<uuid>      folder mode: a file being collected, briefly, before it is renamed into output/
  splits/<lead-id>.json the splitter's proposal for a lead
  trace.atif.json      written by sous export atif
```

## Implementation

Node 22.19 or later runs the TypeScript sources directly (type stripping). Only the lead runner has
runtime dependencies: `@earendil-works/pi-durable`, `pi-ai` and `chord`, pinned to exact versions because
the API is experimental. The supervisor, adapters and exporters use Node built-ins only.
Development dependency: `typescript` for type checking, and for the npm package (`@krimvp/sous`): Node does not
strip types from files under `node_modules`, so `npm pack`/`npm publish` first build `dist/` (`scripts/build.mjs`):
`src/` compiled with `tsconfig.build.json` into the same layout, `.ts` imports rewritten to `.js`, and
`src/ui/page.html` copied to `dist/ui/page.html`. The paths a run hands to another process (sous's MCP server, the
`sous send` command) come from `src/self.ts` and take the extension of the running file. Tests use `node:test`;
`test/package.test.ts` runs the compiled package from a `node_modules` directory.

## Roadmap

| Version | Scope | Done when |
|---|---|---|
| **v0** (done) | Fixed graph file; `work` and `check` nodes run in the workspace directory, writing nodes one at a time; Claude, Codex and Pi adapters; event log; `sous run`, `status`; ATIF and OTLP exporters | a two-node graph (work, then check) runs to completion on each harness and exports a valid ATIF file and a Langfuse trace |
| **v1** (done) | `lead` nodes and their tools; inboxes; `queue` and `interrupt`; notes; `answer`, `cancel` | a goal given to a root lead is split into children that complete, with one interrupt exercised |
| **v2** (done) | `sous resume` and crash recovery; `gate` nodes | killing the supervisor mid-run and resuming completes the run without repeating finished turns |
| **v3** (done) | Agents as the unit of work (definitions, availability defaults, standing agents); worktrees, merge queue and the integrator | parallel writing children of a lead are merged into `sous/<run>`, one real conflict resolved by the integrator |
| **v4** (done) | Agents leads define on runtimes the run lists `models` for; model limits; `--agents` for goal runs; `--max-depth` | a lead defines an agent in a real run, and its worker runs with that agent's model and instructions |
| **v5** (done) | The splitter: an agent that proposes each lead's split; `--approve-splits`; roles per subtree | in a real run a splitter on a CLI harness reads the code, proposes a split, and the lead spawns it |
| **v6** (done) | Worker messages: `send` to a sibling or the lead and `receive` within a turn, through sous's MCP server or `sous send`/`receive`; workers load no other MCP server and little of the person's own setup | in a real run two workers on different harnesses settle an interface with `send`, and the lead sees every message |
| **v7** (in progress) | `sous ui`: a local viewer for live and finished runs (#59); then steering (#60), replay and comparison (#61) | a person follows a real run live and reads a lead's decisions and a worker's trajectory from the page |
| **v8** (done) | Folder mode (no git needed); leads read files before splitting; task-neutral briefs; outcomes name files | a folder-mode run in a directory without git collects its children's files into the output folder |
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

v5 was verified on 2026-10-11 with two real runs (leads on `ollama-cloud/deepseek-v4.1-flash`, workers on Pi). In the
first, a splitter on Claude (`haiku`) with the strategy "one work part per file, then one check" read a two-module
repository and proposed two work parts and a check whose briefs followed the files' style (ESM, no semicolons); with
`--approve-splits` the run waited until `sous approve lead`, the lead spawned the proposal as it was, both parts
merged and the check passed. Harbor's validator accepted the exported ATIF file apart from its schema version (the
installed Harbor knows ATIF up to v1.7). In the second, a splitter on Codex proposed two lead parts for the top-level
lead; that lead spawned them, added a note and a check of its own, and each sub-lead then received its own split from
the same splitter session (turns 2 and 3 resumed it) and completed. In the first run the splitter also ran `mkdir -p`
one directory too high, leaving an empty `.sous/runs/splits/`, which `sous status` and `sous approve` then took for the
latest run; only directories with an event log count as runs since, and the request says the proposal's directory
exists. A splitter turn cut short by a supervisor stop, an invalid proposal and the fallbacks are covered by
fake-harness tests only. Roles were verified in a third real run: a graph lead with `roles: {"splitter": "planner"}`
(Codex) got two sub-lead parts from it, the splitter itself giving the web part `roles: {"splitter": "web-planner"}`
(Claude, `haiku`); the lead spawned them so, the web sub-lead's split came from `web-planner` while the api sub-lead
inherited `planner`, the two splitters ran at the same time, and the run completed with both helpers merged.

v6 was verified on 2026-10-11 with a real run (lead on `ollama-cloud/deepseek-v4.1-flash`): `fmt` on Claude (`haiku`)
told its sibling `app` on Codex the function it chose, then a correction (CommonJS to ESM), with the MCP `send` tool;
Claude's init listed `sous` as its only MCP server. `app` reported to its lead twice with `sous send`; the lead got
both and copies of `fmt`'s messages, the run completed and `node app.js` printed the expected name. Single turns
showed Codex calling the MCP `send` tool and Pi (with `--no-mcp`) running the brief's `sous send` command. Two
findings: `app` first read one of the person's global skills, since harnesses still load the person's own
instructions and skills; and it read `events.jsonl` to learn its messages before its turn ended, since a worker
receives messages only between turns.

v8 (folder mode) was verified on 2026-10-11 with a real run in a directory outside any git repository (lead on
`ollama-cloud/deepseek-v4.1-flash`, workers on Pi): the lead listed and read the two input files before it spawned two
parallel summary children, a third child that needed them, and a check; each child's file was collected into the output
folder and named in its outcome, the check passed there, the lead read the results before completing, and the exported
ATIF file passed the test checker. A run with no `git` on `PATH`, a renamed clash, and collecting again on resume are
covered by fake-harness tests only.

The Droid adapter was verified on 2026-10-12 with Factory Droid 0.210.0 on an Ollama Cloud custom model (`glm-5.3`):
the live test started a session and resumed it twice by forking, remembering the codeword. A graph run had two Droid
siblings, `a` telling `b` a file name with the MCP `send` tool while `b` waited for it with `receive`; both merged and
the check passed. The workspace's own MCP server and `SessionStart` hook stayed out (Droid offered only `sous___send`
and `sous___receive`, and the hook's file was not written), and the exported ATIF passed `test/helpers/atif-checker.ts`
(Harbor was not installed). In a third run `sous run` was killed with SIGKILL while its Droid worker ran `sleep 45`;
`sous resume` stopped the orphaned turn (Droid ended the `sleep`), resumed it as a fork with the recovery note, and
the work merged and the check passed.

## Open questions

- Whether workers run with full permissions in their worktree (current assumption) or a narrower set.
- Whether a run may make the splitter's proposal binding (spawned for the lead) rather than advisory.
- Codex merges configuration layers, so a project server named like one of the person's with another transport, or a
  project server named `sous`, may combine with the override into an invalid or disabled server (not checked).
- Droid workers still load the person's custom droids and whatever MCP servers or droids their plugins bring;
  sous does not read plugin manifests. Whether Droid reads a global `~/.factory/AGENTS.md` was not checked.
- Codex workers still read the person's global `~/.codex/AGENTS.md`, and Claude workers the `CLAUDE.md` files above
  the worktree; leaving them out needs a Codex option or a separate `CODEX_HOME` that shares the login safely, and
  worktrees outside the workspace.
- Agents already running outside a run (#40). Today such an agent can act as the person (`sous answer`, `approve`,
  `cancel`, and reading `events.jsonl`), but cannot receive deliveries without polling or do a node or a role. The
  smallest step is a bridge process that mirrors chosen events to a message service and turns its messages into
  command files, keeping the supervisor the only writer. Next would be a runtime whose turns are requests over that
  service with a deadline; an advisory role such as the splitter, which has a fallback, is the safe first user.
