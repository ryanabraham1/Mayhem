#!/usr/bin/env bash
# Publish the documentation site to the root of the gh-pages branch, which GitHub Pages serves at
# https://<owner>.github.io/<repo>/ . The same branch hosts MayhemLib (maven/ and MayhemLib.json,
# written by scripts/publish-pages.sh), so this replaces everything EXCEPT those files.
#
# Usage: scripts/publish-docs.sh <built-site-dir>      (site/.vitepress/dist)
# Environment:
#   PAGES_REMOTE  git remote URL to push to (CI sets this to an authenticated https URL)
#   PAGES_BRANCH  default gh-pages
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <built-site-dir>" >&2; exit 2; }
DIST="$(cd "$1" && pwd)"
BRANCH="${PAGES_BRANCH:-gh-pages}"
REMOTE="${PAGES_REMOTE:?set PAGES_REMOTE to the git remote URL}"

[[ -f "$DIST/index.html" ]] || { echo "$DIST has no index.html; build the site first" >&2; exit 1; }
for reserved in maven MayhemLib.json; do
  [[ ! -e "$DIST/$reserved" ]] || { echo "$DIST/$reserved collides with the hosted MayhemLib files" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

if git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" pages 2>/dev/null; then
  cd pages
else
  mkdir pages && cd pages
  git init --quiet -b "$BRANCH"
  git remote add origin "$REMOTE"
fi

# Drop the previous docs (hashed asset names change every build) but keep the MayhemLib files.
find . -mindepth 1 -maxdepth 1 \
  ! -name .git ! -name maven ! -name MayhemLib.json -exec rm -rf {} +
cp -R "$DIST"/. .
touch .nojekyll   # serve files as-is (no Jekyll processing)

git add -A
if git diff --cached --quiet; then
  echo "Docs on $BRANCH are already up to date."
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "Docs: ${GITHUB_SHA:-local build}"
git push --quiet origin "HEAD:$BRANCH"
echo "Published docs to $BRANCH"
