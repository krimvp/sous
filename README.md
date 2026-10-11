# Murmuration

Give it a task, or a set of tasks, and it runs them to completion on your machine with a tree of agents.
Lead agents plan and split the work; workers (Claude Code, Codex, Pi or your own agent) do it; plain code
keeps everything moving, delivers messages between levels, and recovers after a crash.

- **Local only.** One supervisor process per run, state in `.murm/runs/<id>/` as plain files.
- **Few dependencies.** Node 22.19 or later runs the TypeScript sources directly; only the lead runner
  depends on Pi's durable runtime.
- **Any worker.** Workers sit behind a small adapter interface and run in turns: a message waits in an
  inbox until the next turn, or interrupts the current one.
- **Portable traces.** Runs export to ATIF trajectories and to Langfuse over OTLP.

Status: v2 works: give `murm run` a goal and a lead agent splits it into workers and checks, answers their
questions, and asks you when it cannot. If the run stops or crashes, `murm resume` continues it without
repeating finished turns. `gate` nodes wait for your approval. Fixed graph files of `work`, `check`, `lead` and
`gate` nodes also run. Read [docs/design.md](docs/design.md).

```bash
node src/cli.ts run "Add greeting.txt containing hello, with a check that verifies it"
node src/cli.ts answer lead "Use Grace."   # from another terminal: answer a question the run printed
node src/cli.ts cancel <node>              # from another terminal: stop a node and its subtree, or reject a gate
node src/cli.ts approve <gate>             # from another terminal: approve a gate the run printed
node src/cli.ts resume                     # continue the latest run after Ctrl-C or a crash (or: resume <run-id>)
```

`murm resume` takes over the stopped run: a turn that finished meanwhile is recorded, a turn still running is
stopped, and an interrupted worker continues its session with a note to re-check the workspace. A node
interrupted more than 3 times fails.

Leads use the model `ollama-cloud/deepseek-v4.1-flash` through your Pi login (`~/.pi/agent/auth.json`; run
`pi` once to log in or refresh). Their workers default to the first agent whose CLI is on your `PATH`: Claude
Code, else Codex, else Pi, each with its default model; a goal can ask for another agent, e.g. "use agent pi for
every work child". Each run prints which agents are available.

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
node src/cli.ts run graph.json        # runs in the current directory; state in .murm/runs/<id>/
node src/cli.ts status                # latest run as a tree
node src/cli.ts export atif           # writes .murm/runs/<id>/trace.atif.json
node src/cli.ts export otlp           # needs LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
```

An agent is a name for how work gets done: it `runs` on `claude`, `codex`, `pi` or `lead`, with an optional
`model` and standing `instructions` added to every brief it gets. The built-in agents `claude`, `codex`, `pi`
and `lead` need no definition; a node's `model` overrides its agent's. Workers run with full permissions in the
workspace (see the design's harness facts).

```bash
npm install          # the lead runner's Pi packages and the type checker
npm run check        # type check and tests; MURM_LIVE=1 adds real Claude, Codex, Pi and lead runs
```
