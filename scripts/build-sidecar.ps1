# Windows counterpart of scripts/build-sidecar.sh.
# Builds the frozen solver with PyInstaller and installs it as
#   app\src-tauri\binaries\mayhem-solver-<rust target triple>.exe
#
# Usage: pwsh scripts/build-sidecar.ps1 [-Target <triple>] [-NoSmoke]
param(
  [string]$Target = $env:MAYHEM_TARGET_TRIPLE,
  [switch]$NoSmoke
)
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Solver = Join-Path $Root "solver"
$BinDir = Join-Path $Root "app\src-tauri\binaries"

if (-not $Target) {
  $Target = (rustc -vV | Select-String '^host: (.+)$').Matches[0].Groups[1].Value.Trim()
}
if (-not $Target) { throw "could not determine rust target triple" }

Write-Host "==> Building mayhem-solver sidecar for $Target"
Push-Location $Solver
try {
  uv sync --frozen --group dev
  if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
  uv run --frozen pyinstaller packaging/mayhem-solver.spec --noconfirm --log-level WARN `
    --distpath build/pyinstaller/dist --workpath build/pyinstaller/work
  if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Src = Join-Path $Solver "build\pyinstaller\dist\mayhem-solver.exe"
$Dest = Join-Path $BinDir "mayhem-solver-$Target.exe"
Copy-Item -Force $Src $Dest
$SizeMB = [math]::Round((Get-Item $Dest).Length / 1MB, 1)
Write-Host "==> Installed $Dest ($SizeMB MB)"

if (-not $NoSmoke) {
  Write-Host "==> Smoke test (stdio ping + solve)"
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $py) { $py = (Get-Command python3) }
  & $py.Source (Join-Path $Root "scripts\smoke-sidecar.py") $Dest
  if ($LASTEXITCODE -ne 0) { throw "smoke test failed" }
}
