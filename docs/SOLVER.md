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
its motor torque-speed envelope, current-limited force, and the friction circle. The current
limit caps the module's total force, not only its longitudinal part: lateral force needs
stator current as well, and a projected limit vanishes at zero wheel speed. When
the robot model supplies center-of-gravity height, longitudinal/lateral acceleration
changes each wheel's normal force, and wheel lift-off is prohibited.

Each bumper corner must remain inside the field. Convex obstacle pieces and the robot
footprint are separated by an optimized hyperplane with the configured clearance
margin (at least 1 cm, so a zero-margin obstacle can't be satisfied by a degenerate
plane). Separation is checked at sample endpoints and the exact constant-acceleration
midpoint of each interval. Suspect intervals also receive quarter-point checks. A
continuous swept-path check follows every successful solve; collisions cause local
quarter-point refinement first, then denser samples on the affected segments.

Before anything else, `resolve_poses(project, trajectory)` replaces the x, y and heading of
every waypoint whose `poseRef` names one of the project's pose variables (`project.poses`,
each `{id, name, x, y, heading}`); the heading only matters for fixed-heading waypoints. A
`poseRef` that names no variable produces a warning and the waypoint keeps its stored pose.
The rest of the pipeline sees plain waypoints and the output format is unchanged. The input
hash is computed on the resolved waypoints (with `poseRef` itself left out), so moving a pose
variable marks exactly the paths that use it stale, and files without links keep their hashes.

Fixed waypoints impose position and heading constraints, with optional circular/box
position and angular tolerances. The start and marked stop waypoints have zero chassis
velocity. User constraints support velocity, acceleration, angular velocity, point-at,
keep-in and straight-line constraints; keep-outs are added to world geometry. A
straight-line constraint (`{"type": "straightLine", "tolerance": 0.02}`) takes a range
scope: at every sample from waypoint `from` to waypoint `to`, the robot center's distance
from the line through those two waypoints is at most `tolerance` (squared cross product
divided by the segment length), and its projection stays between the two ends (plus the
tolerance). It is a "user" constraint for the soft and elastic modes, so diagnostics name
it as `Constraint 'straightLine' (id)`. The initial guess follows the segment for every leg
in the range when the segment is clear in the roadmap, projecting guide waypoints onto it.
A straight line with a waypoint or zone scope, or whose ends coincide, is ignored with a
warning. It is rejected before solving if an obstacle or keep-out comes within the robot's
inradius of the segment, or if a fixed intermediate waypoint lies off the line. Zone membership is
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

If IPOPT reports the direct solve infeasible (`Infeasible_Problem_Detected` or
`Restoration_Failed`), an elastic probe runs next from the same guess (capped at 8 s). If it
converges with a clear violation (slack above 0.01 on a user, heading, stop or waypoint
constraint, or above 5 cm on an obstacle, wall or keep-in), the candidate stops there and
its probe becomes the diagnosis, so no second elastic solve runs. If the probe needs no
slack, its solution warm-starts a hard solve. Otherwise the ladder continues. In elastic
solves, moving a fixed waypoint costs 10 times as much as other slack, so the report blames
the conflicting constraint instead of moving the robot (for example parking it on a
point-at target).

Candidates run in separate processes by default. The fastest solution that passes the
swept check and all zone memberships is exported. If no candidate succeeds, the
closest-to-feasible probe, or a new elastic solve, measures constraint slack and ranks
actionable issues. Simple input errors are rejected before optimization:
- missing waypoints
- out-of-field or obstacle-overlapping fixed poses
- fixed headings that cannot satisfy a point-at target
- straight lines through obstacles, or fixed waypoints off a straight line
- fixed waypoints enclosed by obstacles

For enclosure, two fixed waypoints are in different connected regions of the free space for
the robot's inscribed circle, so no heading can get the robot through. Each check reports
the exact waypoint index, avoiding a long infeasible solve.

## Route candidates

Each segment's routes come from two configuration-space roadmaps: one for the robot's
circumscribed circle (it fits at any heading) and one for its inscribed circle (it fits when
turned square to a gap). Candidate 0 takes the shortest route from either roadmap on every
segment, so a gap only the aligned robot fits through, such as a trench a few cm wider than
the robot, is always tried. The optimizer only refines the route it is given, so a gap that
isn't offered is never found. The remaining candidates are the any-heading roadmap's k
homotopy-distinct routes, as before. The candidate set is therefore a superset of the
any-heading-only one, and adding candidate 0 can only make the best path faster. All
candidates run to completion, and the fastest verified path wins.

Before this, the inscribed-circle roadmap was only used when the any-heading one found no
route at all. With a 10 cm margin on the REBUILT trench wall, every candidate went over the
bump and U-turned into the trench (10.9 s instead of 8.7 s). On the benchmark, offering the
tight routes made 25 of 91 paths faster (up to 58%) and none slower.

## Speed

Measured on the benchmark, where the time goes and what keeps it short:

- **Linear algebra.** About 85% of IPOPT's time is factorizing the KKT system. With MUMPS
  the solver asks for the AMF ordering (`mumps_pivot_order = 2`). MUMPS's automatic choice
  (PORD) makes each iteration about twice as slow on these problems.
- **Warm re-solves.** Zone-membership and swept-collision re-solves start from a converged
  solution. The OCP records which rows of `g` belong to which constraint block and sample
  (`OCP._con`), and the re-solve starts from the previous multipliers matched block by
  block and sample by sample (`OCPOptions.dual_init`), with IPOPT's
  `warm_start_init_point`. New blocks and samples start at zero. A cold start from the same
  point walks away from the optimum and takes about as many iterations as the first solve.
  With the multipliers it takes about 40% fewer, and a re-solve of an unchanged problem
  takes a handful.
- **Stopping.** IPOPT also stops, as `Solved_To_Acceptable_Level`, once the path meets the
  same 1e-4 constraint-violation bound as a full solve and the objective has changed by
  less than 1e-4 (relative) for two iterations. That skips the final iterations spent
  polishing multipliers of a path that no longer moves.

Adaptive barrier updates (the quality-function oracle) cost a large share of each
iteration, but the alternatives were slower overall: monotone mu, and the probing and LOQO
oracles, took more iterations, and the latter two failed on long paths.

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
zone-scoped maximum velocity. The previous run validated all 91/91 feasible scenes
(0.594 s median, 3.208 s p90) but took up to 49 s to diagnose the enclosed-goal case
(infeasible p90 36.4 s). The current run adds the enclosure pre-check and the elastic
probe, along with the total-force current limit and the minimum obstacle separation. It
validates all 91/91 feasible scenes with 0.450 s median and 2.101 s p90 wall time, and
diagnoses all 4/4 infeasible cases with a p90 of 0.26 s (max 0.37 s).

The speed work and the route fix (see Speed and Route candidates above) were measured on
the same field and machine against the solver as of v0.4.0 (`before-speedup` in RESULTS.md).
Both validate 91/91 feasible scenes and diagnose 4/4 infeasible ones. Total path time fell
from 385.7 s to 363.4 s: 25 paths are faster (up to 58%, mostly trench routes) and none is
slower. Total wall time fell from 137.8 s to 78.3 s, and the slowest scene from 37.3 s to
7.4 s. On 100 unseen random scenes (seed 7), 25 paths are faster (up to 33%), none is
slower, and one scene that failed before now solves.

A failed solve is not deployment-ready; edit the path or constraint and generate again.
