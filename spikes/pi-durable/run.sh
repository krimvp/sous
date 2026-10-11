#!/usr/bin/env bash
# usage: spikes/pi-durable/run.sh <faux|real>
# Run the lead, SIGKILL it inside the 2nd spawn (after its effect), resume, and check no child was spawned twice.
set -u
cd "$(dirname "$0")"
mode=$1 dir=$(mktemp -d)
node lead.ts "$dir" "$mode" run 2 2>&1 | tail -4; echo "run exit: ${PIPESTATUS[0]}"
echo "after crash: $(wc -l <"$dir/spawns.jsonl") spawn(s)"
node lead.ts "$dir" "$mode" resume 2>&1 | tail -4; echo "resume exit: ${PIPESTATUS[0]}"
cat "$dir/spawns.jsonl"
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse)
const ids = lines.map((l) => l.id), calls = lines.map((l) => l.callId)
const ok = new Set(calls).size === calls.length && new Set(ids).size === ids.length && ids.length === 3
console.log(`RESULT ${process.argv[2]}: ${ok ? "PASS" : "FAIL"} (${ids.length} spawns: ${ids.join(",")})`)' "$dir/spawns.jsonl" "$mode"
echo "storage: $dir"
