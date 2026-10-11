# Murmuration

Give it a task, or a set of tasks, and it runs them to completion on your machine with a tree of agents.
Lead agents plan and split the work; workers (Claude Code, Codex, Pi or your own agent) do it; plain code
keeps everything moving, delivers messages between levels, and recovers after a crash.

- **Local only.** One supervisor process per run, state in `.murm/runs/<id>/` as plain files.
- **No runtime dependencies.** Node 22.18 or later runs the TypeScript sources directly.
- **Any worker.** Workers sit behind a small adapter interface and run in turns: a message waits in an
  inbox until the next turn, or interrupts the current one.
- **Portable traces.** Runs export to ATIF trajectories and to Langfuse over OTLP.

Status: design and harness spike done; v0 in progress. Read [docs/design.md](docs/design.md).

```bash
npm install          # type checker only
npm run check        # type check and tests
```
