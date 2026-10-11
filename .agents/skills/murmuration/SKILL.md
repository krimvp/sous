---
name: murmuration
description: Run a task to completion with a tree of agents using Murmuration (`murm`): a lead agent splits the goal, Claude Code, Codex or Pi workers do the work in git worktrees, checks and merges keep the result correct. Use when the user wants work delegated to several agents, a goal decomposed and executed, a graph of agent steps run, or a Murmuration run started, watched, answered, resumed or exported.
---

# Murmuration

Murmuration (`~/workspace/murmuration`) runs a goal with a tree of agents on this machine. The supervisor (plain
code) starts every agent, routes messages, merges work and recovers after crashes. You start and steer runs.

```bash
M="node $HOME/workspace/murmuration/src/cli.ts"   # or `murm` if installed
```

## Quick start

Run from the git repository the agents should work in (it needs at least one commit):

```bash
$M run "Add a --precision N option to the CLI, with tests and a check that node --test passes"
```

A lead (default `ollama-cloud/deepseek-v4.1-flash`) splits the goal into workers, checks and sub-leads. The
result lands on branch `murm/<run-id>`; the person's own branch is never touched.

## Workflow

1. **Choose the shape.**
   - A goal string: the lead decides the tree. Put the rules for the tree in the goal ("split into…",
     "use agent pi for workers", "end with a check that runs …").
   - A graph file (`run graph.json`): fixed steps, optionally around leads. See [EXAMPLES.md](EXAMPLES.md).
2. **Define agents and limits when it matters** (cost, roles, models). Goal runs take `--agents agents.json`;
   graph files carry the same `agent`, `agents`, `models` keys. See [REFERENCE.md](REFERENCE.md).
3. **Start it in the background** and keep the log: `$M run … > run.log 2>&1`.
4. **Watch** `run.log` for `node.failed`, `merge.conflict`, `merge.failed`, `-> person`, `run.completed`,
   `run.failed`; `$M status` prints the live tree and pending questions.
5. **Steer from another shell** when needed:
   - `$M answer <node> "text"`: reply to a question, or correct a lead (it reacts within seconds).
   - `$M approve <gate>` / `$M cancel <node>` (cancel stops the node and its subtree, or rejects a gate).
   - `$M resume`: continue after Ctrl-C or a crash; finished turns, checks and merges are not repeated.
6. **Check the result yourself** on `murm/<run-id>` (run the tests, try the program) before telling the user
   it works. Merging that branch into their branch is the user's decision.
7. **Export traces** if asked: `$M export atif` (writes `.murm/runs/<id>/trace.atif.json`) or `$M export otlp`
   (needs `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`).

## Rules that save time

- Agents that exist: built-ins `claude`, `codex`, `pi`, `lead`, plus what the run defines. The run prints
  `agents: …; not available: …` at start; a CLI must be on PATH and logged in.
- Workers run with full permissions inside their own worktree. Say so if the user has not accepted that.
- Leads nest 3 deep unless `--max-depth <n>` (1–8). At most 12 children per lead.
- Leads choose models only from the run's `models` lists; without one they use agents as defined.
- Prefer cheap models for experiments (`pi` on Ollama models, the default lead).
- A failing check is often a wrong command in the goal, not wrong code: read its output in `.murm/runs/<id>/events.jsonl`
  (`check.ended`) before blaming the agents, and correct the lead with `answer`.
- Write check commands that work in Node 22: `node --test`, not `node --test test/`.

Events, files and every definition key: [REFERENCE.md](REFERENCE.md).
