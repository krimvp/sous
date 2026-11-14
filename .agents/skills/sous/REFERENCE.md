# sous reference

## Commands

```
sous run <graph.json | "goal"> [--agents <file>] [--max-depth <n>] [--max-cost <usd>] [--approve-splits] [--workspace <dir>]
sous resume [run-id] [--max-cost <usd>] [--workspace <dir>]   (--max-cost: stop once the cost reported reaches it; resume raises it)
sous status [run-id] [--json] [--workspace <dir>]   (the run as a tree with a `usage:` line of tokens and reported cost, or as one JSON document: see below)
sous wait [run-id] [--timeout <seconds>] [--json] [--workspace <dir>]   (blocks until the run needs you or is over)
sous runs [--workspace <dir>]   (every run, newest first: id, running/stopped/completed/failed, start, first line of the goal)
sous answer <node> "text" [run-id] [--workspace <dir>]
sous approve <node> [run-id] [--workspace <dir>]
sous cancel <node> [run-id] [--workspace <dir>]
sous export atif|otlp [run-id] [--workspace <dir>]
sous diff [run-id] [--stat] [--workspace <dir>]   (git diff from where sous/<run-id> started to its head; folder mode: the output files)
sous clean [run-id] [--all] [--branches] [--unmerged] [--dry-run] [--workspace <dir>]   (remove a finished run's worktrees and merged node branches)
sous --help | --version   (also `sous <command> --help`; the usage goes to stdout, exit 0)
sous ui [--port <n>] [--workspace <dir>]   (serves a local page of the runs, live or finished, until stopped)
sous doctor [--workspace <dir>]  (each harness on PATH with its version, not its login; lead credentials and model; git state; exit 0 when a run could start)
sous send <to> 'text'     (inside a worker: to a sibling or its lead; workers learn this from their brief)
sous receive [seconds]    (inside a worker: its waiting messages, waiting up to 60 seconds for one)
```

`run-id` defaults to the latest run (for `wait` too: name the run you started); for `answer`, `approve` and `cancel`, to the one run that is running (with several
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
`sous clean` refuses (exit 1) a run whose supervisor is alive or that is stopped (resumable); `--all` cleans every
finished run and skips those. It removes only the worktrees and branches the run's log records creating, keeps the
result branch (`--branches` deletes it only once `HEAD` contains it, else refuses with exit 1), and keeps unmerged work,
listed: a worktree with uncommitted changes and a node branch with commits the result lacks (`--unmerged` removes
them). Folder mode removes `work/`, keeping `output/` (a never-collected work folder with files is kept unless
`--unmerged`). The log stays, so `status`, `ui` and `export` work on a cleaned run.

## `status --json` and `wait`

`sous status --json` prints one JSON document (type `RunStatus` in `src/types.ts`); `sous status` prints the same as
text. `sous wait --json` prints it with `"wait"`, why it returned.

```jsonc
{
  "id": "20261114T092641Z-ef7f",
  "state": "running",            // running | stopped (not over, supervisor gone: resume) | completed | failed
  "goal": "…", "mode": "git",    // git | folder
  "summary": "…",                // run.completed's summary, once completed
  "reason": "…",                 // run.failed's reason, once failed
  "result": { "branch": "sous/20261114T092641Z-ef7f" },   // or { "folder": "<dir>" }; absent until there is one; "deleted": true once the branch is gone
  "usage": { "input": 115414, "output": 2141, "cached": 75142, "costUsd": 0.73, "unpriced": 1, "maxCostUsd": 2 },   // tokens so far; costUsd only what was reported, unpriced: turns that reported none (not counted against the budget), maxCostUsd: --max-cost
  "budget": { "spentUsd": 0.55, "maxCostUsd": 0.5 },   // only when the run stopped at its budget: state is "stopped", resume names --max-cost
  "nodes": [                     // depth first; a node is followed by its subtree
    { "id": "lead", "kind": "lead", "status": "running", "turns": 0 },
    { "id": "w", "kind": "work", "parent": "lead", "status": "running", "agent": "claude", "turns": 1,
      "summary": "…",            // failure reason, completion summary, last turn's result summary, or a check's last output line
      "failedChecks": ["c"],     // a lead that completed over failed checks
      "turn": { "number": 1, "startedAt": "…", "ageSeconds": 75, "lastOutputAt": "…", "lastOutputAgeSeconds": 3 } }
  ],                             // status: pending ready running waiting merging idle completed failed; "standing": true for the integrator and splitters
  "waiting": [                   // what waits for you
    { "kind": "gate", "node": "ship", "text": "Ship it?", "seq": 8,
      "commands": { "approve": "sous approve ship", "reject": "sous cancel ship" } },
    { "kind": "question", "node": "lead", "text": "Which database?", "seq": 12,
      "commands": { "answer": "sous answer lead \"<answer>\"" }, "sent": true }
  ],                             // split: { "approve", "answer" (changes) }; "sent": an answer is sent, not yet applied
  "refused": [{ "at": "…", "reason": "sous cancel nope: no node nope" }],   // the latest three, latest last
  "resume": "sous resume 20261114T092641Z-ef7f",   // when stopped; "sous resume <id> --max-cost <usd>" at its budget
  "next": "next: sous diff, then git merge sous/…, then sous clean",   // a finished git-mode run: what is left to do
  "at": "…",                     // when it was read
  "wait": "waiting"              // wait --json only
}
```

Commands name the run (`… <run-id>`) when the workspace has more than one run. `sous wait` polls every 500 ms and only
reads the run's files. It returns, with exit code:

| exit | `wait` | when |
|---|---|---|
| 0 | `completed` | the run completed, no top-level lead over failed checks |
| 3 | `failed` | the run failed, or completed with failed checks |
| 4 | `waiting` | something waits for you that no sent command answers yet (also when it already waited before `wait` started) |
| 5 | `stopped` | the run is not over and its supervisor is gone: `sous resume <id>` |
| 6 | `timeout` | none of these within `--timeout` (default: no limit) |
| 1, 2 | | sous refused the command (as for every command) |

## Definitions (graph file or `--agents` file)

| Key | Meaning |
|---|---|
| `agent` | default agent for work nodes that name none (else the first available of `claude`, `codex`, `pi`, `droid`) |
| `agents` | named agents: `{ "runs": "claude" \| "codex" \| "pi" \| "droid" \| "lead", "model"?, "instructions"? }`; a name may shadow a built-in and follows the id rule (letters, digits, `_` and `-`, and `.` after the first character); `integrator` picks who resolves merge conflicts (default first available of `codex`, `claude`, `pi`, `droid`); `splitter` (not on `lead`) proposes every lead's split before its brief, its `instructions` being the strategy |
| `models` | per runtime, the models **leads** may choose: `{ "claude": ["sonnet"], "pi": ["ollama-cloud/glm-5.3"], … }`. No list for a runtime: leads choose no model for it and cannot define agents on it |

Agents the person defines are not limited by `models`. A work node whose agent and node name no `model` runs on a
small model where sous knows one (Claude Code: `haiku`), else on its harness's default (Codex's, Pi's or Droid's own
settings); `"model": "default"` keeps the harness's own default for Claude too. The integrator and splitters get no
small default (their agent's model, else the harness's). For `lead`, the first lead provider with a credential, in the order
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
  integration/          git mode: worktree of branch sous/<run-id> (the result); `sous clean` removes it, keeping the branch
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
`person`, and `sent: true` for a worker's `send`), `inbox.read` (a worker's `receive`), `node.completed`/`node.failed`/`node.cancelled`, `command.refused` (a person command not applied), `split.requested`/`split.proposed`/`split.failed`, `run.resumed` (`maxCost`: a new budget), `budget.reached` (`spentUsd`, `maxCostUsd`: the run stopped at its budget),
`run.completed`/`run.failed`.
