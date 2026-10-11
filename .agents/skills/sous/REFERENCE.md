# sous reference

## Commands

```
sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--workspace <dir>]
sous resume [run-id] [--workspace <dir>]
sous status [run-id] [--workspace <dir>]
sous answer <node> "text" [--workspace <dir>]
sous approve <node> [--workspace <dir>]
sous cancel <node> [--workspace <dir>]
sous export atif|otlp [run-id] [--workspace <dir>]
```

`run-id` defaults to the latest run. `--workspace` defaults to the current directory. An argument to `run` that
names an existing file is a graph file; anything else is a goal. `--agents` is for goal runs only.

## Definitions (graph file or `--agents` file)

| Key | Meaning |
|---|---|
| `agent` | default agent for work nodes that name none (else the first available of `claude`, `codex`, `pi`) |
| `agents` | named agents: `{ "runs": "claude" \| "codex" \| "pi" \| "lead", "model"?, "instructions"? }`; a name may shadow a built-in; `integrator` picks who resolves merge conflicts (default first available of `codex`, `claude`, `pi`) |
| `models` | per runtime, the models **leads** may choose: `{ "claude": ["sonnet"], "pi": ["ollama-cloud/glm-5.3"], … }`. No list for a runtime: leads choose no model for it and cannot define agents on it |

Agents the person defines are not limited by `models`. An agent with no `model` uses its harness's default
(Claude's, Codex's or Pi's own settings; for `lead`, `ollama-cloud/deepseek-v4.1-flash`).

Model names are per runtime: Claude aliases or IDs (`sonnet`, `haiku`), Codex/ChatGPT models (`gpt-5.5`),
and `provider/model` for `pi` and `lead` (`ollama-cloud/deepseek-v4.1-flash`, `openai-codex/gpt-5.5`).

## Nodes (graph files)

| Field | Kinds | Meaning |
|---|---|---|
| `id` | all | unique; starts with a letter, digit, `_` or `-`, then letters, digits, `.`, `_`, `-`; `root`, `person` and `integrator` are reserved |
| `kind` | all | `work` (agent in its own worktree), `check` (shell command, exit 0 passes, runs on the merged result), `lead` (splits work), `gate` (waits for `sous approve`) |
| `brief` | work, lead, gate | the task, or what the person approves |
| `acceptance` | work, lead | criteria shown to the agent |
| `command` | check, work | a check's command, or a work node's acceptance check |
| `needs` | all | node IDs that must complete first (work nodes: once merged); any nodes in the file, without cycles. A lead's children may only need earlier siblings |
| `agent`, `model` | work, lead | which agent; a model for this node only |

Leads have no `command`; a deterministic gate under a lead is a `check` child.

## What leads can do

Tools: `spawn`, `send` (queue or interrupt), `note` (shared with the subtree), `cancel`, `complete`, `fail`,
`escalate` (to the parent lead, or to the person). In `spawn`, a child's `agent` is a name, or a new agent
`{ "name", "runs", "model"?, "instructions"? }` on a runtime listed in `models` (model from that list, default
its first). New agents exist for the rest of the run.

## Files

```
.sous/runs/<run-id>/
  events.jsonl          the run's only state (one JSON event per line)
  nodes/<node>/turn-<k>.jsonl, .err    raw output of each worker turn
  leads/<node>/         each lead's durable conversation
  integration/          worktree of branch sous/<run-id> (the result)
  worktrees/<node>/     each worker's worktree, branch sous/<run-id>.<node>
  commands/             answer/approve/cancel requests waiting for the supervisor
  trace.atif.json       after `sous export atif`
```

## Events worth grepping

`turn.started`/`turn.ended` (worker turns), `lead.delivered`/`lead.call`/`lead.turn` (leads), `check.ended`,
`merge.queued`/`merge.done`/`merge.conflict`/`merge.failed`/`merge.withdrawn`, `message` (incl. to/from
`person`), `node.completed`/`node.failed`/`node.cancelled`, `run.resumed`, `run.completed`/`run.failed`.
