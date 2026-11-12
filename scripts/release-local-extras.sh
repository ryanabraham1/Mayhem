#!/usr/bin/env bash
# Attach the non-desktop release files when a release is built locally instead of by the
# Release workflow (e.g. while GitHub Actions is unavailable). Does what the workflow's
# suite-tools and MayhemCpp steps do:
#   - Mayhem-suite-tools-<tag>.zip, Mayhem-cpp-<tag>.zip, Mayhem-suite-SHA256SUMS.txt
#     (packaged and verified, including C++ tests; needs python3, node 24+, cmake, a C++ compiler)
#   - MayhemCpp.json + MayhemCpp-maven.zip on the release
#   - MayhemCpp hosted on GitHub Pages (gh-pages: maven/ + MayhemCpp.json); an already hosted
#     C++ version is left unchanged
#
# Usage: scripts/release-local-extras.sh <tag>      (the release <tag> must already exist)
# Builds from a clean worktree of <tag>, never from the working tree.
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <tag>" >&2; exit 2; }
TAG="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${GITHUB_REPOSITORY:-ryanabraham1/Mayhem}"
WORK="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

gh release view "$TAG" --repo "$REPO" >/dev/null
git -C "$ROOT" worktree add -q --detach "$WORK/src" "$TAG"
cd "$WORK/src"

python3 scripts/package-suite.py --version "$TAG" --output "$WORK/suite"
python3 scripts/verify-suite-package.py "$WORK/suite"
python3 scripts/build-cpp-vendordep.py --output "$WORK/cpp"
(cd "$WORK/cpp/repos/releases" && zip -qr ../../MayhemCpp-maven.zip .)

gh release upload "$TAG" --repo "$REPO" --clobber \
  "$WORK"/suite/* "$WORK/cpp/MayhemCpp.json" "$WORK/cpp/MayhemCpp-maven.zip"

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WORK/cpp/MayhemCpp.json")"
PAGES_REMOTE="${PAGES_REMOTE:-https://github.com/$REPO.git}" ARTIFACT_DIR=mayhemlib/MayhemCpp-cpp \
  scripts/publish-pages.sh "$WORK/cpp/repos/releases" "$WORK/cpp/MayhemCpp.json" "$VERSION"
echo "Attached tools/C++ archives and MayhemCpp $VERSION to $TAG"
