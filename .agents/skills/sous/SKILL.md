---
name: sous
description: Run a task to completion with a tree of agents using sous, named after the kitchen brigade: a lead agent splits the goal like a sous chef, Claude Code, Codex, Pi or Factory Droid workers do the work (code, research, writing) in git worktrees or their own folders, checks and merges keep the result correct. Use when the user wants work delegated to several agents, a goal decomposed and executed, a graph of agent steps run, or a sous run started, watched, answered, resumed or exported.
---

# sous

sous runs a goal with a tree of agents on this machine. The supervisor (plain code) starts every agent,
routes messages, merges work and recovers after crashes. You start and steer runs.

```bash
M=sous                                   # if installed (npm install -g @krimvp/sous)
M="node <sous checkout>/src/cli.ts"      # otherwise: the repository this skill lives in (src/cli.ts,
                                         # three levels above this skill's folder)
```

## Before the first run

- Run `$M doctor` where the agents will work: each harness CLI on PATH with its version (not whether it is logged
  in), the lead's credentials and where leads would run, the git state; it exits 0 when a run could start, else says
  what is missing.
- A logged-in Claude Code is enough: with no lead credential, the lead runs on Claude Code (on `haiku`, read only, on
  the user's Claude login), and `$M doctor` says `lead: on claude (haiku), …`. With a lead credential, the lead runs in
  process on the first provider that has one, in a fixed order (`OLLAMA_API_KEY`; Anthropic, OpenAI or ChatGPT by key or
  Pi login), as before. Do not add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for a lead without asking: workers inherit
  the environment, so such a key moves Claude Code, and may move Codex, from the user's subscription to API billing. A
  run keeps its lead's runtime and model when resumed. Only harnesses certified to lead (now Claude Code) can lead; a
  lead named on another is refused before the run starts. With neither a credential nor `claude`, the run is refused
  with what to do.
- In a git repository (it needs a commit) workers see the last commit (`HEAD`) only: commit what they need first (the
  run prints `workspace has N uncommitted changes; workers see HEAD only`). From a subdirectory the workspace is the
  repository root, which the run prints.
- A run starts by printing `agents: claude (haiku), lead (ollama-cloud/deepseek-v4.1-flash); not available: codex
  (codex not found), …`: the agents it can use, each with the model its work runs on (`harness default`: the harness's
  own), then those it cannot, with why (`<cli> not found` means
  not on PATH; `no lead provider has a credential`, `no credential for <provider>`). A lead on Claude Code shows as
  `lead (haiku on claude: no lead provider had a credential)`. Leads are offered only the
  available ones; one whose CLI is not logged in still fails its turns.

## Quick start

Run from the directory the agents should work in: a git repository for code, or any folder (folder mode, automatic
when it is not in a git repository):

```bash
$M run "Add a --precision N option to the CLI, with tests and a check that node --test passes"
```

For anything non-trivial, give it a budget: `$M run "…" --max-cost 2` stops the run once the cost its turns reported
reaches $2 (ask the user what they will spend). A lead splits the goal into workers, checks and sub-leads. The result lands on branch `sous/<run-id>` (the person's
own branch is never touched), or in folder mode in `.sous/runs/<run-id>/output/` (the person's files are only read).
Leads may read files before splitting. In folder mode, workers and checks run in their own folders with links
`workspace/` (inputs) and `results/` (the output), so write checks such as `test -s results/report.md`.

## Workflow

1. **Choose the shape.**
   - A goal string: the lead decides the tree. Put the rules for the tree in the goal ("split into…",
     "use agent pi for workers", "end with a check that runs …").
   - A graph file (`run graph.json`): fixed steps, optionally around leads. See [EXAMPLES.md](EXAMPLES.md).
2. **Define agents and limits when it matters** (cost, roles, models). Goal runs take `--agents agents.json`;
   graph files carry the same `agent`, `agents`, `models` keys. See [REFERENCE.md](REFERENCE.md). For
   consistent or stronger planning, define a `splitter` agent: it proposes every lead's split from the code, and
   `--approve-splits` lets the user approve each one.
3. **Start it in the background** and keep its output: a run waits for answers and approvals, so a foreground run
   blocks your shell. Take its id from the line `run <id> (<dir>)` it prints once the run exists (a run refused before
   it starts prints why and exits):

   ```bash
   $M run "…" > run.log 2>&1 & pid=$!
   until id=$(awk '$1 == "run" { print $2; exit }' run.log) && [ -n "$id" ]; do kill -0 $pid 2>/dev/null || { cat run.log; break; }; sleep 1; done
   ```
4. **Drive it with `wait`**: `$M wait $id --json --timeout 540` blocks until the run needs you or is over and prints
   the run's status as JSON with `wait`, the reason; its exit code says the same:

   | exit | `wait` | do |
   |---|---|---|
   | 0 | `completed` | check the result (step 6) |
   | 3 | `failed` | the run failed, or completed with failed checks: read `reason`, `summary` and the failed nodes' `summary` |
   | 4 | `waiting` | each `waiting` item has `kind` (question, gate, split), `node`, `text` and the `commands` that answer it: decide, or ask the user, run one, then `wait` again |
   | 5 | `stopped` | the supervisor is gone (Ctrl-C, a crash): `$M resume $id > resume.log 2>&1 &`, then `wait` again. With `budget` set, the run reached its `--max-cost`: tell the user what it spent (`budget.spentUsd`) and resume only with a higher budget they agree to (`$M resume $id --max-cost <usd>`; `resume` without one is refused) |
   | 6 | `timeout` | nothing changed yet: look at `nodes` if you want, then `wait` again |
   | 1, 2 | | sous refused the command (no such run, a bad option): it says why on stderr |

   The `commands` start with `sous`: run them as `$M …`, with `<answer>` or `<changes>` replaced.

   Name the run (`$id`): without one `wait` follows the latest run, which until yours exists is an older one. An ask
   you answered does not stop the next `wait` while the run applies the answer (`sent: true`); one you leave
   unanswered stops every `wait` at once. A running node's `turn` gives its age and the age of its last output: a
   worker silent for long (`turn.stalled` in the log after 10 minutes) may run a long command; look before cancelling
   it. `$M status --json` (or `$M status` as text) is the same snapshot without waiting; its `usage` gives the tokens and the
   cost the harnesses reported (Codex, Droid and Ollama report none, so it may be partial: `unpriced` counts those turns,
   which a budget does not count either), and `maxCostUsd` the budget; `$M runs` lists the runs.
5. **Steer** when needed, from your shell or another (the run need not be waiting):
   - `$M answer <node> "text"`: reply to a question, or correct a lead (it reacts within seconds).
   - `$M approve <gate>` / `$M cancel <node>` (cancel stops the node and its subtree, or rejects a gate).
   - With `--approve-splits`: `$M approve <lead>` accepts its proposed split, `$M answer <lead> "…"` changes it.
   - `$M resume`: continue after Ctrl-C or a crash; finished turns, spawns and merges are not repeated, and
     recorded check results are kept (a check still running when the supervisor stopped runs again).
6. **Check the result yourself** on `sous/<run-id>` or in the output folder (run the tests, try the program,
   read the files) before telling the user it works. `$M diff` (or `$M diff --stat`) shows what the run changed
   (in folder mode, lists the output files). Merging that branch into their branch is the user's decision.
   Once they have what they need, `$M clean` removes the finished run's worktrees and merged node branches (it keeps
   `sous/<run-id>`, the log and unmerged work, and lists what it kept; `--dry-run` first, `--branches` also deletes
   the result once merged into `HEAD`). It refuses a running or stopped run: never clean a run the user may resume.
7. **Export traces** if asked: `$M export atif` (writes `.sous/runs/<id>/trace.atif.json`) or `$M export otlp`
   (needs `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`). For the user to watch or revisit runs in
   a browser, start `$M ui` in the background and give them the address it prints (it serves until stopped).

## Rules that save time

- Agents that exist: built-ins `claude`, `codex`, `pi`, `droid`, `lead`, plus what the run defines. A graph whose node
  names an unavailable agent is refused before anything runs.
- Workers run as the user with full permissions inside their own worktree or folder, and can write the run's command
  files: a worker, or anything it runs, could forge an approval, an answer or a cancel. Until workers are sandboxed,
  gates protect only as far as the user trusts the agents. Say so if the user has not accepted that.
- Leads nest 3 deep unless `--max-depth <n>` (1–8). At most 12 children per lead in total; at most 4 workers and
  checks run at a time in a run, the rest wait.
- A failed worker turn's stderr is in `.sous/runs/<id>/nodes/<node>/turn-<k>.err`, its raw output in `turn-<k>.jsonl`.
- Leads choose models only from the run's `models` lists; without one they use agents as defined.
- Pass `--max-cost <usd>` for anything non-trivial. It bounds only the cost reported, once a turn ends: running turns
  can overshoot it, and Codex and Droid workers (and Pi workers and leads on Ollama) report no cost, so a run on them
  is not bounded by it. There is no turn timeout.
- Work nodes whose agent names no model run on a small model of their harness where sous knows one (Claude Code:
  `haiku`); Codex, Pi and Droid run on their own default. For hard work, name a stronger model on the agent or node
  (`"model": "sonnet"`), or `"model": "default"` for the harness's own default. The integrator and splitters keep their
  agent's model or the harness's default.
- Prefer cheap models for experiments (`pi` on Ollama models, the default lead).
- A failing check is often a wrong command in the goal, not wrong code: read its output in `.sous/runs/<id>/events.jsonl`
  (`check.ended`) before blaming the agents, and correct the lead with `answer`.
- Write check commands that work in Node 22: `node --test`, not `node --test test/`.

Events, files and every definition key: [REFERENCE.md](REFERENCE.md).
