# Instructions for agents working on sous

Read [docs/design.md](docs/design.md) first. It defines the concepts, boundaries and roadmap.

- **Few dependencies.** Use Node built-ins. The lead runner alone may use the pinned Pi packages
  (`@earendil-works/pi-durable`, `pi-ai`, `chord`). Ask before adding any other package.
- **Keep it small.** Implement the current roadmap slice; no speculative options, plugins or abstractions.
- **Contracts live in `src/types.ts`.** Changing one changes a boundary: update every side and the design in
  the same change.
- **Tests earn their place.** Test observable behaviour at the strongest practical boundary (real processes,
  real files). No tests of private helpers or copied constants. A regression test must fail before its fix.
- **Real harness checks are separate from unit tests.** Tests that run a real model cost money and run only when asked:
  the live lead run with `SOUS_LIVE=1`, the harness certification with `npm run certify` (never in `npm run check`).
- **A harness merges only certified.** A new harness, or a change to an adapter, passes the conformance suite
  (`test/conformance/harnesses.ts`; see the design's Harness conformance) and `SOUS_HARNESS=<name> npm run certify`,
  whose output goes in the PR and whose `certified.json` (written by the run) is committed with the change.
- **Done means:** `scripts/pr-check.sh` passes (`npm run check` and `npm pack --dry-run`; `npm install` installs it as the
  pre-push hook, since GitHub Actions is not available), the changed path was run for real when practical, and the PR
  fills in [the template](.github/PULL_REQUEST_TEMPLATE.md): issues closed, what changed, the head SHA pr-check passed
  on, what was verified and what was not. Setting `core.hooksPath` replaces any personal hooks in `.git/hooks`.
- **Review:** every code PR gets one independent review of its exact head by an agent that did not write it, posted as a
  GitHub review on the PR (not only a "review fixes" commit), with its link and the SHA it reviewed in the PR body.
- **Releases and dependencies:** user-visible changes go under "Unreleased" in [CHANGELOG.md](CHANGELOG.md); a release PR
  names the version and its merge commit is tagged `vX.Y.Z`. Dependencies are exact pins; look for new
  `@earendil-works/*` releases when cutting a release.
