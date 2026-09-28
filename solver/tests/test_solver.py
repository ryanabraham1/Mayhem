import math

import numpy as np
import pytest
import shapely
from shapely.geometry import Polygon

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.guess import Trap
from mayhem_solver.models import (Constraint, KeepOut, Marker, MaxAcceleration, MaxAngularVelocity, MaxVelocity, Obstacle,
                                  PointAt, Project, RoughTerrain, Scope, StraightLine, Tolerance, Trajectory)
from mayhem_solver.pipeline import Solver, make_world, solve

from .conftest import wp


def arrays(out):
    s = out.samples
    get = lambda k: np.array([getattr(x, k) for x in s])
    return {k: get(k) for k in ("t", "x", "y", "heading", "vx", "vy", "omega", "ax", "ay", "alpha")}, s


def check_physics(project, out, tol=1e-3):
    d = build_drivetrain(project.robot)
    a, s = arrays(out)
    for k, smp in enumerate(s):
        c, sn = math.cos(smp.heading), math.sin(smp.heading)
        vrx, vry = c * smp.vx + sn * smp.vy, -sn * smp.vx + c * smp.vy
        for i, (mx, my) in enumerate(d.modules):
            vw = math.hypot(vrx - smp.omega * my, vry + smp.omega * mx)
            assert vw <= d.wheel_free_speed * (1 + tol)
            assert math.hypot(smp.fx[i], smp.fy[i]) <= d.friction_force * (1 + tol)
        assert math.isclose(sum(smp.fx), d.mass * smp.ax, rel_tol=1e-3, abs_tol=1e-2)


def test_straight_line_matches_trapezoid(project):
    t = Trajectory(name="s", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    r = solve(project, t, parallel=False)
    assert r.success
    d = build_drivetrain(project.robot)
    ideal = Trap(6.0, d.max_speed, d.max_linear_accel).T
    # the optimizer respects the torque-speed curve, so it can only be slower than the ideal
    assert ideal * 0.99 < r.output.stats.total_time < ideal * 1.35
    check_physics(project, r.output)
    a, _ = arrays(r.output)
    assert abs(a["x"][-1] - 8) < 1e-4 and abs(a["vx"][-1]) < 1e-4


def test_obstacle_path_is_collision_free(box_project):
    t = Trajectory(name="o", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, math.pi / 2, stop=True)])
    r = solve(box_project, t, parallel=False)
    assert r.success
    check_physics(box_project, r.output)
    world = make_world(box_project, t)
    d = build_drivetrain(box_project.robot)
    a, _ = arrays(r.output)
    polys = geo.bumper_polygons(d.bumper_corners, a["x"], a["y"], a["heading"])
    for p in polys:
        assert not p.intersects(world.pieces[0].poly)


def test_waypoint_inside_obstacle_is_reported(box_project):
    t = Trajectory(name="bad", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 5, 3.5, stop=True)])
    r = solve(box_project, t, parallel=False)
    assert not r.success
    assert any("overlap" in i.message and i.waypoint == 1 for i in r.issues)


def test_infeasible_heading_is_diagnosed(project):
    t = Trajectory(name="inf", waypoints=[
        wp(0, 2, 4, 0, stop=True),
        wp(1, 5, 4, heading_mode="free"),
        wp(2, 8, 4, 0, stop=True)])
    t.constraints = [Constraint(id="pa", scope=Scope(kind="range", **{"from": 0, "to": 2}),
                                data=PointAt(x=5, y=7, tolerance=0.02))]
    t.settings.time_limit = 20
    r = solve(project, t, parallel=False)
    assert not r.success
    assert any("heading" in i.message.lower() or "pointAt" in i.message for i in r.issues)


def test_tolerance_guide_splits_markers(project):
    t = Trajectory(name="m", waypoints=[
        wp(0, 1.5, 1.5, stop=True),
        wp(1, 4, 5, translation_mode="guide", heading_mode="free"),
        wp(2, 7, 4, 1.0, stop=True, split=True, tolerance=Tolerance(kind="circle", radius=0.3)),
        wp(3, 10, 2, 0, stop=True)])
    t.markers = [Marker(id="a", name="intake", waypoint=1, offset=0.1),
                 Marker(id="b", name="shoot", waypoint=2, end_waypoint=3, must_hit=True)]
    r = solve(project, t, parallel=False)
    assert r.success
    out = r.output
    assert len(out.splits) == 1
    k = out.splits[0]
    smp = out.samples[k]
    assert math.hypot(smp.x - 7, smp.y - 4) <= 0.3 + 1e-4
    assert abs(smp.vx) < 1e-4
    names = [e.name for e in out.events]
    assert names == ["intake", "shoot"]
    shoot = out.events[1]
    assert shoot.end_t is not None and shoot.end_t > shoot.t
    assert any(abs(m - shoot.t) < 1e-3 for m in out.recovery.must_hit_times)


def test_max_velocity_zone_and_keepout(project):
    t = Trajectory(name="z", waypoints=[wp(0, 1.5, 4, stop=True), wp(1, 12, 4, stop=True)])
    t.constraints = [
        Constraint(id="slow", scope=Scope(kind="zone", region=[(5, 0), (7, 0), (7, 8), (5, 8)]),
                   data=MaxVelocity(value=1.0)),
        Constraint(id="ko", data=KeepOut(points=[(9, 3), (10, 3), (10, 5), (9, 5)])),
    ]
    r = solve(project, t, parallel=False)
    assert r.success
    a, _ = arrays(r.output)
    inside = (a["x"] > 5.1) & (a["x"] < 6.9)
    assert inside.any()
    assert np.all(np.hypot(a["vx"], a["vy"])[inside] <= 1.0 + 1e-3)
    d = build_drivetrain(project.robot)
    polys = geo.bumper_polygons(d.bumper_corners, a["x"], a["y"], a["heading"])
    from shapely.geometry import box
    assert not any(p.intersects(box(9, 3, 10, 5)) for p in polys)


def test_parallel_candidates(box_project):
    t = Trajectory(name="p", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)])
    progress = []
    r = solve(box_project, t, progress=progress.append, parallel=True)
    assert r.success
    assert any(m["type"] == "candidates" for m in progress)


def test_parallel_candidates_ignore_wall_clock_jumps(box_project, monkeypatch):
    # Waking from sleep (or an NTP step) moves the wall clock but not the monotonic one. The
    # parallel runner once kept its deadline on the wall clock, so closing the lid mid-solve
    # dropped every candidate and reported "No candidate routes could be generated".
    import time

    progress = []
    real = time.time
    # jump an hour once the candidate processes are running (the first message is the route list)
    monkeypatch.setattr(time, "time", lambda: real() + (3600 if len(progress) > 1 else 0))
    t = Trajectory(name="p", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)])
    r = solve(box_project, t, progress=progress.append, parallel=True)
    assert r.success, [i.message for i in r.issues]


def test_swept_refinement_resolves_a_reported_interval(project, monkeypatch):
    original_verify = Solver.verify
    calls = 0

    def report_once(self, sol):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [geo.Collision(0, 0.0, float(sol.x[0]), float(sol.y[0]), "synthetic", 0.01)]
        return original_verify(self, sol)

    monkeypatch.setattr(Solver, "verify", report_once)
    t = Trajectory(name="refine", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    r = solve(project, t, parallel=False)
    assert r.success
    assert calls > 1
    assert any("densifying" in attempt for attempt in r.output.stats.attempts)


def test_rough_terrain_keeps_speed_and_exports_spans(project):
    """Rough terrain without caps must not change the plan, only export the covered time."""
    wps = [wp(0, 2, 4, stop=True), wp(1, 10, 4, stop=True)]
    plain = solve(project, Trajectory(name="p", waypoints=wps), parallel=False)
    region = [(5.5, 3), (6.5, 3), (6.5, 5), (5.5, 5)]
    t = Trajectory(name="b", waypoints=wps, constraints=[
        Constraint(id="bump", scope=Scope(kind="zone", region=region),
                   data=RoughTerrain(expected_speed=0.6, feedback_scale=0.25))])
    r = solve(project, t, parallel=False)
    assert plain.success and r.success
    assert r.output.stats.total_time == pytest.approx(plain.output.stats.total_time, rel=0.02)
    assert len(r.output.terrain) == 1
    span = r.output.terrain[0]
    a, _ = arrays(r.output)
    x_at = lambda tt: np.interp(tt, a["t"], a["x"])
    # the span covers the robot center crossing the zone (0.05 m buffer, half-sample widening)
    assert x_at(span.t) <= 5.5 and x_at(span.end_t) >= 6.5
    assert x_at(span.t) > 5.0 and x_at(span.end_t) < 7.0
    assert span.feedback_scale == 0.25 and span.expected_speed == 0.6
    assert span.expected_delay == pytest.approx((span.end_t - span.t) * (1 / 0.6 - 1))


def _direct_solve(project, t):
    from mayhem_solver.guess import build_guess
    from mayhem_solver.pipeline import candidate_routes

    solver = Solver(project, t)
    guess = build_guess(t, candidate_routes(t, solver.dt, solver.world, 1)[0], solver.dt)
    return solver, solver.run_ocp(guess, "hard", "direct")


def test_constraint_blocks_cover_every_row(box_project):
    from mayhem_solver.ocp import OCP

    built = []
    original = OCP._build

    def build(self, pairs):
        original(self, pairs)
        built.append((self._ng, self.opti.ng))

    t = Trajectory(name="b", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, math.pi / 2, stop=True)])
    OCP._build = build
    try:
        _direct_solve(box_project, t)
    finally:
        OCP._build = original
    assert built and all(ng == opti_ng for ng, opti_ng in built)


def test_warm_resolve_with_duals_stays_at_the_optimum(box_project):
    t = Trajectory(name="w", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, math.pi / 2, stop=True)])
    solver, res = _direct_solve(box_project, t)
    assert res.success and res.duals is not None
    again = solver.run_ocp(res.solution, "hard", "again", pairs=solver._last_pairs, warm=True)
    assert again.success
    # a cold start from the same point walks away and takes about as long as the first solve
    assert again.iterations <= max(10, res.iterations // 3)
    assert again.solution.total_time == pytest.approx(res.solution.total_time, rel=1e-3)


def test_tight_trench_is_offered_as_a_route():
    """A gap narrower than the robot's circumscribed circle but wider than the robot (when
    turned square to it) must still be tried: the optimizer only refines the routes it gets.
    Regression: with a 10 cm margin on the REBUILT trench wall, every candidate went around
    over the bump and U-turned into the trench."""
    from benchmarks.scenarios import rebuilt_project

    project = rebuilt_project()
    for o in project.field.obstacles:
        if o.name == "Blue Trench Wall (right)":
            o.margin = 0.1
    d = build_drivetrain(project.robot)
    wall = next(o for o in project.field.obstacles if o.name == "Blue Trench Wall (right)")
    gap = min(y for _, y in wall.points) - wall.margin - project.field.wall_margin
    assert 2 * d.inradius < gap < 2 * (d.circumradius + 0.02)  # only the aligned robot fits
    t = Trajectory(name="trench", waypoints=[wp(0, 6.65, 0.75, stop=True), wp(1, 4.61, 0.61),
                                             wp(2, 2.4, 0.97, stop=True)])
    r = solve(project, t, parallel=False)
    assert r.success, r.issues
    a, _ = arrays(r.output)
    assert a["y"].max() < gap  # stayed under the trench wall instead of looping over the bump


def test_limit_check_measures_user_limits_on_the_solution(box_project):
    from mayhem_solver.ocp import user_limit_violations

    # goes around the box (off the straight line) and turns a quarter turn
    t = Trajectory(name="c", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, math.pi / 2, stop=True)])
    _, res = _direct_solve(box_project, t)
    assert res.success
    everywhere = Scope(kind="range", **{"from": 0, "to": 1})
    t.constraints = [Constraint(id="v", scope=everywhere, data=MaxVelocity(value=0.5)),
                     Constraint(id="a", scope=everywhere, data=MaxAcceleration(value=0.5)),
                     Constraint(id="w", scope=everywhere, data=MaxAngularVelocity(value=0.1)),
                     Constraint(id="line", scope=everywhere, data=StraightLine(tolerance=0.02))]
    bad = user_limit_violations(t, res.solution)
    assert [b.split("(")[1].split(")")[0] for b in bad] == ["v", "a", "w", "line"]
    t.constraints = [Constraint(id="v", scope=everywhere, data=MaxVelocity(value=100)),
                     Constraint(id="w", scope=everywhere, data=MaxAngularVelocity(value=100))]
    assert user_limit_violations(t, res.solution) == []


def test_limit_check_fails_a_converged_solve(box_project, monkeypatch):
    """A solve whose rows converged but whose samples break a user limit (a mis-scaled or
    mis-signed row) must fail rather than ship."""
    import mayhem_solver.pipeline as pipeline

    t = Trajectory(name="c", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)])
    solver, res = _direct_solve(box_project, t)
    assert res.success
    monkeypatch.setattr(pipeline, "user_limit_violations", lambda traj, sol: ["'maxVelocity' (v) reaches 9 m/s"])
    res = solver.polish(res)
    assert not res.success and res.status == "User limit check failed"
    assert any(line.startswith("limit check:") for line in solver.log)


@pytest.mark.slow
def test_small_angular_velocity_cap_converges_on_every_candidate():
    """Regression (REBUILT, intake out, rough terrain, straight line): a 0.01 rad/s zone cap on a
    leg the initial guess turns through. Written as ω²/limit² - 1 the cap was violated ~1e3 by the
    guess and IPOPT stalled on that row's curvature; two of three candidates ran to the time limit."""
    import json
    from pathlib import Path

    data = json.loads((Path(__file__).parent / "data" / "angular_cap_rebuilt.json").read_text())
    project = Project.model_validate(data["project"])
    t = Trajectory.model_validate(data["trajectory"])
    t.settings.time_limit = 30
    r = solve(project, t, parallel=True)
    assert r.success, [i.message for i in r.issues]
    stats = r.output.stats
    assert not any("CpuTime" in a or "did not finish" in a for a in stats.attempts), stats.attempts
    cap = next(c for c in t.constraints if isinstance(c.data, MaxAngularVelocity))
    a, _ = arrays(r.output)
    inside = shapely.contains_xy(Polygon(cap.scope.region).buffer(0.05), a["x"], a["y"])
    assert inside.any()
    assert np.abs(a["omega"][inside]).max() <= cap.data.value * (1 + 1e-3)
