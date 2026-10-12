#!/usr/bin/env bash
# Spike: can each harness resume a session after its process is stopped mid-turn?
# Usage: spikes/resume-after-kill.sh <claude|codex|pi|droid> <TERM|KILL>
# Turn 1 learns a codeword, then runs a long sleep; we signal it during the sleep.
# Turn 2 resumes the same session (Droid: forks it) and must recall the codeword.
set -u
harness=$1 sig=$2
out=$(dirname "$0")/out/$harness-$sig
rm -rf "$out" && mkdir -p "$out/work"
cd "$out/work"
printf '#!/bin/sh\nexec sleep "$1"\n' > hold.sh && chmod +x hold.sh
case $harness in claude) d=61;; codex) d=62;; droid) d=64;; *) d=63;; esac
[ "$sig" = KILL ] && d=$((d+10))
word=$(tr -dc 'A-Z' </dev/urandom | head -c 8)
p1="The codeword is $word. Remember it. Now run the shell command \`./hold.sh $d\` in the foreground and wait for it to finish, then reply OK."
p2="You were interrupted by the supervisor. What is the codeword I gave you? Reply with only the codeword."

case $harness in
  claude)
    sid=$(cat /proc/sys/kernel/random/uuid)
    echo "$p1" | setsid claude -p --session-id "$sid" --output-format stream-json --verbose \
      --allowedTools 'Bash(./hold.sh:*)' >../turn1.jsonl 2>../turn1.err &
    ;;
  codex)
    setsid codex exec --json --skip-git-repo-check -s workspace-write "$p1" </dev/null >../turn1.jsonl 2>../turn1.err &
    ;;
  pi)
    sid=$(cat /proc/sys/kernel/random/uuid)
    setsid pi -p --mode json --session-id "$sid" --tools bash "$p1" >../turn1.jsonl 2>../turn1.err &
    ;;
  droid)
    echo "$p1" | setsid droid exec -o stream-json --auto medium >../turn1.jsonl 2>../turn1.err &
    ;;
esac
pid=$!  # setsid makes this the process-group leader

# Wait until the sleep subprocess is running (the agent is mid-turn), at most 90 s.
for _ in $(seq 90); do
  pgrep -f "^sleep $d\$" >/dev/null && break
  sleep 1
done
pgrep -f "^sleep $d\$" >/dev/null && echo "mid-turn: sleep observed" || echo "WARN: sleep never observed"
sleep 2
# A turn that already ended is not a mid-turn test (end markers per harness).
grep -qE '"type":"(result|turn\.completed|agent_end|completion)"' ../turn1.jsonl && echo "WARN: turn had already ended before the signal"
# Signal the whole process group: harness CLIs are launchers whose real process is a child.
kill -"$sig" -- -"$pid"
wait "$pid" 2>/dev/null
echo "turn1 exit: $?"
pkill -f "^sleep $d\$" 2>/dev/null

[ "$harness" = codex ] && sid=$(grep -m1 -o '"thread_id":"[^"]*"' ../turn1.jsonl | cut -d'"' -f4)
[ "$harness" = droid ] && sid=$(grep -m1 -o '"session_id":"[^"]*"' ../turn1.jsonl | cut -d'"' -f4)
echo "session: ${sid:-<none>}"
[ -z "${sid:-}" ] && { echo "RESULT $harness $sig: FAIL (no session id)"; exit 1; }

case $harness in
  claude) claude -p --resume "$sid" "$p2" >../turn2.txt 2>../turn2.err ;;
  codex)  codex exec resume "$sid" "$p2" --skip-git-repo-check </dev/null >../turn2.txt 2>../turn2.err ;;
  pi)     pi -p --session-id "$sid" --tools bash "$p2" >../turn2.txt 2>../turn2.err ;;
  droid)  echo "$p2" | droid exec --fork "$sid" >../turn2.txt 2>../turn2.err ;;
esac
echo "turn2 exit: $?"
tail -c 300 ../turn2.txt
grep -q "$word" ../turn2.txt && echo "RESULT $harness $sig: PASS ($word recalled)" || echo "RESULT $harness $sig: FAIL (expected $word)"
