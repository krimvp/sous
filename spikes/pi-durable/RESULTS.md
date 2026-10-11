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
| faux (scripted) | 3 | pass: `a`, `b`, `c` each spawned once |
| `openai-codex/gpt-5.5` | 1 + 4 after the fix below | 5 of 5 pass; 1 earlier fail, explained below |
| `ollama-cloud/glm-5.3` | 2 | pass; the first run's "goal submitted once" check was wrong (finding 5) |
| `ollama-cloud/deepseek-v4.1-flash` | 3 | 3 of 3 pass |

`run.sh` asserts each step and exits non-zero on failure: the first process was SIGKILLed with exactly 2
spawns done, the resume exited 0 with the run `done`, it made 2 spawn calls (the replay of `b` and the new
`c`), the goal was submitted once, and no child or call ID appears twice. (The last real run and the faux
runs used this asserting version; earlier runs printed the same facts without asserting them.)

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
5. **Ollama Cloud works through pi-ai** with a provider defined in the spike (`createProvider`, the OpenAI
   completions API at `https://ollama.com/v1`, the `ollama-cloud` API key from the Pi login); pi-ai has no
   built-in one. glm-5.3's thinking quoted the goal, so counting the goal text in storage overcounted;
   the check now counts `pi.user` entries.
6. **Pi updated to 1.1.0** (2026-10-11) in the user npm prefix (`~/.npm-global`), which comes first in PATH;
   the root-owned 0.80.6 in `/usr/lib` is untouched. Murmuration's Pi adapter live test passes on 1.1.0.

## Run it

```bash
cd spikes/pi-durable && npm install
./run.sh faux     # no model needed, but ~/.pi/agent/auth.json must exist
./run.sh real     # uses your Pi login for openai-codex
./run.sh ollama:deepseek-v4.1-flash   # uses your Pi login for ollama-cloud
```
