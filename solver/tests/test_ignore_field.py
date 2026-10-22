"""ignoreField: a waypoint range where the solver skips the field's obstacles (and optionally walls)."""

import numpy as np

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import Constraint, IgnoreField, KeepOut, Scope, Trajectory
from mayhem_solver.pipeline import make_world, solve

from .conftest import wp


def _ignore(a: int, b: int, **kw) -> Constraint:
    kind = "waypoint" if a == b else "range"
    return Constraint(id="ign", scope=Scope(kind=kind, **{"from": a, "to": b}), data=IgnoreField(**kw))


def _hits_box(project, traj, r) -> bool:
    d = build_drivetrain(project.robot)
    box = next(p for p in make_world(project, traj).pieces if p.field).poly
    s = r.output.samples
    xs, ys, th = (np.array([getattr(q, k) for q in s]) for k in ("x", "y", "heading"))
    return any(q.intersects(box) for q in geo.bumper_polygons(d.bumper_corners, xs, ys, th))


def test_ignored_range_drives_through_obstacle(box_project):
    wps = [wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)]
    plain = Trajectory(name="p", waypoints=wps)
    through = Trajectory(name="i", waypoints=wps, constraints=[_ignore(0, 1)])
    rp, ri = solve(box_project, plain, parallel=False), solve(box_project, through, parallel=False)
    assert rp.success and ri.success
    assert not _hits_box(box_project, plain, rp)
    assert _hits_box(box_project, through, ri)
    assert ri.output.stats.total_time < rp.output.stats.total_time
    assert max(abs(q.y - 3.5) for q in ri.output.samples) < 0.05


def test_obstacle_still_counts_outside_the_range(box_project):
    wps = [wp(0, 2, 3.5, stop=True), wp(1, 3, 3.5), wp(2, 8, 3.5, stop=True)]
    t = Trajectory(name="i", waypoints=wps, constraints=[_ignore(0, 1)])
    r = solve(box_project, t, parallel=False)
    assert r.success
    assert not _hits_box(box_project, t, r)


def test_waypoint_inside_obstacle_allowed_when_ignored(box_project):
    wps = [wp(0, 2, 3.5, stop=True), wp(1, 5, 3.5, stop=True)]
    bad = solve(box_project, Trajectory(name="b", waypoints=wps), parallel=False)
    assert not bad.success and any("overlap 'Box'" in i.message for i in bad.issues)
    ok = solve(box_project, Trajectory(name="o", waypoints=wps, constraints=[_ignore(1, 1)]), parallel=False)
    assert ok.success


def test_path_keep_outs_still_apply(box_project):
    wps = [wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)]
    ko = Constraint(id="ko", data=KeepOut(points=[(4.8, 3.0), (5.2, 3.0), (5.2, 4.0), (4.8, 4.0)]))
    t = Trajectory(name="k", waypoints=wps, constraints=[_ignore(0, 1), ko])
    r = solve(box_project, t, parallel=False)
    assert r.success
    d = build_drivetrain(box_project.robot)
    poly = next(p for p in make_world(box_project, t).pieces if not p.field).poly
    s = r.output.samples
    xs, ys, th = (np.array([getattr(q, k) for q in s]) for k in ("x", "y", "heading"))
    assert not any(q.intersects(poly) for q in geo.bumper_polygons(d.bumper_corners, xs, ys, th))


def test_walls_only_ignored_when_asked(project):
    # bumpers poke past the wall at y=0
    wps = [wp(0, 2, 0.2, stop=True), wp(1, 6, 1.5, stop=True)]
    obs_only = solve(project, Trajectory(name="a", waypoints=wps, constraints=[_ignore(0, 0)]), parallel=False)
    assert not obs_only.success and any("leave the field" in i.message for i in obs_only.issues)
    walls = solve(project, Trajectory(name="w", waypoints=wps, constraints=[_ignore(0, 0, walls=True)]),
                  parallel=False)
    assert walls.success
    assert walls.output.samples[0].y < 0.25


def test_zone_scope_is_warned_and_ignored(box_project):
    c = Constraint(id="z", scope=Scope(kind="zone", region=[(3, 2), (7, 2), (7, 5), (3, 5)]), data=IgnoreField())
    wps = [wp(0, 2, 3.5, stop=True), wp(1, 8, 3.5, stop=True)]
    t = Trajectory(name="z", waypoints=wps, constraints=[c])
    r = solve(box_project, t, parallel=False)
    assert r.success and not _hits_box(box_project, t, r)
    assert any("Ignore-field" in i.message for i in r.issues)
