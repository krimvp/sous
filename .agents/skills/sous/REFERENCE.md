# sous reference

## Commands

```
sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--approve-splits] [--workspace <dir>]
sous resume [run-id] [--workspace <dir>]
sous status [run-id] [--workspace <dir>]
sous answer <node> "text" [--workspace <dir>]
sous approve <node> [--workspace <dir>]
sous cancel <node> [--workspace <dir>]
sous export atif|otlp [run-id] [--workspace <dir>]
sous ui [--port <n>] [--workspace <dir>]   (serves a local page of the runs, live or finished, until stopped)
sous send <to> 'text'     (inside a worker: to a sibling or its lead; workers learn this from their brief)
sous receive [seconds]    (inside a worker: its waiting messages, waiting up to 60 seconds for one)
```

`run-id` defaults to the latest run. `--workspace` defaults to the current directory. An argument to `run` that
names an existing file is a graph file; anything else is a goal, except a single word that ends in `.json` or holds a
path separator, which is refused as a mistyped file name. `--agents` is for goal runs only.
`--approve-splits` needs a `splitter` agent: each proposed split waits for `sous approve <lead>` or
`sous answer <lead> "<changes>"`.

## Definitions (graph file or `--agents` file)

| Key | Meaning |
|---|---|
| `agent` | default agent for work nodes that name none (else the first available of `claude`, `codex`, `pi`, `droid`) |
| `agents` | named agents: `{ "runs": "claude" \| "codex" \| "pi" \| "droid" \| "lead", "model"?, "instructions"? }`; a name may shadow a built-in; `integrator` picks who resolves merge conflicts (default first available of `codex`, `claude`, `pi`, `droid`); `splitter` (not on `lead`) proposes every lead's split before its brief, its `instructions` being the strategy |
| `models` | per runtime, the models **leads** may choose: `{ "claude": ["sonnet"], "pi": ["ollama-cloud/glm-5.3"], … }`. No list for a runtime: leads choose no model for it and cannot define agents on it |

Agents the person defines are not limited by `models`. An agent with no `model` uses its harness's default
(Claude's, Codex's, Pi's or Droid's own settings; for `lead`, `ollama-cloud/deepseek-v4.1-flash`).

Model names are per runtime: Claude aliases or IDs (`sonnet`, `haiku`), Codex/ChatGPT models (`gpt-5.5`),
Droid model IDs (`claude-sonnet-5`, or a custom model `custom:…`),
and `provider/model` for `pi` and `lead` (`ollama-cloud/deepseek-v4.1-flash`, `openai-codex/gpt-5.5`).

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

`turn.started`/`turn.ended` (worker turns), `lead.delivered`/`lead.call`/`lead.read`/`lead.turn` (leads), `check.ended`,
`merge.queued`/`merge.done` (with `files`; in folder mode a collection)/`merge.conflict`/`merge.failed`/`merge.withdrawn`, `message` (incl. to/from
`person`, and `sent: true` for a worker's `send`), `inbox.read` (a worker's `receive`), `node.completed`/`node.failed`/`node.cancelled`, `split.requested`/`split.proposed`/`split.failed`, `run.resumed`,
`run.completed`/`run.failed`.
