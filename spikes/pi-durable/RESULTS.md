# Spike: a durable lead on pi-durable

Run on 2026-10-11 with `@earendil-works/pi-durable`, `pi-ai` and `chord` 1.1.0 (exact pins), Node 22.23.1.

**Question.** Can a lead run on pi-durable, with an orchestration-only tool, survive a SIGKILL in the middle
of a spawn, and continue after reopening without spawning anything twice?

**Setup** (`lead.ts`, `run.sh`): one root conversation on JSONL storage (`fsync: true`) whose only tool is
`spawn` (`replay: "safe"`). Spawns are written to `spawns.jsonl`, keyed by the model's tool call ID. The
goal asks for three children. The process SIGKILLs itself inside the second spawn, after the effect and
before the tool result is committed. A second process reopens the storage, calls `resume()`, resubmits with
the same `requestId` and waits.

## Results

| Model | Runs | Result |
|---|---|---|
| faux (scripted) | 2 | pass: `a`, `b`, `c` each spawned once |
| `openai-codex/gpt-5.5` | 1 + 3 after the fix below | 4 of 4 pass; 1 earlier fail, explained below |

In every passing run the interrupted spawn of `b` was replayed once, recognised by its call ID, and the lead
continued to `c`. The resubmitted goal reused the existing submission (the goal appears once in storage).

## Findings

1. **A replayed tool call must return exactly what the original returned.** The first version answered a
   replay with "child b already exists". gpt-5.5 took that as a problem and ended with "DONE: a" without
   spawning `c`. Returning the original result ("child b created") fixed it in all later runs.
2. **The ChatGPT login works through pi-ai with read-only credentials.** The spike reads the `openai-codex`
   entry of `~/.pi/agent/auth.json` and refuses to refresh it, because a refresh rotates the refresh token
   Pi itself uses. An expired login is refreshed by running `pi` once. With a ChatGPT account,
   `gpt-5.4-mini` is rejected; `gpt-5.5` and `gpt-5.6-sol` work.
3. **The process stays alive about 5 minutes after `harness.close()`**: an open TCP socket and a timer,
   most likely the provider's keep-alive connection. Measured at 311–313 s in three runs. A long-running
   supervisor is unaffected; a one-shot process exits explicitly.
4. **Footprint:** about 100 packages and 122 MB in `node_modules`, mostly provider SDKs pulled in by pi-ai.
   Requires Node 22.19 or later. The API is marked experimental, so versions are pinned exactly.

## Run it

```bash
cd spikes/pi-durable && npm install
./run.sh faux     # no model needed
./run.sh real     # uses your Pi login for openai-codex
```
