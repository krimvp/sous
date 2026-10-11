#!/usr/bin/env bash
# usage: spikes/pi-durable/run.sh <faux|real|ollama:<model>>
# Run the lead, SIGKILL it inside the 2nd spawn (after its effect), resume, and check that recovery happened:
# the crash left exactly 2 spawns, the resume replayed the interrupted call and finished the run, the goal
# was submitted once, and no child was spawned twice. Exits non-zero on any failed check.
set -u
cd "$(dirname "$0")"
mode=$1 dir=$(mktemp -d)
node lead.ts "$dir" "$mode" run 2 >"$dir/run.out" 2>&1; run_exit=$?
crash_spawns=$(wc -l <"$dir/spawns.jsonl")
node lead.ts "$dir" "$mode" resume >"$dir/resume.out" 2>&1; resume_exit=$?
cat "$dir/resume.out" "$dir/spawns.jsonl"
node -e '
const fs = require("fs")
const [dir, mode, runExit, crashSpawns, resumeExit] = process.argv.slice(1)
const spawns = fs.readFileSync(`${dir}/spawns.jsonl`, "utf8").trim().split("\n").map(JSON.parse)
const resume = JSON.parse(fs.readFileSync(`${dir}/resume.out`, "utf8").split("\n").find((l) => l.startsWith("{")) ?? "{}")
const goals = (fs.readFileSync(`${dir}/main.jsonl`, "utf8").match(/"kind":"pi.user"/g) ?? []).length
const checks = {
  "run was SIGKILLed": runExit === "137",
  "crash left 2 spawns": crashSpawns.trim() === "2",
  "resume exited 0": resumeExit === "0",
  "resumed run is done": resume.status === "done",
  "resume replayed b and spawned c (2 calls)": resume.spawnCallsThisProcess === 2,
  "goal submitted once": goals === 1,
  "3 distinct children, no call twice":
    spawns.length === 3 && new Set(spawns.map((s) => s.id)).size === 3 && new Set(spawns.map((s) => s.callId)).size === 3,
}
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
const pass = Object.values(checks).every(Boolean)
console.log(`RESULT ${mode}: ${pass ? "PASS" : "FAIL"}`)
process.exit(pass ? 0 : 1)' "$dir" "$mode" "$run_exit" "$crash_spawns" "$resume_exit"; status=$?
echo "storage: $dir"
exit $status
