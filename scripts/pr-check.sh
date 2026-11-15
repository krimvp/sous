#!/usr/bin/env bash
# What a PR must show before review: `npm run check` and `npm pack --dry-run` pass on the exact commit being pushed.
# It runs as the pre-push hook (.githooks/pre-push, installed by `npm install`) and by hand; CI runs the same two
# commands (.github/workflows/check.yml). Paste the last line into the PR as "head SHA checked".
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
# As a hook in a linked worktree, git hands these down, and every `git init` the tests run in a temporary directory
# would then act on this repository instead.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
sha=$(git rev-parse HEAD)
note=""
if [ -n "$(git status --porcelain)" ]; then note=" (the working tree has uncommitted changes, which the SHA does not cover)"; fi
echo "pr-check: head $sha"
failed=""
npm run check || failed="npm run check"
if [ -z "$failed" ]; then npm pack --dry-run || failed="npm pack --dry-run"; fi
if [ -n "$failed" ]; then
  echo "pr-check: FAIL head $sha: $failed failed$note"
  exit 1
fi
echo "pr-check: PASS head $sha: npm run check and npm pack --dry-run$note"
