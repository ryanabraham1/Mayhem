"""Robust solve pipeline.

1. Build world geometry (convex pieces) and a configuration-space roadmap.
2. Generate up to K homotopy-distinct routes -> full-state initial guesses.
3. For each candidate (in parallel), run a continuation ladder:
      direct -> coarse mesh then refine -> soft geometry then hard
      -> relaxed limits then nominal
   each followed by a swept-collision check that refines the mesh and adds
   obstacle pairs until the continuous path is clean.
4. Keep the fastest verified candidate. If none, run an elastic solve and turn
   the remaining slack into human-readable issues.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from . import geometry as geo
from .drivetrain import Drivetrain, build_drivetrain
from .guess import Solution, build_guess, dense, resample
from .models import (
    EventOut,
    Issue,
    KeepOut,
    Limits,
    PointAt,
    Project,
    RecoveryPayload,
    RoughTerrain,
    Sample,
    SolveStats,
    StraightLine,
    TerrainSpan,
    Trajectory,
    TrajectoryOutput,
)
from .ocp import SUCCESS, OCP, OCPOptions, OCPResult, scope_samples, select_pairs, waypoint_indices

ProgressFn = Callable[[dict], None]


@dataclass
class SolveResult:
    success: bool
    output: Optional[TrajectoryOutput]
    issues: list[Issue] = field(default_factory=list)
    preview: Optional[list[list[float]]] = None  # best-effort path for failed solves


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def resolve_poses(project: Project, traj: Trajectory) -> Trajectory:
    """Copy of `traj` whose pose-linked waypoints take x/y/heading from the project's pose variables.

    Waypoints keep their `pose_ref`, so resolving twice is a no-op. Unknown refs keep the
    waypoint's stored pose (validate() warns about them). Only the waypoints are copied.
    """
    poses = {p.id: p for p in project.poses}
    wps = []
    for wp in traj.waypoints:
        p = poses.get(wp.pose_ref) if wp.pose_ref else None
        wps.append(wp.model_copy(update={"x": p.x, "y": p.y, "heading": p.heading}) if p else wp.model_copy())
    return traj.model_copy(update={"waypoints": wps})


def input_hash(project: Project, traj: Trajectory) -> str:
    traj = resolve_poses(project, traj)
    payload = {
        "robot": project.robot.dump(),
        "field": project.field.dump(),
        # Pose refs are hashed through their resolved values: moving a pose variable marks the
        # paths that use it stale, and files without refs keep their old hashes.
        "traj": traj.model_dump(by_alias=True, mode="json",
                                exclude={"output": True, "folder": True, "waypoints": {"__all__": {"pose_ref"}}}),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def make_world(project: Project, traj: Trajectory) -> geo.World:
    extra = []
    for con in traj.constraints:
        if con.enabled and isinstance(con.data, KeepOut):
            extra.append((f"Keep-out {con.id}", con.data.points, con.data.margin))
    return geo.build_world(project.field, extra)


def point_at_members(traj: Trajectory, sol: Solution):
    out = []
    for con in traj.constraints:
        if con.enabled and isinstance(con.data, PointAt):
            ks = scope_samples(con.scope, sol.Ns, sol)
            out.append((ks, con.data.x, con.data.y, con.data.flip))
    return out


def straight_line_ranges(traj: Trajectory) -> list[tuple[str, StraightLine, int, int]]:
    """Enabled straight-line constraints that can be applied: (id, data, a, b) with a < b.

    Only range scopes between two distinct, in-range waypoints at different positions count;
    validate() warns about the others and the OCP ignores them.
    """
    wps = traj.waypoints
    out = []
    for con in traj.constraints:
        if not con.enabled or not isinstance(con.data, StraightLine) or con.scope.kind != "range":
            continue
        a, b = sorted((con.scope.from_, con.scope.to))
        if a < 0 or b >= len(wps) or a == b:
            continue
        if math.hypot(wps[b].x - wps[a].x, wps[b].y - wps[a].y) < 1e-6:
            continue
        out.append((con.id, con.data, a, b))
    return out


def _free_components(world: geo.World, dt: Drivetrain) -> list:
    """Connected regions the robot center can move through, whatever the heading.

    The bumper always contains its inscribed circle, so the center must stay at least the
    inradius away from every obstacle and inside the walls. A hair is taken off the radius so
    this is never stricter than the optimizer.
    """
    r = max(dt.inradius - 5e-3, 0.0)
    fld = box(0, 0, world.length, world.width).buffer(-(r + world.wall_margin), join_style="mitre")
    blocked = unary_union([p.buffer(r) for _, p, _ in world.obstacle_polys]) if world.obstacle_polys else Polygon()
    free = fld.difference(blocked)
    return [g for g in getattr(free, "geoms", [free]) if g.geom_type == "Polygon" and not g.is_empty]


def _enclosure_issues(traj: Trajectory, dt: Drivetrain, world: geo.World) -> list[Issue]:
    """Fixed waypoints in different free-space components can never be joined by a path."""
    comps = _free_components(world, dt)
    if len(comps) < 2:
        return []
    located = []
    for j, wp in enumerate(traj.waypoints):
        if wp.translation_mode != "fixed" or wp.tolerance.kind != "none":
            continue
        pt = Point(wp.x, wp.y)
        ci = next((i for i, c in enumerate(comps) if c.distance(pt) < 1e-9), None)
        if ci is not None:  # a center inside the blocked area is left to the footprint checks
            located.append((j, ci))
    issues, blamed = [], set()
    r = max(dt.inradius - 5e-3, 0.0)
    inner = box(0, 0, world.length, world.width).buffer(-(r + world.wall_margin) - 1e-3, join_style="mitre")
    for (ja, ca_), (jb, cb) in zip(located, located[1:]):
        if ca_ == cb:
            continue
        # blame the waypoint in the smaller region: that's the one that is walled in
        j, other, ci = (ja, jb, ca_) if comps[ca_].area <= comps[cb].area else (jb, ja, cb)
        if j in blamed:
            continue
        blamed.add(j)
        comp = comps[ci]
        names = []
        for name, poly, _ in world.obstacle_polys:
            if name not in names and poly.buffer(r).distance(comp) < 1e-3:
                names.append(f"'{name}'")
        if not inner.contains(comp):
            names.append("the field wall")
        what = ", ".join(names[:5]) or "obstacles"
        wp = traj.waypoints[j]
        issues.append(Issue(
            severity="error",
            message=f"Waypoint {j + 1} can't be reached from waypoint {other + 1}: it is enclosed by {what} "
                    "with no gap wide enough for the robot.",
            waypoint=j, x=wp.x, y=wp.y))
    return issues


def _straight_line_issues(traj: Trajectory, dt: Drivetrain, world: geo.World) -> list[Issue]:
    issues = []
    wps = traj.waypoints
    n = len(wps)
    for con in traj.constraints:
        if not con.enabled or not isinstance(con.data, StraightLine):
            continue
        s = con.scope
        if s.kind != "range":
            issues.append(Issue(severity="warning",
                                message=f"Straight-line constraint '{con.id}' needs a range scope "
                                        "(from one waypoint to another); ignored."))
            continue
        a, b = sorted((s.from_, s.to))
        if a < 0 or b >= n:
            continue  # already reported as a missing waypoint
        if a == b or math.hypot(wps[b].x - wps[a].x, wps[b].y - wps[a].y) < 1e-6:
            issues.append(Issue(severity="warning",
                                message=f"Straight-line constraint '{con.id}' starts and ends at the same point; "
                                        "ignored.", waypoint=a))
            continue
        seg = LineString([(wps[a].x, wps[a].y), (wps[b].x, wps[b].y)])
        swept = seg.buffer(max(dt.inradius - 1e-3, 0.0))
        for name, poly, _ in world.obstacle_polys:
            if swept.intersects(poly):
                q = shapely.ops.nearest_points(seg, poly)[0]
                issues.append(Issue(severity="error",
                                    message=f"Straight-line constraint '{con.id}' passes through obstacle '{name}'.",
                                    waypoint=a, x=q.x, y=q.y))
                break
        tol = max(con.data.tolerance, 0.0)
        for j in range(a + 1, b):
            wp = wps[j]
            if wp.translation_mode != "fixed" or wp.tolerance.kind != "none":
                continue
            off = seg.distance(Point(wp.x, wp.y))
            if off > tol + 1e-4:
                issues.append(Issue(severity="error",
                                    message=f"Waypoint {j + 1} is {off:.2f} m off the line of straight-line "
                                            f"constraint '{con.id}'. Move it onto the line or make it a guide.",
                                    waypoint=j, x=wp.x, y=wp.y))
    return issues


def validate(project: Project, traj: Trajectory, dt: Drivetrain, world: geo.World) -> list[Issue]:
    issues = []
    pose_ids = {p.id for p in project.poses}
    for j, wp in enumerate(traj.waypoints):
        if wp.pose_ref and wp.pose_ref not in pose_ids:
            issues.append(Issue(severity="warning",
                                message=f"Waypoint {j + 1} links to a missing pose variable; using its own position.",
                                waypoint=j, x=wp.x, y=wp.y))
    traj = resolve_poses(project, traj)
    wps = traj.waypoints
    if len(wps) < 2:
        issues.append(Issue(severity="error", message="A trajectory needs at least 2 waypoints."))
        return issues
    for j, wp in enumerate(wps):
        if not (0 <= wp.x <= world.length and 0 <= wp.y <= world.width):
            issues.append(Issue(severity="error", message=f"Waypoint {j + 1} is outside the field.",
                                waypoint=j, x=wp.x, y=wp.y))
            continue
        if wp.translation_mode != "fixed" or wp.heading_mode != "fixed" or wp.tolerance.kind != "none":
            continue
        rob = geo.bumper_polygon(dt.bumper_corners, wp.x, wp.y, wp.heading)
        for piece in world.pieces:
            if rob.intersects(piece.poly):
                issues.append(Issue(
                    severity="error",
                    message=f"Waypoint {j + 1}'s bumpers overlap '{piece.name}'. Move it, rotate it, "
                            "or give it a position tolerance.",
                    waypoint=j, x=wp.x, y=wp.y))
                break
        minx, miny, maxx, maxy = rob.bounds
        if minx < 0 or miny < 0 or maxx > world.length or maxy > world.width:
            issues.append(Issue(severity="error", message=f"Waypoint {j + 1}'s bumpers leave the field.",
                                waypoint=j, x=wp.x, y=wp.y))
    for con in traj.constraints:
        s = con.scope
        n = len(wps)
        if s.kind in ("waypoint", "range") and not (0 <= s.from_ < n and (s.kind == "waypoint" or 0 <= s.to < n)):
            issues.append(Issue(severity="warning", message=f"Constraint {con.id} refers to a missing waypoint; ignored."))
        if con.enabled and isinstance(con.data, RoughTerrain) and s.kind == "waypoint":
            issues.append(Issue(severity="warning",
                                message=f"Rough terrain {con.id} is at a single waypoint and covers almost no time; "
                                        "use a zone or a waypoint range."))
        if not con.enabled or not isinstance(con.data, PointAt):
            continue
        for j, wp in enumerate(wps):
            if wp.heading_mode != "fixed" or wp.translation_mode != "fixed" or wp.tolerance.kind != "none":
                continue
            if s.kind == "waypoint" and j != s.from_:
                continue
            if s.kind == "range" and not min(s.from_, s.to) <= j <= max(s.from_, s.to):
                continue
            if s.kind == "zone" and (len(s.region) < 3 or not Polygon(s.region).covers(Point(wp.x, wp.y))):
                continue
            dx, dy = con.data.x - wp.x, con.data.y - wp.y
            if math.hypot(dx, dy) < 1e-4:
                continue
            target = math.atan2(dy, dx) + (math.pi if con.data.flip else 0)
            error = abs(math.remainder(wp.heading - target, 2 * math.pi))
            if error > con.data.tolerance + wp.heading_tolerance + 1e-4:
                issues.append(Issue(severity="error",
                                    message=f"Waypoint {j + 1} heading conflicts with point-at constraint '{con.id}'.",
                                    waypoint=j, x=wp.x, y=wp.y))
    issues += _straight_line_issues(traj, dt, world)
    if not any(i.severity == "error" for i in issues):
        issues += _enclosure_issues(traj, dt, world)
    return issues


def candidate_routes(traj: Trajectory, dt: Drivetrain, world: geo.World, k: int) -> list[list[list]]:
    """Returns a list of candidates; each is a list of per-segment polylines."""
    wps = traj.waypoints
    S = len(wps) - 1
    per_seg: list[list[list]] = []
    for j in range(S):
        a = (wps[j].x, wps[j].y)
        b = (wps[j + 1].x, wps[j + 1].y)
        routes = []
        for radius in (dt.circumradius + 0.02, dt.inradius + 0.02):
            rm = geo.build_roadmap(world, radius)
            routes = geo.route_candidates(rm, a, b, k)
            if routes:
                break
        if not routes:
            routes = [[a, b]]
        per_seg.append(routes)
    # straight-line constraints: when the line is clear, every leg in the range follows it.
    # Intermediate waypoints are projected onto the segment (fixed ones must already lie on
    # it - validate() rejects those that don't - so this only moves guides and tolerances).
    lines = straight_line_ranges(traj)
    if lines:
        rm = geo.build_roadmap(world, dt.inradius + 0.02)
        for _, _, a, b in lines:
            p, q = np.array([wps[a].x, wps[a].y]), np.array([wps[b].x, wps[b].y])
            if not geo._segment_free(rm, tuple(p), tuple(q)):
                continue
            d = q - p
            pts = []
            for j in range(a, b + 1):
                u = float(np.clip(np.dot(np.array([wps[j].x, wps[j].y]) - p, d) / np.dot(d, d), 0.0, 1.0))
                pts.append(tuple(p + u * d))
            for j in range(a, b):
                per_seg[j] = [[pts[j - a], pts[j - a + 1]]]
    cands = []
    n_c = max(len(r) for r in per_seg) if per_seg else 1
    for i in range(min(k, n_c)):
        cands.append([r[i] if i < len(r) else r[0] for r in per_seg])
    return cands


# ---------------------------------------------------------------------------
# single-candidate ladder
# ---------------------------------------------------------------------------


@dataclass
class Attempt:
    ok: bool
    sol: Solution
    iters: int
    log: list[str]
    slacks: list = field(default_factory=list)
    probe: Optional[OCPResult] = None  # converged elastic probe that proved a hard violation
    infeasible: bool = False


# IPOPT statuses that suggest the hard problem has no feasible point near the guess
INFEASIBLE_STATUSES = {"Infeasible_Problem_Detected", "Restoration_Failed"}
# Elastic slack (per constraint label) above which a constraint is counted as truly violated.
# Drivetrain categories are absent on purpose: the elastic solve trades small wheel/motor
# violations for time, which says nothing about feasibility.
DECISIVE_SLACK = {"user": 1e-2, "heading": 1e-2, "stop": 1e-2, "waypoint": 1e-2,
                  "obstacle": 0.05, "wall": 0.05, "keepin": 0.05}


def hard_violations(slacks) -> list[tuple[str, str, float]]:
    """(label, category, total) of the constraints an elastic solve could not satisfy."""
    agg: dict[str, tuple[str, float]] = {}
    for label, cat, total, _ in slacks:
        if total > agg.get(label, ("", -1.0))[1]:
            agg[label] = (cat, total)
    bad = [(lab, cat, tot) for lab, (cat, tot) in agg.items() if tot > DECISIVE_SLACK.get(cat, math.inf)]
    return sorted(bad, key=lambda v: -v[2])


class Solver:
    def __init__(self, project: Project, traj: Trajectory, progress: Optional[ProgressFn] = None,
                 candidate: int = 0, deadline: Optional[float] = None):
        self.project, self.traj = project, traj
        self.dt = build_drivetrain(project.robot)
        self.world = make_world(project, traj)
        self.progress = progress
        self.candidate = candidate
        self.deadline = deadline or (time.monotonic() + traj.settings.time_limit)
        self.iters = 0
        self.log: list[str] = []
        self._last_pairs: dict = {}
        self._last_dense: set = set()
        self._last_zone_used: dict = {}
        self._last_planes: dict = {}

    def _time_left(self) -> float:
        return max(self.deadline - time.monotonic(), 1.0)

    def _progress_fn(self, stage: str):
        if self.progress is None:
            return None

        def fn(i, v):
            th = np.arctan2(v[3], v[2])
            pts = np.round(np.vstack([v[0], v[1], th]).T, 3).tolist()
            self.progress({"type": "iteration", "candidate": self.candidate, "stage": stage,
                           "iteration": i, "path": pts})
        return fn

    def run_ocp(self, guess: Solution, mode: str, stage: str, limit_scale: float = 1.0,
                pairs: Optional[dict] = None, dense: Optional[set] = None, warm: bool = False,
                time_cap: Optional[float] = None, zone_extra: Optional[dict] = None) -> OCPResult:
        if pairs is None:
            act = max(0.4, 2.5 * float(np.max(np.hypot(guess.vx, guess.vy)) * np.max(guess.h)) + 0.25)
            pairs = select_pairs(self.world, self.dt, guess, act)
        s = self.traj.settings
        tl = self._time_left() if time_cap is None else min(self._time_left(), time_cap)
        opts = OCPOptions(mode=mode, limit_scale=limit_scale, smoothing=s.smoothing,
                          max_iter=s.max_iterations, time_limit=tl,
                          progress=self._progress_fn(stage), dense_intervals=dense, warm=warm,
                          zone_extra=zone_extra, plane_init=self._last_planes if warm else None)
        if self.progress:
            self.progress({"type": "stage", "candidate": self.candidate, "stage": stage})
        ocp = OCP(self.dt, self.world, self.traj, guess, pairs, opts)
        res = ocp.solve()
        self._last_zone_used = ocp.zone_used
        self._last_planes = res.planes
        self.iters += res.iterations
        self.log.append(f"{stage}: {res.status} ({res.iterations} it, {res.seconds:.2f}s)")
        self._last_pairs, self._last_dense = pairs, set(dense or ())
        return res

    def verify(self, sol: Solution) -> list[geo.Collision]:
        t, x, y, th, idx = dense(sol, 4)
        hits = geo.check_path(self.world, self.dt.bumper_corners, t, x, y, th)
        for h in hits:
            h.index = int(idx[h.index])
        return hits

    def _zone_missing(self, sol: Solution) -> dict[str, set[int]]:
        """Zone-scoped constraints whose region the solution enters at unconstrained samples."""
        out = {}
        for c in self.traj.constraints:
            if c.enabled and c.scope.kind == "zone" and not isinstance(c.data, RoughTerrain):
                now = set(scope_samples(c.scope, sol.Ns, sol))
                used = self._last_zone_used.get(c.id, set())
                if not now <= used:
                    out[c.id] = now | used
        return out

    def polish(self, res: OCPResult, local_rounds: int = 2, rounds: int = 5) -> OCPResult:
        """Make a converged solution verifiably valid.

        Two things can be wrong with a converged NLP solution:
          * zone-scoped constraints were attached to the samples that were inside the zone
            in the *guess*; the solution may enter the zone at other samples. Membership is
            made sticky (union) and the problem re-solved warm until it is a fixpoint.
          * the swept (continuous-time) check finds clipping between samples. The first
            rounds keep the mesh and add quarter-point checks (and missing obstacle pairs)
            on the offending intervals only, warm-started from the solution: a small change
            to the NLP that re-converges in a few iterations. After that, the offending
            segments' mesh is refined (resampled 1.6x).
        """
        local_left = local_rounds
        zone_extra: dict[str, set[int]] = {}
        for _ in range(rounds):
            if not res.success:
                return res
            sol = res.solution
            hits = self.verify(sol)
            missing = self._zone_missing(sol)
            if not hits and not missing:
                return res
            for cid, ks in missing.items():
                zone_extra[cid] = set(zone_extra.get(cid, set())) | ks
            K = sol.K
            if not hits:
                self.log.append(f"zones: membership changed ({', '.join(sorted(missing))}), re-solving")
                res = self.run_ocp(sol, "hard", "zones", pairs=self._last_pairs, dense=self._last_dense,
                                   warm=True, zone_extra=zone_extra)
                continue
            if local_left > 0:
                local_left -= 1
                bad = {k for h in hits for k in range(h.index - 1, h.index + 2) if 0 <= k < K - 1}
                dense_iv = set(self._last_dense) | bad
                act = max(0.6, 3.0 * float(np.max(np.hypot(sol.vx, sol.vy)) * np.max(sol.h)) + 0.35)
                pairs = {o: set(ks) for o, ks in select_pairs(self.world, self.dt, sol, act).items()}
                for o, ks in (self._last_pairs or {}).items():
                    pairs.setdefault(o, set()).update(ks)
                names = {h.name for h in hits}
                for o, piece in enumerate(self.world.pieces):
                    if piece.name in names:
                        near = {k for h in hits if h.name == piece.name for k in range(h.index - 2, h.index + 3)
                                if 0 <= k < K}
                        pairs.setdefault(o, set()).update(near)
                pairs = {o: sorted(ks) for o, ks in pairs.items()}
                self.log.append(f"swept check: {len(hits)} hits, densifying {len(bad)} intervals")
                res = self.run_ocp(sol, "hard", "refine", pairs=pairs, dense=dense_iv, warm=True,
                                   zone_extra=zone_extra)
                continue
            wi = waypoint_indices(sol.Ns)
            bad_segs = {j for h in hits for j in range(len(sol.Ns)) if wi[j] <= h.index < wi[j + 1]}
            Ns = [int(math.ceil(n * 1.6)) if j in bad_segs else n for j, n in enumerate(sol.Ns)]
            self.log.append(f"swept check: {len(hits)} hits, refining segments {sorted(bad_segs)}")
            guess = resample(sol, Ns)
            act = max(0.6, 3.0 * float(np.max(np.hypot(guess.vx, guess.vy)) * np.max(guess.h)) + 0.35)
            pairs = select_pairs(self.world, self.dt, guess, act)
            zone_extra = {}  # sample indices changed; membership is re-evaluated on the resampled guess
            local_left = 1
            res = self.run_ocp(guess, "hard", "refine", pairs=pairs)
        if res.success and (self.verify(res.solution) or self._zone_missing(res.solution)):
            res.success = False
            res.status = "Swept collision / zone check failed"
        return res

    def ladder(self, guess: Solution) -> Attempt:
        def finish(res: OCPResult) -> Optional[Attempt]:
            if not res.success:
                return None
            res = self.polish(res)
            if res.success:
                return Attempt(True, res.solution, self.iters, self.log)
            return None

        # 1. direct
        res = self.run_ocp(guess, "hard", "direct")
        if (a := finish(res)):
            return a
        best_fail = res

        # 1b. IPOPT says infeasible: an elastic probe tells a real conflict (stop now and let the
        # caller report it) from a bad guess (its solution is then a feasible warm start).
        if res.status in INFEASIBLE_STATUSES and self._time_left() > 2:
            probe = self.run_ocp(guess, "elastic", "elastic-probe", time_cap=min(8.0, 0.3 * self._time_left()))
            if probe.status in SUCCESS and np.all(np.isfinite(probe.solution.x)):
                bad = hard_violations(probe.slacks)
                if bad:
                    self.log.append("elastic probe: " + ", ".join(lab for lab, _, _ in bad[:3])
                                    + " cannot be met; stopping")
                    return Attempt(False, best_fail.solution, self.iters, self.log, probe=probe, infeasible=True)
                if max((t for _, _, t, _ in probe.slacks), default=0.0) < 1e-3:
                    res = self.run_ocp(probe.solution, "hard", "elastic->hard")
                    if (a := finish(res)):
                        return a

        # 2. coarse mesh then refine
        Ns_coarse = [max(3, n // 2) for n in guess.Ns]
        if Ns_coarse != guess.Ns and self._time_left() > 2:
            res_c = self.run_ocp(resample(guess, Ns_coarse), "hard", "coarse")
            if res_c.success:
                res = self.run_ocp(resample(res_c.solution, guess.Ns), "hard", "coarse->fine")
                if (a := finish(res)):
                    return a

        # 3. soft geometry homotopy
        if self._time_left() > 2:
            res_s = self.run_ocp(guess, "soft_geometry", "soft-geometry")
            if res_s.status in ("Solve_Succeeded", "Solved_To_Acceptable_Level", "Maximum_Iterations_Exceeded"):
                res = self.run_ocp(res_s.solution, "hard", "soft->hard")
                if (a := finish(res)):
                    return a

        # 4. relaxed limits
        if self._time_left() > 2:
            res_r = self.run_ocp(guess, "hard", "relaxed-limits", limit_scale=1.5)
            if res_r.success:
                res = self.run_ocp(res_r.solution, "hard", "relaxed->nominal")
                if (a := finish(res)):
                    return a

        # 5. segment-wise warm start (solve each segment alone, stitch)
        if len(guess.Ns) > 1 and self._time_left() > 2:
            stitched = self.segmentwise(guess)
            if stitched is not None:
                res = self.run_ocp(stitched, "hard", "segmentwise->joint")
                if (a := finish(res)):
                    return a

        return Attempt(False, best_fail.solution, self.iters, self.log)

    def segmentwise(self, guess: Solution) -> Optional[Solution]:
        wps = self.traj.waypoints
        wi = waypoint_indices(guess.Ns)
        parts = []
        for j in range(len(guess.Ns)):
            sub = self.traj.model_copy(deep=True)
            sub.waypoints = [wps[j].model_copy(), wps[j + 1].model_copy()]
            sub.waypoints[0].stop = True
            sub.waypoints[1].stop = True
            sub.constraints = []  # segment solve only needs geometry & limits
            sl = slice(wi[j], wi[j + 1] + 1)
            g = Solution([guess.Ns[j]], guess.h[j:j + 1], guess.x[sl], guess.y[sl], guess.th[sl],
                         guess.vx[sl], guess.vy[sl], guess.w[sl], guess.ax[sl], guess.ay[sl], guess.al[sl],
                         guess.Fx[:, sl], guess.Fy[:, sl])
            s2 = Solver(self.project, sub, None, self.candidate, self.deadline)
            s2.world = self.world
            r = s2.run_ocp(g, "hard", f"segment {j + 1}")
            self.iters += s2.iters
            if not r.success:
                return None
            parts.append(r.solution)
        # stitch (drop duplicated boundary samples)
        def cat(attr):
            arrs = [getattr(p, attr) for p in parts]
            return np.concatenate([arrs[0]] + [a[1:] for a in arrs[1:]])
        Fx = np.hstack([parts[0].Fx] + [p.Fx[:, 1:] for p in parts[1:]])
        Fy = np.hstack([parts[0].Fy] + [p.Fy[:, 1:] for p in parts[1:]])
        th = np.unwrap(cat("th"))
        return Solution(list(guess.Ns), np.concatenate([p.h for p in parts]), cat("x"), cat("y"), th,
                        cat("vx"), cat("vy"), cat("w"), cat("ax"), cat("ay"), cat("al"), Fx, Fy)


# ---------------------------------------------------------------------------
# candidate worker (runs in a separate process when parallel)
# ---------------------------------------------------------------------------


def _solve_candidate(project_json: dict, traj_json: dict, routes, cand: int, deadline_wall: float,
                     queue=None) -> dict:
    project = Project.model_validate(project_json)
    traj = Trajectory.model_validate(traj_json)
    progress = (lambda msg: queue.put(msg)) if queue is not None else None
    deadline = time.monotonic() + max(deadline_wall - time.time(), 1.0)
    solver = Solver(project, traj, progress, cand, deadline)
    guess0 = build_guess(traj, routes, solver.dt)
    pa = point_at_members(traj, guess0)
    guess = build_guess(traj, routes, solver.dt, pa) if pa else guess0
    att = solver.ladder(guess)
    out = {"ok": att.ok, "sol": att.sol, "iters": att.iters, "log": att.log, "candidate": cand,
           "infeasible": att.infeasible}
    if att.probe is not None:
        out["probe_sol"], out["probe_slacks"] = att.probe.solution, att.probe.slacks
    return out


# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------


def solve(project: Project, traj: Trajectory, progress: Optional[ProgressFn] = None,
          parallel: bool = True) -> SolveResult:
    t_start = time.monotonic()
    traj_in = traj
    traj = resolve_poses(project, traj)  # everything below sees plain waypoints
    dt = build_drivetrain(project.robot)
    world = make_world(project, traj)
    issues = validate(project, traj_in, dt, world)  # (validate resolves too, and warns about bad refs)
    if any(i.severity == "error" for i in issues):
        return SolveResult(False, None, issues)

    k = max(1, traj.settings.candidates)
    cands = candidate_routes(traj, dt, world, k)
    if progress:
        progress({"type": "candidates", "count": len(cands),
                  "routes": [[[list(p) for p in seg] for seg in c] for c in cands]})

    pj, tj = project.dump(), traj.model_dump(by_alias=True, mode="json", exclude={"output"})
    deadline_wall = time.time() + traj.settings.time_limit
    results = []
    if parallel and len(cands) > 1:
        results = _run_parallel(pj, tj, cands, deadline_wall, progress)
    else:
        for i, c in enumerate(cands):
            results.append(_solve_candidate(pj, tj, c, i, deadline_wall, None if progress is None else _Direct(progress)))

    results = [r for r in results if r.get("sol") is not None] or results
    good = [r for r in results if r["ok"]]
    total_iters = sum(r["iters"] for r in results)
    attempts = [f"candidate {r['candidate']}: {line}" for r in results for line in r["log"]]
    if good:
        best = min(good, key=lambda r: r["sol"].total_time)
        stats = SolveStats(success=True, total_time=best["sol"].total_time,
                           solve_seconds=time.monotonic() - t_start, iterations=total_iters,
                           candidate=best["candidate"], attempts=attempts)
        out = build_output(project, traj, dt, world, best["sol"], stats)
        return SolveResult(True, out, issues)

    # diagnose with an elastic solve on the most promising candidate
    issues += diagnose(project, traj, results)
    preview = None
    if results and results[0].get("sol") is not None:
        s = results[0]["sol"]
        preview = np.round(np.vstack([s.x, s.y, s.th]).T, 3).tolist()
    return SolveResult(False, None, issues, preview)


def _candidate_entry(pj, tj, routes, cand, deadline_wall, queue):
    try:
        res = _solve_candidate(pj, tj, routes, cand, deadline_wall, queue)
    except Exception as e:  # pragma: no cover - reported to the user
        res = {"ok": False, "sol": None, "iters": 0, "log": [f"crashed: {e!r}"], "candidate": cand}
    queue.put({"type": "_result", "result": res})


def _run_parallel(pj, tj, cands, deadline_wall, progress) -> list[dict]:
    """One daemon process per candidate; progress and results share a queue."""
    import multiprocessing as mp
    import queue as queue_mod

    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    procs = [ctx.Process(target=_candidate_entry, args=(pj, tj, c, i, deadline_wall, q), daemon=True)
             for i, c in enumerate(cands)]
    for pr in procs:
        pr.start()
    results: dict[int, dict] = {}
    hard_deadline = deadline_wall + 30
    try:
        while len(results) < len(procs):
            try:
                msg = q.get(timeout=0.2)
            except queue_mod.Empty:
                for i, pr in enumerate(procs):
                    if i not in results and not pr.is_alive() and pr.exitcode not in (0, None):
                        results[i] = {"ok": False, "sol": None, "iters": 0,
                                      "log": [f"process exited with {pr.exitcode}"], "candidate": i}
                if time.time() > hard_deadline:
                    break
                continue
            if msg.get("type") == "_result":
                r = msg["result"]
                results[r["candidate"]] = r
            elif progress:
                progress(msg)
    finally:
        for pr in procs:
            if pr.is_alive():
                pr.terminate()
    return [r for _, r in sorted(results.items()) if r["sol"] is not None] or list(results.values())


class _Direct:
    """Queue-like adapter for sequential solving."""

    def __init__(self, fn):
        self.fn = fn

    def put(self, msg):
        self.fn(msg)


def diagnose(project: Project, traj: Trajectory, results: list[dict]) -> list[Issue]:
    issues: list[Issue] = []
    if not results:
        return [Issue(severity="error", message="No candidate routes could be generated.")]
    traj = resolve_poses(project, traj)
    probes = [r for r in results if r.get("infeasible") and r.get("probe_sol") is not None]
    if probes:
        # a candidate's elastic probe already proved the conflict; the closest-to-feasible
        # candidate gives the most specific report
        best = min(probes, key=lambda r: sum(t for _, _, t, _ in r["probe_slacks"]))
        dsol, dslacks = best["probe_sol"], best["probe_slacks"]
    else:
        solver = Solver(project, traj, None, 0, time.monotonic() + max(10.0, traj.settings.time_limit / 3))
        sol = results[0].get("sol")
        if sol is None or not np.all(np.isfinite(sol.x)):
            cands = candidate_routes(traj, solver.dt, solver.world, 1)
            sol = build_guess(traj, cands[0], solver.dt)
        res = solver.run_ocp(sol, "elastic", "diagnose")
        dsol, dslacks = res.solution, res.slacks
    times = dsol.times()
    agg: dict[str, tuple[float, int, str]] = {}
    for label, cat, total, k in dslacks:
        if total <= 1e-3:
            continue
        prev = agg.get(label)
        if prev is None or total > prev[0]:
            agg[label] = (total, k, cat)
    ranked = sorted(agg.items(), key=lambda kv: -kv[1][0])
    for label, (total, k, cat) in ranked[:6]:
        t = float(times[k]) if 0 <= k < len(times) else None
        x = float(dsol.x[k]) if 0 <= k < len(times) else None
        y = float(dsol.y[k]) if 0 <= k < len(times) else None
        waypoint = (int(match.group(1)) - 1) if (match := re.match(r"Waypoint (\d+)", label)) else None
        if waypoint is None and cat in ("obstacle", "wall", "keepin") and x is not None and y is not None:
            waypoint = min(range(len(traj.waypoints)),
                           key=lambda j: math.hypot(x - traj.waypoints[j].x, y - traj.waypoints[j].y))
        hint = {
            "obstacle": "the path can't clear this obstacle; add a guide waypoint on the side you want, or move nearby waypoints",
            "wall": "the robot gets pushed into a wall; move waypoints away from the wall",
            "waypoint": "this waypoint can't be reached; add a position tolerance or move it",
            "heading": "this heading can't be reached in time; loosen heading tolerance or add distance",
            "stop": "the robot can't stop here in time",
            "user": "this constraint conflicts with the others; loosen it",
            "wheel": "wheel speed limit is exceeded; the path demands too much speed",
            "force": "traction limit exceeded",
            "motor": "motor torque/current limit exceeded",
        }.get(cat, "")
        issues.append(Issue(severity="error", message=f"{label} is infeasible (violation {total:.3g}): {hint}.",
                            waypoint=waypoint,
                            t=t, x=x, y=y))
    if not ranked:
        issues.append(Issue(severity="error",
                            message="The solver did not converge, but no single constraint looks infeasible. "
                                    "Try adding a guide waypoint or increasing the time limit."))
    return issues


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------


def build_output(project: Project, traj: Trajectory, dt: Drivetrain, world: geo.World,
                 sol: Solution, stats: SolveStats) -> TrajectoryOutput:
    t = sol.times()
    samples = [
        Sample(t=float(t[k]), x=float(sol.x[k]), y=float(sol.y[k]), heading=float(sol.th[k]),
               vx=float(sol.vx[k]), vy=float(sol.vy[k]), omega=float(sol.w[k]),
               ax=float(sol.ax[k]), ay=float(sol.ay[k]), alpha=float(sol.al[k]),
               fx=[float(f) for f in sol.Fx[:, k]], fy=[float(f) for f in sol.Fy[:, k]])
        for k in range(sol.K)
    ]
    wi = waypoint_indices(sol.Ns)
    wtimes = [float(t[i]) for i in wi]
    wps = traj.waypoints
    splits = [wi[j] for j, wp in enumerate(wps) if wp.split and 0 < j < len(wps) - 1]
    T = float(t[-1])
    events = []
    for mk in traj.markers:
        if not (0 <= mk.waypoint < len(wps)):
            continue
        te = min(max(wtimes[mk.waypoint] + mk.offset, 0.0), T)
        end = None
        if mk.end_waypoint is not None and 0 <= mk.end_waypoint < len(wps):
            end = min(max(wtimes[mk.end_waypoint] + mk.end_offset, te), T)
        events.append(EventOut(name=mk.name, command=mk.command or mk.name, t=te, end_t=end,
                               recovery_policy=mk.recovery_policy, must_hit=mk.must_hit))
    events.sort(key=lambda e: e.t)

    recovery = build_recovery(project, traj, dt, world, wtimes, events, T)
    return TrajectoryOutput(input_hash=input_hash(project, traj), samples=samples, waypoint_times=wtimes,
                            splits=splits, events=events, terrain=terrain_spans(traj, sol),
                            recovery=recovery, stats=stats)


def terrain_spans(traj: Trajectory, sol: Solution) -> list[TerrainSpan]:
    """Time spans of the solved trajectory covered by rough-terrain constraints.

    Each run of consecutive covered samples becomes one span; a span is widened by half a sample
    on each side so a zone the robot only clips still covers the time it is on the terrain.
    """
    t = sol.times()
    T = float(t[-1])
    spans: list[TerrainSpan] = []
    for con in traj.constraints:
        if not con.enabled or not isinstance(con.data, RoughTerrain):
            continue
        d = con.data
        ks = sorted(set(scope_samples(con.scope, sol.Ns, sol)))
        runs: list[list[int]] = []
        for k in ks:
            if runs and k == runs[-1][-1] + 1:
                runs[-1].append(k)
            else:
                runs.append([k])
        for run in runs:
            a, b = run[0], run[-1]
            t0 = float(t[a]) - (0.5 * float(t[a] - t[a - 1]) if a > 0 else 0.0)
            t1 = float(t[b]) + (0.5 * float(t[b + 1] - t[b]) if b + 1 < len(t) else 0.0)
            t0, t1 = max(t0, 0.0), min(t1, T)
            if t1 <= t0:
                continue
            spans.append(TerrainSpan(t=t0, end_t=t1, expected_speed=d.expected_speed,
                                     feedback_scale=d.feedback_scale,
                                     expected_delay=(t1 - t0) * (1 / d.expected_speed - 1)))
    spans.sort(key=lambda s: s.t)
    return spans


def build_recovery(project, traj, dt: Drivetrain, world: geo.World, wtimes, events, T) -> RecoveryPayload:
    obstacles = []
    for piece in world.pieces:
        # The optimizer keeps the full margin at samples and >= half of it between samples,
        # so export 0.4x margin: the reference itself is always clear of the exported shapes.
        buf = piece.poly.buffer(0.4 * piece.margin, join_style="mitre", mitre_limit=2.0)
        buf = shapely.geometry.polygon.orient(buf.convex_hull, 1.0)
        obstacles.append([(round(x, 4), round(y, 4)) for x, y in list(buf.exterior.coords)[:-1]])
    rm = geo.build_roadmap(world, dt.circumradius + 0.05)
    nodes = [(round(x, 4), round(y, 4)) for x, y in rm.nodes]
    edges = [(int(a), int(b)) for a, b in rm.graph.edges() if isinstance(a, int) and isinstance(b, int)]
    limits = Limits(
        max_velocity=0.8 * dt.max_speed,
        max_acceleration=0.7 * dt.max_linear_accel,
        max_angular_velocity=0.7 * dt.max_angular_velocity,
        max_angular_acceleration=0.6 * dt.max_angular_accel,
    )
    must = set()
    wps = traj.waypoints
    for j, wp in enumerate(wps):
        if j > 0 and (wp.stop or wp.split):
            must.add(round(wtimes[j], 4))
    for e in events:
        if e.must_hit:
            must.add(round(e.t, 4))
    must.add(round(T, 4))
    return RecoveryPayload(bumper=list(dt.bumper_corners), obstacles=obstacles, field_length=world.length,
                           field_width=world.width, symmetry=project.field.symmetry, roadmap_nodes=nodes,
                           roadmap_edges=edges, limits=limits, must_hit_times=sorted(must))
