# Instructions for agents working on sous

Read [docs/design.md](docs/design.md) first. It defines the concepts, boundaries and roadmap.
[CONTRIBUTING.md](CONTRIBUTING.md) gives the commands to build and test.

- **Few dependencies.** Use Node built-ins. Only the lead runner may use the pinned Pi packages
  (`@earendil-works/pi-durable`, `pi-ai`, `chord`). Ask before you add any other package.
- **Keep it small.** Implement the current roadmap step. Add no speculative options, plugins or abstractions.
- **Contracts live in `src/types.ts`.** A change to a contract changes a boundary: update every side and the design in
  the same change.
- **Test behaviour, not internals.** Test observable behaviour at the strongest practical boundary (real processes, real
  files). Do not test private helpers or copied constants. A regression test must fail before its fix.
- **Live checks are separate from unit tests.** Tests that run a real model cost money and run only when asked: the
  live lead run with `SOUS_LIVE=1`, and the harness certification with `npm run certify`. Never add them to
  `npm run check`.
- **A harness merges only when certified.** A new harness, or a change to an adapter, passes the conformance suite
  (`test/conformance/harnesses.ts`; see the design's Harness conformance) and `SOUS_HARNESS=<name> npm run certify`.
  Put its output in the PR, and commit the `certified.json` that the run writes.
- **Done means:** `scripts/pr-check.sh` passes (`npm run check` and `npm pack --dry-run`; `npm install` installs it as
  the pre-push hook). The changed path was run for real when practical. The PR fills in
  [the template](.github/PULL_REQUEST_TEMPLATE.md): issues closed, what changed, the head SHA that pr-check passed on,
  what was verified and what was not. Setting `core.hooksPath` replaces any personal hooks in `.git/hooks`.
- **Review:** every code PR gets one independent review of its exact head by a reviewer that did not write it, posted
  as a GitHub review on the PR (not only a "review fixes" commit). Put its link and the SHA it reviewed in the PR body.
- **Releases and dependencies:** user-visible changes go under "Unreleased" in [CHANGELOG.md](CHANGELOG.md). A release
  PR names the version, and its merge commit is tagged `vX.Y.Z`. Dependencies are exact pins. Look for new
  `@earendil-works/*` releases when you cut a release.
