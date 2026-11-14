# Changelog

Releases of `@krimvp/sous`. Each release is a PR titled "Release x.y.z" and a `vx.y.z` git tag on its merge commit.
Add changes under Unreleased as they merge; the release PR renames that heading.

## Unreleased

- **Changed: Claude Code workers now run on `haiku` by default.** A work node whose agent, node and lead name no model
  used to run on Claude Code's own default (for a person on a top model, the most expensive one); it now runs on
  `haiku`, the model Claude Code is certified on (two workers on one small task: $1.39 before, $0.02 on `haiku`). Codex,
  Pi and Droid workers keep their own default, since theirs depends on your login and settings. An agent's or a node's
  `model`, and a lead's choice from `models`, still win; the integrator and splitters keep the harness's default. **To
  get the old behaviour**, give the agent `"model": "default"`, for the built-in one in an agents file or graph:
  `{ "agents": { "claude": { "runs": "claude", "model": "default" } } }`, or name the model you want. The `agents:`
  line, `sous doctor` (`worker models:`) and a lead's brief show the model each agent's work runs on. A run keeps the
  models it was created with when resumed (`run.created.workerModels`); runs created before this resume on the
  harness's default as before. `turn.started.model` records the model passed.
- `sous run --max-cost <usd>` sets a cost budget: once the cost the run's turns reported reaches it, no new turn
  starts, the running turns are stopped as Ctrl-C stops them (they resume), `budget.reached` is recorded and `sous run`
  ends with the run stopped, the spend and `sous resume <id> --max-cost <usd>`. `sous resume` refuses such a run without
  a higher `--max-cost` (recorded in `run.resumed`). `sous status` (and `status --json`: `budget`, `usage.maxCostUsd`)
  and `sous wait` (exit 5, `stopped`) show it. The budget bounds reported cost only: a cost is known when a turn ends,
  so running turns can overshoot it, and Codex and Droid workers, and leads and Pi workers on Ollama, report none and
  are not counted (`sous run` says so once). There is no turn timeout yet. The budget and the usage totals share one
  rule for Claude's running session cost.

- A resumed Claude Code turn is no longer charged again for the turns before it: Claude's `total_cost_usd` is the
  session's running total, which sous summed per turn (a run that cost $1.39 showed $2.09). Each turn now costs what
  the session's total grew by, in the UI, `sous export` and the CLI; runs recorded before this keep the old figures
  where only the log is read (the UI's run list, `sous status`). `sous status`, and `sous run`/`sous resume` when
  the run ends, print the run's tokens and the cost reported, the same totals the UI shows: `usage: 115,414 tokens in
  (75,142 cached), 2,141 out; $0.73 cost reported (1 turn reported no cost)`.
- `sous status --json` prints a run's status as one JSON document (`RunStatus`: state, result, the node tree with
  running turns' ages, what waits for the person with the commands that answer it, refused commands); the text status
  is rendered from the same structure. `sous wait [run-id] [--timeout <seconds>] [--json]` blocks until the run needs
  the person or is over and exits 0 completed, 3 failed (or completed with failed checks), 4 waits for the person, 5
  stopped (resume needed) or 6 timeout; an ask whose answer was sent but not yet applied does not stop it, so `wait`,
  `answer`, `wait` neither repeats nor spins. `sous status` marks such an ask `(answer sent)`. The skill drives runs
  with `wait` and `status --json` instead of reading the run's output.
- `sous diff [run-id] [--stat]` shows what a run changed (git diff of `sous/<run-id>` from where it started, through
  git's pager; in folder mode, the output files with sizes), and `sous clean [run-id] [--all] [--branches] [--unmerged]
  [--dry-run]` removes a finished run's worktrees and merged node branches (folder mode: its `work/` folders), keeping
  the result branch, the log and any unmerged work, which it lists. It refuses a running or stopped run, deletes only
  what the run's log records creating, and with `--branches` deletes the result branch only once `HEAD` contains it.
  `sous run` and `sous status` end a finished git-mode run with a one-line `next:` hint.
- Fewer lead turns that need no decision: what a worker tells its lead while it works, and the copy of what it tells a
  sibling, no longer wake the lead on their own; they wait for the lead's next delivery that needs it (a child's
  outcome, a question, a message), or go out once no child is working, and the lead still cannot complete before it has
  them. What waits while the lead is answering goes out as one delivery when it is done (an interrupt still steers it at
  once). The run that motivated it, two workers that send and a check, takes four lead turns instead of seven.
  `lead.delivered.carries` names the further items a delivery carries.
- Supervisor reliability under real conditions: a lead is not reminded or abandoned while a child lead's split awaits
  the person (#88); a check ends when its command exits and what it left running is stopped (#89); the integration
  worktree is reset before each merge and after each check there, and the integrator's verification counts untracked
  files (#90); an error inside the supervisor stops every worker, keeps the run resumable and prints the `sous resume`
  hint, and a second Ctrl-C kills what still runs (#91); a lead delivery the runner could not get answered is retried
  once with the reason and then fails the lead with it, and a settlement the runner cannot report reaches the host as
  unanswered (#92).
- Leads run on Anthropic (`anthropic/claude-haiku-5-5`) and OpenAI (`openai/gpt-6-luna`) models with `ANTHROPIC_API_KEY`
  or `OPENAI_API_KEY`, or through the Pi login, beside Ollama Cloud (`OLLAMA_API_KEY`; Pi's login does not cover it)
  and the ChatGPT login in Pi. A lead that names no model gets
  the first provider with a credential (Ollama Cloud first, so nothing changes for a person who has it), printed on the
  `agents:` line and kept on resume; a run with no lead credential is refused with what to do. The Anthropic and OpenAI
  leads have not been run live yet, and such a key in the environment also reaches Claude Code and Codex workers.
  `sous doctor` reports each harness on PATH with its version (not its login), the lead credentials and model, and the
  git state, and exits 0 when a run could start (#93, #99).
- A Pi login with under five minutes left does not count as a lead credential (pi-ai would refresh it, which sous
  cannot); a run from before the lead model was recorded resumes on the fixed default it started on; the README says
  how to install Pi and what its login covers (#126).
- The skill tells a first run what it needs: a lead credential of its own, that workers see `HEAD` only, the cap of 4
  workers at a time, and where a failed turn's stderr is (#112). README, the skill and the design say that workers,
  which run as the person, can forge the person's commands, an approval, an answer or a cancel, until they are
  sandboxed (#106).
- CLI: `-h`/`--help`/`help` (also `sous <command> --help`) print the usage and `--version`/`-v` the version; a command line
  sous cannot parse prints one `sous: ...` line before the usage and exits 2; `sous runs` lists the workspace's runs;
  `sous status` shows the first line of a multi-line goal; `sous export otlp` names the URL and cause of a failed post;
  the start-up `agents:` line of a graph without leads lists only the agents the graph uses (#98, #99).
- A run in a git checkout with uncommitted changes warns that workers see `HEAD` only. Started in a subdirectory of a
  repository, a run uses the repository root as its workspace (an explicit `--workspace` is used as given).
- A worker harness that exits with an error before ending its turn is explained: the last lines of its stderr and the
  path of its `.err` file are in the turn's error and the node's failure reason, and a turn that wrote no output fails
  its node at once instead of spending a reminder turn. `docs/harnesses.md` lists the known Claude causes (#87).
- `sous status` and `sous ui` show each running turn's age and when its output last grew; a turn without output for
  10 minutes is reported once as `turn.stalled`, a warning that changes nothing (#100).
- Git-mode workers are told their worktree's branch and that sous commits for them; a worker that leaves its branch
  fails its node instead of having its work committed where it is never merged (#101).
- `sous answer`, `approve` and `cancel` take an optional run id (`sous answer <node> "text" [run-id]`); without one
  they go to the run that is running, not the newest run, and with several running they ask for the id (#94).
- A person command the run does not apply (the node finished, a gate not waiting yet, an answer to a check) is recorded
  as `command.refused`, printed by `sous run` and listed by `sous status`, instead of being dropped silently (#95).
- `sous cancel` of the integrator or a splitter is refused with the node to cancel instead, so conflict resolution
  keeps working; a node cancelled while its merge runs is no longer merged, also when the run stopped before the
  merge was undone (#96).

## 0.1.1 (2026-10-12)

- Folder mode: without git (or outside a git work tree) a run works in plain folders and collects each work node's files
  into `.sous/runs/<id>/output/` through the merge queue, keeping both files on a name clash. Check nodes run in the
  output folder, and nothing runs git (#74, #85).
- Leads get read-only `list_files` and `read_file` over the workspace and the results so far.
- Lead and worker briefs no longer assume coding or worktrees, and a finished child's outcome names the files it added.

## 0.1.0 (2026-10-12)

- First release on npm as `@krimvp/sous`, MIT licensed (#83).
- The package ships the compiled `dist/`, because Node does not strip types under `node_modules`; `npm pack` and
  `npm publish` build it (`prepack`). From a checkout, `node src/cli.ts` runs the TypeScript sources directly.
- Leads plan and workers do on four harnesses (Claude Code, Codex, Pi, Droid), each certified with its real CLI
  against one conformance suite (#80, #82).
- Runs keep their state in `.sous/runs/<id>/`, resume after a crash, export to ATIF and Langfuse (OTLP), and show in
  a local viewer (`sous ui`).
