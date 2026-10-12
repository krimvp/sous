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
  whose output goes in the PR.
- **Done means:** `npm run check` passes, the changed path was run for real when practical, and the PR says
  what was verified and what was not.
- **Review:** every code PR gets one independent review of its exact head by an agent that did not write it.
