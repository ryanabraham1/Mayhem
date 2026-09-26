# Mayhem solver

The solver builds a time-optimal swerve trajectory with CasADi/IPOPT. The public entry
point is `pipeline.solve(project, trajectory, progress=None, parallel=True)`. The desktop
app sends the same project and trajectory through the solver's JSON-RPC `solve` method;
the solver streams `solveProgress` events and returns `solveDone` with either a verified
trajectory or issues tied to the field and, where possible, a waypoint.

## Optimization model

The path is divided at waypoints. Each segment has `N` intervals with one shared
interval duration `h`; minimizing the sum of `N*h` for all segments minimizes travel
time. At each sample the decision variables are field position `(x,y)`, orientation
`(cos(theta),sin(theta))`, field velocity `(vx,vy)`, angular velocity, field acceleration,
angular acceleration, and two field-frame force components per swerve module. The first
orientation sample is constrained to unit length; the discrete rotation equations then
preserve that norm across the trajectory.

Between samples, translation and rotation use constant-acceleration integration.
Newton-Euler equations equate summed module forces to chassis acceleration and summed
module moments to angular acceleration. Each module is bounded by free wheel speed,
its motor torque-speed envelope, current-limited force, and the friction circle. When
the robot model supplies center-of-gravity height, longitudinal/lateral acceleration
changes each wheel's normal force, and wheel lift-off is prohibited.

Each bumper corner must remain inside the field. Convex obstacle pieces and the robot
footprint are separated by an optimized hyperplane with the configured clearance
margin. Separation is checked at sample endpoints and the exact constant-acceleration
midpoint of each interval. Suspect intervals also receive quarter-point checks. A
continuous swept-path check follows every successful solve; collisions cause local
quarter-point refinement first, then denser samples on the affected segments.

Fixed waypoints impose position and heading constraints, with optional circular/box
position and angular tolerances. The start and marked stop waypoints have zero chassis
velocity. User constraints support velocity, acceleration, angular velocity, point-at,
and keep-in scopes; keep-outs are added to world geometry. Zone membership is
rechecked against the solved samples and made sticky on a warm re-solve until it stops
changing. The objective adds a small module-force change penalty for smoothness. The
force variables are scaled by the robot's maximum wheel force; normalized wheel,
friction, and motor inequalities keep differently sized limits numerically comparable.

## Search and diagnostics

The solver creates several configuration-space route candidates around obstacles. Each
candidate starts from a full-state guess and tries this ladder within the trajectory's
time limit:

1. Hard solve on the requested mesh.
2. Coarse-mesh solve, then refine back to the requested mesh.
3. Soft geometry/waypoint solve, then hard solve from that result.
4. Relaxed drivetrain limits, then nominal limits.
5. Segment-wise solves stitched into a joint warm start.

Candidates run in separate processes by default. The fastest solution that passes the
swept check and all zone memberships is exported. If no candidate succeeds, an elastic
solve measures constraint slack and ranks actionable issues. Simple input errors are
rejected before optimization: missing waypoints, out-of-field or obstacle-overlapping
fixed poses, and fixed headings that cannot satisfy a point-at target. The latter are
reported with the exact waypoint index, avoiding a long infeasible solve.

`MAYHEM_LINEAR_SOLVER` can select an installed IPOPT linear solver; the default probes
HSL MA57 and otherwise uses bundled MUMPS. `MAYHEM_IPOPT_OPTIONS` accepts a JSON object
of IPOPT options for experiments. Keep validation enabled when comparing settings:
convergence alone does not establish physical or collision validity.

## Benchmarks

Run `cd solver && uv run python -m benchmarks.run` for the seeded 2026 REBUILT corpus.
The benchmark checks exported physics, swept collision, waypoints, and user constraints
independently of the NLP's success flag. `--fast` runs the small CI subset; `--jobs N`
runs throughput mode and should not be compared with app-mode wall times. Detailed
per-scenario numbers and machine context are in [RESULTS.md](../solver/benchmarks/RESULTS.md).

The baseline (seed 2026, 60 random cases) validated 90/91 feasible scenes (98.9%),
with 0.733 s median and 5.943 s p90 wall time. Its one invalid output exceeded a
zone-scoped maximum velocity. The current run validates all 91/91 feasible scenes,
with 0.594 s median and 3.208 s p90 wall time; 4/4 intentionally infeasible cases
were diagnosed. The enclosed-goal diagnosis still takes about 49 s, so complex
infeasible geometry remains a performance target. A failed solve is not
deployment-ready; edit the path or constraint and generate again.
