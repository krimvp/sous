# Contributing to sous

Read [docs/design.md](docs/design.md) before you change the code. It defines the concepts, the boundaries and the
roadmap. Agents that work in this repository also follow [AGENTS.md](AGENTS.md).

## Set up

```bash
git clone https://github.com/krimvp/sous.git
cd sous
npm install
```

`npm install` installs the Pi packages that the lead runner uses and the type checker. It also sets
`core.hooksPath` to `.githooks`, which adds a pre-push hook that runs `scripts/pr-check.sh`. After this, hooks in
`.git/hooks` do not run.

## Build and test

| Command | What it does |
|---|---|
| `npm run check` | Type check and all tests. Run it before each push. |
| `npm run test:quick` | Only the fast, pure test files (about 2 seconds). It does not replace `check`. |
| `SOUS_LIVE=1 npm run check` | Adds a run with a real lead model. This costs money. |
| `SOUS_HARNESS=<name> npm run certify` | Certifies one worker CLI against the conformance suite. This costs money. |
| `npm pack` | Builds `dist/` and the package that `npm publish` would upload. |
| `scripts/pr-check.sh` | Runs `npm run check` and `npm pack --dry-run` on `HEAD`. The pre-push hook runs it. |

## Rules for changes

- **Few dependencies.** Use Node built-ins. Only the lead runner uses packages: the pinned
  `@earendil-works/pi-durable`, `pi-ai` and `chord`. Ask before you add a package. Pin each dependency to an exact
  version.
- **Keep it small.** Implement the current roadmap step. Do not add options, plugins or abstractions for a possible
  future need.
- **Contracts are in `src/types.ts`.** A change to a contract changes a boundary. Update every side and the design in
  the same change.
- **Test behaviour, not internals.** Test at the strongest boundary that is practical: real processes and real files.
  Do not test private helpers or copied constants. A regression test must fail before its fix.
- **Keep live tests separate.** Tests that call a real model cost money. They run only when you ask for them, never in
  `npm run check`.
- **Certify worker CLIs.** A new harness, or a change to an adapter, must pass the conformance suite
  (`test/conformance/harnesses.ts`) and `SOUS_HARNESS=<name> npm run certify`. Put the output in the pull request,
  and commit the `certified.json` file that the run writes. See [docs/harnesses.md](docs/harnesses.md#adding-a-harness).

## Pull requests

1. Make sure that `scripts/pr-check.sh` passes on the commit you push.
2. Run the changed path for real when it is practical.
3. Fill in every section of [the template](.github/PULL_REQUEST_TEMPLATE.md): the issues it closes, what changed,
   the head SHA that pr-check passed on, and what you verified and did not verify.
4. Add each change that users can see under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

Each code pull request gets one independent review of its exact head commit. The reviewer, a person or an agent, did
not write the change and posts the review on the pull request.

## Releases

A release pull request names the version and renames the "Unreleased" heading in the changelog. Its merge commit gets
the tag `vX.Y.Z`. Before a release, look for new `@earendil-works/*` versions.
