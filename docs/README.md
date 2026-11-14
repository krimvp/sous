# sous documentation

Each document, who it is for, and what it answers.

| Document | For | What it answers |
|---|---|---|
| [README.md](../README.md) | users | How to install sous, start a first run, use every command, and find the result. |
| [design.md](design.md) | contributors, and users who want the details | How sous works and why: concepts, leads, merging, recovery, traces, the storage layout and the roadmap. |
| [harnesses.md](harnesses.md) | users and contributors | Which worker CLIs sous runs, what it keeps out of them, why a worker fails at once, and how to add a harness. |
| [architecture.md](architecture.md) | contributors | The code map: where each part of sous lives in `src/`, which module may import which, how a run passes through the code, and which files a given change touches. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | contributors | How to build, test and send a change. |
| [AGENTS.md](../AGENTS.md) | coding agents that work on sous | The rules for changing this repository. |
| [CHANGELOG.md](../CHANGELOG.md) | users | What changed in each release. |
| [site/](site/README.md) | whoever changes the landing page | How the page at [krimvp.github.io/sous](https://krimvp.github.io/sous/) is changed and published; [COPY.md](site/COPY.md) holds its text and the source of each fact. |
| [.agents/skills/sous/](../.agents/skills/sous/SKILL.md) | coding agents that use sous | How to start, watch, steer and export runs; [REFERENCE.md](../.agents/skills/sous/REFERENCE.md) lists every command, key and file, and [EXAMPLES.md](../.agents/skills/sous/EXAMPLES.md) gives graph and agents files. |
