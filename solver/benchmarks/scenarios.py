"""Reproducible benchmark scenarios on the 2026 REBUILT field.

Two groups:
  * ``random``: seeded random autos (2-10 waypoints, random headings, mixed stop /
    pass-through, point-at-hub ranges, velocity zones, tolerance waypoints, extra
    keep-out polygons). Every waypoint's bumper footprint is checked to be clear.
  * ``hard``: a hand-written corpus of the cases that break other generators
    (trench openings, hub circuits, poses flush against the tower / walls / hub,
    long autos, sharp reversals).

Every scenario is generated from its own ``random.Random`` stream, so a scenario's
content depends only on (seed, index), never on how many scenarios are requested.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from importlib import resources

from shapely.geometry import Polygon, box

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import (
    Constraint,
    Field_,
    KeepOut,
    MaxAcceleration,
    MaxVelocity,
    PointAt,
    Project,
    Scope,
    Tolerance,
    Trajectory,
    Waypoint,
)

L, W = 16.541, 8.0692
BLUE_HUB = (4.62565, 4.0346)
RED_HUB = (L - BLUE_HUB[0], W - BLUE_HUB[1])
# Trench openings: between the field wall and the trench wall, 1.2787 m wide.
TRENCH_Y_LO = 0.64  # center line of the lower openings
TRENCH_Y_HI = W - 0.64


def rebuilt_project() -> Project:
    fld = Field_.model_validate_json((resources.files("mayhem_solver") / "fields/rebuilt-2026.json").read_text())
    return Project(field=fld)


@dataclass
class Scenario:
    name: str
    group: str  # "random" | "hard" | "infeasible"
    traj: Trajectory
    tags: list[str] = field(default_factory=list)
    project: Project | None = None  # None -> default REBUILT project
    # infeasible group only: the report must contain one of these words, and (if set)
    # an issue must point at this waypoint index.
    expect_keywords: list[str] = field(default_factory=list)
    expect_waypoint: int | None = None


def _wp(i, x, y, h=0.0, **kw) -> Waypoint:
    return Waypoint(id=f"w{i}", x=float(x), y=float(y), heading=float(h), **kw)


# ---------------------------------------------------------------------------
# footprint checks
# ---------------------------------------------------------------------------


class Checker:
    def __init__(self, project: Project, extra_polys: list[Polygon] | None = None, clearance: float = 0.02):
        self.dt = build_drivetrain(project.robot)
        self.world = geo.build_world(project.field)
        self.polys = [(p.poly, p.margin) for p in self.world.pieces]
        for p in extra_polys or []:
            self.polys.append((p, 0.03))
        self.clearance = clearance

    def free(self, x, y, th, clearance: float | None = None) -> bool:
        c = self.clearance if clearance is None else clearance
        rob = geo.bumper_polygon(self.dt.bumper_corners, x, y, th)
        minx, miny, maxx, maxy = rob.bounds
        wm = self.world.wall_margin + c
        if minx < wm or miny < wm or maxx > L - wm or maxy > W - wm:
            return False
        return all(rob.distance(p) >= m + c for p, m in self.polys)


def check_waypoints(project: Project, traj: Trajectory) -> list[str]:
    """Footprint errors for fixed-pose waypoints (used to vet the hand corpus)."""
    extra = [Polygon(c.data.points) for c in traj.constraints if isinstance(c.data, KeepOut)]
    chk = Checker(project, extra, clearance=0.0)
    bad = []
    for j, w in enumerate(traj.waypoints):
        if w.heading_mode == "fixed" and w.tolerance.kind == "none" and not chk.free(w.x, w.y, w.heading):
            bad.append(f"waypoint {j + 1} ({w.x:.3f}, {w.y:.3f}) collides")
    return bad


# ---------------------------------------------------------------------------
# random scenarios
# ---------------------------------------------------------------------------


def _hub_heading(x, y, hub):
    return math.atan2(hub[1] - y, hub[0] - x)


def random_scenario(seed: int, i: int, project: Project) -> Scenario:
    rng = random.Random(f"mayhem-bench-{seed}-{i}")
    chk = Checker(project)
    n = rng.randint(2, 10)
    tags: list[str] = [f"{n}wp"]

    # point-at-hub range (decided up front so headings along it can aim at the hub)
    pa_range = None
    if n >= 2 and rng.random() < 0.2:
        a = rng.randint(0, n - 2)
        b = rng.randint(a + 1, min(n - 1, a + 3))
        pa_range = (a, b)
        tags.append("pointAt")

    wps: list[Waypoint] = []
    hub = None
    for j in range(n):
        for _ in range(2000):
            if j == 0:
                x, y = rng.uniform(0.5, L - 0.5), rng.uniform(0.5, W - 0.5)
            else:
                px, py = wps[-1].x, wps[-1].y
                d, ang = rng.uniform(0.8, 6.0), rng.uniform(-math.pi, math.pi)
                x, y = px + d * math.cos(ang), py + d * math.sin(ang)
                if not (0.5 <= x <= L - 0.5 and 0.5 <= y <= W - 0.5):
                    continue
            if pa_range and pa_range[0] <= j <= pa_range[1]:
                if hub is None:
                    hub = BLUE_HUB if math.dist((x, y), BLUE_HUB) < math.dist((x, y), RED_HUB) else RED_HUB
                if math.dist((x, y), hub) < 1.6:
                    continue
                th = _hub_heading(x, y, hub)
            else:
                th = rng.uniform(-math.pi, math.pi)
            if chk.free(x, y, th):
                break
        else:  # pragma: no cover - extremely unlikely
            raise RuntimeError("could not place waypoint")
        last = j == n - 1
        mid = 0 < j < n - 1
        stop = j == 0 or (last and rng.random() < 0.85) or (mid and rng.random() < 0.25)
        kw = {}
        if mid and not (pa_range and pa_range[0] <= j <= pa_range[1]) and rng.random() < 0.25:
            kw["heading_mode"] = "free"
        if mid and rng.random() < 0.15:
            if rng.random() < 0.5:
                kw["tolerance"] = Tolerance(kind="circle", radius=round(rng.uniform(0.15, 0.4), 3))
            else:
                kw["tolerance"] = Tolerance(kind="box", dx=round(rng.uniform(0.1, 0.4), 3),
                                            dy=round(rng.uniform(0.1, 0.4), 3))
        wps.append(_wp(j, round(x, 4), round(y, 4), round(th, 4), stop=stop, **kw))
    if any(w.tolerance.kind != "none" for w in wps):
        tags.append("tolerance")
    if any(w.stop for w in wps[1:-1]):
        tags.append("midStops")

    cons: list[Constraint] = []
    if pa_range:
        tol = round(rng.uniform(0.05, 0.15), 3)
        cons.append(Constraint(id="pa", scope=Scope(kind="range", **{"from": pa_range[0], "to": pa_range[1]}),
                               data=PointAt(x=hub[0], y=hub[1], tolerance=tol)))
    if rng.random() < 0.2:
        cx, cy = rng.uniform(2, L - 2), rng.uniform(1.5, W - 1.5)
        sx, sy = rng.uniform(1.5, 4.0) / 2, rng.uniform(1.5, 4.0) / 2
        region = [(cx - sx, cy - sy), (cx + sx, cy - sy), (cx + sx, cy + sy), (cx - sx, cy + sy)]
        region = [(round(max(0, min(L, px)), 3), round(max(0, min(W, py)), 3)) for px, py in region]
        cons.append(Constraint(id="zone", scope=Scope(kind="zone", region=region),
                               data=MaxVelocity(value=round(rng.uniform(0.8, 2.5), 2))))
        tags.append("velocityZone")
    if rng.random() < 0.1:
        cons.append(Constraint(id="acc", scope=Scope(kind="range", **{"from": 0, "to": n - 1}),
                               data=MaxAcceleration(value=round(rng.uniform(2.0, 5.0), 2))))
        tags.append("maxAccel")
    if rng.random() < 0.3:
        placed, want = 0, rng.randint(1, 2)
        for _ in range(300):
            if placed >= want:
                break
            j = rng.randrange(n - 1)
            u = rng.uniform(0.3, 0.7)
            cx = wps[j].x + u * (wps[j + 1].x - wps[j].x) + rng.uniform(-0.6, 0.6)
            cy = wps[j].y + u * (wps[j + 1].y - wps[j].y) + rng.uniform(-0.6, 0.6)
            s1, s2 = rng.uniform(0.2, 0.6), rng.uniform(0.2, 0.6)
            if rng.random() < 0.5:
                pts = [(cx - s1, cy - s2), (cx + s1, cy - s2), (cx + s1, cy + s2), (cx - s1, cy + s2)]
            else:
                a0 = rng.uniform(0, 2 * math.pi)
                pts = [(cx + s1 * 1.5 * math.cos(a0 + k * 2 * math.pi / 3),
                        cy + s1 * 1.5 * math.sin(a0 + k * 2 * math.pi / 3)) for k in range(3)]
            pts = [(round(px, 3), round(py, 3)) for px, py in pts]
            poly = Polygon(pts)
            if not poly.within(box(0.2, 0.2, L - 0.2, W - 0.2)):
                continue
            if any(geo.bumper_polygon(chk.dt.bumper_corners, w.x, w.y, w.heading).distance(poly) < 0.15
                   for w in wps if w.tolerance.kind == "none"):
                continue
            # never cover a tolerance waypoint's target point either
            if any(poly.distance(Polygon([(w.x, w.y), (w.x + 1e-3, w.y), (w.x, w.y + 1e-3)])) < 0.9
                   for w in wps if w.tolerance.kind != "none"):
                continue
            cons.append(Constraint(id=f"ko{placed}", data=KeepOut(points=pts)))
            placed += 1
        if placed:
            tags.append("keepOut")
    traj = Trajectory(name=f"random-{i:03d}", waypoints=wps, constraints=cons)
    return Scenario(traj.name, "random", traj, tags)


# ---------------------------------------------------------------------------
# hand-written hard corpus
# ---------------------------------------------------------------------------


def hard_corpus() -> list[Scenario]:
    P = math.pi
    out: list[Scenario] = []

    def add(name, wps, tags, cons=(), **settings):
        t = Trajectory(name=name, waypoints=wps, constraints=list(cons))
        for k, v in settings.items():
            setattr(t.settings, k, v)
        out.append(Scenario(name, "hard", t, list(tags)))

    def rng(a, b):
        return Scope(kind="range", **{"from": a, "to": b})

    # --- trench openings (1.2787 m wide, robot 0.9 m square) -------------------
    add("trench-lower-straight", [_wp(0, 2.5, TRENCH_Y_LO, 0, stop=True), _wp(1, 7.2, TRENCH_Y_LO, 0, stop=True)],
        ["trench"])
    add("trench-upper-straight", [_wp(0, 7.2, TRENCH_Y_HI, P, stop=True), _wp(1, 2.2, TRENCH_Y_HI, P, stop=True)],
        ["trench"])
    add("trench-forced-pass", [_wp(0, 2.0, 3.0, P / 2, stop=True), _wp(1, 4.62, TRENCH_Y_LO, 0),
                               _wp(2, 7.2, 2.2, -P / 2, stop=True)], ["trench", "sharp"])
    add("trench-both-lower", [_wp(0, 1.6, TRENCH_Y_LO, 0, stop=True), _wp(1, 4.62, TRENCH_Y_LO, 0),
                              _wp(2, 11.9, TRENCH_Y_LO, 0), _wp(3, 14.9, TRENCH_Y_LO, 0, stop=True)],
        ["trench", "long"])
    add("trench-diag-entry", [_wp(0, 1.5, 2.8, 0.6, stop=True), _wp(1, 4.62, TRENCH_Y_LO, P / 2, heading_mode="free"),
                              _wp(2, 6.8, 1.9, 0.0, stop=True)], ["trench"])
    add("trench-in-out-return", [_wp(0, 2.6, 2.4, 0, stop=True), _wp(1, 6.5, TRENCH_Y_LO, 0, stop=True),
                                 _wp(2, 2.6, TRENCH_Y_LO, P / 2, stop=True)], ["trench", "reversal"])
    add("trench-flush-start", [_wp(0, 4.62, 1.2787 - 0.03 - 0.45 - 0.004, 0, stop=True),
                               _wp(1, 7.5, 4.0, P, stop=True)], ["trench", "flush"])
    add("trench-rotate-inside", [_wp(0, 2.3, TRENCH_Y_LO, 0, stop=True), _wp(1, 7.0, TRENCH_Y_LO, P / 2, stop=True)],
        ["trench", "rotation"])

    # --- around the hub -------------------------------------------------------
    add("hub-straight-through", [_wp(0, 2.5, BLUE_HUB[1], 0, stop=True), _wp(1, 7.0, BLUE_HUB[1], 0, stop=True)],
        ["hub"])
    add("hub-circuit", [_wp(0, 3.0, 4.0, 0, stop=True), _wp(1, 4.6, 2.5, 0), _wp(2, 6.3, 4.0, P / 2),
                        _wp(3, 4.6, 5.6, P), _wp(4, 3.0, 4.1, P, stop=True)], ["hub", "loop"])
    add("hub-point-at-orbit", [_wp(0, 2.6, 4.0, 0, stop=True), _wp(1, 4.6, 2.1, P / 2, heading_mode="free"),
                               _wp(2, 6.6, 4.0, P, heading_mode="free"), _wp(3, 4.6, 6.0, -P / 2, stop=True)],
        ["hub", "pointAt"], [Constraint(id="pa", scope=rng(0, 3), data=PointAt(x=BLUE_HUB[0], y=BLUE_HUB[1],
                                                                               tolerance=0.1))])
    add("hub-flush-start", [_wp(0, 4.0284 - 0.04 - 0.45 - 0.004, BLUE_HUB[1], 0, stop=True),
                            _wp(1, 6.5, 1.0, 0, stop=True)], ["hub", "flush"])
    add("hub-flush-end-red", [_wp(0, 9.0, 6.0, P, stop=True),
                              _wp(1, 12.5126 + 0.04 + 0.45 + 0.004, RED_HUB[1], P, stop=True)], ["hub", "flush"])
    add("hub-cross-field", [_wp(0, 2.0, 4.0, 0, stop=True), _wp(1, 14.5, 4.0, 0, stop=True)], ["hub", "long"])

    # --- tower-adjacent end poses ---------------------------------------------
    add("tower-front-end", [_wp(0, 3.5, 2.0, 0, stop=True), _wp(1, 1.1446 + 0.04 + 0.45 + 0.01, 3.75, P, stop=True)],
        ["tower", "flush"])
    add("tower-top-side", [_wp(0, 3.0, 6.5, 0, stop=True), _wp(1, 0.6, 4.241 + 0.04 + 0.45 + 0.01, 0, stop=True)],
        ["tower", "flush", "wall"])
    add("tower-red-corner", [_wp(0, 12.0, TRENCH_Y_LO, P, stop=True),
                             _wp(1, 15.3964 - 0.04 - 0.45 - 0.01, 4.3, 0, stop=True)], ["tower", "flush"])
    add("tower-under-side", [_wp(0, 2.4, 5.4, 0, stop=True), _wp(1, 0.6, 3.2504 - 0.04 - 0.45 - 0.01, P / 2, stop=True)],
        ["tower", "flush", "wall"])

    # --- near-wall poses ------------------------------------------------------
    add("wall-corner-to-corner", [_wp(0, 0.48, 0.48, 0, stop=True), _wp(1, L - 0.48, W - 0.48, 0, stop=True)],
        ["wall", "long"])
    add("wall-slide", [_wp(0, 6.5, 0.48, 0, stop=True), _wp(1, 10.0, 0.48, 0), _wp(2, 10.0, W - 0.48, P / 2, stop=True)],
        ["wall"])
    add("wall-rotate-corner", [_wp(0, 0.48, W - 0.48, 0, stop=True), _wp(1, 2.5, W - 1.0, P / 2, stop=True)],
        ["wall", "rotation"])

    # --- long autos (10+ waypoints) --------------------------------------------
    add("long-12wp-neutral-sweep", [
        _wp(0, 3.4, 5.6, 0, stop=True), _wp(1, 6.5, 7.3, 0), _wp(2, 8.0, 6.5, -P / 2), _wp(3, 8.0, 5.0, -P / 2),
        _wp(4, 8.0, 3.2, -P / 2), _wp(5, 8.0, 1.6, -P / 2), _wp(6, 6.5, 0.8, P), _wp(7, 4.6, TRENCH_Y_LO, P),
        _wp(8, 2.8, 1.6, P / 2), _wp(9, 2.5, 3.0, 0, stop=True), _wp(10, 3.0, 5.2, 0),
        _wp(11, 2.2, 6.2, 0, stop=True)], ["long", "trench"])
    add("long-11wp-slalom", [_wp(k, 1.8 + 1.25 * k, 2.2 if k % 2 == 0 else 5.9, 0, stop=k in (0, 10))
                             for k in range(11)], ["long", "slalom"])
    add("long-14wp-both-sides", [
        _wp(0, 1.8, 6.2, 0, stop=True), _wp(1, 4.62, TRENCH_Y_HI, 0), _wp(2, 7.5, 7.0, -P / 4),
        _wp(3, 8.27, 5.5, -P / 2), _wp(4, 9.0, 4.0, -P / 2), _wp(5, 11.9, TRENCH_Y_HI, 0, heading_mode="free"),
        _wp(6, 14.5, 6.6, 0, stop=True), _wp(7, 14.0, 2.0, P), _wp(8, 11.9, TRENCH_Y_LO, P),
        _wp(9, 9.0, 1.6, P), _wp(10, 8.27, 3.0, P / 2), _wp(11, 7.0, 2.2, P), _wp(12, 4.62, TRENCH_Y_LO, P),
        _wp(13, 2.2, 2.0, P, stop=True)], ["long", "trench"])
    add("long-10wp-stops", [_wp(k, [2.5, 6.0, 7.8, 6.0, 2.5, 3.0, 6.5, 8.0, 6.5, 2.8][k],
                                [5.6, 7.2, 5.0, 3.0, 2.3, 1.0, 1.4, 3.8, 6.0, 6.0][k],
                                [0, 0, -P / 2, P, P, 0, 0, P / 2, P, P][k], stop=k in (0, 2, 4, 7, 9))
                            for k in range(10)], ["long", "midStops"])

    # --- sharp reversals / spins ----------------------------------------------
    add("reversal-pass", [_wp(0, 2.0, 2.4, 0, stop=True), _wp(1, 6.8, 2.4, 0), _wp(2, 2.2, 2.8, 0, stop=True)],
        ["reversal"])
    add("reversal-zigzag", [_wp(0, 6.0, 6.0, 0, stop=True), _wp(1, 9.0, 6.2, 0), _wp(2, 6.3, 5.3, 0),
                            _wp(3, 9.5, 4.6, 0), _wp(4, 6.3, 3.4, 0), _wp(5, 9.5, 2.4, 0, stop=True)],
        ["reversal", "sharp"])
    add("spin-while-driving", [_wp(0, 6.2, 2.0, 0, stop=True), _wp(1, 10.3, 2.0, 3 * P, stop=True)],
        ["rotation"])
    add("reversal-around-hub", [_wp(0, 6.6, 4.0, P, stop=True), _wp(1, 2.9, 4.0, P),
                                _wp(2, 6.6, 3.0, 0, stop=True)], ["reversal", "hub"])

    # --- user keep-outs forming a corridor ---------------------------------------
    add("keepout-corridor", [_wp(0, 6.3, 2.0, 0, stop=True), _wp(1, 10.3, 6.0, P / 2, stop=True)], ["keepOut"],
        [Constraint(id="k1", data=KeepOut(points=[(7.2, 2.6), (9.0, 2.6), (9.0, 3.6), (7.2, 3.6)])),
         Constraint(id="k2", data=KeepOut(points=[(7.2, 4.8), (9.0, 4.8), (9.0, 5.9), (7.2, 5.9)])),
         Constraint(id="k3", data=KeepOut(points=[(9.6, 3.0), (10.6, 3.0), (10.6, 4.6), (9.6, 4.6)]))])
    add("keepout-zone-pointat", [_wp(0, 7.5, 1.0, P, stop=True), _wp(1, 5.9, 2.5, P, heading_mode="free"),
                                 _wp(2, 3.0, 2.2, 0.0, heading_mode="free", stop=True)],
        ["keepOut", "pointAt", "velocityZone"],
        [Constraint(id="ko", data=KeepOut(points=[(6.2, 1.0), (6.8, 1.0), (6.8, 1.9), (6.2, 1.9)])),
         Constraint(id="vz", scope=Scope(kind="zone", region=[(5.0, 1.8), (7.0, 1.8), (7.0, 3.2), (5.0, 3.2)]),
                    data=MaxVelocity(value=1.2)),
         Constraint(id="pa", scope=rng(1, 2), data=PointAt(x=BLUE_HUB[0], y=BLUE_HUB[1], tolerance=0.08))])
    return out


def infeasible_corpus() -> list[Scenario]:
    """Problems with no solution: the solver must fail quickly and say why."""
    P = math.pi
    out: list[Scenario] = []

    def add(name, wps, cons, keywords, waypoint=None):
        t = Trajectory(name=name, waypoints=wps, constraints=list(cons))
        out.append(Scenario(name, "infeasible", t, ["infeasible"], expect_keywords=keywords,
                            expect_waypoint=waypoint))

    def rng(a, b):
        return Scope(kind="range", **{"from": a, "to": b})

    # Reported from UI testing: waypoint 3 has a fixed heading that can't face the hub.
    add("infeasible-pointat-fixed-heading",
        [_wp(0, 3.4, 5.6, 0, stop=True), _wp(1, 6.5, 7.4, 0), _wp(2, 7.9, 5.6, -P / 2, stop=True, split=True),
         _wp(3, 2.6, 4.03, 0, heading_mode="free", stop=True)],
        [Constraint(id="pa", scope=rng(2, 3), data=PointAt(x=4.63, y=4.03, tolerance=0.05))],
        ["heading", "pointAt"], 2)
    add("infeasible-pointat-start",
        [_wp(0, 2.0, 2.0, 0, stop=True), _wp(1, 5.9, 2.2, heading_mode="free"), _wp(2, 8.0, 2.0, 0, stop=True)],
        [Constraint(id="pa", scope=rng(0, 2), data=PointAt(x=5.0, y=7.0, tolerance=0.02))],
        ["heading", "pointAt"], 0)
    # Two point-at targets over the same range: no pre-check catches this, only the solver.
    add("infeasible-two-pointat",
        [_wp(0, 7.0, 2.0, heading_mode="free", stop=True), _wp(1, 10.0, 2.0, heading_mode="free", stop=True)],
        [Constraint(id="pa1", scope=rng(0, 1), data=PointAt(x=8.5, y=7.0, tolerance=0.05)),
         Constraint(id="pa2", scope=rng(0, 1), data=PointAt(x=8.5, y=-3.0, tolerance=0.05))],
        ["pointAt"])
    # Goal sealed off by keep-outs.
    add("infeasible-enclosed-goal",
        [_wp(0, 7.0, 2.0, 0, stop=True), _wp(1, 10.0, 4.0, 0, stop=True)],
        [Constraint(id="k1", data=KeepOut(points=[(8.8, 2.8), (11.2, 2.8), (11.2, 3.0), (8.8, 3.0)])),
         Constraint(id="k2", data=KeepOut(points=[(8.8, 5.0), (11.2, 5.0), (11.2, 5.2), (8.8, 5.2)])),
         Constraint(id="k3", data=KeepOut(points=[(8.8, 3.0), (9.0, 3.0), (9.0, 5.0), (8.8, 5.0)])),
         Constraint(id="k4", data=KeepOut(points=[(11.0, 3.0), (11.2, 3.0), (11.2, 5.0), (11.0, 5.0)]))],
        ["reach", "blocked", "enclosed", "obstacle", "Keep-out"], 1)
    return out


def all_scenarios(seed: int = 2026, n_random: int = 60) -> list[Scenario]:
    project = rebuilt_project()
    scen = hard_corpus() + infeasible_corpus() + [random_scenario(seed, i, project) for i in range(n_random)]
    for s in scen:
        s.project = s.project or project
    return scen


# Fast CI subset: cheap but representative (trench, hub, flush, reversal, keep-out, random).
FAST_SUBSET = [
    "trench-lower-straight",
    "trench-forced-pass",
    "hub-straight-through",
    "tower-front-end",
    "hub-flush-start",
    "reversal-pass",
    "keepout-corridor",
    "random-000",
    "random-003",
    "infeasible-pointat-fixed-heading",
]
