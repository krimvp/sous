# Changelog

Releases of `@krimvp/sous`. Each release is a PR titled "Release x.y.z" and a `vx.y.z` git tag on its merge commit.
Add changes under Unreleased as they merge; the release PR renames that heading.

## Unreleased

- CLI: `-h`/`--help`/`help` (also `sous <command> --help`) print the usage and `--version`/`-v` the version; a command line
  sous cannot parse prints one `sous: ...` line before the usage and exits 2; `sous runs` lists the workspace's runs;
  `sous status` shows the first line of a multi-line goal; `sous export otlp` names the URL and cause of a failed post;
  the start-up `agents:` line of a graph without leads lists only the agents the graph uses (#98, #99).
- A run in a git checkout with uncommitted changes warns that workers see `HEAD` only. Started in a subdirectory of a
  repository, a run uses the repository root as its workspace (an explicit `--workspace` is used as given).

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
