# Changelog

Releases of `@krimvp/sous`. Each release is a PR titled "Release x.y.z" and a `vx.y.z` git tag on its merge commit.
Add changes under Unreleased as they merge; the release PR renames that heading.

## Unreleased

- A worker harness that exits with an error before ending its turn is explained: the last lines of its stderr and the
  path of its `.err` file are in the turn's error and the node's failure reason, and a turn that wrote no output fails
  its node at once instead of spending a reminder turn. `docs/harnesses.md` lists the known Claude causes (#87).
- `sous status` and `sous ui` show each running turn's age and when its output last grew; a turn without output for
  10 minutes is reported once as `turn.stalled`, a warning that changes nothing (#100).
- Git-mode workers are told their worktree's branch and that sous commits for them; a worker that leaves its branch
  fails its node instead of having its work committed where it is never merged (#101).

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
