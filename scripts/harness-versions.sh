#!/usr/bin/env bash
# Print each harness CLI's installed version next to the version it was certified with
# (test/fixtures/conformance/<harness>/certified.json, written by `npm run certify`).
# Either side may be missing; a harness whose CLI moved on since its certification is marked "differs".
set -euo pipefail
cd "$(dirname "$0")/.."
printf '%-8s %-28s %-40s %s\n' harness installed certified status
harnesses=$(node --input-type=module -e "import { HARNESSES } from './src/types.ts'; console.log(HARNESSES.join(' '))")
for h in $harnesses; do
  installed="not installed"
  if command -v "$h" >/dev/null 2>&1; then
    installed=$("$h" --version 2>/dev/null | head -n1 || true)
    [ -n "$installed" ] || installed="unknown"
  fi
  certified="not certified"
  file="test/fixtures/conformance/$h/certified.json"
  if [ -f "$file" ]; then
    certified=$(node -e "const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(c.version + (c.failed?.length ? ' (' + c.failed.length + ' failed)' : '') + ', ' + c.date)" "$file" || echo "unreadable")
  fi
  status="-"
  if [ "$certified" != "not certified" ] && [ "$installed" != "not installed" ] && [ "$installed" != "unknown" ]; then
    case "$certified" in "$installed"*) status="same" ;; *) status="differs" ;; esac
  fi
  printf '%-8s %-28s %-40s %s\n' "$h" "$installed" "$certified" "$status"
done
