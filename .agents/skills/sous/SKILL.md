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

## Quick start

Run from the directory the agents should work in: a git repository (with at least one commit) for code, or any
folder (folder mode, automatic when it is not in a git repository):

```bash
$M run "Add a --precision N option to the CLI, with tests and a check that node --test passes"
```

A lead (default `ollama-cloud/deepseek-v4.1-flash`, which needs `OLLAMA_API_KEY` or a Pi login, `pi` run once; a run
without a lead credential is refused with what to do) splits the goal into workers, checks and sub-leads. The
result lands on branch `sous/<run-id>` (the person's own branch is never touched), or in folder mode in
`.sous/runs/<run-id>/output/` (the person's files are only read). Leads may read files before splitting. In folder
mode, workers and checks run in their own folders with links `workspace/` (inputs) and `results/` (the output), so
write checks such as `test -s results/report.md`.

## Workflow

1. **Choose the shape.**
   - A goal string: the lead decides the tree. Put the rules for the tree in the goal ("split into…",
     "use agent pi for workers", "end with a check that runs …").
   - A graph file (`run graph.json`): fixed steps, optionally around leads. See [EXAMPLES.md](EXAMPLES.md).
2. **Define agents and limits when it matters** (cost, roles, models). Goal runs take `--agents agents.json`;
   graph files carry the same `agent`, `agents`, `models` keys. See [REFERENCE.md](REFERENCE.md). For
   consistent or stronger planning, define a `splitter` agent: it proposes every lead's split from the code, and
   `--approve-splits` lets the user approve each one.
3. **Start it in the background** and keep the log: `$M run … > run.log 2>&1 &` (a run waits for answers and
   approvals, so a foreground run can block your shell).
4. **Watch** `run.log` for `completed with failed checks`, `node.failed`, `merge.conflict`, `merge.failed`, `-> person`, `run.completed`,
   `run.failed`; `$M status` prints the live tree and pending questions.
5. **Steer from another shell** when needed:
   - `$M answer <node> "text"`: reply to a question, or correct a lead (it reacts within seconds).
   - `$M approve <gate>` / `$M cancel <node>` (cancel stops the node and its subtree, or rejects a gate).
   - With `--approve-splits`: `$M approve <lead>` accepts its proposed split, `$M answer <lead> "…"` changes it.
   - `$M resume`: continue after Ctrl-C or a crash; finished turns, spawns and merges are not repeated, and
     recorded check results are kept (a check still running when the supervisor stopped runs again).
6. **Check the result yourself** on `sous/<run-id>` or in the output folder (run the tests, try the program,
   read the files) before telling the user it works. Merging that branch into their branch is the user's decision.
7. **Export traces** if asked: `$M export atif` (writes `.sous/runs/<id>/trace.atif.json`) or `$M export otlp`
   (needs `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`). For the user to watch or revisit runs in
   a browser, start `$M ui` in the background and give them the address it prints (it serves until stopped).

## Rules that save time

- Agents that exist: built-ins `claude`, `codex`, `pi`, `droid`, `lead`, plus what the run defines. The run prints
  `agents: …; not available: …` at start; a CLI must be on PATH and logged in. A graph whose node names an
  unavailable agent is refused before anything runs.
- Workers run with full permissions inside their own worktree or folder. Say so if the user has not accepted that.
- Leads nest 3 deep unless `--max-depth <n>` (1–8). At most 12 children per lead.
- Leads choose models only from the run's `models` lists; without one they use agents as defined.
- Prefer cheap models for experiments (`pi` on Ollama models, the default lead).
- A failing check is often a wrong command in the goal, not wrong code: read its output in `.sous/runs/<id>/events.jsonl`
  (`check.ended`) before blaming the agents, and correct the lead with `answer`.
- Write check commands that work in Node 22: `node --test`, not `node --test test/`.

Events, files and every definition key: [REFERENCE.md](REFERENCE.md).
