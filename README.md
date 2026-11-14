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
export OLLAMA_API_KEY=…        # the lead's model access: an Ollama Cloud key, or a Pi login (below) for Anthropic or ChatGPT
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

Leads run on a model of Ollama Cloud (`ollama-cloud/deepseek-v4.1-flash`, with `OLLAMA_API_KEY`), Anthropic
(`anthropic/claude-haiku-5-5`, with `ANTHROPIC_API_KEY`), OpenAI (`openai/gpt-6-luna`, with `OPENAI_API_KEY`) or your
ChatGPT subscription (`openai-codex/gpt-5.5`). Anthropic, OpenAI and ChatGPT also work through your
[Pi](https://github.com/earendil-works/pi) login (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`,
then `/login` inside `pi`; it stores `~/.pi/agent/auth.json`, which sous reads and never refreshes: an expired login
is refreshed by running `pi` once). Pi's login has no Ollama Cloud account: that provider needs the key. A lead that
names no model runs on the first of these, in that order, that has a credential, and the run keeps that choice when
resumed; the run prints it on its
`agents:` line, as `lead (ollama-cloud/deepseek-v4.1-flash)`. A run with no credential for its lead is refused with
what to do. Caution: an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment is also what Claude Code and Codex
workers use (workers inherit your environment), so it moves Claude Code, and may move Codex, from your subscription
to API billing; prefer the Pi login or `OLLAMA_API_KEY` when your workers run on a subscription. Anthropic and OpenAI
leads have not been run live yet. Another lead model, as `provider/model`, goes in an agents file (`--agents`,
`{ "agents": { "lead": { "runs": "lead", "model": "anthropic/claude-sonnet-5-5" } } }`) or on a graph's lead node. `sous doctor`
shows what a run here would find (it does not check that a harness is logged in), and says what is missing. Their workers default to the first agent whose CLI is on your `PATH`: Claude
Code, else Codex, else Pi, else Droid, each with its default model; a goal can ask for another agent, e.g. "use agent pi for
every work child". Each run prints which agents are available.

In a git repository (it needs at least one commit), each work node runs in its own git worktree, in parallel
with the others; when it is done its branch is merged into the run's branch `sous/<run-id>`, one merge at a time. A conflict, or a check that fails after a merge, goes to the integrator: an agent of the run
(Codex, else Claude, else Pi, else Droid; or a graph agent named `integrator`) that resolves it in the integration worktree.
Your own checkout is not touched: `sous status` names the result branch, and merging it is up to you.

Anywhere else, or without git, sous uses folder mode on its own; good for research and summaries of many
documents. Each worker and check runs in a folder of its own where `workspace/` (your files) and `results/` (the
results so far) are links, the same names the lead reads by. Workers write their files at the top of their folder,
and these are collected into `.sous/runs/<run-id>/output/` one at a time. A file of the same name and different content is kept beside the
first as `<name>.<node>.<ext>` (or `<name>.<node>-2.<ext>`, …); nothing in the results is replaced. Your files are only read; `sous status` names the output folder. A lead may
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
sous doctor                # could a run start here? harnesses on PATH with versions, lead credentials and model, git state
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
