# Harnesses

A harness is the coding-agent CLI a worker runs on. sous starts it for each turn in the worker's own git worktree,
reads its output, and resumes its session when messages arrive. Four harnesses are built in; each is an agent of the
same name (`claude`, `codex`, `pi`, `droid`), available when its CLI is on your `PATH` and logged in.

| Harness | CLI | Login | Messages between workers | Certified |
|---|---|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude` | your Claude login | sous's MCP tools `send` and `receive` | 2.1.296, 2026-10-12 |
| [Codex](https://github.com/openai/codex) | `codex` | your ChatGPT or API login | sous's MCP tools `send` and `receive` | 0.160.0, 2026-10-12 |
| [Pi](https://github.com/earendil-works/pi) | `pi` | your Pi login (leads use it too) | the commands `sous send` and `sous receive` | 1.1.0, 2026-10-12 |
| [Factory Droid](https://docs.factory.ai/cli/getting-started/overview) | `droid` | your Factory login, or a custom model in your Droid settings | sous's MCP tools `send` and `receive` | 0.210.0, 2026-10-12 |

A work node that names no agent runs on the first available of Claude Code, Codex, Pi, Droid. The integrator, which
resolves merge conflicts, prefers Codex, then Claude Code, Pi, Droid. Name a harness, or a model on it, in an agents
file (`sous run --agents agents.json "…"`) or a graph file:

```json
{ "agents": { "fast": { "runs": "droid", "model": "claude-sonnet-5" } }, "agent": "fast" }
```

Without a `model`, a harness uses the one its own settings choose.

## What every harness guarantees

Each harness passes the same conformance suite before it is merged
([design: Harness conformance](design.md#harness-conformance)). In a live certification with the real CLI it must:

- read a file with a tool and end with a structured result: done, blocked, or a question for its lead;
- resume its session twice and still remember the first turn;
- stop cleanly mid-command when sous stops it, leaving nothing running, and resume afterwards;
- survive being killed mid-command, and resume;
- let two workers tell each other a file name through sous while they work;
- start no MCP server that the project configures;
- finish a run that `sous resume` takes over after the supervisor was killed.

Run it yourself (it costs model usage): `SOUS_HARNESS=droid npm run certify`.

## What sous keeps out of workers

Workers talk to the run's other agents only through sous, and get as little of your own setup as each harness allows.
The project's own instructions (`AGENTS.md`, `CLAUDE.md`) still apply.

- **Claude Code:** no MCP server but sous's; none of your user settings, skills, plugins or hooks. It still reads
  `CLAUDE.md` files in the directories above the worktree.
- **Codex:** your MCP servers and the project's are disabled; rules, hooks, apps, plugins and skills are off. Your
  global `~/.codex/AGENTS.md` still loads. Codex records each workspace it runs in as trusted in your
  `~/.codex/config.toml`.
- **Pi:** no MCP, skills, prompt templates or context files, apart from the worktree's own `AGENTS.md` and `CLAUDE.md`.
- **Droid:** your MCP servers and the project's are disabled, hooks are off, and your skills (yours and your plugins')
  are off. Your custom droids, and MCP servers or droids your plugins bring, still load. A resumed turn continues a
  fork of the session, so it works without a Factory login.

Workers run with full permissions in their worktree and still have a shell, your files and your network: this keeps
honest workers inside sous rather than sandboxing them. The details per harness are in the
[design](design.md#worker-messages).

## Adding a harness

1. Write its adapter in `src/adapters/` and add its name to `HARNESSES` in `src/types.ts`.
2. Give it an entry in `test/conformance/harnesses.ts`; the type checker requires one.
3. Record its conformance fixtures and pass certification: `SOUS_HARNESS=<name> SOUS_RECORD=1 npm run certify`, then
   `npm run check`.
4. Add its row to the isolation table and its facts to [the design](design.md), and the certification output to its PR.
