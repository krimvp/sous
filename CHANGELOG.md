# Changelog

Releases of `@krimvp/sous`. Each release is a PR titled "Release x.y.z" and a `vx.y.z` git tag on its merge commit.
Add changes under Unreleased as they merge; the release PR renames that heading.

## Unreleased

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
