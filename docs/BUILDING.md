# Building Mayhem

| Part | Path | Toolchain |
|------|------|-----------|
| Desktop app (UI + Tauri shell) | `app/`, `app/src-tauri/` | Node 22+ / pnpm, Rust (stable) |
| C++ library and physics sim (MayhemCpp vendordep) | `lib-cpp/` | C++17 / CMake |
| CLI and MCP server | `scripts/mayhem.mjs` | Node 24+ |

See [the user guide](USER_GUIDE.md), [C++ setup](../lib-cpp/README.md) and [suite agent tools](SUITE_AGENTS.md).

The desktop app is a Tauri 2 shell around the Vite/React UI. The Rust side (`app/src-tauri/src/`)
holds the native commands: robot log transfer, project files, the robot repo review, the sim proof
and deploys.

The Python trajectory solver, the classic planner UI and the Java MayhemLib were removed after
v0.9.59. Releases up to v0.9.59 still carry them, and the MayhemLib versions already hosted on
GitHub Pages stay there.

## Prerequisites

- Node 22+ and pnpm (`corepack enable` or `npm i -g pnpm`)
- Rust stable (`rustup` or Homebrew)
- CMake and a C++ compiler, for `lib-cpp/` and the archive checks
- Python 3.12+, for the packaging scripts
- Linux only, for Tauri: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev build-essential file`
- Windows only: WebView2 (preinstalled on Windows 10 and 11), the MSVC build tools
  ("Desktop development with C++" in the Visual Studio installer) and PowerShell 7 (`pwsh`)

## Development

### Browser dev (fastest loop)

For the new suite, only the frontend is needed:

```sh
cd app
pnpm install
pnpm dev
```

Open `http://localhost:5173`. Editing, preview and log import all work in the browser.

### Desktop dev (`tauri dev`)

```sh
cd app && pnpm tauri dev          # starts `pnpm dev` itself, then opens the window
```

If a Vite dev server is already running on 5173, reuse it:
`pnpm tauri dev --config '{"build":{"beforeDevCommand":""}}'`.

## Release builds

The desktop bundles, with artifact paths printed at the end:

```sh
scripts/build-all.sh                        # --bundles app,dmg | appimage,deb | nsis
```

or directly:

```sh
cd app && pnpm tauri build                  # macOS: --bundles app,dmg   Linux: --bundles appimage,deb   Windows: --bundles nsis
```

Outputs:

- `app/src-tauri/target/release/bundle/macos/Mayhem.app`, `dmg/Mayhem_<ver>_<arch>.dmg`
- `.../bundle/appimage/*.AppImage`, `.../bundle/deb/*.deb`
- `.../bundle/nsis/Mayhem_<ver>_x64-setup.exe`

The C++ vendordep: `python3 scripts/build-cpp-vendordep.py --output <dir>` writes
`<dir>/MayhemCpp.json` and the maven repo `<dir>/repos/releases/`.

Notes:

- **macOS DMG from a terminal without Automation permission.** `bundle_dmg.sh` scripts Finder to
  lay out the DMG window and fails with "Not authorized to send Apple events to Finder". Either
  allow it when prompted or run with `CI=true`, which skips that step.
- **Signing.** Bundles are ad-hoc signed (`signingIdentity: "-"`) with the hardened runtime. The
  app isn't notarized, so users who download it have to clear quarantine
  (`xattr -dr com.apple.quarantine /Applications/Mayhem.app`) or right-click and pick Open. To
  notarize, set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (or the
  API-key variables) in CI.
- **Linux AppImage.** `build-all.sh` and CI build with `NO_STRIP=true`, as every release so far
  has; linuxdeploy then leaves the bundled binaries unstripped.
- **Tauri versions.** The Tauri CLI won't build when the `tauri` crate and `@tauri-apps/api`
  differ in major.minor. Both are on 2.11. `app/src-tauri/Cargo.toml` pins the tauri crate
  family (`tauri`, `tauri-runtime(-wry)`, `tauri-utils`, `tauri-macros`, `tauri-build`) to
  2.11-compatible versions, so bump those together with `@tauri-apps/api`.
- **Windows installer.** Releases ship the NSIS installer only. It installs per user, needs no
  admin rights, installs WebView2 if it's missing, and is what the updater runs. It isn't
  code-signed, so SmartScreen warns on first run.
- **Cross-compiling.** Not supported; CI builds each platform on that platform.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on PRs, and on manual dispatch:

| Job | What it runs |
|-----|--------------|
| `workflows` | Actionlint validates workflow syntax, expressions and reusable-workflow calls |
| `frontend` | `pnpm test`, then `pnpm build` (`tsc -b` typecheck + Vite build) |
| `cpp` | CMake/CTest, installation and independent `find_package` consumer on Linux, macOS and Windows |
| `tools` | Build/extract CLI/MCP and C++ archives; verify hashes, CLI simulation, MCP stdio, C++ tests and compilation of Node-generated routines on Linux, macOS and Windows |
| `browser` | Playwright against the production build: author/preview/export/reopen an auto, switch projects, import/persist/replay WPILOG through its worker, simulate state inputs, and navigate all suite pages in both themes |
| `desktop` | Real frontend; Rust tests and strict Clippy; unsigned Tauri bundles and packaged-process startup on Linux, Windows, and both macOS architectures |
| `ready` | Stable `CI ready` check; fails if any validation job fails, is cancelled or is skipped |

Desktop CI disables updater artifact signing so PRs need no signing secrets. The release workflow
still requires the updater key. Linux uses Xvfb and an extracted `.deb`; Windows silently installs
the NSIS bundle into a temporary directory; macOS launches the bundled executable. Startup checks
fail on early process exit. They do not exercise native dialogs, SFTP, updater installation or a
physical robot. Browser traces/screenshots and desktop startup logs are uploaded for diagnosis.

For local browser checks, run `pnpm exec playwright install chromium`, `pnpm build`, then
`pnpm test:e2e` in `app/`. Archive checks require Node 24+, Python 3.12+, CMake and a C++ compiler:

```sh
python3 scripts/package-suite.py --version local --output artifacts/suite
python3 scripts/verify-suite-package.py artifacts/suite
```

`.github/workflows/release.yml` runs when a version tag such as `v0.1.0` is pushed, or by
manual dispatch with an existing tag:

1. `resolve-tag` resolves the tag to an immutable commit SHA. `validate` calls the same CI workflow
   against that SHA. Only after every job passes does `create-release` create/reuse a draft release.
   All packaging jobs check out that validated SHA.
2. `desktop` is a matrix build that sets the app version from the tag and builds bundles with `tauri-apps/tauri-action`, which uploads them to the
   draft. The same files are also kept as workflow artifacts.
   - macOS arm64 (`macos-latest`): `.app` (tar.gz) + `.dmg`
   - macOS x64 (`macos-15-intel`, since GitHub retired `macos-13`): `.app` + `.dmg`
   - Linux x64 (`ubuntu-22.04`, for older glibc): `.AppImage` + `.deb`
   - Windows x64 (`windows-latest`): NSIS `-setup.exe`
3. `mayhemcpp` builds the header-only C++ vendordep (`scripts/build-cpp-vendordep.py`), attaches
   `MayhemCpp-maven.zip` and `MayhemCpp.json` (for offline installs), and, unless the tag is an
   `-rc`, hosts the maven repo and `MayhemCpp.json` on GitHub Pages (`scripts/publish-pages.sh`;
   see "Hosting MayhemCpp" below).
4. `suite-tools` builds and independently verifies `Mayhem-suite-tools-<tag>.zip`,
   `Mayhem-cpp-<tag>.zip`, and `Mayhem-suite-SHA256SUMS.txt`. The CLI/MCP archive needs Node 24+
   but no npm installation. Keep its directory structure intact. The C++ archive contains the
   header-only library, CMake setup and tests.
5. `publish` checks that the tag still points at the validated SHA and all installers/library/tool
   assets are present, writes the
   auto-update manifest `latest.json` from the uploaded `.sig` files, then publishes the
   release. If a build fails, the release stays a draft so incomplete downloads are not shown
   as the latest release, and installed apps are not offered it.

To cut a release:

```sh
git tag v0.2.0 && git push origin v0.2.0
# wait for the Release workflow; installers appear at
# https://github.com/ryanabraham1/Mayhem/releases/latest
```

A tag like `v0.2.0-rc1` builds a release candidate from any branch. It goes through the same
jobs but is published as a GitHub prerelease, which never becomes `releases/latest`, so
installed apps are not offered it. The app inside reports the plain version (`0.2.0`).

## Auto-update

The desktop app updates itself with `tauri-plugin-updater` (state in `app/src/updater.ts`; the banner
is in `app/src/suite/SuiteApp.tsx`). It checks
`https://github.com/ryanabraham1/Mayhem/releases/latest/download/latest.json` a few seconds
after launch and every 6 hours, shows a banner when a newer version exists, and installs only
when the user clicks **Install & restart**. Settings, Updates has a manual check. Dev builds (`tauri dev`) skip the automatic check.

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
| Windows | `windows-x86_64`, `windows-x86_64-nsis` | the NSIS `-setup.exe`, run in passive mode (progress bar, no prompts); the app exits while it runs and restarts afterwards |
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

## Hosting MayhemCpp

Users install the C++ library with **Install new libraries (online)** and
`https://ryanabraham1.github.io/Mayhem/MayhemCpp.json`. That URL, and the maven repo the JSON points
at (`https://ryanabraham1.github.io/Mayhem/maven/`), are served by GitHub Pages from the `gh-pages`
branch. The release workflow's `mayhemcpp` job (or `scripts/release-local-extras.sh` for a local
release) pushes to that branch with `scripts/publish-pages.sh`; nobody edits the branch by hand.
The same branch still serves the Java `MayhemLib.json` and its maven files from earlier releases.

**Versions.** The version is `MAYHEM_CPP_VERSION` in `lib-cpp/include/mayhem/version.hpp`. A
published version is never overwritten, because build tools cache artifacts by version. If a
release's version is already hosted, the script logs a notice and leaves the branch alone, so bump
the version before tagging when the library changes; app-only releases can leave it.

## Documentation site

The docs at `https://ryanabraham1.github.io/Mayhem/` are a [VitePress](https://vitepress.dev) project in `site/` (pages are Markdown, screenshots are in `site/public/img/`).

```sh
cd site && pnpm install && pnpm dev     # live preview at http://localhost:5173/Mayhem/
cd site && pnpm build                   # static output in site/.vitepress/dist
```

`.github/workflows/docs.yml` builds the site on pull requests that touch `site/` and, on a push to `main`, publishes it with `scripts/publish-docs.sh`. The script replaces everything at the root of the `gh-pages` branch except `maven/`, `MayhemCpp.json` and `MayhemLib.json`, which `scripts/publish-pages.sh` owns (see "Hosting MayhemCpp"), and the two workflows share the `mayhemlib-pages` concurrency group so pushes to the branch never race. The docs and the vendordep files live on the same Pages site, so no extra Pages setup is needed once the branch is serving.

`site/` repeats material from `docs/USER_GUIDE.md` and `lib-cpp/README.md`; update both when behavior changes.
