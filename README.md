# sous

Give it a task and it runs it to completion on your machine with a tree of agents. Like a kitchen brigade: you call
the order, lead agents split it across stations, workers (Claude Code, Codex, Pi or Factory Droid) cook, and checks
and merges inspect every plate at the pass.

## Quickstart

You need Node 22.19 or later (Linux or macOS; the tests run on Linux), a logged-in
[Claude Code](https://claude.com/claude-code), and, for code, a git repository with at least one commit. Workers see
your last commit only, so commit what they need first. Codex, Pi or Droid can do the work instead of Claude Code, but
then the lead needs a credential of its own ([Where leads run](docs/usage.md#where-leads-run)).

```bash
npm install -g @krimvp/sous
sous doctor                    # could a run start here?
sous run --max-cost 1 "Add greeting.txt containing hello, with a check that verifies it"
sous diff                      # what the run changed, on branch sous/<run-id>
git merge sous/<run-id>        # take it into your branch
sous clean                     # remove the run's worktrees; keeps sous/<run-id> and the log
```

With only Claude Code logged in and no lead credential, `sous doctor` prints, for example:

```
claude: 2.1.325 (Claude Code); login not checked
codex: not on PATH
pi: not on PATH
droid: not on PATH
lead credentials: none
lead: on claude (haiku), the first lead-certified harness on PATH, as no lead provider has a credential
worker models: claude (haiku)
workspace: /home/you/project, git repository at its top level, no uncommitted changes
ready: lead on claude (haiku), workers on claude
```

`sous run` prints the agents it can use and `run <id> (<dir>)`, then its progress, and at the end the result branch, the tokens and cost reported, and a
`next:` line with the steps above that still apply. `--max-cost 1` stops the run once its turns reported $1 of cost.

## What happens in a run

- A **lead** agent splits the goal into workers, checks and sub-leads (3 levels deep by default), answers their
  questions, and asks you when it cannot. It may read your files before it splits.
- **Workers** run in parallel, each in its own git worktree, on Claude Code (on `haiku` unless you name a model),
  Codex, Pi or Droid. They can tell a sibling or their lead what the others must know while they work.
- **Checks** are shell commands; a check passes when it exits 0.
- Each finished worker's branch goes through a **merge queue**, one merge at a time, into `sous/<run-id>`. A conflict,
  or a check that fails after a merge, goes to an **integrator** agent that resolves it.
- The **result** is the branch `sous/<run-id>`. Your own checkout is not touched; merging is up to you.
- Outside a git repository, sous uses **folder mode**: workers write into folders of their own and their files are
  collected into `.sous/runs/<run-id>/output/`. Good for research and summaries of many documents.
- Plain code (the supervisor, one process per run) starts every agent, delivers messages between levels, keeps the run
  in plain files under `.sous/runs/<run-id>/`, and recovers after a crash.

## Watching and steering

From another terminal, while the run runs:

| Command | What it does |
|---|---|
| `sous wait [--timeout <s>]` | Block until the run needs you or is over; exit 0 completed, 3 failed, 4 waits for you, 5 stopped, 6 timeout |
| `sous status [--json]` | The run as a tree, what waits for you and the command that answers it, tokens and cost |
| `sous answer <node> "text"` | Answer a question the run printed, or correct a lead |
| `sous approve <node>` | Approve a gate or a proposed split |
| `sous cancel <node>` | Stop a node and its subtree, or reject a gate |
| `sous resume [--max-cost <usd>]` | Continue after Ctrl-C, a crash or the budget, without repeating finished turns |
| `sous ui` | A local page with every run, live or finished: trees, timelines, each lead's decisions and worker's turns |
| `sous runs` | The workspace's runs, newest first |

Every command, graph files of fixed steps, agents files, models, the splitter, folder mode and exports:
[docs/usage.md](docs/usage.md).

## Before you trust it

- **Workers run with full permissions, as you.** They have a shell, your files and your network, inside their
  worktree or folder. A worker, or anything it runs, can also write the run's command files and so forge an approval,
  an answer or a cancel: until workers are sandboxed ([#43](https://github.com/krimvp/sous/issues/43)), a gate protects
  only as far as you trust the agents you run.
- **Workers see `HEAD` only.** Uncommitted changes are not in their worktrees; sous warns when there are some.
- **An API key moves workers to API billing.** Claude Code and Codex workers inherit the environment, so an
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` there moves them from your subscription to API billing. Such a key also moves
  the lead from Claude Code to an in-process provider ([Where leads run](docs/usage.md#where-leads-run)).
- **The budget counts only reported cost.** A cost is known when a turn ends, so turns in flight can overshoot
  `--max-cost`, and Codex and Droid workers, and leads and Pi workers on Ollama, report no cost and are not counted.
  There is no turn timeout yet.
- **What is certified.** All four harnesses are certified as workers by the same conformance suite; only Claude Code
  is certified to lead so far ([docs/harnesses.md](docs/harnesses.md)).

## More

- [docs/usage.md](docs/usage.md): every command and option, git and folder mode, budgets, agents and models, where
  leads run, graph files, the splitter.
- [docs/harnesses.md](docs/harnesses.md): what each harness needs, what sous keeps out of it, why a worker fails at
  once, how to add one.
- [docs/design.md](docs/design.md): the concepts, boundaries and roadmap.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
- For agents: the `sous` skill in [.agents/skills/sous](.agents/skills/sous/SKILL.md) (linked for Claude Code from
  `.claude/skills`) teaches an agent to start, watch, steer, resume and export runs.
- Runs export to ATIF trajectories and to Langfuse over OTLP (`sous export`).
- The landing page is [site/index.html](site/index.html), published at https://krimvp.github.io/sous/ with
  `scripts/publish-site.sh`.

## Development

From a checkout, `node src/cli.ts` works the same as `sous`.

```bash
npm install          # the lead runner's Pi packages, the type checker, and the pre-push hook (scripts/pr-check.sh)
npm run check        # type check and tests (SOUS_LIVE=1 adds a real lead run)
npm run test:quick   # the pure, fast test files only (about 2 s); not a substitute for check
npm run certify      # live harness certification, costs money: SOUS_HARNESS=droid npm run certify
npm pack             # builds dist/ (prepack) and the tarball npm publish would upload; check it before publishing
```

Read [AGENTS.md](AGENTS.md) before contributing.
