# sous: landing page copy

The visible text of `site/index.html`, in page order. Notes in *italics* are for the builder and are not shown on
the page. *Keep the scene labels (Orders, Sous · head lead, Station lead, Cooks, Brigade board, Check, Bell, You) and
the animated captions as they are in the page.*

## Hero

**sous**
A brigade of AI agents runs your goal to completion, on your machine.

*No paragraph under the scene. Under the scene, keep only this one line:*
Every work part in this order has a check.

## Live ticket (in the scene)

```
ORDER #0143
Add --precision N to the CLI
  1  Parse the --precision flag
  2  Round output to N places
  3  Tests for rounding
  4  Document it in README
  5  Check: node --test passes
  6  Gate: your approval
```

## Read the pass

1. **Tickets.** Your goal, split into parts by the leads.
2. **The sous.** Head lead agent. Plans the order, assigns parts.
3. **Station leads.** Sub-leads, each running its own team.
4. **Cooks.** Worker agents, each in its own git worktree.
5. **Brigade board.** The run's tree, filling in as cooks finish.
6. **Tasting.** Shell command on the merged code; exit 0 passes.
7. **The bell.** Part merged and its check passed: ready for you.
8. **Your hand.** Take branch `sous/<run-id>`. Merging it is your call.

*"How a service runs" is merged into this key and the live ticket. The scene already plays the sequence
(ticket, sous, station, cook, merge, taste, bell, hand). The integrator moved to "Built for a real service",
gates to "What you control", and starting a run to "Get started".*

## How a big order is split

A lead can hand a part to a sub-lead with its own cooks and checks. Leads nest 3 deep by default,
up to 8 with `--max-depth`.

*Diagram labels, top to bottom:*
- You
- Lead: Build a calculator
- Sub-leads: Parser · Evaluator · CLI
- Under Parser: cook tokenizer · cook grammar · check parser tests
- Beside the sub-leads: check node --test

## What you control

- `--agents agents.json`: your own agents, with model and instructions.
- `"models"` in that file: which models leads may choose.
- `--max-depth <n>`: how deep leads nest, 1–8 (default 3).
- `sous approve`, `answer`, `cancel`: approve gates, reply, cancel subtrees.

## Built for a real service

- `sous resume` continues after a crash without repeating finished turns.
- Merges go one at a time; conflicts go to an integrator agent.
- Exports ATIF and Langfuse traces. No sandbox: workers have full permissions.

## A real service: order #0142

A calculator, built by a tree five levels deep on cheap Ollama models.

| Stat | Label |
|---|---|
| 99 | nodes, 41 of them leads |
| 28 | worker turns |
| 30 | checks |
| 27 | merges, 0 conflicts |
| 166 | tests passing |
| 28:54 | from order to result |

## Get started

Node 22.19+, git, and one harness logged in: Claude Code, Codex, Pi or Droid. Leads use `OLLAMA_API_KEY` or your
Pi login to Anthropic or ChatGPT (an Anthropic or OpenAI key works too, but Claude Code and Codex workers would then
bill it as well).

*"harness" links to docs/harnesses.md on GitHub.*

- `npm install -g @krimvp/sous`: Install the CLI.
- `sous run "goal"`: Start a run inside your git repository.
- `sous status`: See the tree and what waits for you.

## Footer

sous · runs on your machine · harnesses · github.com/krimvp/sous

*"harnesses" links to docs/harnesses.md on GitHub.*

---

## Fact sources

- Leads, sub-leads, depth 3 by default and 1–8 with `--max-depth`: docs/design.md §Leads; src/cli.ts.
- Worktree per worker; merges one at a time; conflicts to the integrator: docs/design.md §Merging 2–4.
- Checks: a shell command, exit 0 passes, check nodes run in the integration worktree: docs/design.md §Node kinds, §Merging 5.
- Bell: a work part completes on `merge.done`; every work part in #0143 has a check (scene note): docs/design.md §Merging 5.
- `--agents`, `models` binds what leads choose: REFERENCE.md §Definitions; docs/design.md §Agents.
- `approve`/`answer`/`cancel`: README; REFERENCE.md §Commands.
- Resume without repeating finished turns: README; SKILL.md step 5; docs/design.md §Recovery.
- ATIF and Langfuse (OTLP) export: docs/design.md §Traces. No sandbox, full permissions: §Out of scope, §Harness facts.
- Requirements and the Pi login for leads: README; package.json `engines`.
- The four harnesses (Claude Code, Codex, Pi, Droid), each certified: `HARNESSES` in src/types.ts; docs/harnesses.md;
  docs/design.md §Harness conformance.
- Order #0142: site/index.html §A real service.
- `@krimvp/sous`: package.json `name`.
