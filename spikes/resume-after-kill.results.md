# Spike results

Run on 2026-10-11 with Claude Code 2.1.296, Codex 0.160.0, Pi 0.80.6. See docs/design.md, "Harness facts".

```
mid-turn: sleep observed
turn1 exit: 143
session: 3df9cda7-cba8-49aa-b743-232bec523140
turn2 exit: 0
MJTNQSKJ
RESULT claude TERM: PASS (MJTNQSKJ recalled)
mid-turn: sleep observed
turn1 exit: 137
session: 84c613fd-2710-4449-90a3-4925ecff47a4
turn2 exit: 0
KBSUOMYE
RESULT claude KILL: PASS (KBSUOMYE recalled)
mid-turn: sleep observed
turn1 exit: 0
session: 01a129db-3104-7032-b1d0-6b74b93c4422
turn2 exit: 0
VSRDMVCK
RESULT codex TERM: PASS (VSRDMVCK recalled)
mid-turn: sleep observed
turn1 exit: 137
session: 01a129db-59d2-7af2-924c-b0a526d19645
turn2 exit: 0
WNWLWNGF
RESULT codex KILL: PASS (WNWLWNGF recalled)
mid-turn: sleep observed
turn1 exit: 143
session: 427aa424-3c35-450c-8f23-08cd89d0e560
turn2 exit: 0
DQDLGDZN
RESULT pi TERM: PASS (DQDLGDZN recalled)
mid-turn: sleep observed
turn1 exit: 137
session: c2a6b251-a40c-4f44-8383-07cb6514e999
turn2 exit: 0
KOQZSPDE
RESULT pi KILL: PASS (KOQZSPDE recalled)
```

Droid run on 2026-10-12 with Factory Droid 0.210.0 (`--auto medium`, an Ollama Cloud custom model); turn 2 forks the
session. On SIGTERM Droid saw its command killed, started it again, then exited 0 without a `completion` event.

```
mid-turn: sleep observed
turn1 exit: 0
session: 3769fc3e-3bcf-44db-b1fc-b8340d4a047e
turn2 exit: 0
OESNUKHA
RESULT droid TERM: PASS (OESNUKHA recalled)
mid-turn: sleep observed
turn1 exit: 137
session: 915f7d38-5f8c-423f-88cd-8dafee9bf1de
turn2 exit: 0
HOZUJMQY
RESULT droid KILL: PASS (HOZUJMQY recalled)
```
