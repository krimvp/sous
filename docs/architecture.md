# sous architecture

This is the code map. It says where each part of sous lives in `src/`, what may depend on what, and which files to
touch for a given change. Read [the design](design.md) first: it says what sous does and why. This document says where
the code does it.

**Contents:** [The shape](#the-shape) · [The module rule](#the-module-rule) · [The modules](#the-modules) ·
[A run through the code](#a-run-through-the-code) · [Where to change what](#where-to-change-what) · [Tests](#tests)

## The shape

`src/` holds two programs, `self.ts` and thirteen module directories. Node runs the `.ts` files directly.

```
src/
  cli.ts          the sous program: gives the adapters and the lead runner to cli/
  mcp.ts          sous's MCP server for one worker turn: the tools send and receive
  self.ts         this copy of sous: its version, and the paths of the two programs
  contracts/      the types and constants that every boundary shares
  definitions/    agents, graph files and agents files: read and checked, nothing run
  run/            a run as data: the event log, the lock, command files, and the fold into state
  workspace/      git worktrees, branches and merges; node folders, and collecting them
  commands/       whether a person's command applies; a worker's send and receive
  prompts/        every text sous writes for a model, by audience
  supervisor/     the only writer of a run: runs the tree, every process and every merge
  adapters/       one worker adapter per harness: start, resume, parse
  lead/           the lead runner on pi-durable, and the lead model providers
  trace/          a run read into per-node views, and exported as ATIF or to Langfuse
  ui/             sous ui: a local page that only reads (server.ts, page.html)
  status/         a run's status (RunStatus) as sous status --json and sous wait report it; only reads
  cli/            the sous commands, one file each
```

Each file starts with a comment that says what it owns. Read it before you change the file.

**The package.** `npm run build` (`scripts/build.mjs`, which `npm pack` and `npm publish` run) compiles `src/` to
`dist/` with `tsconfig.build.json`. `dist/` has the same layout as `src/`, with `.ts` imports rewritten to `.js`. The
build copies `src/ui/page.html` to `dist/ui/page.html`, because `tsc` does not emit it. The package's `sous` command
is `dist/cli.js`. `src/self.ts` gives the two programs' paths with the extension of the running file, so a worker's
harness starts `src/mcp.ts` from a clone and `dist/mcp.js` from the package.

## The module rule

Every directory under `src/` is a module, and its `index.ts` is its only interface. A file in one module imports
another module only through that module's `index.ts`, and only when the table below allows it. `self.ts` is a module
of one file. Nothing imports `cli.ts` or `mcp.ts`: they are programs.

| Module | May import |
|---|---|
| `contracts` | nothing |
| `self` | nothing |
| `workspace` | `contracts` |
| `definitions` | `contracts` |
| `run` | `contracts`, `definitions` |
| `commands` | `contracts`, `run` |
| `prompts` | `contracts`, `definitions`, `run`, `self` |
| `trace` | `contracts`, `definitions`, `run`, `self` |
| `adapters` | `contracts`, `self` |
| `lead` | `contracts` |
| `ui` | `contracts`, `run`, `trace` |
| `status` | `contracts`, `run`, `workspace`, `trace` |
| `supervisor` | `contracts`, `definitions`, `run`, `workspace`, `commands`, `prompts` |
| `cli` | `contracts`, `self`, `definitions`, `run`, `workspace`, `commands`, `supervisor`, `trace`, `ui`, `status` |
| `cli.ts` (program) | `cli`, `adapters`, `lead` |
| `mcp.ts` (program) | `contracts`, `run`, `commands`, `self` |

The table is `ALLOWED` in `test/structure.test.ts`, and that test is its source of truth: if this copy and the test
ever differ, the test wins. `npm run check` fails when a directory under `src/` has no `index.ts` or no row, when an
import goes past a module's `index.ts`, when an import is not in the table, or when anything imports a program. The
test reads relative imports only; package imports are not checked.

The table forms layers, the programs at the top. Each module imports only from rows below its own:

```
src/cli.ts (cli, adapters, lead)                    src/mcp.ts (commands, run, contracts, self)
  cli
  supervisor                     ui         status
  prompts       commands         trace
  run
  workspace     definitions      adapters        lead
  contracts     self
```

### Why these boundaries

- **Contracts import nothing.** Every side of a boundary uses the same types, and a contract pulls in no code. A change
  to a contract changes a boundary, so update every side and the design in the same change.
- **The supervisor gets its workers and its leads handed to it.** It imports no adapter, no lead runner, no exporter,
  no UI and no CLI. `SupervisorOptions` (in `supervisor/context.ts`) carries `getAdapter` and `createLeadRunner`, and
  the supervisor sees only the `WorkerAdapter` and `LeadRunner` contracts. Tests run the real supervisor with the fakes
  in `test/helpers/`.
- **The CLI gets the adapters and the lead runner from the program.** `CliDeps` (`cli/deps.ts`) names what
  `src/cli.ts` gives `main`. `src/cli.ts` is the only file that imports `adapters` and `lead`; it imports them only
  when it runs as the program. `test/helpers/sous-fake.ts` runs the same `main` with the fake adapter and the scripted
  lead runner.
- **Only `lead/` uses the Pi packages** (`@earendil-works/pi-durable`, `pi-ai`, `chord`), the only runtime
  dependencies. It imports only `contracts`. `git grep earendil-works src` lists `lead/` files only.
- **Workers and the person reach the supervisor through command files.** `commands/` decides whether a command
  applies. The CLI and `src/mcp.ts` check a command with it before they write the file, and the supervisor checks it
  again when it reads the file. Only the supervisor appends to the log of a running run.
- **Traces, status and the UI only read.** `trace/`, `status/` and `ui/` read the log with `run/`'s reader and fold it with `run/`'s fold,
  the same ones the supervisor uses.

## The modules

Each entry gives what the module owns, the notable exports of its `index.ts`, and what it must not do.

### contracts

The shared types, and the lists and limits that more than one side needs. It has no logic beyond small helpers
(`roleNode`, `withoutIdentity`, `leadCredentialFix`). `index.ts` re-exports every file:

- `nodes.ts`: `NodeKind`, `NodeSpec`, the reserved IDs (`ROOT`, `PERSON`, `INTEGRATOR`), `ROLES`, `SPLITTER`,
  `roleNode`, `DEFAULT_MAX_LEAD_DEPTH`.
- `agents.ts`: `RUNTIMES`, `AgentSpec`, `BUILTIN_AGENTS`, `WORKER_AGENT_PREFERENCE`, `INTEGRATOR_AGENT_PREFERENCE`,
  `DEFAULT_WORKER_MODELS`, `HARNESS_DEFAULT_MODEL`, `Definitions`, `GraphFile`, `LEAD_PROVIDERS`, `DEFAULT_LEAD_MODEL`.
- `workers.ts`: `HARNESSES`, `LEAD_HARNESSES` (the harnesses certified to lead), `TurnResult` and `TURN_RESULT_SCHEMA`,
  `Usage`, `TraceItem`, `ParsedTurn`, `TurnSpec`, `LeadTurnSpec` (a lead's turn on a harness), `RunningTurn`,
  `WorkerAdapter`, `withoutIdentity` (the environment without any `SOUS_*` variable).
- `leads.ts`: `CHILD_KINDS`, `MAX_CHILDREN`, `MAX_ENTRIES`, `MAX_READ`, `ChildSpec`, `NewAgent`, `LeadCall`,
  `LeadResult` and `LEAD_RESULT_SCHEMA` (how a lead's turn on a harness ends), `LeadRead`, `LeadHost`, `LeadRunner`,
  `CreateLeadRunner`, and `LEAD_SPLIT_RULE` and `LEAD_RULES`, the rules of a lead's role that both the lead runner's
  system prompt (`lead/tools.ts`) and a harness lead's (`prompts/lead.ts`) state.
- `events.ts`: `EventBody`, one variant per event, and `Event` (with `seq` and `at`); `RunMode`.
- `commands.ts`: `Command`, the command-file shape, and `PersonCommand`.
- `status.ts`: `NodeStatus`, `RunLiveness`, `RunStatus` (`sous status --json`) with `StatusNode` and `StatusAsk`,
  `WAIT_EXIT_CODES`, `WaitReason` and `RunWait` (`sous wait --json`).

### self

`SOUS_VERSION` (from `package.json`), `CLI_PROGRAM` and `MCP_PROGRAM`. The prompts use `CLI_PROGRAM` in the
`sous send` command a worker's brief gives; the adapters start `MCP_PROGRAM` as sous's MCP server.

### definitions

What a run is made of before it starts. `agents.ts` resolves agents and availability (`agentFor`, `checkAgents`,
`whyUnavailable`, `startAgents`, `childAgents`, `integratorAgent`, `roleChoices`, `defineAgent`; where leads run and the
models nodes run on: `leadsOn`, `leadRuntimeError`, `workerModel`, `agentModel`); `graph.ts` loads and
checks graph files and agents files (`loadGraph`, `loadDefinitions`, `validateGraph`) and lead children (`childError`).
It reads and checks; it runs nothing.

### run

A run as data. `log.ts` owns `events.jsonl` and the lock: `openLog` takes the lock and appends (one `fsync` per
event), `readEvents` reads, `lockHolder` says whether a live supervisor holds the run (`liveStatus`: a run not over without one is `stopped`),
`writeCommand` writes a command
file, `listRuns` lists a workspace's runs. `state.ts` is `fold`, a pure function from the events to `RunState`, with
helpers over it (`isFinal`, `childrenOf`, `ancestors`, `roleAgent`, `childNode`), and the cost budget's rules
(`turnCost`, the one rule for a turn's cost; `overBudget`, `usd`, `budgetResume`, `budgetRefusal`). The CLI opens a new run's log to write
its first events (`run.created`, `node.added`) before the supervisor starts; after that only the supervisor appends.

### workspace

Where work happens and results gather. `git.ts` runs the `git` CLI: the integration worktree (`createIntegration`), node
worktrees (`createNodeWorktree`), `commitAll`, `merge`, `resetTo`, `changedFiles`, `withConflictMarkers`, `repoRoot`,
`repoState`, and for `sous diff` and `sous clean` `branchExists`, `commitsNotIn`, `worktreePaths`, `removeWorktree`,
`pruneWorktrees`, `deleteBranch` and `showDiff`. `files.ts` collects a folder-mode node's files (`collect`), makes a
node's folder with its links (`linkedFolder`), gives the leads' read-only look (`listFiles`, `readText`), and lists a
folder's files (`filesIn`). It reads no events and writes none.

### commands

What the person and the workers ask of a running supervisor. `person.ts` has `commandRefusal`: whether an answer,
approval or cancel applies to the run as it is. `worker.ts` has `workerSend` and `workerReceive` (each writes a command
file), `sendRefusal`, `sendTargets` and the limits `MAX_SENDS` and `MAX_WAIT_SECONDS`. It never appends to the log.

### prompts

Every text sous writes for a model, by audience: `worker.ts` (`composeBrief`, `inboxPrompt`, `recoveryPrompt`,
`resultReminder`, `fixPrompt`), `lead.ts` (`leadBrief`, `outcomeText`, `leadMessageText`, `idleReminder`,
`retryPrompt`, `splitApproval`, and for a lead on a CLI harness its role `HARNESS_LEAD_ROLE` and `leadTurnPrompt`), `integrator.ts` (`INTEGRATOR_BRIEF`, `integratorPrompt`, `mergeRequest`), `splitter.ts`
(`SPLITTER_BRIEF`, `splitterPrompt`, `splitRequest`), and `shared.ts` for pieces that several audiences use. The texts
are harness-neutral and are functions of state; how a harness must give its result is the adapter's
(`RESULT_INSTRUCTION` in `adapters/common.ts`). The lead runner's system prompt and tool descriptions are in `lead/tools.ts`.

### supervisor

The only writer of a run's state. `index.ts` exports `runSupervisor`, `SupervisorOptions`, `SupervisorOutcome` and
`stopGroup`. It is one file per concern around a shared `Context`:

| File | What it owns |
|---|---|
| `supervisor.ts` | `runSupervisor`: opens the log, builds the context, calls `recover` on `sous resume`, then the main loop (read commands, stop at the budget, stop what must stop, end the run, route leads and gates, start the turns of leads on a CLI harness, merges, splits, work and checks, wait). Ctrl-C and its `finally` stop every process group. |
| `context.ts` | `SupervisorOptions`, `Context` and `createContext`, with `stop` (stop every group, record the running turns as interrupted) and `checkBudget` (record `budget.reached` and stop once the reported cost reaches the run's budget); `SUPERVISOR`, the sender of the integrator's and the splitter's requests. |
| `processes.ts` | Process groups: `createProcesses` (the live groups, `terminate`, `runCommand` for checks), `stopGroup`, `turnAlive`, `stderrTail`. |
| `policy.ts` | What a lead may do: `refusal` and `accepted` for each tool call, and the `notesFor` and `depthOf` a brief states. Pure functions of `RunState`. |
| `commands.ts` | `readCommands`: applies each command file once, checked again against the run as it is. |
| `turns.ts` | `runTurn` (one worker turn through its adapter, or a lead's turn on a CLI harness: start, session, stall, end, then `checkBudget`), `check` (one command), `ask` (a worker's question to its parent), `MAX_RECOVERIES`, `resumable` (the session a node's next turn resumes: its last established one, else none, and the messages the turns after it took) with `established`. |
| `leads.ts` | `createLeads`: the `LeadHost` given to the runner, `routeLead` (brief, messages, outcomes, retries, reminders; what needs no answer is held and goes out coalesced with the next delivery), deliveries, `driveLead` (the turns of a lead on a CLI harness, with `settleLead` applying each turn's calls and `refusedCall`), abandoning a lead, `cancelInRunner`. Owns the runner. |
| `work.ts` | `runWork`: a work node's life (turns, messages, result reminders, recoveries, its acceptance check, queueing it to merge); `runCheckNode`. |
| `merge.ts` | `mergeNext`: the merge queue (git mode) or collecting (folder mode), the check after a clean merge, and the integrator. |
| `split.ts` | `createSplitter`: `splitNext` runs a splitter's standing node until it writes a valid proposal; `splitFor` maps each splitter turn to its lead. |
| `recover.ts` | `recover`: on `sous resume`, closes the turns a stopped supervisor left open (a lead's with its lead result), stops again if they reached the budget, undoes merges of nodes cancelled mid-merge, sends unsent questions, resumes the lead runner and delivers again what it did not answer. |

**The context.** `createContext(opts, log)` builds one `Context` per run: the resolved options (`workspace`, `runDir`,
`runId`, `getAdapter`, `unavailable`, `graceMs`, `stallMs`), the `log`, `commandsDir`, `folder` (folder mode), the
`stopping`, `closed` and `budgetStop` flags, `stop` and `checkBudget`, `wakeUp` (wakes the main loop), `processes`, and helpers: `current()` (the fold of the
log, computed on each call), `nodeNow`, `agentOf`, `complete`, `fail`, `nodeFolder`, `integrationTree` and
`resultsDir`. A concern is plain functions that take the context (`runWork(ctx, spec)`, `mergeNext(ctx)`). A concern
that keeps state of its own is a factory: `createLeads(ctx, createLeadRunner)` keeps the runner and the leads it
abandoned or cancelled; `createSplitter(ctx)` keeps `splitFor`. Read `ctx.stopping` after every `await`.

**Import order.** Within the module each file imports only files earlier in this order, so there are no cycles:
`processes`, `policy`; `context`; `commands`, `turns`; `leads`, `work`, `merge`, `split`; `recover`; `supervisor`. The
structure test does not check this order.

The supervisor must not import adapters, the lead runner, the exporters, the UI or the CLI, and must not print: what
the person sees goes through `onEvent`.

### adapters

One adapter per harness (`claude.ts`, `codex.ts`, `pi.ts`, `droid.ts`), each a `WorkerAdapter`. `common.ts` has what
they share: `spawnTurn` (a process group of its own, stdout and stderr to the turn's files, the environment without
`SOUS_*` plus the turn's identity), `sousServer`, the JSON-line readers, `resultFromText`, and for a lead mode
(`WorkerAdapter.lead`, `TurnSpec.lead`) `toLeadResult`, `leadFromText` and `strictSchema`. `index.ts` exports
`getAdapter` and `listCodexServers`. Only `src/cli.ts` imports it.

### lead

The lead runner. `runner.ts` (`openLeadRunner`) keeps one pi-durable conversation per lead on JSONL storage in
`<runDir>/leads/<node>/`. `tools.ts` (`leadExtension`) is the lead's tools and system prompt; each tool calls the
`LeadHost`. `providers.ts` gives model access from the environment or the Pi login. `index.ts` exports
`createLeadRunner`, `leadCredential` and `loginProblem`. It never writes the run's log: it reports through the host.

### trace

A run read into views and exported. `run.ts` has `loadRun` (the log and the turn files, parsed with the harness's
`parse`), `viewRun` (per-node views, each turn's cost by `turnCost`), `usagesOf`, and the totals `tokensOf`,
`runTokens` and `logView` (a run's view from its log alone). `atif.ts` and `otlp.ts` turn a loaded run into ATIF or OTLP JSON
(`toAtif`, `toOtlp`); `index.ts` exports `exportAtif` (returns the document) and `exportOtlp` (posts it). It takes a
`ParseTurn` function instead of importing the adapters.

### ui

`server.ts` (`startUi`) serves `page.html` and a JSON API on `127.0.0.1`, built from `fold` and `viewRun` with one
reading of the log per request. It only reads.

### status

A run's status as `sous status --json` and `sous wait` report it. `status.ts` has `runStatus` (a `RunStatus` from the
fold, the lock, the running turns' output files and the command files not yet applied), `waitRun` (polls it until the
run needs the person or is over), and the parts `sous run` prints at its end: `resultOf`, `runUsage`, `budgetOf`,
`nextSteps`. It only reads; the CLI renders it (`cli/status.ts`, `cli/wait.ts`).

### cli

The sous commands. `index.ts` exports `main` and `CliDeps`.

| File | What it owns |
|---|---|
| `main.ts` | `main(argv, deps)`: parses the options (refusing an option on a command it is not for) and runs one command; `sous send` and `sous receive` skip the parser, and `sous ui` calls `startUi` here. |
| `usage.ts` | `USAGE`, `usageOf` (one command's lines), `usageError` (exit code 2). |
| `run.ts` | `run` and `resumeRun`: check the agents, create the run directory and its first events, run the supervisor with the printer, print the result, the usage, the budget and the next steps; `--max-cost`; `repoWorkspace`, `announceRoot`. |
| `status.ts` | `status` (text, or `--json`), `runs`, and the text of a `RunStatus` and its parts (`statusText`, `waitingLines`, `resultText`, `usageText`, `budgetText`), which `run.ts` and `wait.ts` use too. |
| `wait.ts` | `wait`: `sous wait`, its text and its exit code. |
| `diff.ts` | `diff`: `sous diff`. |
| `clean.ts` | `clean`: `sous clean`, removing what a finished run's log records creating. |
| `lookup.ts` | `findRun`, `runningRun`, `runRef`. |
| `person.ts` | `sendCommand`: `sous answer`, `approve` and `cancel` as command files. |
| `worker.ts` | `worker`: `sous send` and `sous receive`. |
| `export.ts` | `exportRun`: `sous export atif` and `otlp`. |
| `events.ts` | `printer`: one line per event, and every request for the person with the command that answers it. |
| `text.ts` | One-line text helpers. |
| `doctor.ts` | `doctor`: `sous doctor`. |
| `deps.ts` | `CliDeps`. |

## A run through the code

`sous run "goal"`, step by step:

1. **The program.** `src/cli.ts` imports `adapters` and `lead` and calls `main(argv, deps)` (`cli/main.ts`), which
   finds the workspace (`repoWorkspace`) and calls `run` (`cli/run.ts`).
2. **The run.** `run` turns the goal into a graph with one `lead` node, checks the agents (`checkAgents`,
   `unusableNodeAgents`), creates `.sous/runs/<id>/` with `run.json`, decides the mode (`inWorkTree`), and appends
   `run.created` and `node.added` with `openLog`. It closes the log and calls `runSupervisor` with `deps.getAdapter`,
   `deps.createLeadRunner` and `printer` as `onEvent`.
3. **The supervisor starts.** `runSupervisor` (`supervisor/supervisor.ts`) opens the log again, which takes the lock,
   builds the `Context`, and calls `createLeads` (which calls `createLeadRunner`, here `openLeadRunner` in
   `lead/runner.ts`) and `createSplitter`. Each pass of the main loop runs `readCommands` and folds the log with
   `current()`.
4. **A lead delivery.** `routeLead` (`supervisor/leads.ts`) composes the lead's brief with `leadBrief`
   (`prompts/lead.ts`), appends `lead.delivered`, and calls `runner.deliver`.
5. **A spawn.** The model calls `spawn`. The tool in `leadExtension` (`lead/tools.ts`) calls `host.act`, which checks
   the call with `refusal` (`supervisor/policy.ts`) and appends `lead.call` with the result from `accepted`. The fold
   (`fold` in `run/state.ts`, case `lead.call`) adds the children; nothing else is needed. When the model answers, the
   runner calls `host.settled`, which appends `lead.turn`.
6. **A worker turn.** The main loop starts a ready work child with `runWork` (`supervisor/work.ts`). In git mode it
   creates the node's worktree (`createNodeWorktree`), composes the brief (`composeBrief`) and calls `runTurn`
   (`supervisor/turns.ts`). `runTurn` calls the adapter's `start` (for example `claude` in `adapters/claude.ts`, which
   uses `spawnTurn` and `sousServer` from `adapters/common.ts`), appends `turn.started`, watches the output file, and
   when the process exits appends `turn.ended` with what `parse` read.
7. **The merge.** After a `done` result, `runWork` runs the node's acceptance check if it has one (`check`), commits
   the worktree (`commitAll`) and appends `merge.queued`. The main loop calls `mergeNext` (`supervisor/merge.ts`), which
   merges the branch into the integration worktree (`merge` in `workspace/git.ts`), runs the check again there, and
   appends `merge.done`. The fold completes the node.
8. **The outcome.** On the next pass `routeLead` delivers the child's outcome (`outcomeText`). The lead calls
   `complete`, and the fold completes it.
9. **The end.** With every top-level node final and nothing in flight, the main loop appends `run.completed` and
   returns `'completed'`. The `finally` stops what still runs and closes the runner and the log. `run` prints the
   result (`printEnd`) and `main` returns exit code 0.

**Commands from outside.** `sous answer <node> "text"` runs `sendCommand` (`cli/person.ts`): it checks the answer with
`commandRefusal`, then `writeCommand` puts a file in `<runDir>/commands/`. A worker's `sous send` runs `worker`
(`cli/worker.ts`) and `workerSend` (`commands/worker.ts`); its MCP tool `send` runs the same `workerSend` in
`src/mcp.ts`. The supervisor's `readCommands` (`supervisor/commands.ts`) applies each file once, in each pass of the
main loop and after each worker turn, and appends the event (a `message`, `node.completed`, `node.cancelled`,
`inbox.read` or `command.refused`) before it removes the file.

**Resume.** `sous resume` runs `resumeRun` (`cli/run.ts`), and `runSupervisor` with `resume: true` takes over the lock
and calls `recover` (`supervisor/recover.ts`) before the main loop.

## Where to change what

**A CLI command.** Add `src/cli/<command>.ts` with its header comment. Add a `case` to `main` in `cli/main.ts`, and any
new option to its `parseArgs` call. Add its line to `USAGE` in `cli/usage.ts` in the form of the others, so that
`sous <command> --help` finds it (`usageOf` picks the lines that start with the command). Document it in the command table
of [usage.md](usage.md#commands) and in `.agents/skills/sous/REFERENCE.md`. Test it through a real `sous` process
(`test/helpers/sous-proc.ts`).

**An event.** Add its variant to `EventBody` in `contracts/events.ts`, with a comment. Append it where the supervisor
decides it. If it changes state, handle it in `fold` (`run/state.ts`). Give it a line in the printer
(`cli/events.ts`): the type checker requires every event there. Add it to the traces where it belongs (`trace/run.ts`,
`trace/atif.ts`, `trace/otlp.ts`) and to the UI's event list (`ui/page.html`). Describe it in the design, and in
REFERENCE.md's events when a person would look for it.

**A lead tool.** Add the variant to `LeadCall` (or `LeadRead` for a read) in `contracts/leads.ts`. In `lead/tools.ts`
add its schema and its description. Check it in `refusal` and phrase its result in `accepted` (`supervisor/policy.ts`),
and apply its effect in the `lead.call` case of `fold`. The type checker asks for the schema, the description and the
result. Show it in `trace/run.ts` and the UI (`ui/page.html`) if it has an effect there. Add it to the design's tools
table and, if leads should be told when to use it, to the system prompt in `lead/tools.ts` or the brief
(`prompts/lead.ts`).

**A prompt.** Change the file of its audience in `src/prompts/` and export new functions from `prompts/index.ts`. A
lead's system prompt and tool descriptions are in `lead/tools.ts`; how a worker gives its result is in the adapters
(`RESULT_INSTRUCTION` in `adapters/common.ts`, `TURN_RESULT_SCHEMA` in `contracts/workers.ts`). Tests that assert parts
of the text fail where it changed.

**A harness.** Write the adapter in `src/adapters/`, register it in `adapters/index.ts`, and add its name to
`HARNESSES` (`contracts/workers.ts`) and the preference lists (`contracts/agents.ts`). The certification steps are in
[harnesses.md](harnesses.md#adding-a-harness).

**A module, or a dependency between modules.** A new directory under `src/` needs an `index.ts` with a header comment
and a row in `ALLOWED` in `test/structure.test.ts`. A new import between modules needs its entry in that row. Change
the table here in the same change. Keep the layers: a module never imports one above it.

## Tests

- `test/*.test.ts`: one file per behaviour (`supervisor`, `merge`, `split`, `send`, `resume`, `folder`, `ui`,
  `cli-usage`, `trace-atif`, and so on). They test through real processes and real files: `sous` itself or the real
  supervisor, real git repositories, and fake harnesses that run as processes.
- `test/helpers/`: the fakes and helper programs: `fake-adapter.ts` and `fake-worker.ts` (a scripted harness),
  `fake-lead.ts` (a scripted lead runner), `sous-fake.ts` (`sous` with both), `sous-proc.ts`, `crash-supervisor.ts`,
  `lead-proc.ts`, `git-repo.ts`, `atif-checker.ts` and others.
- `test/fixtures/`: recorded data only (harness output, finished runs). `test/fixtures/conformance/<harness>/` holds the
  conformance recordings and `certified.json`; `test/conformance/harnesses.ts` holds each harness's entry.
- `test/structure.test.ts`: the module rule above.

`npm run check` runs the type checker and every test file; the live tests skip themselves there. `npm run test:quick`
runs a few fast files (parsers, agents, graphs, git, traces and the structure test, about 2 seconds); it runs `git`
and a local HTTP server, starts no `sous` process, and does not replace `check`. `SOUS_LIVE=1` adds a run with a real
lead model, and `npm run certify` certifies a harness with its real CLI; both cost money. The commands are in
[CONTRIBUTING.md](../CONTRIBUTING.md#build-and-test).

Tests import a module through its `index.ts`. A test may import a file inside a module when it must reach what the
interface does not export, as the trace tests do with `toAtif` and `toOtlp`, and the lead tests with `openLeadRunner`.
