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

Leads use the model `ollama-cloud/deepseek-v4.1-flash` through your Pi login (`~/.pi/agent/auth.json`; run
`pi` once to log in or refresh). Their workers default to the first agent whose CLI is on your `PATH`: Claude
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
sous run graph.json        # runs in the current directory; state in .sous/runs/<id>/
sous status                # latest run as a tree
sous export atif           # writes .sous/runs/<id>/trace.atif.json
sous export otlp           # needs LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
sous ui                    # a local page with every run, live or finished (--port <n>)
```

`sous ui` prints a `127.0.0.1` address with a random token and serves one page: the workspace's runs, each run's tree
folded by team beside a timeline of every lead's and worker's busy time, merges and checks, and for any node its brief,
a lead's decisions in order, or a worker's turns with their messages, tool calls and results. It follows a running run
as its log grows, and lists what waits for you with the command that answers it. It only reads the run's files.

An agent is a name for how work gets done: it `runs` on `claude`, `codex`, `pi`, `droid` or `lead`, with an optional
`model` and standing `instructions` added to every brief it gets. The built-in agents `claude`, `codex`, `pi`,
`droid` and `lead` need no definition; a node's `model` overrides its agent's. Workers run with full permissions in their
worktree (see the design's harness facts).

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
npm install          # the lead runner's Pi packages and the type checker
npm run check        # type check and tests (SOUS_LIVE=1 adds a real lead run)
npm run certify      # live harness certification, costs money: SOUS_HARNESS=droid npm run certify
npm pack             # builds dist/ (prepack) and the tarball npm publish would upload; check it before publishing
```

## For agents

The `sous` skill in [.agents/skills/sous](.agents/skills/sous/SKILL.md) (linked for Claude Code
from `.claude/skills`) teaches an agent to start, watch, steer, resume and export runs. The landing page is
[site/index.html](site/index.html), published at https://krimvp.github.io/sous/ with
`scripts/publish-site.sh`.
