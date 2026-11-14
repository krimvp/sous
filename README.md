# sous

Give it a task, or a set of tasks, and it runs them to completion on your machine with a tree of agents.
Like a kitchen brigade: you call the order, lead agents split it across stations, workers (Claude Code, Codex,
Pi, Factory Droid or your own agent) cook, and checks and merges inspect every plate at the pass. Plain code keeps everything
moving, delivers messages between levels, and recovers after a crash.

- **Local only.** One supervisor process per run, state in `.sous/runs/<id>/` as plain files. Runs from
  before the rename, under `.murm/`, are not read.
- **Few dependencies.** Node 22.19 or later, on Linux and macOS (the tests run on Linux); only the lead runner depends on Pi's durable runtime. A checkout runs
  the TypeScript sources directly; the npm package is the same code compiled to JavaScript.
- **Any worker.** Workers sit behind a small adapter interface and run in turns: a message waits in an
  inbox until the next turn, or interrupts the current one.
- **Portable traces.** Runs export to ATIF trajectories and to Langfuse over OTLP.

Status: v4 works: give `sous run` a goal and a lead agent splits it into workers and checks, answers their
questions, and asks you when it cannot. Workers run in parallel in their own git worktrees and their work is
merged into one result branch, with conflicts resolved by an integrator agent; outside a git repository the
workers' files are collected into an output folder instead. Leads may look at files before they split, and may
define new agents on the
runtimes and models you allow. If the run stops or crashes, `sous resume` continues it without repeating
finished turns. `gate` nodes wait for your approval. A splitter agent can propose how every lead splits its
task. Fixed graph files of `work`, `check`, `lead` and `gate` nodes also run. Read [docs/design.md](docs/design.md).

```bash
npm install -g @krimvp/sous    # Node 22.19+; from a checkout, `node src/cli.ts` works the same as `sous`
sous doctor                    # a logged-in Claude Code is all a run needs
```

```bash
sous run "Add greeting.txt containing hello, with a check that verifies it"
sous run --max-depth 4 "…"     # let leads nest 4 deep instead of 3
sous answer lead "Use Grace."   # from another terminal: answer a question the run printed
sous cancel <node>              # from another terminal: stop a node and its subtree, or reject a gate
sous approve <gate>             # from another terminal: approve a gate (or a proposed split) the run printed
                                # (these three go to the running run; with several running, add its id)
sous resume                     # continue the latest run after Ctrl-C or a crash (or: resume <run-id>)
```

Workers see your last commit (`HEAD`) only, so commit the files they need first (sous warns at the start when your checkout
has uncommitted changes); started in a subdirectory of a git repository, sous works at the repository root and says so.

While they work, workers may tell a sibling or their lead what the others must know (an interface they settled, a file
they moved) with a `send` tool (sous's own MCP server, for Claude, Codex and Droid) or `sous send <to> 'text'`, and
read what they are told, or wait for it, with `receive` / `sous receive [seconds]`. Their lead sees every message.
Workers load no other MCP server (for Droid: none you configured; your plugins' servers still load) and as little of
your own setup as each harness allows: no user skills, plugins or hooks, and for Claude none of your user settings (so
your default model, `env`, permission rules and hooks do not apply to workers). The project's instructions still
apply; Codex still reads your global `AGENTS.md`, Claude the `CLAUDE.md` files above the worktree, and Droid your
custom droids and what your plugins bring besides skills. So what workers tell each other stays in the run's log.

`sous resume` takes over the stopped run: a turn that finished meanwhile is recorded, a turn still running is
stopped, and an interrupted worker continues its session with a note to re-check the workspace. A node
interrupted more than 3 times fails.

Workers run on a harness: Claude Code, Codex, Pi or Factory Droid, each certified by the same conformance suite
([docs/harnesses.md](docs/harnesses.md): what each needs, what sous keeps out of it, how to add one).

**What a run needs.** A logged-in Claude Code (`claude`, on your subscription) is enough: with no lead credential, the
lead runs on Claude Code too, on `haiku`, through Claude's own login, and the `agents:` line says so, as
`lead (haiku on claude: no lead provider had a credential)`. There is nothing to set. A lead on Claude Code runs each
turn read only (Claude's Read, Glob and Grep tools, confined to the run's results) and ends it with the calls it makes,
which sous applies. Codex has a lead mode too, not yet certified; Pi and Droid have none yet
([docs/harnesses.md](docs/harnesses.md)).

If you have a lead credential, leads run in process instead, as before: on Ollama Cloud
(`ollama-cloud/deepseek-v4.1-flash`, with `OLLAMA_API_KEY`), Anthropic (`anthropic/claude-haiku-5-5`, with
`ANTHROPIC_API_KEY`), OpenAI (`openai/gpt-6-luna`, with `OPENAI_API_KEY`) or your ChatGPT subscription
(`openai-codex/gpt-5.5`), the first with a credential in that order. Anthropic, OpenAI and ChatGPT also work through your
[Pi](https://github.com/earendil-works/pi) login (`/login` inside `pi`; sous reads `~/.pi/agent/auth.json` and never
refreshes it: run `pi` once when it has expired). Caution: an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment
is also what Claude Code and Codex workers use (they inherit it), so it moves them from your subscription to API
billing. A run keeps its lead choice when resumed. To choose: an agents file (`--agents`) can put the lead on a model,
`{ "agents": { "lead": { "runs": "lead", "model": "anthropic/claude-sonnet-5-5" } } }`, or on Claude Code,
`{ "agents": { "lead": { "runs": "claude", "model": "sonnet" } } }`. `sous doctor` shows where leads would run and why
(it does not check that a harness is logged in), and says what is missing.

Workers default to the first agent whose CLI is on your `PATH`: Claude Code, else Codex, else Pi, else Droid; a goal can ask for another agent, e.g. "use agent pi for every work child".

**Worker models.** A work node whose agent, node and lead name no model runs on a small model of its harness where sous
knows one: Claude Code workers run on `haiku` (two Claude Code workers on a small task cost $1.39 on Claude's default
model and $0.02 on `haiku`). Codex, Pi and Droid have no such default: their default model depends on your login or
settings, so they run on it. An agent's or a node's `model`, and a lead's choice from the run's `models`, still win; to
run a worker on its harness's own default instead, give its agent `"model": "default"` (for the built-in Claude agent:
`{ "agents": { "claude": { "runs": "claude", "model": "default" } } }`). The integrator and splitters, which judge
merges and plans for the whole run, keep their agent's model or the harness's default. Each run prints the agents
with the model their work runs on (`agents: claude (haiku), codex (harness default), …`), `sous doctor` prints the
worker models, and a lead's brief names the model of every agent it may give a child. A run keeps the models it
started with when resumed.

**Cost budget.** `sous run --max-cost <usd>` stops the run once the cost its turns reported reaches the budget: no new
turn starts, the running turns are stopped as Ctrl-C stops them, and `sous run` ends with the run stopped (not failed):
`stopped at its cost budget: $0.55 reported of $0.50 …; continue with a higher budget: sous resume <run-id> --max-cost
<usd>`. `sous resume` without a higher `--max-cost` refuses such a run; `sous status` and `sous wait` (exit 5, stopped)
say the same. The budget bounds only the cost reported: a cost is known when a turn ends, so the turns running at the
time can overshoot it, and turns that report no cost (Codex and Droid workers, and leads and Pi workers on Ollama) are not
counted. There is no turn timeout yet.

In a git repository (it needs at least one commit), each work node runs in its own git worktree, in parallel
with the others; when it is done its branch is merged into the run's branch `sous/<run-id>`, one merge at a time. A conflict, or a check that fails after a merge, goes to the integrator: an agent of the run
(Codex, else Claude, else Pi, else Droid; or a graph agent named `integrator`) that resolves it in the integration worktree.
Your own checkout is not touched: `sous status` names the result branch, and merging it is up to you. At the end
`sous run` and `sous status` print the next steps in one line:

```bash
sous diff [--stat]         # what the run changed: git diff from where sous/<run-id> started to its head (so far, while it runs)
git merge sous/<run-id>    # take it into your branch
sous clean                 # remove the finished run's worktrees and merged node branches; keep sous/<run-id> and the log
sous clean --branches      # also delete sous/<run-id>, once your HEAD contains it
```

`sous clean` refuses a run that is running or stopped (resume needs its worktrees); `--all` cleans every finished run
and `--dry-run` shows what would go. It removes only what the run's log records creating. Work no result holds is
kept and listed: a failed node's branch with commits not in `sous/<run-id>`, a worktree with uncommitted changes
(`--unmerged` removes those too). `status`, `ui` and `export` still work on a cleaned run.

Anywhere else, or without git, sous uses folder mode on its own; good for research and summaries of many
documents. Each worker and check runs in a folder of its own where `workspace/` (your files) and `results/` (the
results so far) are links, the same names the lead reads by. Workers write their files at the top of their folder,
and these are collected into `.sous/runs/<run-id>/output/` one at a time. A file of the same name and different content is kept beside the
first as `<name>.<node>.<ext>` (or `<name>.<node>-2.<ext>`, …); nothing in the results is replaced. Your files are only read; `sous status` names the output folder, `sous diff` lists its files and `sous clean` removes
the per-node folders (`work/`), keeping `output/`. A lead may
complete over a failed check, and then `sous run` and `sous status` say "completed with failed checks: …".

Or give it a fixed graph file:

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
sous run graph.json        # runs in the current directory (the repository root, in a git repository); state in .sous/runs/<id>/
sous run graph.json --max-cost 2   # stop once the turns reported $2 of cost; sous resume --max-cost <more> continues
sous status                # latest run as a tree; a running turn shows its age and how long ago its output last grew
                           # and the run's tokens and reported cost, also printed when `sous run` ends
sous runs                  # every run of the workspace, newest first: id, state, start, goal
sous status --json         # the same as one JSON document, with what waits for you and the commands that answer it
sous wait --timeout 300    # block until the run needs you or is over; the exit code says which (0 completed, 3 failed,
                           # 4 waits for you, 5 stopped: resume it, 6 timeout); --json prints status --json with the reason
sous --help | --version    # the usage (also: sous <command> --help), the installed version
sous export atif           # writes .sous/runs/<id>/trace.atif.json
sous export otlp           # needs LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
sous ui                    # a local page with every run, live or finished (--port <n>)
sous doctor                # could a run start here? harnesses on PATH with versions, lead credentials, where leads run, git state
```

`sous ui` prints a `127.0.0.1` address with a random token and serves one page: the workspace's runs, each run's tree
folded by team beside a timeline of every lead's and worker's busy time, merges and checks, and for any node its brief,
a lead's decisions in order, or a worker's turns with their messages, tool calls and results. It follows a running run
as its log grows, and lists what waits for you with the command that answers it. It only reads the run's files.

An agent is a name for how work gets done: it `runs` on `claude`, `codex`, `pi`, `droid` or `lead`, with an optional
`model` and standing `instructions` added to every brief it gets. The built-in agents `claude`, `codex`, `pi`,
`droid` and `lead` need no definition; a node's `model` overrides its agent's. Workers run with full permissions in their
worktree (see the design's harness facts), as you. So a worker, or anything it runs, can also write the run's command
files, where `sous answer`, `approve` and `cancel` put yours: an approval of a gate or a split, an answer or a cancel can
be forged. Until workers are sandboxed ([#43](https://github.com/krimvp/sous/issues/43)), a gate protects only as far
as you trust the agents you run.

A lead may define a new agent for a child, `{ "name": "hr", "runs": "pi", "instructions": "…" }`, which later
children may name, but only on a runtime the run lists `models` for, with one of those models (default: the
first): `"models": { "claude": ["haiku"], "pi": ["ollama-cloud/glm-5.2"] }` in a graph file. The same lists bound
the `model` a lead sets on a child that names its agent. A goal run takes the same
`agent`, `agents` and `models` from a file: `sous run --agents agents.json "…"`.

A run may hand splitting to a **splitter**: define an agent named `splitter` on `claude`, `codex`, `pi` or `droid`, with your
splitting strategy as its `instructions`, e.g. `"splitter": { "runs": "claude", "model": "opus", "instructions":
"One part per module, tests first." }`. Before each lead (sub-leads included) gets its brief, the splitter reads the
code merged so far in a throwaway worktree (in folder mode, the inputs and results through its own folder's links) and proposes the lead's children; the lead receives the proposal and
spawns it, adjusts it or ignores it. With `run --approve-splits`, each proposal waits for you: `sous approve <lead>`
or `sous answer <lead> "<changes>"`. A subtree can have its own splitter: give a lead `"roles": { "splitter":
"<agent>" }` in a graph file (a lead may do the same for a child lead, naming an agent you defined); its sub-leads
inherit it.

```bash
npm install          # the lead runner's Pi packages, the type checker, and the pre-push hook (scripts/pr-check.sh)
npm run check        # type check and tests (SOUS_LIVE=1 adds a real lead run)
npm run test:quick   # the pure, fast test files only (about 2 s); not a substitute for check
npm run certify      # live harness certification, costs money: SOUS_HARNESS=droid npm run certify
npm pack             # builds dist/ (prepack) and the tarball npm publish would upload; check it before publishing
```

## For agents

The `sous` skill in [.agents/skills/sous](.agents/skills/sous/SKILL.md) (linked for Claude Code
from `.claude/skills`) teaches an agent to start, watch, steer, resume and export runs. The landing page is
[site/index.html](site/index.html), published at https://krimvp.github.io/sous/ with
`scripts/publish-site.sh`.
