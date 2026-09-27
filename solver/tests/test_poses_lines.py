"""Pose variables, the straight-line constraint and fast infeasibility reports."""

import math
import time

import numpy as np

from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import (Constraint, KeepOut, PointAt, PoseVariable, Scope, StraightLine, Trajectory)
from mayhem_solver.pipeline import candidate_routes, input_hash, make_world, resolve_poses, solve, validate

from .conftest import wp


def rng(a, b):
    return Scope(kind="range", **{"from": a, "to": b})


def issues_of(project, traj):
    return validate(project, traj, build_drivetrain(project.robot), make_world(project, traj))


# ---------------------------------------------------------------------------
# pose variables
# ---------------------------------------------------------------------------


def test_resolve_poses_replaces_linked_waypoints(project):
    project.poses = [PoseVariable(id="shoot", name="Shooting spot", x=6.0, y=5.0, heading=1.0)]
    t = Trajectory(name="p", waypoints=[wp(0, 2, 2, stop=True), wp(1, 9, 9, 0.2, pose_ref="shoot", stop=True)])
    r = resolve_poses(project, t)
    assert (r.waypoints[1].x, r.waypoints[1].y, r.waypoints[1].heading) == (6.0, 5.0, 1.0)
    assert (r.waypoints[0].x, r.waypoints[0].y) == (2, 2)
    assert (t.waypoints[1].x, t.waypoints[1].y) == (9, 9)  # input untouched
    assert resolve_poses(project, r) == r  # idempotent


def test_input_hash_follows_pose_variable(project):
    project.poses = [PoseVariable(id="shoot", name="Shooting spot", x=6.0, y=5.0)]
    t = Trajectory(name="p", waypoints=[wp(0, 2, 2), wp(1, 0, 0, pose_ref="shoot")])
    plain = Trajectory(name="p", waypoints=[wp(0, 2, 2), wp(1, 6.0, 5.0)])
    h = input_hash(project, t)
    # a linked waypoint hashes like a plain one at the resolved pose (old files keep their hashes)
    assert h == input_hash(project, plain)
    # unrelated pose variables don't make the path stale
    project.poses.append(PoseVariable(id="other", name="Other", x=1, y=1))
    assert input_hash(project, t) == h
    # moving the variable does
    project.poses[0].x = 6.5
    assert input_hash(project, t) != h


def test_unknown_pose_ref_warns_and_falls_back(project):
    t = Trajectory(name="p", waypoints=[wp(0, 2, 4, stop=True), wp(1, 6, 4, pose_ref="gone", stop=True)])
    warn = [i for i in issues_of(project, t) if i.severity == "warning"]
    assert any(i.waypoint == 1 and "missing pose variable" in i.message for i in warn)
    r = solve(project, t, parallel=False)
    assert r.success
    assert any("missing pose variable" in i.message for i in r.issues)
    end = r.output.samples[-1]
    assert abs(end.x - 6) < 1e-3 and abs(end.y - 4) < 1e-3


def test_solve_uses_pose_variable(project):
    project.poses = [PoseVariable(id="shoot", name="Shooting spot", x=5.0, y=3.0, heading=0.5)]
    t = Trajectory(name="p", waypoints=[wp(0, 2, 4, stop=True), wp(1, 9, 7, 0, pose_ref="shoot", stop=True)])
    r = solve(project, t, parallel=False)
    assert r.success
    end = r.output.samples[-1]
    assert abs(end.x - 5) < 1e-3 and abs(end.y - 3) < 1e-3 and abs(end.heading - 0.5) < 1e-3
    assert r.output.input_hash == input_hash(project, t)


# ---------------------------------------------------------------------------
# straight line
# ---------------------------------------------------------------------------


def test_straight_line_is_followed(project):
    # the guide waypoint pulls the default route off the line; the constraint keeps it straight
    t = Trajectory(name="s", waypoints=[
        wp(0, 2, 2, 0, stop=True),
        wp(1, 5, 4, translation_mode="guide", heading_mode="free"),
        wp(2, 8, 2, math.pi / 2, stop=True)])
    t.constraints = [Constraint(id="line", scope=rng(0, 2), data=StraightLine(tolerance=0.02))]
    d = build_drivetrain(project.robot)
    routes = candidate_routes(t, d, make_world(project, t), 3)
    assert all(abs(p[1] - 2) < 1e-9 for c in routes for seg in c for p in seg)
    r = solve(project, t, parallel=False)
    assert r.success, r.issues
    x = np.array([s.x for s in r.output.samples])
    y = np.array([s.y for s in r.output.samples])
    assert np.all(np.abs(y - 2) <= 0.02 + 1e-4)
    assert np.all((x >= 2 - 0.02 - 1e-4) & (x <= 8 + 0.02 + 1e-4))


def test_straight_line_through_obstacle_is_rejected(box_project):
    t = Trajectory(name="s", waypoints=[wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)])
    t.constraints = [Constraint(id="line", scope=rng(0, 1), data=StraightLine())]
    r = solve(box_project, t, parallel=False)
    assert not r.success
    assert any(i.severity == "error" and "Straight-line constraint 'line' passes through obstacle 'Box'" in i.message
               for i in r.issues)


def test_straight_line_through_keepout_is_rejected(project):
    t = Trajectory(name="s", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    t.constraints = [Constraint(id="line", scope=rng(0, 1), data=StraightLine()),
                     Constraint(id="ko", data=KeepOut(points=[(4.5, 4.3), (5.5, 4.3), (5.5, 5.5), (4.5, 5.5)]))]
    assert any("passes through obstacle 'Keep-out ko'" in i.message for i in issues_of(project, t))


def test_straight_line_with_wrong_scope_is_ignored_with_warning(project):
    t = Trajectory(name="s", waypoints=[wp(0, 2, 4, stop=True), wp(1, 6, 4, stop=True)])
    t.constraints = [Constraint(id="line", scope=Scope(kind="waypoint", **{"from": 0}), data=StraightLine())]
    issues = issues_of(project, t)
    assert any(i.severity == "warning" and "'line'" in i.message and "range" in i.message for i in issues)
    assert not any(i.severity == "error" for i in issues)
    same = Trajectory(name="s", waypoints=[wp(0, 2, 4, stop=True), wp(1, 2, 4, 1.0, stop=True)])
    same.constraints = [Constraint(id="line", scope=rng(0, 1), data=StraightLine())]
    assert any(i.severity == "warning" and "same point" in i.message for i in issues_of(project, same))


def test_waypoint_off_straight_line_is_rejected(project):
    t = Trajectory(name="s", waypoints=[wp(0, 2, 2, stop=True), wp(1, 5, 3), wp(2, 8, 2, stop=True)])
    t.constraints = [Constraint(id="line", scope=rng(0, 2), data=StraightLine())]
    assert any(i.severity == "error" and i.waypoint == 1 and "off the line" in i.message
               for i in issues_of(project, t))


# ---------------------------------------------------------------------------
# fast infeasibility reports
# ---------------------------------------------------------------------------


def test_enclosed_goal_is_rejected_before_solving(project):
    t = Trajectory(name="e", waypoints=[wp(0, 7.0, 2.0, stop=True), wp(1, 10.0, 4.0, stop=True)])
    t.constraints = [
        Constraint(id="k1", data=KeepOut(points=[(8.8, 2.8), (11.2, 2.8), (11.2, 3.0), (8.8, 3.0)])),
        Constraint(id="k2", data=KeepOut(points=[(8.8, 5.0), (11.2, 5.0), (11.2, 5.2), (8.8, 5.2)])),
        Constraint(id="k3", data=KeepOut(points=[(8.8, 3.0), (9.0, 3.0), (9.0, 5.0), (8.8, 5.0)])),
        Constraint(id="k4", data=KeepOut(points=[(11.0, 3.0), (11.2, 3.0), (11.2, 5.0), (11.0, 5.0)]))]
    t0 = time.monotonic()
    r = solve(project, t, parallel=False)
    assert time.monotonic() - t0 < 2.0
    assert not r.success
    assert any(i.waypoint == 1 and "enclosed" in i.message and "Keep-out k3" in i.message for i in r.issues)


def test_conflicting_point_at_is_diagnosed_quickly(project):
    t = Trajectory(name="c", waypoints=[wp(0, 7.0, 2.0, heading_mode="free", stop=True),
                                        wp(1, 10.0, 2.0, heading_mode="free", stop=True)])
    t.constraints = [Constraint(id="pa1", scope=rng(0, 1), data=PointAt(x=8.5, y=7.0, tolerance=0.05)),
                     Constraint(id="pa2", scope=rng(0, 1), data=PointAt(x=8.5, y=-3.0, tolerance=0.05))]
    t0 = time.monotonic()
    r = solve(project, t, parallel=False)
    assert time.monotonic() - t0 < 10.0
    assert not r.success
    assert "pointAt" in r.issues[0].message


# ---------------------------------------------------------------------------
# formulation regressions
# ---------------------------------------------------------------------------


def test_low_current_limit_does_not_weave(project):
    project.robot.motor.current_limit = 40.0
    t = Trajectory(name="c", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    r = solve(project, t, parallel=False)
    assert r.success, r.issues
    d = build_drivetrain(project.robot)
    for s in r.output.samples:
        assert abs(s.y - 4) <= 0.01
        for fx, fy in zip(s.fx, s.fy):
            assert math.hypot(fx, fy) <= d.wheel_current_force * (1 + 1e-3)


def test_zero_margin_obstacle_is_not_crossed():
    from shapely.geometry import box

    from mayhem_solver import geometry as geo
    from mayhem_solver.models import Obstacle, Project

    p = Project()
    p.field.obstacles = [Obstacle(id="bump", name="Bump", margin=0.0,
                                  points=[(4.5, 3.5), (5.5, 3.5), (5.5, 4.5), (4.5, 4.5)])]
    t = Trajectory(name="z", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    r = solve(p, t, parallel=False)
    assert r.success, r.issues
    d = build_drivetrain(p.robot)
    s = r.output.samples
    xs, ys, th = (np.array([getattr(q, k) for q in s]) for k in ("x", "y", "heading"))
    # samples plus constant-acceleration poses between them
    ts = np.array([q.t for q in s])
    vx, vy, w, ax, ay, al = (np.array([getattr(q, k) for q in s]) for k in ("vx", "vy", "omega", "ax", "ay", "alpha"))
    px, py, pth = [xs], [ys], [th]
    for f in (0.25, 0.5, 0.75):
        hh = np.diff(ts) * f
        px.append(xs[:-1] + vx[:-1] * hh + 0.5 * ax[:-1] * hh ** 2)
        py.append(ys[:-1] + vy[:-1] * hh + 0.5 * ay[:-1] * hh ** 2)
        pth.append(th[:-1] + w[:-1] * hh + 0.5 * al[:-1] * hh ** 2)
    polys = geo.bumper_polygons(d.bumper_corners, np.concatenate(px), np.concatenate(py), np.concatenate(pth))
    assert not any(q.intersects(box(4.5, 3.5, 5.5, 4.5)) for q in polys)


def test_zero_margin_separation_is_not_degenerate():
    """With margin 0 the plane n = 0, b = 0 used to satisfy every separation constraint."""
    from mayhem_solver import geometry as geo
    from mayhem_solver.guess import build_guess
    from mayhem_solver.models import Obstacle, Project
    from mayhem_solver.ocp import OCP, OCPOptions

    p = Project()
    p.field.obstacles = [Obstacle(id="bump", name="Bump", margin=0.0,
                                  points=[(4.5, 3.5), (5.5, 3.5), (5.5, 4.5), (4.5, 4.5)])]
    t = Trajectory(name="z", waypoints=[wp(0, 2, 4, stop=True), wp(1, 8, 4, stop=True)])
    d = build_drivetrain(p.robot)
    world = make_world(p, t)
    g = build_guess(t, [[(2, 4), (8, 4)]], d)  # straight through the obstacle
    zero_planes = {(0, k): np.zeros(3) for k in range(g.K)}
    res = OCP(d, world, t, g, {0: list(range(g.K))}, OCPOptions(plane_init=zero_planes)).solve()
    assert res.success
    s = res.solution
    polys = geo.bumper_polygons(d.bumper_corners, s.x, s.y, s.th)
    assert not any(q.intersects(world.pieces[0].poly) for q in polys)
