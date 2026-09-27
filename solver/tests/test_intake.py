"""Extended intake: a second collision part that only counts where the path says it is out."""

import math

import numpy as np

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import Constraint, Intake, IntakeExtended, Scope, Trajectory
from mayhem_solver.pipeline import input_hash, make_world, solve

from .conftest import wp


def _intake_project(box_project, **kw):
    box_project.robot.intake = Intake(**{"side": "right", "extension": 0.6, **kw})
    return box_project


def _extended(scope: Scope) -> Constraint:
    return Constraint(id="in", scope=scope, data=IntakeExtended())


def test_extended_intake_clears_obstacle(box_project):
    """Driving past the box with the intake out toward it must keep the intake clear too."""
    p = _intake_project(box_project)
    # bumpers alone clear the box (top at y=4.5) by 0.45 m; a 0.6 m right-side intake would not
    wps = [wp(0, 2, 5.4, stop=True), wp(1, 8, 5.4, stop=True)]
    plain = solve(p, Trajectory(name="p", waypoints=wps), parallel=False)
    t = Trajectory(name="i", waypoints=wps,
                   constraints=[_extended(Scope(kind="range", **{"from": 0, "to": 1}))])
    r = solve(p, t, parallel=False)
    assert plain.success and r.success
    assert not plain.output.intake and len(r.output.intake) == 1
    span = r.output.intake[0]
    assert span.t == 0 and math.isclose(span.end_t, r.output.stats.total_time)

    d = build_drivetrain(p.robot)
    world = make_world(p, t)
    box = world.pieces[0].poly
    s = r.output.samples
    xs, ys, th = (np.array([getattr(q, k) for q in s]) for k in ("x", "y", "heading"))
    assert not any(q.intersects(box) for q in geo.bumper_polygons(d.intake_corners, xs, ys, th))
    # the plain plan would have hit the box with the intake out
    s0 = plain.output.samples
    x0, y0, h0 = (np.array([getattr(q, k) for q in s0]) for k in ("x", "y", "heading"))
    assert any(q.intersects(box) for q in geo.bumper_polygons(d.intake_corners, x0, y0, h0))


def test_intake_only_counts_inside_its_range(box_project):
    """With the intake out only before the box, the path past it matches the plain plan."""
    p = _intake_project(box_project)
    wps = [wp(0, 1.5, 5.4, stop=True), wp(1, 3, 5.4), wp(2, 8, 5.4, stop=True)]
    plain = solve(p, Trajectory(name="p", waypoints=wps), parallel=False)
    t = Trajectory(name="i", waypoints=wps,
                   constraints=[_extended(Scope(kind="range", **{"from": 0, "to": 1}))])
    r = solve(p, t, parallel=False)
    assert plain.success and r.success
    assert r.output.stats.total_time < plain.output.stats.total_time * 1.05
    assert r.output.intake[0].end_t < r.output.waypoint_times[2]


def test_waypoint_with_intake_in_obstacle_is_reported(box_project):
    p = _intake_project(box_project)
    t = Trajectory(name="bad", waypoints=[wp(0, 2, 5.4, stop=True), wp(1, 5, 5.4, stop=True)],
                   constraints=[_extended(Scope(kind="waypoint", **{"from": 1}))])
    r = solve(p, t, parallel=False)
    assert not r.success
    assert any("intake overlaps 'Box'" in i.message and i.waypoint == 1 for i in r.issues)


def test_intake_settings_only_restale_paths_that_use_it(box_project):
    p = _intake_project(box_project)
    wps = [wp(0, 2, 5.4, stop=True), wp(1, 8, 5.4, stop=True)]
    plain = Trajectory(name="p", waypoints=wps)
    used = Trajectory(name="i", waypoints=wps, constraints=[_extended(Scope(kind="range", **{"from": 0, "to": 1}))])
    before = input_hash(p, plain), input_hash(p, used)
    p.robot.intake.extension = 0.4
    assert input_hash(p, plain) == before[0]
    assert input_hash(p, used) != before[1]


def test_intake_rectangle_sides(project):
    b = project.robot.bumper
    for side, key in (("front", lambda c: c[0]), ("back", lambda c: -c[0]),
                      ("left", lambda c: c[1]), ("right", lambda c: -c[1])):
        project.robot.intake = Intake(side=side, extension=0.25, width=0.3, offset=0.1)
        corners = build_drivetrain(project.robot).intake_corners
        edge = {"front": b.front, "back": b.back, "left": b.left, "right": b.right}[side]
        assert math.isclose(max(map(key, corners)), edge + 0.25)
        assert math.isclose(min(map(key, corners)), edge)
    project.robot.intake = Intake(extension=0)
    assert build_drivetrain(project.robot).intake_corners == ()
