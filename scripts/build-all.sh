#!/usr/bin/env bash
# Build everything: solver sidecar -> Tauri desktop bundles -> MayhemLib (Java vendordep).
#
# Usage: scripts/build-all.sh [--skip-sidecar] [--skip-app] [--skip-lib] [--bundles <list>]
#   --bundles  comma list passed to `tauri build --bundles` (default: app,dmg on macOS,
#              appimage,deb on Linux, nsis,msi on Windows/Git-Bash)
# Environment: MAYHEM_VERSION overrides the MayhemLib version (gradle -PmayhemVersion).
#
# Note (macOS): the DMG step drives Finder via AppleScript to lay out the window. From a
# terminal without Automation permission set CI=true to skip that cosmetic step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DO_SIDECAR=1 DO_APP=1 DO_LIB=1
BUNDLES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-sidecar) DO_SIDECAR=0; shift ;;
    --skip-app) DO_APP=0; shift ;;
    --skip-lib) DO_LIB=0; shift ;;
    --bundles) BUNDLES="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) DEFAULT_BUNDLES="app,dmg" ;;
  Linux) DEFAULT_BUNDLES="appimage,deb" ;;
  *) DEFAULT_BUNDLES="nsis,msi" ;;
esac
BUNDLES="${BUNDLES:-$DEFAULT_BUNDLES}"
ARTIFACTS=()

if [[ $DO_SIDECAR == 1 ]]; then
  "$ROOT/scripts/build-sidecar.sh"
  ARTIFACTS+=("$(ls "$ROOT"/app/src-tauri/binaries/mayhem-solver-* | head -1)")
fi

if [[ $DO_APP == 1 ]]; then
  echo "==> Building desktop app ($BUNDLES)"
  cd "$ROOT/app"
  pnpm install --frozen-lockfile
  # Auto-update artifacts (.app.tar.gz / .sig) need the updater signing key. Releases get it
  # from CI secrets; locally use ~/.tauri/mayhem-updater.key if present, else skip them.
  TAURI_ARGS=(--bundles "$BUNDLES")
  KEY_FILE="${MAYHEM_UPDATER_KEY:-$HOME/.tauri/mayhem-updater.key}"
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$KEY_FILE" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
    [[ -f "$KEY_FILE.password" ]] && export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$KEY_FILE.password")"
  fi
  [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] && TAURI_ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  # PyInstaller onefile binaries must not be stripped (linuxdeploy does that for AppImages).
  NO_STRIP=true pnpm tauri build "${TAURI_ARGS[@]}"
  BUNDLE_DIR="$ROOT/app/src-tauri/target/release/bundle"
  while IFS= read -r f; do ARTIFACTS+=("$f"); done < <(
    find "$BUNDLE_DIR" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.AppImage' \
      -o -name '*.deb' -o -name '*.rpm' -o -name '*.msi' -o -name '*-setup.exe' \) ! -name 'rw.*' 2>/dev/null | sort)
fi

if [[ $DO_LIB == 1 ]]; then
  echo "==> Building MayhemLib"
  cd "$ROOT/lib"
  GRADLE_ARGS=()
  [[ -n "${MAYHEM_VERSION:-}" ]] && GRADLE_ARGS+=("-PmayhemVersion=$MAYHEM_VERSION")
  ./gradlew "${GRADLE_ARGS[@]+"${GRADLE_ARGS[@]}"}" build vendordepJson publishJavaPublicationToLocalRepository
  # Zip the maven repo so it can be attached to a release / unzipped into ~/wpilib/<year>/maven.
  (cd build/repos/releases && rm -f ../MayhemLib-maven.zip && zip -qr ../MayhemLib-maven.zip .)
  ARTIFACTS+=("$ROOT/lib/build/vendordeps/MayhemLib.json" "$ROOT/lib/build/repos/MayhemLib-maven.zip")
  while IFS= read -r f; do ARTIFACTS+=("$f"); done < <(find "$ROOT/lib/build/libs" -name '*.jar' | sort)
fi

echo
echo "==> Artifacts"
for a in "${ARTIFACTS[@]}"; do
  printf '  %-8s %s\n' "$(du -sh "$a" 2>/dev/null | cut -f1)" "$a"
done
