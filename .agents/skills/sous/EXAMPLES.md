# sous examples

## A goal with cheap workers and a final check

```bash
cat > agents.json <<'EOF'
{ "agent": "pi", "models": { "pi": ["ollama-cloud/glm-5.3", "ollama-cloud/deepseek-v4.1-flash"] } }
EOF
sous run --agents agents.json "Add input validation to src/cli.js with unit tests. Use agent pi for workers. \
Finish with a check that runs: node --test"
```

## Research over many documents (folder mode)

From a folder of documents that is not a git repository, sous collects the workers' files into
`.sous/runs/<id>/output/`:

```bash
cd ~/reports
sous run "Summarise each document here in its own Markdown file, then write overview.md from those summaries. \
Use agent pi for workers. Finish with a check that runs: test -s results/overview.md"
```

## Fixed steps: writer, reviewer, check, approval

```json
{
  "goal": "Add a CHANGELOG.md",
  "agent": "writer",
  "agents": {
    "writer":   { "runs": "pi", "model": "ollama-cloud/glm-5.3", "instructions": "Write plain, short Markdown." },
    "reviewer": { "runs": "codex", "instructions": "Review only. Never edit files; report problems as blocked." }
  },
  "nodes": [
    { "id": "draft",    "kind": "work",  "brief": "Write CHANGELOG.md from the git log, newest first." },
    { "id": "review",   "kind": "work",  "agent": "reviewer", "needs": ["draft"], "brief": "Check CHANGELOG.md against git log." },
    { "id": "lint",     "kind": "check", "needs": ["review"], "command": "test -s CHANGELOG.md" },
    { "id": "sign-off", "kind": "gate",  "needs": ["lint"], "brief": "Approve the changelog." }
  ]
}
```

## Fixed steps around a lead, with limits on what the lead may use

```json
{
  "goal": "Ship a --precision option",
  "agents": {
    "planner": { "runs": "lead", "model": "ollama-cloud/deepseek-v4.1-flash" },
    "senior":  { "runs": "claude", "model": "opus" }
  },
  "models": { "pi": ["ollama-cloud/glm-5.3"], "claude": ["sonnet", "haiku"] },
  "nodes": [
    { "id": "spec",  "kind": "work",  "agent": "senior", "brief": "Write docs/precision.md with the exact behaviour." },
    { "id": "build", "kind": "lead",  "agent": "planner", "needs": ["spec"], "brief": "Implement docs/precision.md with tests." },
    { "id": "tests", "kind": "check", "needs": ["build"], "command": "node --test" },
    { "id": "ship",  "kind": "gate",  "needs": ["tests"], "brief": "Approve merging --precision." }
  ]
}
```

`senior` may use Opus because the person defined it. Inside `build`, the lead may create agents only on `pi`
(glm-5.3) or `claude` (sonnet, haiku), for example:

```json
{ "id": "hr-review", "kind": "work", "brief": "Review the onboarding text.",
  "agent": { "name": "hr", "runs": "claude", "model": "sonnet", "instructions": "You are an HR specialist." } }
```

## A deep decomposition (experiment)

```bash
sous run --max-depth 4 "$(cat goal.md)"
```

with a goal that fixes each level: "depth 1 splits into these four subsystem leads; depth 2 splits into 2–3
module leads; depth 3 into 2–3 function leads; depth 4 spawns one worker on agent pi and one check". Leads
otherwise decompose as they judge best, usually shallower.

## Driving a run from a script or an agent

```bash
$M run graph.json > run.log 2>&1 & pid=$!
until id=$(awk '$1 == "run" { print $2; exit }' run.log) && [ -n "$id" ]; do kill -0 $pid 2>/dev/null || exit 1; sleep 1; done
while :; do
  $M wait "$id" --json --timeout 540 > wait.json
  case $? in
    6) continue ;;                       # timeout: still working
    4) node -e 'for (const a of require("./wait.json").waiting) if (!a.sent) console.log(a.kind, a.node, a.text, a.commands)'
       break ;;                          # decide (or ask the user), run one of the commands, then loop again
    *) break ;;                          # 0 completed, 3 failed, 5 stopped (resume it), 1/2 sous refused
  esac
done
```
