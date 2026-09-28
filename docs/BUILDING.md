# Building Mayhem

Mayhem has three parts:

| Part | Path | Toolchain |
|------|------|-----------|
| Solver (CasADi + IPOPT) | `solver/` | Python 3.12 via [uv](https://docs.astral.sh/uv/) |
| Desktop app (UI + Tauri shell) | `app/`, `app/src-tauri/` | Node 22+ / pnpm, Rust (stable) |
| Robot library (vendordep) | `lib/` | JDK 17+, Gradle wrapper |

The desktop app is a Tauri 2 shell around the Vite/React UI. The UI talks to the solver over
newline-delimited JSON-RPC: inside the desktop app it spawns the frozen solver as a Tauri
**sidecar** (`binaries/mayhem-solver`, `serve` subcommand, stdio). In a plain browser it
connects to `ws://127.0.0.1:8765` instead (override with `VITE_SOLVER_WS`).

## Prerequisites

- uv (it installs Python 3.12 for you)
- Node 22+ and pnpm (`corepack enable` or `npm i -g pnpm`)
- Rust stable (`rustup` or Homebrew)
- JDK 17+ for `lib/`
- Linux only, for Tauri: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev build-essential file`
- Windows only: WebView2 (preinstalled on Windows 11) and the MSVC build tools

## Development

### Browser dev (fastest loop)

Two terminals:

```sh
# 1: solver over WebSocket, straight from source
cd solver && uv run mayhem-solver serve --ws 8765

# 2: UI with hot reload
cd app && pnpm install && pnpm dev     # http://localhost:5173
```

Solver changes need a restart of terminal 1.

### Desktop dev (`tauri dev`)

The desktop shell always runs the **frozen** sidecar, so build it once (and again whenever
solver code changes):

```sh
scripts/build-sidecar.sh          # -> app/src-tauri/binaries/mayhem-solver-<target-triple>
cd app && pnpm tauri dev          # starts `pnpm dev` itself, then opens the window
```

If a Vite dev server is already running on 5173, reuse it:
`pnpm tauri dev --config '{"build":{"beforeDevCommand":""}}'`.

## The solver sidecar

`solver/packaging/mayhem-solver.spec` is a PyInstaller spec that produces a single-file
executable (Tauri's `bundle.externalBin` needs a single file per platform). What it includes:

- all of `casadi` via `collect_all`. CasADi `dlopen()`s its solver plugins
  (`libcasadi_nlpsol_ipopt`, `libcasadi_linsol_mumps`, ...) and IPOPT/MUMPS/METIS/gfortran at
  runtime, so import analysis can't find them. Static archives, headers and cmake/pkgconfig
  files are dropped.
- `shapely`, `networkx`, `pydantic`, `websockets` (their submodules too, because they import
  lazily)
- the field presets `mayhem_solver/fields/*.json` (read with `importlib.resources`)

The entry point `solver/packaging/entry.py` calls `mayhem_solver.cli.main`, which runs
`multiprocessing.freeze_support()` before anything else. Solves run in `spawn` worker processes
that re-exec the frozen binary, and that call is what routes those workers to their target.

`scripts/build-sidecar.sh` (on Windows, `scripts/build-sidecar.ps1`) builds the spec, copies the
result to `app/src-tauri/binaries/mayhem-solver-<triple>[.exe]` (triple from `rustc -vV`,
override with `--target`), then runs `scripts/smoke-sidecar.py`. The smoke test checks the
time to the `ready` line, `ping`, `listFields`, `defaultProject`, and a real `solve`, which has to
end in a successful `solveDone`. Skip it with `--no-smoke`.

Numbers on an M-series Mac: the binary is about 64 MB, `ready` arrives 0.8 to 1.6 s after
launch, and the smoke solve finishes in about 2 to 4 s.

Set `MAYHEM_PYI_ONEDIR=1` to get an unpacked onedir build under `solver/build/pyinstaller/`
when you want to see exactly what was collected.

### Shutdown

A onefile binary is a bootloader process that unpacks into a temp dir (`_MEIxxxx`) and runs
Python as its child. tauri-plugin-shell SIGKILLs its children on exit, and that would leave
the temp dir behind. To prevent this, `app/src-tauri/src/sidecar.rs` registers a small plugin
ahead of the shell plugin. On `RunEvent::Exit` it sends SIGINT to its own `mayhem-solver`
children, and SIGTERM to any still running after 1.5 s. Python gets `KeyboardInterrupt`,
cancels the running solve jobs and exits, and the bootloader removes the temp dir. Separately,
the server always exits when its stdin closes, so a crashed or force-killed app doesn't leave
solvers running either.

## Release builds

Everything at once (sidecar, then desktop bundles, then MayhemLib), with artifact paths printed
at the end:

```sh
scripts/build-all.sh                        # --skip-sidecar / --skip-app / --skip-lib / --bundles ...
```

Or one piece at a time:

```sh
scripts/build-sidecar.sh
cd app && pnpm tauri build                  # macOS: --bundles app,dmg   Linux: --bundles appimage,deb
cd lib && ./gradlew build vendordepJson publishJavaPublicationToLocalRepository
```

Outputs:

- `app/src-tauri/target/release/bundle/macos/Mayhem.app`, `dmg/Mayhem_<ver>_<arch>.dmg`
- `.../bundle/appimage/*.AppImage`, `.../bundle/deb/*.deb`
- `.../bundle/nsis/*-setup.exe`, `.../bundle/msi/*.msi`
- `lib/build/repos/releases/` (maven repo; `build-all.sh` also zips it to `lib/build/repos/MayhemLib-maven.zip`),
  `lib/build/vendordeps/MayhemLib.json`

Notes:

- **macOS DMG from a terminal without Automation permission.** `bundle_dmg.sh` scripts Finder to
  lay out the DMG window and fails with "Not authorized to send Apple events to Finder". Either
  allow it when prompted or run with `CI=true`, which skips that step.
- **Signing.** Bundles are ad-hoc signed (`signingIdentity: "-"`) with the hardened runtime
  and `app/src-tauri/Entitlements.plist`. `disable-library-validation` is required because the
  sidecar loads libpython/CasADi from its temp dir, and without it the sidecar won't start
  under the hardened runtime. The app isn't notarized, so users who download it have to clear
  quarantine (`xattr -dr com.apple.quarantine /Applications/Mayhem.app`) or right-click and pick
  Open. To notarize, set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID` (or the API-key variables) in CI. The entitlements already cover it.
- **Linux AppImage.** Build with `NO_STRIP=true` (`build-all.sh` and CI already set it).
  linuxdeploy strips the binaries it bundles, and stripping a PyInstaller onefile binary cuts
  off its embedded archive.
- **Tauri versions.** The Tauri CLI won't build when the `tauri` crate and `@tauri-apps/api`
  differ in major.minor. Both are on 2.11. `app/src-tauri/Cargo.toml` pins the tauri crate
  family (`tauri`, `tauri-runtime(-wry)`, `tauri-utils`, `tauri-macros`, `tauri-build`) to
  2.11-compatible versions, so bump those together with `@tauri-apps/api`.
- **Cross-compiling.** Not supported. Each platform's sidecar has to be frozen on that
  platform, which is why CI uses a build matrix.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on PRs, and on manual dispatch:

| Job | What it runs |
|-----|--------------|
| `solver` | `uv run pytest -q` on ubuntu-latest and macos-latest |
| `sidecar` | Frozen solver + stdio smoke solve on Ubuntu and macOS |
| `java` | `./gradlew test` on JDK 17 |
| `frontend` | `pnpm install --frozen-lockfile && pnpm build` (`tsc -b` typecheck + Vite build) |
| `desktop` | `cargo clippy --locked -D warnings` for the Tauri shell (placeholder sidecar) |

`.github/workflows/release.yml` runs when a version tag such as `v0.1.0` is pushed, or by
manual dispatch with an existing tag:

1. `create-release` creates a draft GitHub Release for the tag, or reuses the existing one.
2. `desktop` is a matrix build that freezes and smoke-tests the sidecar, sets the app version
   from the tag, and builds bundles with `tauri-apps/tauri-action`, which uploads them to the
   draft. The same files are also kept as workflow artifacts.
   - macOS arm64 (`macos-latest`): `.app` (tar.gz) + `.dmg`
   - macOS x64 (`macos-15-intel`, since GitHub retired `macos-13`): `.app` + `.dmg`
   - Linux x64 (`ubuntu-22.04`, for older glibc): `.AppImage` + `.deb`
   Windows installers are pending a fix for the frozen solver worker on Windows.
3. `mayhemlib` runs `./gradlew build vendordepJson publishJavaPublicationToLocalRepository`
   and attaches `MayhemLib-maven.zip` and `MayhemLib.json`.
4. `publish` checks that the installers and MayhemLib files are present, writes the
   auto-update manifest `latest.json` from the uploaded `.sig` files, then publishes the
   release. If a build fails, the release stays a draft so incomplete downloads are not shown
   as the latest release, and installed apps are not offered it.

To cut a release:

```sh
git tag v0.2.0 && git push origin v0.2.0
# wait for the Release workflow; installers appear at
# https://github.com/ryanabraham1/Mayhem/releases/latest
```

## Auto-update

The desktop app updates itself with `tauri-plugin-updater` (UI in `app/src/updater.ts` and
`app/src/components/UpdateBanner.tsx`). It checks
`https://github.com/ryanabraham1/Mayhem/releases/latest/download/latest.json` a few seconds
after launch and every 6 hours, shows a banner when a newer version exists, and installs only
when the user clicks **Install & restart**. Before restarting it stops running generations
and saves pending edits. Settings, About & updates, and the Welcome screen have a manual
check. Dev builds (`tauri dev`) skip the automatic check.

Every update is verified against the public key in `app/src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). The release workflow signs with the matching private key from two
repository secrets:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/mayhem-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contents of `~/.tauri/mayhem-updater.key.password` |

**Back up the private key and password** (e.g. in a password manager). If they are lost,
installed copies can't be updated again; you'd have to generate a new key pair
(`pnpm tauri signer generate -w ~/.tauri/mayhem-updater.key`), put the new public key in
`tauri.conf.json`, and have everyone reinstall manually once.

What each platform updates from (`latest.json` target keys):

| Install | Target | Artifact |
|---|---|---|
| macOS `.app` | `darwin-aarch64`, `darwin-x86_64` | `Mayhem_<arch>.app.tar.gz` (replaces the bundle in place) |
| Linux AppImage | `linux-x86_64` | the `.AppImage` itself |
| Linux `.deb` | `linux-x86_64-deb` | the `.deb`, installed with `pkexec dpkg -i` (asks for a password) |

Local `pnpm tauri build` fails without the key because `bundle.createUpdaterArtifacts` is on.
`scripts/build-all.sh` uses `~/.tauri/mayhem-updater.key` if it exists and otherwise turns
updater artifacts off. For a one-off build without the key, run:
`pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

To test an update locally, build the "new" version with the key
(`pnpm tauri build --bundles app --config '{"version":"9.9.9"}'`) and serve a `latest.json`
pointing at its `Mayhem.app.tar.gz` + `.sig`. Then build an "old" version with
`--config '{"version":"0.0.1","plugins":{"updater":{"endpoints":["http://127.0.0.1:8799/latest.json"],"dangerousInsecureTransportProtocol":true}}}'`
and launch it.

## MayhemLib from a release

To use MayhemLib from a release, unzip `MayhemLib-maven.zip` into `~/wpilib/2026/maven` and copy
`MayhemLib.json` into the robot project's `vendordeps/`. Or run
`cd lib && ./gradlew installVendordep -ProbotProject=/path/to/robot` from a checkout.
