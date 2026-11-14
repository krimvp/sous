# Harnesses

A harness is the coding-agent CLI that a worker runs on. For each turn, sous starts the CLI in the worker's own git
worktree (or folder), reads its output, and resumes its session when messages arrive. Four harnesses are built in.
Each is an agent of the same name (`claude`, `codex`, `pi`, `droid`). An agent is available when its CLI is on your
`PATH`. The CLI must also be logged in, or the nodes it gets fail. `sous doctor` lists each one with its version.

| Harness | CLI | Login | Messages between workers | Certified | Leads |
|---|---|---|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude` | your Claude login | sous's MCP tools `send` and `receive` | 2.1.325, 2026-11-14 | certified (2.1.325 on `haiku`, 2026-11-14) |
| [Codex](https://github.com/openai/codex) | `codex` | your ChatGPT or API login | sous's MCP tools `send` and `receive` | 0.160.0, 2026-10-12 | lead mode, not yet certified |
| [Pi](https://github.com/earendil-works/pi) | `pi` | your Pi login (in-process leads may use it too) | the commands `sous send` and `sous receive` | 1.1.0, 2026-10-12 | no lead mode |
| [Factory Droid](https://docs.factory.ai/cli/getting-started/overview) | `droid` | your Factory login, or a custom model in your Droid settings | sous's MCP tools `send` and `receive` | 0.210.0, 2026-10-12 | no lead mode |

A work node that names no agent runs on the first available of Claude Code, Codex, Pi, Droid. The integrator, which
resolves merge conflicts, prefers Codex, then Claude Code, Pi, Droid. Name a harness, or a model on it, in an agents
file (`sous run --agents agents.json "…"`) or a graph file:

```json
{ "agents": { "fast": { "runs": "droid", "model": "claude-sonnet-5" } }, "agent": "fast" }
```

Without a `model`, a Claude Code worker runs on `haiku`, the model it is certified on, which costs a small part of
Claude's default; `"model": "default"` keeps Claude's own default (the project's settings or Claude's built-in default:
workers leave out your user settings). Codex, Pi and Droid use your own settings: their default model depends on your
login and providers, so sous has no small model it knows to be valid for them. The integrator and splitters keep the
harness's default unless their agent names a model.

## Leads on a harness

A lead can run on a harness too, on its login, so a logged-in Claude Code is all a run needs. With no lead credential
(`OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or a Pi login), the built-in lead runs on the first harness
certified to lead that is on your `PATH`, on its small model (Claude Code: `haiku`); an agents file can also put a lead
there, `{ "agents": { "lead": { "runs": "claude" } } }`. Each lead turn is a turn of the harness that only reads
(Claude Code: its Read, Glob and Grep tools, confined to the run's results, with no project hooks, no MCP server and none
of your settings) and ends with the calls it makes, which sous checks and applies after the turn, as it does for any
lead. A harness leads only once its adapter has a lead mode and its certification passed the lead tests. Codex has a
lead mode (Codex's read-only sandbox, `--output-schema`) that has not been certified yet: `SOUS_HARNESS=codex npm run
certify` runs its lead tests, and on success Codex can join `LEAD_HARNESSES` in `src/contracts/workers.ts` with its `certified.json`.
Pi and Droid have no lead mode, as sous knows no option that keeps them from writing (for Pi, offering only read tools;
for Droid, that `droid exec` at its default autonomy changes nothing). A lead named on a harness that cannot lead is
refused before the run starts.

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

A harness with a lead mode must also, to lead: read files and end a lead turn with valid calls; create and change no
file when asked to; resume a lead's session and remember its earlier turn; run a real `sous run` whose lead splits into
work and a check and completes; and finish one that `sous resume` takes over after the supervisor was killed during a
lead turn, with each spawn recorded once.

Run it yourself (it costs model usage): `SOUS_HARNESS=droid npm run certify`. Certifying Codex adds an entry for each
temporary workspace to your `~/.codex/config.toml`, as every Codex run in a new workspace does.

Every certification run writes `test/fixtures/conformance/<harness>/certified.json`: the output of `<cli> --version`,
the model, the date, and the tests that passed and failed. Commit it with the adapter change it certifies. Claude Code
has this file. For Codex, Pi and Droid, the Certified column above is the only record until their next
certification. `scripts/harness-versions.sh` prints the CLI versions installed on your machine next to the
certified ones. Use it to see when a CLI has a new version that needs a new certification.

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
  and Droid's built-in skills are off. It reads the worktree's `AGENTS.md`. Your custom droids, and MCP servers or droids your plugins bring, still
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

1. Write its adapter in `src/adapters/` and register it in `src/adapters/index.ts`. Add its name to `HARNESSES` in
   `src/contracts/workers.ts`, and to `WORKER_AGENT_PREFERENCE` and `INTEGRATOR_AGENT_PREFERENCE` in
   `src/contracts/agents.ts`. [The code map](architecture.md#adapters) says what an adapter shares with the others.
2. Give it an entry in `test/conformance/harnesses.ts`; the type checker requires one. To let it lead, give its adapter a
   lead mode (`lead: true`, honouring `TurnSpec.lead`: read only, the role, the lead result), set `lead: true` in its
   entry once its lead recording exists, and add it to `LEAD_HARNESSES` (`src/contracts/workers.ts`) with the
   `certified.json` that lists the lead tests as passed.
3. Record its conformance fixtures and pass certification: `SOUS_HARNESS=<name> SOUS_RECORD=1 npm run certify`, then
   `npm run check`.
4. Add its row to the isolation table and its facts to [the design](design.md), and the certification output to its PR.
