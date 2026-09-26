# Mayhem — Implementation Plan

Mayhem is a time-optimal swerve trajectory generator for FRC. It has three parts:

1. **Desktop app** (macOS + Linux first, Windows later). Lay out autos on the field and generate numerically optimized trajectories that respect the drivetrain's physical limits.
2. **Solver core**. A robust optimization pipeline built on **CasADi + IPOPT**, designed specifically to avoid the failure cases we hit in Choreo.
3. **MayhemLib** (Java vendordep). Loads and follows trajectories on the robot (CTRE Phoenix 6 swerve). It also **detects bumps and recovers** by planning a path back onto the trajectory.

This is a clean break from Choreo: Mayhem uses its own file formats and its own robot library. The repo stays private for now.

---

## 1. Requirements summary (from Q&A)

| Topic | Decision |
|---|---|
| Collision recovery | On-robot bump recovery: detect being knocked off path, then **rejoin the trajectory and catch up** |
| Control system | **Both** roboRIO 2 and SystemCore (2027). No coprocessor. |
| Localization | AprilTag vision fused into the CTRE pose estimator |
| Recovery latency | Our choice → start moving within the same loop, then refine in the background where the CPU allows |
| Obstacles | Polygons drawn in the UI, **customizable** preloaded season field geometry, true rotating bumper footprint, keep-in zones and walls |
| Choreo pain points to fix | Generation fails once obstacles are added; paths with many waypoints fail to converge |
| v1 features | Event markers, alliance flipping, split/chained segments, in-app sim playback (no AdvantageScope export) |
| Constraints | Point-at target, speed/accel zones, waypoint types, stop-in-zone / tolerance waypoints |
| Physics | Choreo-level+: motor torque-speed curve, gearing, stator current limit, wheel friction, mass, MOI, module positions |
| Robot code | CTRE swerve (Phoenix 6) |
| Maintainers | Mentors. Tech choices optimize for the best result. |

---

## 2. Architecture

```
┌────────────────────────────── Desktop app (Tauri 2) ─────────────────────────────┐
│  React + TypeScript UI                                                           │
│  • field canvas (SVG + d3-zoom)   • robot config   • field/obstacle editor       │
│  • waypoint/constraint editing    • playback + graphs (uPlot)                    │
│            │  JSON-RPC over stdio (streams solver progress for live preview)     │
│  ┌─────────▼──────────────────────────────────────────────────────────────────┐  │
│  │ Solver sidecar (Python, bundled with PyInstaller)                          │  │
│  │  geometry (Shapely) → global route search (networkx) → multi-start NLP     │  │
│  │  (CasADi + IPOPT) → continuation / refinement → diagnostics → export       │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
                     │ writes  src/main/deploy/mayhem/*.mtraj  (JSON)
                     ▼
┌──────────────────────────── MayhemLib (Java vendordep) ──────────────────────────┐
│  Trajectory loading/sampling · alliance flip · events · splits                   │
│  Follower: FF (per-module forces) + saturated feedback → CTRE SwerveRequest      │
│  Recovery: detect → time-dilate → bridge planner (pure Java, fast)               │
│            → [SystemCore only] Sleipnir NLP refinement in a background thread    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Why this stack
- **CasADi + IPOPT (Python)** is the most widely used open-source NLP toolchain. It provides exact automatic-differentiation Hessians. Prebuilt wheels (v3.8.1) include IPOPT for macOS arm64/x86, Linux x86_64/aarch64, and Windows. That makes cross-platform builds nearly free and lets us add Windows at little cost. Python also makes it quick to iterate on the math. CasADi's structure-exploiting OCP solver (**fatrop**) is available as a drop-in speedup if IPOPT is slow on large problems.
- **Tauri 2 + React** is the same UI approach Choreo uses. It produces small native binaries on all three operating systems. The Rust layer is thin glue that launches the solver sidecar and handles file I/O.
- **Pure Java on the robot** means recovery runs on the roboRIO 2 without native code. On SystemCore, we add **Sleipnir's Java bindings** (landing in WPILib 2027, with a vendordep backport also available). They're used only for optional refinement.
- **Single source of truth for file formats.** JSON Schema generates the Pydantic (Python), TypeScript, and Java types, so the three parts can't drift apart.

---

## 3. Solver core: formulation

This is a direct-transcription multiple-shooting formulation, in the same family as Choreo's TrajoptLib, with extensions.

**Decision variables per sample k:** `x, y, cosθ, sinθ, vx, vy, ω, ax, ay, α`, per-module force `(Fx_i, Fy_i)`, and a per-segment `dt`. Each segment's `dt` is constant, and there's one segment per pair of waypoints.

**Dynamics:** Constant acceleration between samples (`x+ = x + v·dt + ½a·dt²`, and likewise for heading via rotation composition). Also `ΣF = m·a` and `Σ(r_i × F_i) = J·α`.

**Drivetrain limits (Choreo-level+):**
- Wheel ground speed from chassis twist: `|v_wheel_i| ≤ v_free · (gearing, wheel radius)`
- **Torque-speed curve:** wheel force along its velocity direction is limited by the DC motor line `F ≤ (τ_stall/r)(1 − |v_wheel|/v_free)` while driving. Braking uses a separate limit. Motor constants come from WPILib `DCMotor` presets (Kraken X60/X44, Falcon, NEO, Vortex).
- **Stator current limit** → a torque cap per module.
- **Friction:** `|F_i| ≤ μ·N_i`, with optional weight transfer from center-of-gravity height (off by default).
- Unit-circle constraint on `(cosθ, sinθ)`.

**Cost:** minimize total time, plus a small, configurable regularizer on force rate. The regularizer removes chatter and wheel scrub without meaningfully slowing the path.

**Constraints:**
- *Waypoint types:* full pose, translation only, heading only, or guide point (a soft pull). Each can be **stop** or **pass-through**, and **exact** or **tolerance region** (circle or box, plus optional heading tolerance).
- *Point-at:* heading faces a target point within a tolerance, across a waypoint range or inside a zone.
- *Speed/accel zones:* max `|v|`, `|a|`, `|ω|` over a waypoint range or while inside a polygon region. Region membership uses smooth indicator constraints.
- *Keep-in regions and field walls.*
- *Obstacles* (below).

**Scaling:** All variables are nondimensionalized by field size, max speed, and max force before being passed to IPOPT. Poor scaling is one of the main reasons IPOPT fails to converge.

---

## 4. Robustness: fixing Choreo's failure modes

This is the core differentiator. Choreo seeds its solver with a linear or spline guess that goes straight through waypoints, and therefore straight through obstacles. It only supports circular keep-outs, enforced at sample points. From a guess like that, a local NLP solver often converges to an infeasible local minimum. Mayhem replaces the "one guess, one solve, fail" approach with a pipeline:

### 4.1 Obstacle model
- **Obstacles are polygons** (concave allowed). The app decomposes them into convex pieces using Shapely plus a Hertel–Mehlhorn decomposition. Circles are approximated as polygons.
- **The robot is its real bumper rectangle**, rotating with θ, not a circle around the robot.
- **Collision constraint:** a separating-hyperplane (OBCA-family) formulation. For each active pair of robot sample and convex obstacle piece, a hyperplane `(n, b)` must separate the robot's four corners from the obstacle's vertices by a safety margin. This is smooth, exact for convex shapes, and correct under rotation.
- **Broad-phase culling:** only pairs near the current route get constraints, which keeps the problem small. The set of active pairs is updated between solves.
- **No cutting corners between samples:** after each solve, we do a dense swept-footprint check. If there's a violation, we add samples or a local margin at that spot and warm-restart. We repeat until the path is clean. Every exported path is verified collision-free, not just at its samples.

### 4.2 Global initial guess (fixes "infeasible with obstacles")
1. Build a roadmap by inflating obstacles in configuration space. We use two inflation radii: circumscribed (conservative) and inscribed (optimistic).
2. Run A* on the visibility graph through the waypoint sequence. Use **k-shortest homotopy-distinct routes** so we get candidates that go around each obstacle on different sides.
3. Smooth each route and time-parameterize it with trapezoidal profiles. This gives a *full-state* guess (positions, velocities, accelerations, forces), not just positions.
4. **Solve the candidates in parallel** (process pool) and keep the fastest feasible result.

### 4.3 Continuation fallbacks (fixes "many waypoints fail")
When a direct solve fails, we escalate automatically:
1. **Mesh continuation:** solve at a coarse sample count, then refine and warm-start. Sample counts come from the estimated segment time and a target `dt`.
2. **Segment-wise warm start:** solve each segment on its own with free boundary velocities, stitch them together, then solve the whole path jointly.
3. **Constraint homotopy:** start with obstacles and tolerance waypoints as l1-penalized *soft* constraints, then tighten to hard constraints. Physical limits can also be relaxed first and restored afterward.
4. If IPOPT with MUMPS struggles, optionally use **HSL MA57/MA97** linear solvers when installed (free academic license).

### 4.4 Diagnostics (when it's truly infeasible)
If every attempt fails, we run an **elastic-mode solve** that minimizes total constraint violation. Then we report *which* constraints needed slack and *where*, highlighted on the field. For example: "Waypoint 4 heading is unreachable: needs 14 rad/s², max is 9". No more silent failures.

### 4.5 Regression suite
- Keep a corpus of hard scenes: tight gaps, many waypoints, concave obstacles, and ported Choreo failure cases.
- Run a randomized obstacle-scene benchmark in CI that tracks **success rate, solve time, and path time**.
- Where comparable, compare against Choreo.

---

## 5. Desktop app features

- **Project and robot config:** mass, MOI (with an estimator helper), bumper size, module positions, wheel radius, μ, motor type and count, gearing, current limits.
- **Field presets:** season JSON files containing the field image, dimensions, obstacle polygons, walls, and **symmetry type** (mirror or rotational). The preloaded geometry is **fully editable**: duplicate a preset, move or add or delete polygons, adjust margins, and save your own custom version.
- **Field editor:** draw and edit polygons, circles, and keep-in zones, and snap to field elements.
- **Path editing:** place, drag, and rotate waypoints. Set waypoint type, stop vs pass-through, and tolerance regions. Edit constraints on a timeline or range bar under the path.
- **Event markers:** named commands at a waypoint or time offset, plus "during" zones that span a range.
- **Split points:** break one auto into chained segments so robot code can branch between them.
- **Solve UX:** a live preview while iterating (streamed from the solver). Solves are cancellable. Multiple trajectories can solve in parallel. Solved outputs are cached and invalidated when inputs change.
- **Sim playback:** a scrubber with the bumper footprint, a ghost trail, and collision highlighting. Graphs of speed, acceleration, ω, per-module force, and estimated motor current vs. limits.
- **Alliance flip preview:** toggle to see the red-alliance version.
- **Deploy:** write `.mtraj` files into the robot project's `src/main/deploy/mayhem/`.

### File formats
- `project.mayhem` holds the robot config, field reference, and named commands.
- `*.mtraj` per auto holds the **inputs** (waypoints, constraints, markers, splits) plus the **solved output**: timestamped samples `t, x, y, θ, vx, vy, ω, ax, ay, α`, per-module forces, event list, and split indices. It also holds the **recovery payload**: the field obstacle polygons, bumper footprint, a precomputed roadmap graph, derived limits for the bridge planner, and per-marker/waypoint "must-hit" flags.

---

## 6. MayhemLib (Java vendordep)

Builds target WPILib 2026 (roboRIO 2) and WPILib 2027 (SystemCore).

- **Loading and sampling:** parse `.mtraj` and interpolate between samples. Alliance flipping follows the field's symmetry.
- **Follower:** the feedforward is the trajectory's chassis speeds plus **per-module force feedforwards**, sent via CTRE `SwerveRequest.ApplyFieldSpeeds` with wheel force feedforwards. Feedback is PID on x, y, θ, **saturated so feedforward plus feedback stays within physical limits**. That keeps the robot from lurching.
- **Command API** (command-based):
  ```java
  var auto = Mayhem.autoFactory(drivetrain, config);
  var traj = auto.trajectory("TwoPiece");
  traj.atMarker("intake").onTrue(intake.run());
  return Commands.sequence(traj.segment(0).cmd(), Commands.either(traj.segment(1).cmd(), traj.segment(2).cmd(), hasPiece));
  ```
- **Logging:** reference vs. actual pose, recovery state, and bridge paths, published to NetworkTables and DataLog.
- **Sim support:** works with CTRE's swerve sim. Includes a **bump injector** that applies an impulse or pose offset to the sim robot, so we can test recovery at a desk.

---

## 7. On-robot bump recovery (rejoin & catch up)

The design goal is to **never pause visibly on either controller**. Recovery escalates only as far as each situation needs.

**Detection:** a collision is flagged when any of these happens (with hysteresis):
- Tracking error between the vision-fused pose and the reference exceeds a position or heading threshold for N loops.
- The Pigeon 2 accelerometer reports a spike (jerk).
- There's a large vision correction jump.

On a detected hit, we briefly raise how much the pose estimator trusts vision, because wheel odometry is unreliable after slip.

**Response ladder:**
1. **Small error:** normal saturated feedback.
2. **Medium error (time dilation):** the trajectory clock slows or pauses so the reference waits for the robot instead of running away from it. Because markers are tied to the trajectory clock, event markers stay in sync automatically.
3. **Large error or path blocked (bridge planner, pure Java, every loop):**
   - Candidate join times `t_j` range from now up to the next **must-hit** point (stop waypoint, split, or flagged marker).
   - For each candidate, compute a min-time **bridge** from the current state (pose and velocity) to the reference state at `t_j`. It uses synchronized, acceleration-limited per-axis time-optimal profiles (closed form, runs in microseconds). The limits are the conservative ones exported by the desktop app.
   - Collision-check each bridge's swept **bumper rectangle** against the exported field polygons. If every direct bridge is blocked, route through the **precomputed roadmap** (small A*) and blend the corners.
   - Choose the bridge that minimizes *arrival time at the end of the trajectory*: `bridge_time + (T_end − t_j)`. After the join, keep following the original time-optimal trajectory.
   - Target: **< 3 ms on a roboRIO 2**. This gets verified in the Phase 0 spike.
4. **SystemCore only (refinement):** a small Sleipnir NLP with the full swerve dynamics (about 30 samples), warm-started from the bridge. It runs in a background thread and hot-swaps in if it finishes in time and is faster. It's disabled on the roboRIO 2.

**Marker policy during a bridge:** each marker is configurable to *fire at join*, *fire immediately*, or *skip*. Must-hit markers can't be jumped past.

**Stretch goal:** detect being pinned or stalled (commanding motion without moving), then hold and retry or side-step.

---

## 8. Repo layout

```
Mayhem/
  schemas/            JSON Schema (source of truth) → generated Py/TS/Java types
  solver/             Python package `mayhem_solver`
    model/ constraints/ geometry/ guess/ pipeline/ diagnostics/ rpc/ cli.py
    tests/ benchmarks/
  app/                Tauri 2 app (src-tauri/ Rust glue, src/ React+TS)
  lib/                Gradle project for MayhemLib + vendordep JSON
  fields/             Season field presets (JSON + images)
  .github/workflows/  CI: solver tests, benchmark, app builds (macOS/Linux, later Windows), Java build
```

---

## 9. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0: Spikes** | CasADi reproduction of Choreo's formulation. Separating-hyperplane collision with a rotating rectangle. Timing of the pure-Java bridge planner on a real roboRIO 2. Check that Sleipnir Java is available for 2027. | Formulation matches Choreo on simple paths. Collision approach converges. Bridge planner under 3 ms on the RIO. |
| **1: Solver core** | Full physics, all constraints, polygon obstacles, global guess, multi-start, continuation, diagnostics. CLI `mayhem solve`. Schemas. | Regression corpus passes. Benchmark success rate beats Choreo on obstacle scenes. |
| **2: Desktop app** | Field canvas, robot config, field editor with customizable presets, path/constraint/marker/split editing, live solve, playback and graphs, deploy. | A student can build and deploy an auto end-to-end on macOS and Linux. |
| **3: MayhemLib core** | Loading, sampling, alliance flip, follower with force feedforward, CTRE integration, events, splits, logging. | Runs autos in sim and on the practice bot. |
| **4: Recovery** | Detection, time dilation, bridge planner plus roadmap, marker policy, sim bump injector, then SystemCore Sleipnir refinement. | Recovers from injected bumps in sim, then from real pushes on the practice bot, without hitting obstacles. |
| **5: Hardening** | CI installers (dmg, AppImage/deb), docs, Windows build, performance tuning (fatrop, HSL). | Tagged release that the team uses for the season. |

---

## 10. Risks and open items

- **roboRIO 2 CPU budget:** the bridge planner is designed for it, but its performance needs Phase 0 measurement. Fallback: fewer join-time candidates and a coarser collision check.
- **Sleipnir Java packaging for 2027:** it may ship in WPILib or stay a vendordep. Either works. Refinement is optional in any case.
- **IPOPT speed on long autos:** mitigated by mesh continuation, fatrop, and HSL.
- **Where time dilation can't be used:** time dilation can't satisfy timed events tied to the match clock. We'll document that markers follow the trajectory clock, not the match clock.
