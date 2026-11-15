# Using sous

The reference for running sous: every command, where a run works and where its result lands, how to watch and steer
it, budgets, agents and models, where leads run, graph files and the splitter. Start with the
[README](../README.md); the concepts and the reasons behind them are in the [design](design.md), the worker CLIs in
[harnesses](harnesses.md).

- [Install](#install)
- [Commands](#commands)
- [Git mode](#git-mode)
- [Folder mode](#folder-mode)
- [After a run: diff, merge, clean](#after-a-run-diff-merge-clean)
- [Watching and steering](#watching-and-steering)
- [Cost budget](#cost-budget)
- [Agents and models](#agents-and-models)
- [Where leads run](#where-leads-run)
- [Graph files](#graph-files)
- [The splitter](#the-splitter)
- [What workers see](#what-workers-see)

## Install

```bash
npm install -g @krimvp/sous
```

Node 22.19 or later, on Linux and macOS (the tests run on both). The npm package is the TypeScript sources compiled to
JavaScript; a checkout runs the sources directly, so from a checkout `node src/cli.ts` works the same as `sous` (after
`npm install`, for the lead runner's Pi packages). State is plain files in `.sous/runs/<id>/` of the workspace.

## Commands

| Command | What it does |
|---|---|
| `sous run "goal"` | A lead splits the goal into workers, checks and sub-leads, and the run goes to completion |
| `sous run graph.json` | Runs a fixed [graph file](#graph-files) |
| `  --max-cost <usd>` | Stops the run once its turns reported that much cost ([Cost budget](#cost-budget)) |
| `  --agents <file>` | Agents, the default agent and `models` for a goal run ([Agents and models](#agents-and-models)) |
| `  --max-depth <n>` | How deep leads may nest, 1 to 8 (default 3) |
| `  --approve-splits` | Each split the [splitter](#the-splitter) proposes waits for your approval; it needs a possible splitter: an agent named `splitter`, a lead with `roles.splitter` in a graph file, or any agent you define that does not run `lead` (a lead may give it the splitter role) |
| `sous doctor` | Could a run start here: harnesses on `PATH` with their versions (not whether they are logged in), lead credentials, where leads would run, worker models, git state; exits 0 when a run could start, else says what is missing |
| `sous status [--json]` | The latest run (or the one named) as a tree, what waits for you, tokens and reported cost, the result and the next steps |
| `sous wait [--timeout <s>] [--json]` | Blocks until the run needs you or is over; the exit code says which ([below](#watching-and-steering)) |
| `sous runs` | Every run of the workspace, newest first: id, state, start, goal |
| `sous answer <node> "text"` | Answers a question the run printed, corrects a lead, or changes a proposed split |
| `sous approve <node>` | Approves a gate, or a proposed split |
| `sous cancel <node>` | Stops a node and its subtree, or rejects a gate |
| `sous resume [--max-cost <usd>]` | Continues a stopped or crashed run without repeating finished turns |
| `sous diff [--stat]` | What the run changed ([After a run](#after-a-run-diff-merge-clean)) |
| `sous clean [--all] [--branches] [--unmerged] [--dry-run]` | Removes a finished run's worktrees and merged node branches |
| `sous ui [--port <n>]` | A local page with every run of the workspace, live or finished |
| `sous export atif` | Writes `.sous/runs/<id>/trace.atif.json` (an ATIF trajectory) |
| `sous export otlp` | Sends the run to Langfuse over OTLP; needs `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| `sous send <to> 'text'`, `sous receive [seconds]` | For workers of a running run ([What workers see](#what-workers-see)) |
| `sous --help`, `sous <command> --help`, `sous --version` | The usage, one command's usage, the installed version |

Every command but `send` and `receive` takes `--workspace <dir>`, and those that act on a run take an optional run id
after their other arguments (default: the latest run; `answer`, `approve` and `cancel` go to the running run, and with
several running you add its id). They work from another terminal while the run runs.

## Git mode

In a git repository (it needs at least one commit; without one the run fails), sous works at the repository root, also when started in a
subdirectory, and says so.

- **Workers see your last commit (`HEAD`) only.** Commit the files they need first; sous warns at the start when your
  checkout has uncommitted changes.
- **Each work node runs in its own git worktree**, in parallel with the others (at most 4 workers and checks at a time
  in a run, in either mode; the rest wait). When a node is done, its branch is merged into the run's branch `sous/<run-id>`, one merge
  at a time.
- **A conflict, or a check that fails after a merge, goes to the integrator**: an agent of the run (Codex, else Claude
  Code, else Pi, else Droid; or an agent you define named `integrator`) that resolves it in the integration worktree.
- **Your own checkout is not touched.** `sous status` names the result branch; merging it is up to you.
- A lead may complete over a failed check, and then `sous run` and `sous status` say
  `completed with failed checks: …`.

The details: [design: Merging](design.md#merging).

## Folder mode

Outside a git repository, sous uses folder mode on its own: good for research and summaries of many documents.

- Each worker and check runs in a folder of its own (at most 4 at a time, as in git mode), `.sous/runs/<run-id>/work/<node>/`, where `workspace/` (your
  files) and `results/` (the results so far) are links, the same names the lead reads by. So a check of a result reads,
  for example, `test -s results/report.md`.
- Workers write their files at the top of their folder. These are collected into `.sous/runs/<run-id>/output/` one at
  a time. A file of the same name and different content is kept beside the first as `<name>.<node>.<ext>` (or
  `<name>.<node>-2.<ext>`, …); nothing in the results is replaced.
- Your files are only read. `sous status` names the output folder.

The details: [design: Folder mode](design.md#folder-mode).

## After a run: diff, merge, clean

At the end, `sous run` and `sous status` print the result (`result: branch sous/<run-id>`, or `result: folder …`), the
tokens and cost reported, and for a git-mode run a `next:` line with the steps that still apply:

```bash
sous diff [--stat]         # git diff from where sous/<run-id> started to its head (so far, while it runs)
git merge sous/<run-id>    # take it into your branch
sous clean                 # remove the finished run's worktrees and merged node branches; keep sous/<run-id> and the log
sous clean --branches      # also delete sous/<run-id>, once your HEAD contains it
```

`sous clean` refuses a run that is running or stopped (resume needs its worktrees); `--all` cleans every finished run
and `--dry-run` shows what would go. It removes only what the run's log records creating. Work no result holds is kept
and listed: a failed node's branch with commits not in `sous/<run-id>`, a worktree with uncommitted changes
(`--unmerged` removes those too). In folder mode, `sous diff` lists the output files with their sizes and `sous clean`
removes the per-node folders (`work/`), keeping `output/`. `status`, `ui` and `export` still work on a cleaned run.
The details: [design: After a run](design.md#after-a-run-diff-and-clean).

## Watching and steering

- **`sous status`** shows the run as a tree; a running turn shows its age and how long ago its output last grew. A turn
  without output for 10 minutes is reported once as `turn.stalled`; a long command a worker waits on is silent too, so
  look before you cancel it. There is no turn timeout yet. `sous status --json` is the same as one JSON document, with
  what waits for you and the commands that answer it.
- **`sous wait`** blocks until the run needs you or is over, and exits with:

  | Exit | Meaning |
  |---|---|
  | 0 | completed |
  | 3 | failed, or completed with failed checks |
  | 4 | waits for you: a question, a gate or a proposed split |
  | 5 | stopped: resume it (or it reached its budget) |
  | 6 | `--timeout` passed |
  | 1, 2 | sous refused the command (no such run, a bad option), and says why |

  `--json` prints `status --json` with the reason. An ask you answered does not stop the next `wait` while the run
  applies the answer.
- **`sous answer`, `approve`, `cancel`** steer the run from any terminal, whether or not it waits; a lead reacts to an
  answer within seconds.
- **`sous resume`** takes over a stopped run (Ctrl-C, a crash): a turn that finished meanwhile is recorded, a turn still
  running is stopped, and an interrupted worker continues its session with a note to re-check the workspace. Finished
  turns, spawns and merges are not repeated. A node whose turn is cut short by a supervisor stop more than 3 times
  fails. A run keeps its lead and worker models when resumed.
- **`sous ui`** prints a `127.0.0.1` address with a random token and serves one page: the workspace's runs, each run's
  tree folded by team beside a timeline of every lead's and worker's busy time, merges and checks, and for any node its
  brief, a lead's decisions in order, or a worker's turns with their messages, tool calls and results. It follows a
  running run as its log grows, and lists what waits for you with the command that answers it. It only reads the run's
  files.
- A worker turn that fails at once keeps its stderr in `.sous/runs/<id>/nodes/<node>/turn-<k>.err`; the known causes
  are in [harnesses: When a worker fails at once](harnesses.md#when-a-worker-fails-at-once).

## Cost budget

`sous run --max-cost <usd>` stops the run once the cost its turns reported reaches the budget: no new turn starts, the
running turns are stopped as Ctrl-C stops them, and `sous run` ends with the run stopped (not failed):
`stopped at its cost budget: $0.55 reported of $0.50 …; continue with a higher budget: sous resume <run-id> --max-cost
<usd>`. `sous resume` without a higher `--max-cost` refuses such a run; `sous status` and `sous wait` (exit 5) say the
same.

The budget bounds only the cost reported. A cost is known when a turn ends, so the turns running at the time can
overshoot it, and turns that report no cost (Codex and Droid workers, and leads and Pi workers on Ollama) are not
counted. The budget has been tested with fake harnesses, not yet in a live run ([design: Roadmap](design.md#roadmap)).

## Agents and models

An agent is a name for how work gets done: it `runs` on `claude`, `codex`, `pi`, `droid` or `lead`, with an optional
`model` and standing `instructions` added to every brief it gets. The built-in agents `claude`, `codex`, `pi`, `droid`
and `lead` need no definition; a node's `model` overrides its agent's. A goal run takes `agent` (the default), `agents`
and `models` from a file, `sous run --agents agents.json "…"`; a graph file carries the same keys.

- **Which harness.** A work node that names no agent uses the run's `agent`, when the graph or agents file sets one;
  else the first agent whose CLI is on your `PATH`: Claude Code, else Codex, else Pi, else Droid. A goal can ask for another, e.g. "use agent pi for every work child".
- **Worker models.** A work node whose agent, node and lead name no model runs on a small model of its harness where
  sous knows one: Claude Code workers run on `haiku` (two Claude Code workers on a small task cost $1.39 on Claude's
  default model and $0.02 on `haiku`). Codex, Pi and Droid have no such default: their default model depends on your
  login or settings, so they run on it. An agent's or a node's `model`, and a lead's choice from the run's `models`,
  win. To run a worker on its harness's own default instead, give its agent `"model": "default"`; for the built-in
  Claude agent: `{ "agents": { "claude": { "runs": "claude", "model": "default" } } }`. The integrator and splitters,
  which judge merges and plans for the whole run, keep their agent's model or the harness's default.
- **What a run prints.** Each run starts with the agents and the model their work runs on (`agents: claude (haiku),
  codex (harness default), …`), then those it cannot use and why. `sous doctor` prints the worker models, and a lead's
  brief names the model of every agent it may give a child.
- **Agents leads define.** A lead may define a new agent for a child, `{ "name": "hr", "runs": "pi", "instructions":
  "…" }`, which later children may name, but only on a runtime the run lists `models` for, with one of those models
  (default: the first): `"models": { "claude": ["haiku"], "pi": ["ollama-cloud/glm-5.2"] }`. The same lists bound the
  `model` a lead sets on a child that names its agent.
- **Limits.** Leads nest 3 deep unless `--max-depth <n>` (1 to 8). A lead has at most 12 children over its lifetime.

The details: [design: Agents](design.md#agents).

## Where leads run

- **On Claude Code, with no lead credential.** A logged-in Claude Code is enough: the lead runs on Claude Code too, on
  `haiku`, through Claude's own login, and the `agents:` line says so, as `lead (haiku on claude: no lead provider had
  a credential)`. Each lead turn is read only (Claude's Read, Glob and Grep tools, confined to the run's results) and
  ends with the calls it makes, which sous checks and applies. Only Claude Code is certified to lead so far; Codex has a
  lead mode that is not yet certified, Pi and Droid have none ([harnesses: Leads on a harness](harnesses.md#leads-on-a-harness)).
- **In process, with a lead credential**, as before, on the first of these providers with a credential:

  | Provider | Default model | Credential |
  |---|---|---|
  | Ollama Cloud | `ollama-cloud/deepseek-v4.1-flash` | `OLLAMA_API_KEY` |
  | Anthropic | `anthropic/claude-haiku-5-5` | `ANTHROPIC_API_KEY`, or a Pi login |
  | OpenAI | `openai/gpt-6-luna` | `OPENAI_API_KEY`, or a Pi login |
  | ChatGPT subscription | `openai-codex/gpt-5.5` | a Pi login |

  For a [Pi](https://github.com/earendil-works/pi) login, install Pi
  (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), start it and type `/login`; sous reads
  `~/.pi/agent/auth.json` and never refreshes it: run `pi` once when it has expired. The Anthropic and OpenAI leads
  have not been run live yet. When no provider has a credential and no lead-certified harness is on `PATH`, sous
  refuses the run and says what to do.
- **Caution:** an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment is also what Claude Code and Codex workers
  use (they inherit it), so it moves them from your subscription to API billing.
- **To choose**, an agents file can put the lead on a model, `{ "agents": { "lead": { "runs": "lead", "model":
  "anthropic/claude-sonnet-5-5" } } }`, or on Claude Code, `{ "agents": { "lead": { "runs": "claude", "model":
  "sonnet" } } }`. A lead named on a harness that cannot lead is refused before the run starts. `sous doctor` shows
  where leads would run and why. A run keeps its lead choice when resumed.

The details: [design: Lead runner](design.md#lead-runner) and [Leads on a CLI harness](design.md#leads-on-a-cli-harness).

## Graph files

A goal lets the lead decide the tree. A graph file fixes the steps instead, with `work`, `check`, `lead` and `gate`
nodes:

```json
{ "goal": "Add a greeting", "agent": "claude",
  "agents": { "reviewer": { "runs": "codex", "instructions": "Review only; do not change files." } },
  "nodes": [
    { "id": "write", "kind": "work", "brief": "Create greeting.txt containing: hello" },
    { "id": "review", "kind": "work", "agent": "reviewer", "needs": ["write"], "brief": "Review greeting.txt" },
    { "id": "verify", "kind": "check", "needs": ["write"], "command": "grep -qx hello greeting.txt" },
    { "id": "ship", "kind": "gate", "needs": ["verify"], "brief": "Keep greeting.txt?" }
  ] }
```

```bash
sous run graph.json --max-cost 2
```

A `check` runs a shell command and passes when it exits 0; a `gate` waits for `sous approve` (or `sous cancel`, which
rejects it). A graph whose node names an unavailable agent is refused before anything runs. More examples and every
key: the skill's [EXAMPLES.md](../.agents/skills/sous/EXAMPLES.md) and [REFERENCE.md](../.agents/skills/sous/REFERENCE.md);
the node kinds: [design: Node kinds](design.md#node-kinds).

## The splitter

A run may hand splitting to a splitter: define an agent named `splitter` on `claude`, `codex`, `pi` or `droid`, with
your splitting strategy as its `instructions`, e.g. `"splitter": { "runs": "claude", "model": "opus", "instructions":
"One part per module, tests first." }`. Before each lead (sub-leads included) gets its brief, the splitter reads the
code merged so far in a throwaway worktree (in folder mode, the inputs and results through its own folder's links)
and proposes the lead's children; the lead receives the proposal and spawns it, adjusts it or ignores it.

With `sous run --approve-splits`, each proposal waits for you: `sous approve <lead>` or `sous answer <lead>
"<changes>"`. A subtree can have its own splitter: give a lead `"roles": { "splitter": "<agent>" }` in a graph file (a
lead may do the same for a child lead, naming an agent you defined); its sub-leads inherit it. The details:
[design: Splitting](design.md#splitting).

## What workers see

- **Messages.** While they work, workers may tell a sibling or their lead what the others must know (an interface
  they settled, a file they moved) with a `send` tool (sous's own MCP server, for Claude Code, Codex and Droid) or
  `sous send <to> 'text'` (Pi), and read what they are told, or wait for it, with `receive` / `sous receive [seconds]`.
  Their lead sees every message, and the run's log keeps them.
- **Your setup.** Workers load no other MCP server and as little of your own setup as each harness allows: no user
  skills, plugins or hooks, and for Claude Code none of your user settings (so your default model, `env`, permission
  rules and hooks do not apply to workers). The project's instructions still apply. Some of your setup still loads:
  for example, Codex reads your global `~/.codex/AGENTS.md`, and Claude Code reads the `CLAUDE.md` files above the
  worktree. What each harness still loads:
  [harnesses: What sous keeps out of workers](harnesses.md#what-sous-keeps-out-of-workers).
- **Permissions.** Workers run with full permissions in their worktree or folder, as you, with a shell, your files and
  your network. So a worker, or anything it runs, can also write the run's command files, where `sous answer`,
  `approve` and `cancel` put yours: an approval of a gate or a split, an answer or a cancel can be forged. Until
  workers are sandboxed, a gate protects only as far as you trust the
  agents you run.
