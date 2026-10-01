# Building and contributing

Mayhem has three parts:

| Part | Path | Toolchain |
|---|---|---|
| Solver (CasADi + IPOPT) | `solver/` | Python 3.12 via [uv](https://docs.astral.sh/uv/) |
| Desktop app (UI + Tauri shell) | `app/`, `app/src-tauri/` | Node 22+ / pnpm, Rust (stable) |
| Robot library (vendordep) | `lib/` | JDK 17+, Gradle wrapper |

## Run it from source

Two terminals:

```bash
cd solver && uv sync && uv run mayhem-solver serve --ws 8765
```

```bash
cd app && pnpm install && pnpm dev
```

Open `http://localhost:5173`. To run as a desktop app, build the solver sidecar once and use `pnpm tauri dev`.

## Tests

```bash
cd solver && uv run pytest -q
```

```bash
cd lib && ./gradlew test
```

```bash
cd app && pnpm test
```

## More

- Sidecar packaging, release builds, CI, auto-update and hosting MayhemLib: [docs/BUILDING.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/BUILDING.md).
- Standing product and engineering decisions: [docs/DECISIONS.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/DECISIONS.md).

## This documentation site

The site is a [VitePress](https://vitepress.dev) project in `site/`:

```bash
cd site && pnpm install && pnpm dev      # live preview at http://localhost:5173/Mayhem/
cd site && pnpm build                    # static output in site/.vitepress/dist
```

Every page has an **Edit this page on GitHub** link. A push to `main` that touches `site/` publishes the site to the root of the `gh-pages` branch, next to the hosted MayhemLib files.
