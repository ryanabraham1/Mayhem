# Building and contributing

| Part | Path | Toolchain |
|---|---|---|
| Desktop app (UI + Tauri shell) | `app/`, `app/src-tauri/` | Node 22+ / pnpm, Rust (stable) |
| C++ library | `lib-cpp/` | C++17 (C++20 for the WPILib adapters), CMake |
| CLI and MCP tools | `scripts/mayhem.mjs` | Node 24+ |
| This documentation site | `site/` | Node / pnpm, VitePress |

## Run it from source

Editing, previews and imported logs only need the frontend:

```bash
cd app
pnpm install
pnpm dev
```

Open `http://localhost:5173`. To run the desktop app, build the bundled sidecar once with `scripts/build-sidecar.sh` (`pwsh scripts/build-sidecar.ps1` on Windows), then run `pnpm tauri dev`.

## Tests

```bash
cd app && pnpm test            # unit tests
cd app && pnpm test:e2e        # browser tests (Playwright)
```

```bash
cmake -S lib-cpp -B lib-cpp/build -DBUILD_TESTING=ON
cmake --build lib-cpp/build
ctest --test-dir lib-cpp/build --output-on-failure
```

## More

- Release builds, CI, auto-update and hosting the vendordep: [docs/BUILDING.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/BUILDING.md).
- What's been verified and what hasn't: [docs/SUITE_STATUS.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SUITE_STATUS.md).
- Standing product and engineering decisions: [docs/DECISIONS.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/DECISIONS.md).

## This documentation site

The site is a [VitePress](https://vitepress.dev) project in `site/`:

```bash
cd site && pnpm install && pnpm dev      # live preview at http://localhost:5173/Mayhem/
cd site && pnpm build                    # static output in site/.vitepress/dist
```

Every page has an **Edit this page on GitHub** link. A push to `main` that touches `site/` publishes the site to the root of the `gh-pages` branch, next to the hosted vendordep files.

### Screenshots

The workspace screenshots in `site/public/img/suite/` come from a real robot repo. To retake them, build the app and run the docs screenshot test against a throwaway clone of the robot repo (the test writes tasks into it):

```bash
git clone <robot repo> /tmp/robot
cd app && pnpm build
MAYHEM_DOCS_SHOTS=/tmp/shots MAYHEM_REVIEW_REPO=/tmp/robot MAYHEM_DOCS_LOG=<a .wpilog> \
  npx playwright test docs-shots
```

Then convert the PNGs to JPEG in `site/public/img/suite/`.
