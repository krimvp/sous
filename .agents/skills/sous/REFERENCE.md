# sous reference

## Commands

```
sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--approve-splits] [--workspace <dir>]
sous resume [run-id] [--workspace <dir>]
sous status [run-id] [--workspace <dir>]   (the tree, pending questions, and `usage: <in> tokens in (<cached> cached), <out> out; $<x> cost reported`)
sous runs [--workspace <dir>]   (every run, newest first: id, running/stopped/completed/failed, start, first line of the goal)
sous answer <node> "text" [run-id] [--workspace <dir>]
sous approve <node> [run-id] [--workspace <dir>]
sous cancel <node> [run-id] [--workspace <dir>]
sous export atif|otlp [run-id] [--workspace <dir>]
sous --help | --version   (also `sous <command> --help`; the usage goes to stdout, exit 0)
sous ui [--port <n>] [--workspace <dir>]   (serves a local page of the runs, live or finished, until stopped)
sous doctor [--workspace <dir>]  (each harness on PATH with its version, not its login; lead credentials and model; git state; exit 0 when a run could start)
sous send <to> 'text'     (inside a worker: to a sibling or its lead; workers learn this from their brief)
sous receive [seconds]    (inside a worker: its waiting messages, waiting up to 60 seconds for one)
```

`run-id` defaults to the latest run; for `answer`, `approve` and `cancel`, to the one run that is running (with several
running, name one). A command the run cannot apply is refused: up front, or as `command.refused` when it no longer
applies by the time the run reads it (shown by the run and `sous status`). The integrator and splitters are not
cancelled: cancel the node they work for. `--workspace` defaults to the current directory, or when that is inside a git
repository to the repository's top level (`sous run` and `sous doctor` say so); a `--workspace` you give is used exactly as given. A
command line sous cannot parse (unknown command or option, wrong number of arguments, a bad `--port` or `--max-depth`)
prints `sous: <what is wrong>` and the usage on stderr and exits 2; a refusal after that (a mistyped graph file, an empty
goal, `--agents` with a graph file, a missing run) is one `sous: ...` line and exits 1. An argument to `run` that
names an existing file is a graph file; anything else is a goal, except a single word that ends in `.json` or holds a
path separator, which is refused as a mistyped file name. `--agents` is for goal runs only.
`--approve-splits` needs a `splitter` agent: each proposed split waits for `sous approve <lead>` or
`sous answer <lead> "<changes>"`.

## Definitions (graph file or `--agents` file)

| Key | Meaning |
|---|---|
| `agent` | default agent for work nodes that name none (else the first available of `claude`, `codex`, `pi`, `droid`) |
| `agents` | named agents: `{ "runs": "claude" \| "codex" \| "pi" \| "droid" \| "lead", "model"?, "instructions"? }`; a name may shadow a built-in and follows the id rule (letters, digits, `_` and `-`, and `.` after the first character); `integrator` picks who resolves merge conflicts (default first available of `codex`, `claude`, `pi`, `droid`); `splitter` (not on `lead`) proposes every lead's split before its brief, its `instructions` being the strategy |
| `models` | per runtime, the models **leads** may choose: `{ "claude": ["sonnet"], "pi": ["ollama-cloud/glm-5.3"], … }`. No list for a runtime: leads choose no model for it and cannot define agents on it |

Agents the person defines are not limited by `models`. An agent with no `model` uses its harness's default
(Claude's, Codex's, Pi's or Droid's own settings; for `lead`, the first lead provider with a credential, in the order
`ollama-cloud/deepseek-v4.1-flash`, `anthropic/claude-haiku-5-5`, `openai/gpt-6-luna`, `openai-codex/gpt-5.5`).

Model names are per runtime: Claude aliases or IDs (`sonnet`, `haiku`), Codex/ChatGPT models (`gpt-5.5`),
Droid model IDs (`claude-sonnet-5`, or a custom model `custom:…`),
and `provider/model` for `pi` and `lead` (`ollama-cloud/deepseek-v4.1-flash`, `anthropic/claude-haiku-5-5`, `openai/gpt-6-luna`,
`openai-codex/gpt-5.5`; a lead's provider needs its API key in the environment, `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`, or a Pi login).

## Nodes (graph files)

| Field | Kinds | Meaning |
|---|---|---|
| `id` | all | unique; starts with a letter, digit, `_` or `-`, then letters, digits, `.`, `_`, `-`; `root`, `person`, `integrator`, `splitter` and `splitter.*` are reserved |
| `kind` | all | `work` (agent in its own worktree or folder), `check` (shell command, exit 0 passes, runs on the merged result, or in folder mode in its own folder with `results/` linked), `lead` (splits work), `gate` (waits for `sous approve`) |
| `brief` | work, lead, gate | the task, or what the person approves |
| `acceptance` | work, lead | criteria shown to the agent |
| `command` | check, work | a check's command, or a work node's acceptance check |
| `needs` | all | node IDs that must complete first (work nodes: once merged or collected); any nodes in the file, without cycles. A lead's children may only need earlier siblings |
| `agent`, `model` | work, lead | which agent; a model for this node only |
| `roles` | lead | `{ "splitter": "<agent>" }`: the splitter for this lead and its subtree (inherited; overrides the agent named `splitter`); a CLI agent |

Leads have no `command`; a deterministic gate under a lead is a `check` child.

## What leads can do

Tools: `spawn`, `send` (queue or interrupt), `note` (shared with the subtree), `cancel`, `complete`, `fail`,
`escalate` (to the parent lead, or to the person), and read-only `list_files` and `read_file` (the workspace plus the
results so far; in folder mode under `workspace/` and `results/`). In `spawn`, a child's `agent` is a name, or a new agent
`{ "name", "runs", "model"?, "instructions"? }` on a runtime listed in `models` (model from that list, default
its first). New agents exist for the rest of the run. A lead child may set `roles` naming agents the person defined.

## Files

```
.sous/runs/<run-id>/
  events.jsonl          the run's only state (one JSON event per line)
  nodes/<node>/turn-<k>.jsonl, .err    raw output of each worker turn
  leads/<node>/         each lead's durable conversation
  integration/          git mode: worktree of branch sous/<run-id> (the result)
  worktrees/<node>/     git mode: each worker's worktree, branch sous/<run-id>.<node> (and the splitter's, reset per request)
  output/               folder mode: the result, the workers' files collected
  work/<node>/          folder mode: each worker's, check's or splitter's own folder, with links workspace/ and results/
  splits/<lead>.json    the splitter's proposal for each lead
  commands/             answer/approve/cancel requests waiting for the supervisor
  trace.atif.json       after `sous export atif`
```

## Events worth grepping

`turn.started`/`turn.ended` (worker turns; an `error` names the turn's `.err` file and ends with its stderr), `turn.stalled` (no output for 10 minutes; the turn goes on), `lead.delivered`/`lead.call`/`lead.read`/`lead.turn` (leads), `check.ended`,
`merge.queued`/`merge.done` (with `files`; in folder mode a collection)/`merge.conflict`/`merge.failed`/`merge.withdrawn`, `message` (incl. to/from
`person`, and `sent: true` for a worker's `send`), `inbox.read` (a worker's `receive`), `node.completed`/`node.failed`/`node.cancelled`, `command.refused` (a person command not applied), `split.requested`/`split.proposed`/`split.failed`, `run.resumed`,
`run.completed`/`run.failed`.
