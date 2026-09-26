import math

import numpy as np
import pytest

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.guess import Trap
from mayhem_solver.models import (Constraint, KeepOut, Marker, MaxVelocity, Obstacle, PointAt, Scope,
                                  Tolerance, Trajectory)
from mayhem_solver.pipeline import make_world, solve

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
