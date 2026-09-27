# Mayhem: handoff notes

Instructions for whoever picks this up next. Read [PLAN.md](PLAN.md) first (the original plan), then this file.

## Current status (2026-09-26)

- **Released:** v0.2.0 and v0.3.0 on GitHub Releases. Pushing a `v*` tag makes `.github/workflows/release.yml` build macOS arm64/x64 DMGs, a Linux AppImage/.deb and the MayhemLib Maven zip + vendordep, verify the assets, then publish automatically.
- **All background-agent work is integrated.** Packaging/CI, the robot example, and the solver benchmark/robustness work are merged, along with pose variables, straight line, fast infeasibility, and the current-limit and zero-margin fixes. The "Agent" briefs further down are history.
- **Latest user-requested UI (v0.2.0):**
  - Choreo-style Pose / Translation / Guide tools; new waypoints always append at the end.
  - Drag-and-drop waypoint reorder.
  - One Constraint menu: pick a type, then click the first and last waypoint.
  - Straight-line constraint; pose variables; path folders; no auto-generate.
- **MayhemLib 2026.1.0 (v0.3.0):** Choreo-style `AutoFactory` / `AutoRoutine` / `AutoChooser` (breaking change from `MayhemAutoFactory`).
- **Tests:** solver 39, lib 23, app 7, plus the example robot sim test. Run them all before tagging.
- **Other Claude sessions work in this repo.** Coordinate via SendMessage before editing shared files. Only the main session commits and pushes.

## What Mayhem is

An FRC swerve trajectory generator (a Choreo alternative) for the user's team. It has three parts:

| Part | Dir | Stack | Status |
|---|---|---|---|
| Solver | `solver/` | Python 3.12 (uv), CasADi 3.8.1 + IPOPT, shapely, networkx, pydantic | Working; 13 pytest tests pass |
| Robot library | `lib/` | Java 17, Gradle 9.7, WPILib 2026.2.2, Phoenix 6 26.3.0 | Working; JUnit tests pass |
| Desktop app | `app/` | Vite + React 19 + TS + Zustand, Tauri 2 shell | UI working in the browser; Tauri packaging in progress |

## User decisions (don't re-ask)

- **Target:** 2026 season, game **REBUILT**, WPILib 2026, roboRIO 2. SystemCore/2027 comes later. Nothing should depend on 2027.
- **Robot:** CTRE Phoenix 6 swerve (Tuner X `CommandSwerveDrivetrain`), AprilTag-fused pose, no coprocessor.
- **Collision recovery:** on-robot bump recovery. Detect the hit, then **rejoin the trajectory and catch up**. No obstacle avoidance during recovery (user decision 2026-09-27: keep roboRIO load minimal).
- **Obstacles:** polygons drawn in the UI, customizable preloaded field geometry, true rotating bumper rectangle, keep-in zones and walls.
- **Choreo pain points to beat:** generation failing with obstacles, and long multi-waypoint paths failing.
- **Features:** event markers, alliance flipping, split segments, sim playback (no AdvantageScope export), point-at, speed zones, waypoint types, tolerance waypoints.
- **Physics:** motor torque-speed curve, stator current limit, friction, mass, MOI.
- **Formats:** clean break from Choreo (own formats). Private repo. macOS and Linux first; Windows if cheap.
- **UI style:** follow **Choreo's layout** (sidebar lists, top tool strip, big field, floating properties panel, bottom timeline). Use a **mostly white** theme with a **purple** accent. Light is the default and dark is opt-in. No "AI landing page" look: no big hero headlines, eyebrow labels or stat cards.
- Use popular libraries; don't write your own optimizer.

## Repo map

```
solver/src/mayhem_solver/
  models.py        Pydantic file formats — SOURCE OF TRUTH (app types in app/src/types.ts mirror it; lib parses output by hand)
  drivetrain.py    Motor constants (WPILib DCMotor) → wheel force/speed limits
  geometry.py      Convex decomposition, C-space roadmap, homotopy-distinct routes, swept collision check
  guess.py         Full-state initial guess, resampling, dense sampling
  ocp.py           CasADi Opti NLP (cos/sin heading, per-module forces, per-segment dt, separating-hyperplane obstacles incl. mid-interval poses, soft/elastic modes)
  pipeline.py      Robust ladder, parallel candidates (raw processes + queue), elastic diagnostics, build_output/build_recovery
  rpc.py           JSON-lines RPC server (stdio for Tauri, --ws for browser dev); solves run in killable subprocesses
  cli.py           mayhem-solver serve|solve|schema|fields
  fields/          rebuilt-2026.json (from Choreo's 2026 SVG, rotational symmetry), blank-2026.json
solver/scripts_make_fields.py    regenerates field presets
solver/scripts_make_fixtures.py  regenerates lib/src/test/resources/*.mtraj (Java test fixtures)
lib/src/main/java/mayhemlib/
  trajectory/  TrajectoryLoader (.mtraj, deploy/mayhem/), MayhemTrajectory (sampleAt, segment, flipped), RecoveryData
  follow/      HolonomicFollower (FF + saturated P), DriveCommand, FollowerConfig
  recovery/    BridgePlanner (fastest feasible quintic bridge; no obstacle checks),
               CollisionDetector (tracking error + accel beyond planned), RecoveryConfig, SleipnirBridgeRefiner (optional)
  runner/      TrajectoryRunner: framework-free state machine (FOLLOWING / BRIDGING / SETTLING), time dilation, event policies
  auto/        AutoFactory, AutoRoutine, AutoTrajectory, AutoChooser (Choreo-style API)
  ctre/        CtreSwerve.autoFactory(drivetrain)
  telemetry/, sim/BumpInjector
app/src/
  store.ts     Zustand + immer: project/trajectories, undo/redo, debounced autosave via RPC, solve jobs, stale detection
  backend.ts   Tauri sidecar (plugin-shell) or WebSocket transport
  model.ts     defaults, sampleAt, flip, footprint, motor current estimate
  components/  TopBar, Sidebar, Toolstrip, Stage, FieldCanvas (the big one), Inspector (editors), FieldPanels,
               Timeline (BottomBar + Graphs), SettingsModal, Welcome (+ browser folder picker), ui.tsx
docs/USER_GUIDE.md, README.md
```

## Running things

```bash
# solver tests
cd solver && uv run pytest -q
# Java tests (+ vendordep json + local maven repo)
cd lib && ./gradlew test vendordepJson publishJavaPublicationToLocalRepository
# frontend typecheck + tests
cd app && npx tsc -p . && pnpm test
# browser dev (two terminals)
cd solver && uv run mayhem-solver serve --ws 8765
cd app && pnpm dev        # http://localhost:5173 ; store exposed as window.__mayhem in dev
```

- There's a demo project with a solved "Hub Cycle" path at `/private/tmp/claude-501/.../scratchpad/demo-project`, which is session scratch and may be gone. Recreate one with **New project** in the UI.
- Tools needed: uv, pnpm, Rust (cargo), Gradle wrapper, Java 17+. All are installed on this Mac via Homebrew.

## Work that was delegated to background agents

Three agents were running in parallel when this was written. None had reported back yet. They were told **not to commit**, so any partial work is sitting uncommitted in the tree.

### If an agent was stopped midway

1. Run `git status` and `git diff --stat` to see what it left behind. Each agent owns specific paths (listed below), so you can tell whose work is whose.
2. Run the checks listed for that agent to see which parts work.
3. Either finish the remaining steps by hand, or start a new agent with the brief below plus a note saying "partial work already exists in <paths>; continue from it and don't start over".
4. Only commit once all three test suites pass.

Shared rules for all agents: don't commit, stay inside your own paths, and don't kill the dev servers on ports 8765 (solver WebSocket) and 5173 (Vite).

---

### Agent 1: Packaging & CI

**Owns:** `app/src-tauri/**`, `solver/packaging/**`, `scripts/**`, `.github/workflows/**`, `docs/BUILDING.md`. It may add scripts or devDeps to `app/package.json`.

**Must not touch:** `app/src/**` (the lead's UI), `lib/`, `solver/src/` (except a minimal fix if something blocks freezing, which it must report).

**Brief:**
1. Create a Tauri 2 project in `app/src-tauri/`:
   - `Cargo.toml`, `build.rs`, `src/main.rs` (+ `lib.rs`), `tauri.conf.json`
     - productName "Mayhem", identifier like `dev.mayhem.app`
     - window 1440×900, min 1000×640
     - devUrl `http://localhost:5173`, frontendDist `../dist`
     - beforeDevCommand `pnpm dev`, beforeBuildCommand `pnpm build`
     - `bundle.externalBin: ["binaries/mayhem-solver"]`
   - `capabilities/default.json`: shell spawn / stdin-write / kill for the sidecar `binaries/mayhem-solver` with args `["serve"]`, plus dialog open.
   - Register `tauri-plugin-shell` and `tauri-plugin-dialog`.
   - Kill the sidecar when the app exits.
   - Generate icons from `app/public/icon.svg` with `pnpm tauri icon` (render the SVG to a 1024 px PNG first).
   - Add `app/src-tauri/binaries/.gitkeep`.
   - How the frontend uses it: `app/src/backend.ts` calls `Command.sidecar("binaries/mayhem-solver", ["serve"])` and speaks JSON lines over stdin/stdout. `Welcome.tsx` uses `open({directory:true})` from plugin-dialog.
2. Build the sidecar with PyInstaller:
   - Spec file: `solver/packaging/mayhem-solver.spec`. It must bundle all of casadi (its plugin dylibs such as `libcasadi_nlpsol_ipopt`, `libipopt`, MUMPS; use `collect_all('casadi')`), plus shapely, networkx, pydantic, websockets, and the `mayhem_solver/fields/*.json` data.
   - Build script: `scripts/build-sidecar.sh` (+ `.ps1` if easy). It copies the binary to `app/src-tauri/binaries/mayhem-solver-<rustc host triple>`.
   - **Verify** that the frozen binary answers `{"id":1,"method":"ping"}` over stdio.
   - **Verify** that a real `solve` returns a successful `solveDone`. Solves spawn multiprocessing children; `cli.main` calls `freeze_support()`.
   - Sample solve params: `{"project": <result of defaultProject>, "trajectory": {"name":"t","waypoints":[{"id":"a","x":2,"y":2,"heading":0,"stop":true},{"id":"b","x":3,"y":6,"heading":0,"stop":true}]}}`.
   - Measure startup time to the `ready` line (target under ~3 s).
3. Run `cd app && pnpm tauri build` (`--bundles app,dmg`) and confirm the sidecar is inside the bundle. If `tsc` fails on in-progress `app/src` code, use `pnpm vite build` instead and report it.
4. Write `scripts/build-all.sh`. It builds the sidecar, the app, and the Java lib (`./gradlew build vendordepJson publishJavaPublicationToLocalRepository`), then prints the artifact paths.
5. Add `.github/workflows/ci.yml`:
   - solver pytest on ubuntu and macOS with uv
   - `./gradlew test` on JDK 17
   - `pnpm install && pnpm build`
6. Add `.github/workflows/release.yml`, triggered on `v*` tags:
   - matrix: macos-latest (arm64), macos-13 (x64), ubuntu-22.04 (+ windows if the ps1 exists)
   - on Linux, install apt deps: libwebkit2gtk-4.1-dev, libappindicator3-dev, librsvg2-dev, patchelf
   - build the sidecar and the Tauri bundles
   - upload a draft Release that includes the MayhemLib Maven zip and the vendordep JSON
7. Write `docs/BUILDING.md`.

**Checks:**
- `ls app/src-tauri/binaries/`
- run `echo '{"id":1,"method":"ping"}' | app/src-tauri/binaries/mayhem-solver-*` (inside `serve`)
- `cd app && pnpm tauri build`
- the workflow YAML is valid

---

### Agent 2: Robot example & lib docs (DONE, committed)

The example builds with GradleRIO 2026.2.1 using `JAVA_HOME=~/wpilib/2026/jdk`, and its JUnit sim test runs the autos, including one with a bump, on CTRE swerve sim. `lib/` has 23 tests. Not verified: real hardware, Pigeon accel-spike detection (in sim, recovery was triggered by tracking error instead), and the Sleipnir refiner at runtime. `MayhemLib.json` has an empty `mavenUrls`, so run `installVendordep` on each machine first.


**Owns:** `examples/robot-2026/**`, `lib/README.md`, `lib/src/test/**`. It may make minimal API fixes in `lib/src/main/**`, but must keep `./gradlew test` passing.

**Must not touch:** `app/`, `solver/`.

**Brief:**
1. Create `examples/robot-2026/`, a WPILib 2026 command-based Java project using GradleRIO (use the exact latest 2026.x plugin version).
   - Vendordeps:
     - `vendordeps/Phoenix6-frc2026-latest.json` (the official CTRE JSON)
     - `vendordeps/MayhemLib.json`, generated with `cd lib && ./gradlew installVendordep -ProbotProject=../examples/robot-2026`, which also publishes to `~/wpilib/2026/maven`
   - A Tuner-X-style `TunerConstants` and `CommandSwerveDrivetrain` with sim support. Adapt CTRE's official Phoenix6-Examples "SwerveWithChoreo" and keep its license headers.
   - `RobotContainer` should include:
     - `CtreSwerve.autoFactory(drivetrain).withTelemetry(true).withVisionBoost(...)`
     - bound commands "intake" and "shoot"
     - an auto chooser with one full-path auto and one split-segment auto that uses `Commands.either`
     - alliance flipping
     - a sim-only `BumpInjector` (random bumps behind a SmartDashboard toggle)
   - Copy `lib/src/test/resources/{HubCycle,Straight}.mtraj` into `src/main/deploy/mayhem/`.
2. Run `./gradlew build` in the example. This is the real check that MayhemLib compiles against the 2026 WPILib and Phoenix 6 APIs. If GradleRIO needs JDK 17: `brew install openjdk@17` and point `JAVA_HOME` at it.
   - Fix any MayhemLib API mistakes, then rerun `installVendordep`.
   - If possible, run a short headless `simulateJava`, or a JUnit test that constructs the autos.
3. Write `lib/README.md` covering:
   - install, and quick start with CTRE
   - API overview: factory, AutoTrajectory, markers and zones, segments and branching, alliance flip
   - RecoveryConfig knobs
   - NetworkTables telemetry topics under `/Mayhem`
   - BumpInjector
   - the optional SleipnirBridgeRefiner (needs `https://file.tavsys.net/sleipnir/SleipnirJava.json`)
   - module order FL/FR/BL/BR, and blue-origin, field-frame forces
   - follower tuning, and troubleshooting
4. Add JUnit tests for:
   - event policies (fireImmediately / skip) during a bridge
   - zone markers
   - `segment()` rebasing of must-hit times
   - mirror flipping

**Checks:**
- `cd examples/robot-2026 && ./gradlew build`
- `cd lib && ./gradlew test`
- `lib/README.md` exists

---

### Agent 3: Solver benchmark & robustness

**Owns:** `solver/**` (including `solver/benchmarks/**`), `docs/SOLVER.md`.

**Must not touch:** `app/`, `lib/`.

**Hard rule:** don't change existing field names or shapes in `models.py`. Adding an optional field with a default is allowed only if essential, and must be reported. Keep these stable:
- `pipeline.solve(project, traj, progress=None, parallel=True) -> SolveResult`
- the RPC methods, and `solveProgress` messages with `type` "stage" / "iteration" / "candidates" (iteration carries `candidate` and `path`) plus `solveDone`
- `TrajectoryOutput` and `RecoveryPayload` (Java parses them)

**Brief:**
1. Build a benchmark suite in `solver/benchmarks/` (a runnable script):
   - Seeded random REBUILT scenarios: 2–10 waypoints placed in free space (reject bumper collisions), random headings, stop and pass-through, some point-at-hub, speed zones, tolerance waypoints, extra keep-outs.
   - A hand-written hard corpus: the 1.28 m trench openings with a 0.9 m robot, around the hub, tower-adjacent end poses, near-wall poses, 10+ waypoint autos, sharp reversals.
   - Output success rate, median/p90 wall time and path-time stats, as JSON plus `solver/benchmarks/RESULTS.md`.
   - Add a fast subset (under ~60 s) as a pytest marked `slow`, and register the marker in `pyproject.toml`.
2. Use the data to fix failures and slowness. Ideas:
   - early-cancel of slower candidates
   - better sample counts
   - refining only the intervals near swept-collision hits
   - IPOPT tuning (mu strategy, HSL linear solvers if available)
   - roadmap caching
   - smoother guesses near obstacles
   - waypoints flush against obstacles
   - accurate diagnosis messages

   Outputs must stay physically valid (`tests/test_solver.py` checks wheel speed, friction and Newton) and pass the swept collision check.
3. Follow-ups sent while it was running:
   - (a) Infeasible problems take about 77 s. Add pre-solve validation, e.g. a zero-tolerance fixed-heading waypoint inside a pointAt scope that can't face the target. Also exit the ladder early once the elastic slack shows a hard infeasibility.
     - Repro on rebuilt-2026: waypoints (3.4,5.6,0,stop), (6.5,7.4,0), (7.9,5.6,−π/2,stop,split), (2.6,4.03,heading free,stop), plus a pointAt {4.63,4.03,tol 0.05} with scope range from=2 to=3.
   - (b) Diagnose issues for "Waypoint N …" constraints must set `Issue.waypoint = N-1`.
4. Write `docs/SOLVER.md` covering:
   - the NLP formulation: variables, dynamics, motor, current and friction limits, hyperplane obstacles with mid-interval checks, cost, scaling
   - the robustness ladder and diagnostics
   - benchmark numbers before and after

**Checks:**
- `cd solver && uv run pytest -q` (all pass)
- `solver/benchmarks/RESULTS.md` exists
- run the repro above; it should fail fast (a few seconds) with a waypoint-linked issue
- `docs/SOLVER.md` exists

## Remaining TODO (in priority order)

1. **Integrate the agents' work** (above). If an agent failed, finish its task yourself using the same scope.
2. **Tauri end-to-end:** launch the built app, create a project with the native folder dialog, generate, deploy. Make sure the sidecar is killed when the app quits.
3. **UI verification at a real desktop size (≥1280 px wide).** The browser pane used so far was narrow; below 820 px the sidebar is hidden on purpose. Check:
   - drag a waypoint and its heading knob, and the arrow-key nudge
   - delete with ⌫, and undo/redo
   - obstacle vertex editing (double-click an edge to add a corner, ⇧-click to remove)
   - circle tool; keep-out and zone vertex dragging
   - marker zones on the path
   - Deploy writing into `deployDir`
   - rename a path by double-clicking it in the sidebar
   - the Generate all queue (at most two paths at a time)
4. **Solver speed:** done (2026-09-27): AMF MUMPS ordering, dual warm starts for re-solves, objective-stall stopping roughly halve benchmark wall time with identical paths. v0.5.1: candidates also take tight gaps the robot only fits through when aligned (trench), and all candidates run to completion (path time over solve time, per the user) (docs/SOLVER.md, Speed). Remaining ideas: fewer zone-membership re-solve rounds, HSL MA57 where licensing allows.
5. **On-robot validation plan** (document it for the team): run `examples/robot-2026` in simulation with `BumpInjector`, then on a practice bot. Watch `/Mayhem/*` NetworkTables topics and the `lastPlanMs` topic on a roboRIO 2; target under ~5 ms.
6. **Nice to have:**
   - drag-to-reorder waypoints (currently up/down buttons)
   - a field image option
   - a "view options" layer toggle (like Choreo)
   - show per-candidate route previews after solving
   - Windows build in CI
7. **Later (user said 2027 comes later):** SystemCore/WPILib 2027 build of MayhemLib, and enabling `SleipnirBridgeRefiner` by default there.

## Conventions and gotchas

- **Don't change file formats casually.** Change `models.py` first, then regenerate the schema (`uv run mayhem-solver schema ../schemas`), update `app/src/types.ts` by hand, and update `lib/.../TrajectoryLoader.java` if the output changes. Bump `FORMAT_VERSION` for breaking changes.
- Field presets and Java fixtures are generated by scripts. Edit the scripts, not the JSON.
- The heading unit-norm constraint at sample 0 must stay. Without it the solver "shrinks" (cos, sin) and with it the robot's corners.
- Exported recovery obstacles use a 0.4× margin on purpose: the optimizer only guarantees half the margin between samples.
- Hit detection uses acceleration **beyond the planned acceleration**, because a traction-limited swerve can pull more than 1 g normally.
- Alliance flip for 2026 is **rotational** (red = blue rotated 180°), matching Choreo's 2026 field.
- The app store's solve state is `solves` (not `solve`, which is the action).
- Commits: end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Only commit when things pass; don't push unless asked.
- The user's memory notes live in `~/.claude/projects/-Users-ryanabraham-Downloads-Mayhem/memory/`.

## Definition of done

- All three test suites pass, and CI workflows exist and are green (or verified locally).
- `scripts/build-all.sh` produces a working macOS app (and a Linux build via CI), the sidecar, the MayhemLib Maven repo and the vendordep JSON.
- `examples/robot-2026` builds with GradleRIO and uses MayhemLib (autos, markers, split branching, alliance flip, BumpInjector in sim).
- Docs are complete: README, USER_GUIDE, BUILDING, SOLVER, lib/README.
