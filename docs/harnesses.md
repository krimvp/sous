# Harnesses

A harness is the coding-agent CLI a worker runs on. sous starts it for each turn in the worker's own git worktree,
reads its output, and resumes its session when messages arrive. Four harnesses are built in; each is an agent of the
same name (`claude`, `codex`, `pi`, `droid`). An agent counts as available when its CLI is on your `PATH`; the CLI must
also be logged in, or the nodes it gets fail. `sous doctor` lists each one with its version.

| Harness | CLI | Login | Messages between workers | Certified |
|---|---|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude` | your Claude login | sous's MCP tools `send` and `receive` | 2.1.296, 2026-10-12 |
| [Codex](https://github.com/openai/codex) | `codex` | your ChatGPT or API login | sous's MCP tools `send` and `receive` | 0.160.0, 2026-10-12 |
| [Pi](https://github.com/earendil-works/pi) | `pi` | your Pi login (leads may use it too) | the commands `sous send` and `sous receive` | 1.1.0, 2026-10-12 |
| [Factory Droid](https://docs.factory.ai/cli/getting-started/overview) | `droid` | your Factory login, or a custom model in your Droid settings | sous's MCP tools `send` and `receive` | 0.210.0, 2026-10-12 |

A work node that names no agent runs on the first available of Claude Code, Codex, Pi, Droid. The integrator, which
resolves merge conflicts, prefers Codex, then Claude Code, Pi, Droid. Name a harness, or a model on it, in an agents
file (`sous run --agents agents.json "…"`) or a graph file:

```json
{ "agents": { "fast": { "runs": "droid", "model": "claude-sonnet-5" } }, "agent": "fast" }
```

Without a `model`, a harness uses its own default: for Claude Code the project's settings or Claude's built-in default
(workers leave out your user settings), for the others your own settings.

## What every harness guarantees

Every harness passes the same conformance suite, and a new one must pass it before it is merged
([design: Harness conformance](design.md#harness-conformance)). In a live certification with the real CLI it must:

- read a file with a tool and end with a structured result, and end another turn with a question for its lead;
- resume its session twice and still remember the first turn;
- stop cleanly mid-command when sous stops it, leaving nothing running, and resume afterwards;
- survive being killed mid-command, and resume;
- let two workers tell each other a file name through sous while they work;
- start no MCP server that the project configures;
- finish a run that `sous resume` takes over after the supervisor was killed.

Run it yourself (it costs model usage): `SOUS_HARNESS=droid npm run certify`. Certifying Codex adds an entry for each
temporary workspace to your `~/.codex/config.toml`, as every Codex run in a new workspace does.

Every certification run writes `test/fixtures/conformance/<harness>/certified.json`: the output of `<cli> --version`,
the model, the date, and the tests that passed and failed. Commit it with the adapter change it certifies. The next
`npm run certify` for a harness creates its file (none is committed yet, so until then the Certified column above
is the only record). `scripts/harness-versions.sh` prints the CLI versions installed on your machine next to the
certified ones, so you can see when a harness has moved on and needs certifying again.

## What sous keeps out of workers

Workers talk to the run's other agents only through sous, and get as little of your own setup as each harness allows.
The project's own instruction files still apply, as each harness reads them:

- **Claude Code:** no MCP server but sous's; none of your user settings, skills, plugins or hooks; the project's
  settings apply. It reads the project's `CLAUDE.md` and `CLAUDE.local.md`, and those in the directories above the
  worktree, your workspace's included.
- **Codex:** your MCP servers and the project's are disabled; rules, hooks, apps, plugins and skills are off. It reads
  the project's `AGENTS.md`, and your global `~/.codex/AGENTS.md` still loads. A server whose name has a character
  other than letters, digits, `_` and `-` (a dot, a space) is not disabled, nor are your servers when `codex mcp list`
  fails (sous says so on stderr). Codex records each workspace it runs in as trusted in your `~/.codex/config.toml`.
- **Pi:** no MCP, skills, prompt templates or context files, apart from the worktree's own `AGENTS.md` and `CLAUDE.md`,
  which sous passes to it.
- **Droid:** your MCP servers and the project's are disabled, hooks are off, and your skills (yours and your plugins')
  are off. It reads the worktree's `AGENTS.md`. Your custom droids, and MCP servers or droids your plugins bring, still
  load. A resumed turn continues a fork of the session, so it works without a Factory login.

Workers run with full permissions in their worktree and still have a shell, your files and your network: this keeps
honest workers inside sous rather than sandboxing them. The details per harness are in the
[design](design.md#worker-messages).

## When a worker fails at once

A harness that exits with an error before it ends its turn says why on stderr, which sous keeps in
`.sous/runs/<run-id>/nodes/<node>/turn-<k>.err`. The turn's `turn.ended` error, and the node's failure reason in
`sous run`, `sous status` and its lead's outcome, end with the last lines of that file and name it. A turn that wrote
no output at all fails its node at once, since another turn would fail the same way; one that did some work first is
resumed once with a reminder. Known causes with Claude Code, which make every Claude turn exit at once:

- **Not logged in** (`Not logged in · Please run /login`): run `claude` once yourself and log in.
- **Running as root** (a container, `sudo`): Claude refuses `--permission-mode bypassPermissions`, which workers run
  with, unless `IS_SANDBOX=1` is set. Set it in the environment you start `sous` from; workers inherit it.
- **`disableBypassPermissionsMode` in the project's `.claude/settings.json`** (under `permissions`): workers load the
  project's settings (`--setting-sources project`), so they refuse bypass mode too. Run that project's work on another
  harness, or remove the setting.

A worker that hangs without failing is not stopped (there is no turn timeout yet): `sous status` shows how long each
running turn has run and when its output last grew, and a turn without output for 10 minutes is reported once as
`turn.stalled`. A long command a worker waits on is silent too, so look before you cancel it.

## Adding a harness

1. Write its adapter in `src/adapters/` and register it in `src/adapters/index.ts`; add its name to `HARNESSES`, and
   to the worker and integrator preference lists, in `src/types.ts`.
2. Give it an entry in `test/conformance/harnesses.ts`; the type checker requires one.
3. Record its conformance fixtures and pass certification: `SOUS_HARNESS=<name> SOUS_RECORD=1 npm run certify`, then
   `npm run check`.
4. Add its row to the isolation table and its facts to [the design](design.md), and the certification output to its PR.
