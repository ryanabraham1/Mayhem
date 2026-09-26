#!/usr/bin/env bash
# Build the frozen solver sidecar with PyInstaller and install it where Tauri expects it:
#   app/src-tauri/binaries/mayhem-solver-<rust target triple>
#
# Usage: scripts/build-sidecar.sh [--target <triple>] [--no-smoke]
#   --target    override the triple suffix (default: host triple from `rustc -vV`)
#   --no-smoke  skip the post-build stdio smoke test (ping + real solve)
# Needs: uv, rustc (only for the triple; set MAYHEM_TARGET_TRIPLE to skip).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLVER="$ROOT/solver"
BIN_DIR="$ROOT/app/src-tauri/binaries"
SMOKE=1
TRIPLE="${MAYHEM_TARGET_TRIPLE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TRIPLE="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TRIPLE" ]]; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
fi
[[ -n "$TRIPLE" ]] || { echo "could not determine rust target triple" >&2; exit 1; }

EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

echo "==> Building mayhem-solver sidecar for $TRIPLE"
cd "$SOLVER"
uv sync --frozen --group dev >/dev/null 2>&1 || uv sync --group dev
uv run --frozen pyinstaller packaging/mayhem-solver.spec --noconfirm --log-level WARN \
  --distpath build/pyinstaller/dist --workpath build/pyinstaller/work

SRC="$SOLVER/build/pyinstaller/dist/mayhem-solver$EXT"
DEST="$BIN_DIR/mayhem-solver-$TRIPLE$EXT"
mkdir -p "$BIN_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "==> Installed $DEST ($(du -h "$DEST" | cut -f1))"

if [[ "$SMOKE" == 1 ]]; then
  echo "==> Smoke test (stdio ping + solve)"
  PY="$(command -v python3 || command -v python)"
  "$PY" "$ROOT/scripts/smoke-sidecar.py" "$DEST"
fi
