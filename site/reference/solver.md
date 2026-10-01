# How the solver works

This is a user-level summary. The full write-up, with every detail and number, is [docs/SOLVER.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SOLVER.md) in the repo.

The solver builds a time-optimal swerve trajectory with CasADi and IPOPT. The app sends the project and trajectory to it, it streams progress while it works, and it returns either a verified trajectory or a list of issues tied to the field and, where possible, a waypoint.

## The optimization model

The path is divided at waypoints. Each segment has `N` intervals that share one interval duration `h`, and the solver minimizes the total time `N·h`. At each sample the unknowns are position, orientation, velocity, angular velocity, acceleration, angular acceleration, and two field-frame force components per swerve module.

- **Dynamics.** Between samples, translation and rotation use constant-acceleration integration. Newton-Euler equations tie the summed module forces to chassis acceleration and the summed module moments to angular acceleration.
- **Drivetrain limits.** Each module is bounded by free wheel speed, its motor torque-speed envelope, current-limited force, and the friction circle. The current limit caps the module's *total* force, because lateral force needs stator current too.
- **Weight transfer.** If the robot model supplies a center-of-gravity height, acceleration changes each wheel's normal force, and wheel lift-off is prohibited.
- **Collisions.** Each bumper corner must stay inside the field. Obstacles and the robot footprint are separated by an optimized hyperplane with the configured clearance margin, checked at sample endpoints and interval midpoints. A continuous swept-path check follows every successful solve, and a collision triggers local refinement and then denser samples.
- **Constraints.** Fixed waypoints impose position and heading, with optional tolerances. Start and stop waypoints have zero velocity. User constraints cover velocity, acceleration, angular velocity, point-at, keep-in, keep-out and straight-line.
- **Pose variables.** Waypoints linked to a pose variable are resolved to plain poses first, so moving a variable marks exactly the paths that use it out of date.

## Search and diagnostics

The solver creates several route candidates around obstacles. Each one tries a ladder of increasingly forgiving solves within the time limit:

1. A hard solve on the requested mesh.
2. A coarse mesh, then refine back.
3. A soft geometry and waypoint solve, then a hard solve from that result.
4. Relaxed drivetrain limits, then nominal limits.
5. Segment-wise solves stitched into a joint warm start.

If the direct solve doesn't converge, an *elastic probe* measures which constraint is being violated and by how much. A clear violation streams an early **Likely unsolvable** warning to the app, and if no candidate succeeds, the probe ranks the actionable issues. In elastic solves, moving a fixed waypoint costs more than other slack, so the report blames the conflicting constraint rather than moving the robot.

Candidates run in separate processes by default. The fastest solution that passes the swept-collision check and all zone checks is exported, and a warning never overrides a successful candidate.

## Route candidates

Routes come from two roadmaps: one for the robot's circumscribed circle (fits at any heading) and one for its inscribed circle (fits when turned square to a gap). Candidate 0 takes the shortest route from either roadmap, so a gap only the aligned robot fits through, like a trench a few centimeters wider than the robot, is always tried. The remaining candidates are distinct routes around obstacles from the any-heading roadmap. The optimizer only refines the route it is given, so a gap that isn't offered is never found.

## Benchmarks

`cd solver && uv run python -m benchmarks.run` runs a seeded 2026 REBUILT corpus and checks physics, swept collision, waypoints and user constraints independently of the solver's own success flag. The current run validates all 91/91 feasible scenes (0.450 s median, 2.101 s p90 wall time) and diagnoses all 4/4 infeasible ones (p90 0.26 s). Per-scenario numbers are in [RESULTS.md](https://github.com/ryanabraham1/Mayhem/blob/main/solver/benchmarks/RESULTS.md).
