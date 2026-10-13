# Changelog

Releases of `@krimvp/sous`. Each release is a PR titled "Release x.y.z" and a `vx.y.z` git tag on its merge commit.
Add changes under Unreleased as they merge; the release PR renames that heading.

## Unreleased

- Supervisor reliability under real conditions: a lead is not reminded or abandoned while a child lead's split awaits
  the person (#88); a check ends when its command exits and what it left running is stopped (#89); the integration
  worktree is reset before each merge and after each check there, and the integrator's verification counts untracked
  files (#90); an error inside the supervisor stops every worker, keeps the run resumable and prints the `sous resume`
  hint, and a second Ctrl-C kills what still runs (#91); a lead delivery the runner could not get answered is retried
  once with the reason and then fails the lead with it, and a settlement the runner cannot report reaches the host as
  unanswered (#92).
- Leads run on Anthropic (`anthropic/claude-haiku-5-5`) and OpenAI (`openai/gpt-6-luna`) models with `ANTHROPIC_API_KEY`
  or `OPENAI_API_KEY`, beside Ollama Cloud and the ChatGPT login through the Pi login. A lead that names no model gets
  the first provider with a credential (Ollama Cloud first, so nothing changes for a person who has it), printed on the
  `agents:` line and kept on resume; a run with no lead credential is refused with what to do. The Anthropic and OpenAI
  leads have not been run live yet, and such a key in the environment also reaches Claude Code and Codex workers.
  `sous doctor` reports each harness on PATH with its version (not its login), the lead credentials and model, and the
  git state, and exits 0 when a run could start (#93, #99).
- CLI: `-h`/`--help`/`help` (also `sous <command> --help`) print the usage and `--version`/`-v` the version; a command line
  sous cannot parse prints one `sous: ...` line before the usage and exits 2; `sous runs` lists the workspace's runs;
  `sous status` shows the first line of a multi-line goal; `sous export otlp` names the URL and cause of a failed post;
  the start-up `agents:` line of a graph without leads lists only the agents the graph uses (#98, #99).
- A run in a git checkout with uncommitted changes warns that workers see `HEAD` only. Started in a subdirectory of a
  repository, a run uses the repository root as its workspace (an explicit `--workspace` is used as given).
- `sous answer`, `approve` and `cancel` take an optional run id (`sous answer <node> "text" [run-id]`); without one
  they go to the run that is running, not the newest run, and with several running they ask for the id (#94).
- A person command the run does not apply (the node finished, a gate not waiting yet, an answer to a check) is recorded
  as `command.refused`, printed by `sous run` and listed by `sous status`, instead of being dropped silently (#95).
- `sous cancel` of the integrator or a splitter is refused with the node to cancel instead, so conflict resolution
  keeps working; a node cancelled while its clean merge is checked is no longer merged (#96).

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
