#!/usr/bin/env bash
# Publish MayhemLib to the gh-pages branch, which GitHub Pages serves at
# https://<owner>.github.io/<repo>/ :
#   maven/...         maven repo (what MayhemLib.json's mavenUrls points at)
#   MayhemLib.json    vendordep JSON (its jsonUrl; WPILib's "Install new libraries (online)" and
#                     "Check for updates" read it)
#
# Usage: scripts/publish-pages.sh <maven-repo-dir> <MayhemLib.json> <version>
#   <maven-repo-dir>  lib/build/repos/releases   (./gradlew publishJavaPublicationToLocalRepository)
#   <MayhemLib.json>  lib/build/vendordeps/MayhemLib.json   (./gradlew vendordepJson)
# Environment:
#   PAGES_REMOTE  git remote URL to push to (CI sets this to an authenticated https URL)
#   PAGES_BRANCH  default gh-pages
#
# A published version is never overwritten: Gradle caches artifacts by version, so changing one in
# place would leave users with stale or mismatched jars. If <version> is already hosted this does
# nothing; bump `version` in lib/build.gradle (or pass -PmayhemVersion) to ship library changes.
set -euo pipefail

[[ $# -eq 3 ]] || { echo "usage: $0 <maven-repo-dir> <MayhemLib.json> <version>" >&2; exit 2; }
REPO_DIR="$(cd "$1" && pwd)"
JSON="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
VERSION="$3"
BRANCH="${PAGES_BRANCH:-gh-pages}"
REMOTE="${PAGES_REMOTE:?set PAGES_REMOTE to the git remote URL}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

if git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" pages 2>/dev/null; then
  cd pages
else
  # First publish: start the branch from scratch (it holds only hosted files, no source history).
  mkdir pages && cd pages
  git init --quiet -b "$BRANCH"
  git remote add origin "$REMOTE"
fi

if [[ -d "maven/mayhemlib/MayhemLib-java/$VERSION" ]]; then
  echo "::notice::MayhemLib $VERSION is already hosted on $BRANCH; leaving it unchanged. Bump the lib version to publish library changes."
  exit 0
fi

# Only this version (a local build/repos/releases can hold older ones), plus the artifact's
# maven-metadata.xml. maven/mayhemlib/MayhemLib-java matches the publication in lib/build.gradle.
ARTIFACT_DIR="mayhemlib/MayhemLib-java"
[[ -d "$REPO_DIR/$ARTIFACT_DIR/$VERSION" ]] || { echo "no $ARTIFACT_DIR/$VERSION under $REPO_DIR" >&2; exit 1; }
mkdir -p "maven/$ARTIFACT_DIR"
cp -R "$REPO_DIR/$ARTIFACT_DIR/$VERSION" "maven/$ARTIFACT_DIR/"
cp "$REPO_DIR/$ARTIFACT_DIR"/maven-metadata.xml* "maven/$ARTIFACT_DIR/"
cp "$JSON" MayhemLib.json
touch .nojekyll   # serve files as-is (no Jekyll processing)

git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "MayhemLib $VERSION"
git push --quiet origin "HEAD:$BRANCH"
echo "Published MayhemLib $VERSION to $BRANCH"
