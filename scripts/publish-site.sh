#!/usr/bin/env bash
# Publish site/ to GitHub Pages (https://krimvp.github.io/sous/) by committing it to the gh-pages branch.
# Pages builds from that branch; GitHub Actions is not used (the account's Actions billing is blocked).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
git fetch -q origin gh-pages
git worktree add -q "$tmp" origin/gh-pages --detach
# Replace the whole published tree with site/, so files removed from site/ disappear from the page too.
git -C "$tmp" rm -rqf --ignore-unmatch .
cp -R site/. "$tmp/"
touch "$tmp/.nojekyll"
git -C "$tmp" add -A
if git -C "$tmp" diff --cached --quiet; then echo "site unchanged"; exit 0; fi
git -C "$tmp" commit -qm "Publish site from $(git rev-parse --short HEAD)"
git -C "$tmp" push -q origin HEAD:gh-pages
echo "published; GitHub Pages rebuilds in about a minute"
