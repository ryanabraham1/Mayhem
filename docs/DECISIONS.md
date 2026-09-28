# Decisions

Standing product and engineering decisions for Mayhem. Check here before changing scope, UI direction or file formats; these were settled with the team and shouldn't be re-litigated without a reason. The original plan is in [PLAN.md](../PLAN.md).

## Scope and targets

- **Season:** 2026, game REBUILT, WPILib 2026 on roboRIO 2 (Java 17). SystemCore / WPILib 2027 comes later; nothing may depend on 2027.
- **Robot:** CTRE Phoenix 6 swerve (Tuner X `CommandSwerveDrivetrain`), AprilTag-fused pose, no coprocessor.
- **Platforms:** macOS and Linux first. Windows is supported where it's cheap (solver runs solve jobs as child processes there).
- **Libraries:** use popular, maintained libraries (CasADi + IPOPT, shapely, networkx, pydantic). Don't write our own optimizer.

## Why Mayhem exists

Choreo fails to generate paths with obstacles and long multi-waypoint paths. Beating it on those two cases is the priority; path time comes before solve time.

## Solver

- **Physics:** motor torque-speed curve, stator current limit, friction, mass and moment of inertia.
- **Obstacles:** polygons drawn in the UI, customizable preloaded field geometry, the true rotating bumper rectangle, keep-in zones and walls.
- **Intake extended:** when the constraint is active, the solver keeps the deployed intake clear of obstacles and walls (v0.5.0).
- **Route candidates:** candidate 0 is the shortest route from either the any-heading or the inscribed-circle roadmap, so tight gaps like the trench are offered. All candidates run to completion; no early cancel, since it occasionally dropped the winner (v0.5.1).
- **Sleipnir refinement** is optional and off by default on 2026 hardware.

## On-robot recovery (MayhemLib)

- Detect the bump, then rejoin the trajectory with the **fastest feasible bridge** and catch up.
- **No obstacle avoidance during recovery** (2026-09-27): the roboRIO is too weak. Don't re-add collision checks or roadmap routing on the robot.
- MayhemLib exposes an `intakeExtended()` trigger and intake spans instead.

## Features

In scope: event markers, alliance flipping, split segments, sim playback (no AdvantageScope export), point-at, speed zones, waypoint types, tolerance waypoints, pose variables, straight-line constraint, path folders, rough terrain.

Editing behaviour: Choreo-style Pose / Translation / Guide tools; new waypoints append at the end; drag-and-drop reorder; one Constraint menu (pick a type, then click the first and last waypoint). No auto-generate.

## File formats

- Clean break from Choreo: Mayhem uses its own formats (`.mtraj` etc.).
- `solver/src/mayhem_solver/models.py` is the source of truth. To change a format: edit `models.py`, regenerate the schema (`uv run mayhem-solver schema ../schemas`), update `app/src/types.ts`, and update `lib/.../TrajectoryLoader.java` if the output changed. Bump `FORMAT_VERSION` for breaking changes.
- Don't rename or reshape existing fields. New fields must be optional with a default.

## Desktop app UI

- **Layout follows Choreo:** sidebar lists, top tool strip, big field, floating properties panel, bottom timeline.
- **Theme:** mostly white with a purple accent, card-based; light is the default and dark is opt-in.
- **No "AI landing page" look:** no big hero headlines, eyebrow labels or stat cards.

## Distribution

- The repo is public (github.com/ryanabraham1/Mayhem). Pushing a `v*` tag builds and publishes a release via GitHub Actions.
- The app updates itself from GitHub Releases but installs only when the user clicks (v0.6.0). The updater signing key must stay backed up; see [BUILDING.md](BUILDING.md).
- Deferred: update checks for the MayhemLib vendordep (needs `jsonUrl` and a hosted Maven repo).
