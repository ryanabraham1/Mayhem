"""Swerve time-optimal trajectory NLP (direct transcription) built with CasADi Opti.

Decision variables per sample k: x, y, cosθ, sinθ, vx, vy, ω, ax, ay, α and a
field-frame force (Fx_i, Fy_i) per module (scaled by F_ref). One interval
duration h_j per segment (waypoint j -> j+1).

Every non-dynamics constraint goes through `_le` / `_eq` with a category. In
soft modes, constraints in the selected categories get an L1-penalized slack,
which is how the pipeline does constraint homotopy and elastic diagnostics.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import casadi as ca
import numpy as np
import shapely
from shapely.geometry import Point, Polygon

from .drivetrain import G, Drivetrain
from .geometry import World, bumper_polygons
from .guess import Solution
from .models import KeepIn, MaxAcceleration, MaxAngularVelocity, MaxVelocity, PointAt, Trajectory

SOFT_MODES = {
    "hard": set(),
    "soft_geometry": {"obstacle", "wall", "keepin", "waypoint"},
    "elastic": {"obstacle", "wall", "keepin", "waypoint", "heading", "stop", "user", "wheel", "force", "motor"},
}

SUCCESS = {"Solve_Succeeded", "Solved_To_Acceptable_Level"}


@dataclass
class Slack:
    label: str
    category: str
    var: ca.MX
    samples: list[int]


@dataclass
class OCPResult:
    success: bool
    status: str
    solution: Solution
    iterations: int
    seconds: float
    slacks: list[tuple[str, str, float, int]] = field(default_factory=list)  # label, cat, total, worst sample
    planes: dict = field(default_factory=dict)  # {(piece, k): (n0, n1, b)}


@dataclass
class OCPOptions:
    mode: str = "hard"
    limit_scale: float = 1.0
    smoothing: float = 0.02
    max_iter: int = 1500
    time_limit: float = 60.0
    penalty: float = 100.0
    progress: Optional[Callable[[int, np.ndarray], None]] = None
    progress_period: float = 0.1
    # intervals (k -> k+1) that also get quarter-point collision checks (swept refinement)
    dense_intervals: Optional[set[int]] = None
    warm: bool = False  # the guess is a converged solution of a nearby problem (reuse planes)
    # zone-scoped constraints: samples to constrain in addition to the guess's membership
    zone_extra: Optional[dict[str, set[int]]] = None
    # separating-hyperplane values {(piece, k): (n0, n1, b)} from a previous solve (warm start)
    plane_init: Optional[dict] = None


_LINEAR_SOLVER: Optional[str] = None


def linear_solver() -> str:
    """IPOPT linear solver: HSL MA57 when a libhsl is installed, else the bundled MUMPS.

    Override with MAYHEM_LINEAR_SOLVER (e.g. "ma27", "ma57", "ma86", "mumps"). The HSL
    solvers are loaded at runtime by IPOPT, so availability is probed once per process on
    a tiny NLP.
    """
    global _LINEAR_SOLVER
    if _LINEAR_SOLVER is not None:
        return _LINEAR_SOLVER
    want = os.environ.get("MAYHEM_LINEAR_SOLVER", "").strip().lower()
    choices = [want] if want else ["ma57"]
    _LINEAR_SOLVER = "mumps"
    for cand in choices:
        if cand == "mumps":
            break
        try:
            xs = ca.MX.sym("x", 2)
            f = ca.nlpsol("probe", "ipopt", {"x": xs, "f": ca.sumsqr(xs - 1), "g": xs[0] + xs[1]},
                          {"print_time": False, "error_on_fail": False,
                           "ipopt": {"print_level": 0, "sb": "yes", "linear_solver": cand}})
            f(x0=[0, 0], lbg=0, ubg=3)
            if f.stats().get("return_status") in SUCCESS:
                _LINEAR_SOLVER = cand
                break
        except Exception:
            pass
    return _LINEAR_SOLVER


def _env_ipopt_options() -> dict:
    """Extra IPOPT options from MAYHEM_IPOPT_OPTIONS (JSON object), for experiments."""
    raw = os.environ.get("MAYHEM_IPOPT_OPTIONS")
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def waypoint_indices(Ns: list[int]) -> list[int]:
    return [int(sum(Ns[:j])) for j in range(len(Ns) + 1)]


def scope_samples(scope, Ns: list[int], sol: Solution) -> list[int]:
    idx = waypoint_indices(Ns)
    n = len(idx) - 1
    if scope.kind == "waypoint":
        w = min(max(scope.from_, 0), n)
        return [idx[w]]
    if scope.kind == "range":
        a, b = sorted((min(max(scope.from_, 0), n), min(max(scope.to, 0), n)))
        return list(range(idx[a], idx[b] + 1))
    # zone: samples whose center lies in region (evaluated on the current iterate)
    if len(scope.region) < 3:
        return []
    poly = Polygon(scope.region)
    if not poly.is_valid:
        poly = poly.buffer(0)
    inside = shapely.contains_xy(poly.buffer(0.05), sol.x, sol.y)
    return [int(i) for i in np.where(inside)[0]]


def select_pairs(world: World, dt: Drivetrain, sol: Solution, activation: float) -> dict[int, list[int]]:
    """Broad phase: piece index -> list of samples near that piece."""
    polys = bumper_polygons(dt.bumper_corners, sol.x, sol.y, sol.th)
    pairs: dict[int, list[int]] = {}
    for o, piece in enumerate(world.pieces):
        d = shapely.distance(polys, piece.poly)
        ks = np.where(d < activation + piece.margin)[0]
        if len(ks):
            pairs[o] = [int(k) for k in ks]
    return pairs


class OCP:
    def __init__(
        self,
        dt: Drivetrain,
        world: World,
        traj: Trajectory,
        guess: Solution,
        pairs: dict[int, list[int]],
        opts: OCPOptions,
    ):
        self.dt, self.world, self.traj, self.guess, self.opts = dt, world, traj, guess, opts
        self.soft = SOFT_MODES[opts.mode]
        self.slacks: list[Slack] = []
        self.opti = ca.Opti()
        self._pending_slack_init: list[tuple[ca.MX, ca.MX]] = []
        self._build(pairs)

    # -- constraint helpers ------------------------------------------------

    def _le(self, expr, label: str, cat: str, samples: list[int] | None = None):
        """expr <= 0 (elementwise)."""
        opti = self.opti
        if cat in self.soft:
            sig = opti.variable(expr.shape[0], expr.shape[1])
            opti.subject_to(ca.vec(sig) >= 0)
            opti.subject_to(ca.vec(expr - sig) <= 0)
            self.slacks.append(Slack(label, cat, sig, samples or []))
            self._pending_slack_init.append((sig, expr))
        else:
            opti.subject_to(ca.vec(expr) <= 0)

    def _eq(self, expr, label: str, cat: str, samples: list[int] | None = None):
        opti = self.opti
        if cat in self.soft:
            sig = opti.variable(expr.shape[0], expr.shape[1])
            opti.subject_to(ca.vec(sig) >= 0)
            opti.subject_to(ca.vec(expr - sig) <= 0)
            opti.subject_to(ca.vec(-expr - sig) <= 0)
            self.slacks.append(Slack(label, cat, sig, samples or []))
            self._pending_slack_init.append((sig, ca.fabs(expr)))
        else:
            opti.subject_to(ca.vec(expr) == 0)

    # -- problem -------------------------------------------------------------

    def _build(self, pairs: dict[int, list[int]]):
        dt, world, traj, g, opts = self.dt, self.world, self.traj, self.guess, self.opts
        opti = self.opti
        Ns = g.Ns
        S = len(Ns)
        K = sum(Ns) + 1
        M = dt.n_modules
        ls = opts.limit_scale

        F_ref = dt.max_wheel_force
        v_free = dt.wheel_free_speed * ls
        F_stall = dt.wheel_stall_force * ls
        F_curr = dt.wheel_current_force * ls
        F_fric = dt.friction_force * ls
        m, J = dt.mass, dt.moi

        X = opti.variable(10, K)
        Fs = opti.variable(2 * M, K)
        h = opti.variable(S)
        self.X, self.Fs, self.h = X, Fs, h
        x, y, c, s = X[0, :], X[1, :], X[2, :], X[3, :]
        vx, vy, w = X[4, :], X[5, :], X[6, :]
        ax, ay, al = X[7, :], X[8, :], X[9, :]

        # interval durations as a row vector
        hk = ca.horzcat(*[ca.repmat(h[j], 1, Ns[j]) for j in range(S)])
        T_total = ca.sum1(ca.vertcat(*[Ns[j] * h[j] for j in range(S)]))

        h_guess = np.maximum(g.h, 1e-3)
        opti.subject_to(opti.bounded(2e-3, h, 1.0))

        # dynamics (always hard)
        a_ = slice(0, K - 1)
        b_ = slice(1, K)
        opti.subject_to(x[b_] == x[a_] + vx[a_] * hk + 0.5 * ax[a_] * hk ** 2)
        opti.subject_to(y[b_] == y[a_] + vy[a_] * hk + 0.5 * ay[a_] * hk ** 2)
        opti.subject_to(vx[b_] == vx[a_] + ax[a_] * hk)
        opti.subject_to(vy[b_] == vy[a_] + ay[a_] * hk)
        opti.subject_to(w[b_] == w[a_] + al[a_] * hk)
        dth = w[a_] * hk + 0.5 * al[a_] * hk ** 2
        opti.subject_to(c[b_] == c[a_] * ca.cos(dth) - s[a_] * ca.sin(dth))
        opti.subject_to(s[b_] == s[a_] * ca.cos(dth) + c[a_] * ca.sin(dth))

        # Newton-Euler
        Fx = [Fs[2 * i, :] for i in range(M)]
        Fy = [Fs[2 * i + 1, :] for i in range(M)]
        sum_fx = sum(Fx[1:], Fx[0])
        sum_fy = sum(Fy[1:], Fy[0])
        opti.subject_to(sum_fx * (F_ref / m) == ax)
        opti.subject_to(sum_fy * (F_ref / m) == ay)
        tau = 0
        rix, riy = [], []
        for i, (mx, my) in enumerate(dt.modules):
            rx = c * mx - s * my
            ry = s * mx + c * my
            rix.append(rx)
            riy.append(ry)
            tau = tau + (rx * Fy[i] - ry * Fx[i])
        opti.subject_to(tau * (F_ref / J) == al)

        # module limits
        vrx = c * vx + s * vy
        vry = -s * vx + c * vy
        arx = c * ax + s * ay
        ary = -s * ax + c * ay
        mods = np.asarray(dt.modules)
        sx2 = float(np.sum(mods[:, 0] ** 2)) or 1.0
        sy2 = float(np.sum(mods[:, 1] ** 2)) or 1.0
        eps = 1e-2
        all_k = list(range(K))
        for i, (mx, my) in enumerate(dt.modules):
            vwx = vrx - w * my
            vwy = vry + w * mx
            self._le((vwx ** 2 + vwy ** 2) / v_free ** 2 - 1, "Wheel speed limit", "wheel", all_k)

            if dt.cog_height > 0:
                n_i = m * G / M - m * dt.cog_height * (arx * mx / sx2 + ary * my / sy2)
                fric = dt.wheel_cof * n_i * ls
                self._le((Fx[i] ** 2 + Fy[i] ** 2) * F_ref ** 2 / F_fric ** 2 - (fric / F_fric) ** 2,
                         "Wheel friction limit", "force", all_k)
                self._le(-(n_i / (m * G / M)) + 0.05, "Wheel lift-off", "force", all_k)
            else:
                self._le((Fx[i] ** 2 + Fy[i] ** 2) * (F_ref / F_fric) ** 2 - 1,
                         "Wheel friction limit", "force", all_k)

            # motor torque-speed line and current limit on the longitudinal force
            vfx = vx - w * riy[i]
            vfy = vy + w * rix[i]
            sw = ca.sqrt(vfx ** 2 + vfy ** 2 + eps ** 2)
            d = (Fx[i] * vfx + Fy[i] * vfy) * F_ref  # longitudinal force * |v_w|
            self._le(d / (F_stall * v_free) - (sw / v_free) * (1 - sw / v_free),
                     "Motor torque-speed limit", "motor", all_k)
            self._le(d / (F_curr * v_free) - sw / v_free, "Motor current limit", "motor", all_k)
            self._le(-d / (F_curr * v_free) - sw / v_free, "Motor current limit", "motor", all_k)

        def pose_at(km: list[int], frac: float):
            """Pose a fraction of the way through intervals km (exact constant-acceleration model)."""
            hm = hk[0, km] * frac
            xm = X[0, km] + X[4, km] * hm + 0.5 * X[7, km] * hm ** 2
            ym = X[1, km] + X[5, km] * hm + 0.5 * X[8, km] * hm ** 2
            dm = X[6, km] * hm + 0.5 * X[9, km] * hm ** 2
            cm = X[2, km] * ca.cos(dm) - X[3, km] * ca.sin(dm)
            sm = X[3, km] * ca.cos(dm) + X[2, km] * ca.sin(dm)
            return xm, ym, cm, sm

        def corner_xy(xs, ys, cs, ss):
            return [(xs + cs * px - ss * py, ys + ss * px + cs * py) for px, py in dt.bumper_corners]

        dense = sorted({int(k) for k in (opts.dense_intervals or ()) if 0 <= k < K - 1})
        dense_set = set(dense)

        # field walls on every bumper corner at every sample ...
        L, W, wm = world.length, world.width, world.wall_margin

        def wall_exprs(corners):
            return ca.vertcat(*[ca.vertcat(wm - cx, cx - (L - wm), wm - cy, cy - (W - wm)) for cx, cy in corners])

        if not os.environ.get("MAYHEM_NOWALL"):
            self._le(wall_exprs(corner_xy(x, y, c, s)), "Field wall", "wall", all_k)
        # ... and mid-interval (plus quarter points on dense intervals) near the walls, where
        # a rotating or curving robot's corners can bulge past the wall between samples.
        reach = dt.circumradius + wm + 0.3 + float(np.max(np.hypot(g.vx, g.vy)) * np.max(g.h) if K > 1 else 0.0)
        near = np.minimum.reduce([g.x, L - g.x, g.y, W - g.y]) < reach
        km_wall = [k for k in range(K - 1) if near[k] or near[k + 1] or k in dense_set]
        if km_wall:
            self._le(wall_exprs(corner_xy(*pose_at(km_wall, 0.5))), "Field wall", "wall", km_wall)
        kd_wall = [k for k in km_wall if k in dense_set]
        for frac in (0.25, 0.75) if kd_wall else ():
            self._le(wall_exprs(corner_xy(*pose_at(kd_wall, frac))), "Field wall", "wall", kd_wall)

        # obstacles: one separating hyperplane per (piece, interval k -> k+1). The robot
        # footprint at k, at the interval midpoint and at k+1 must all lie on the far side
        # (with the full margin), so the convex hull of the footprints - which is exactly
        # the swept area of a translating robot - clears the piece. Dense intervals also
        # check the quarter points.
        self.pair_vars = []
        for o, ks in pairs.items():
            piece = world.pieces[o]
            ks = sorted(set(int(k) for k in ks))
            nvar = opti.variable(3, len(ks))
            n0, n1, b = nvar[0, :], nvar[1, :], nvar[2, :]
            half = piece.margin / 2
            label = f"Obstacle '{piece.name}'"

            def sep(corners, cols):
                n0c, n1c, bc = nvar[0, cols], nvar[1, cols], nvar[2, cols]
                return ca.vertcat(*[half - (n0c * cx + n1c * cy - bc) for cx, cy in corners])

            all_cols = list(range(len(ks)))
            self._le(sep(corner_xy(X[0, ks], X[1, ks], X[2, ks], X[3, ks]), all_cols), label, "obstacle", ks)
            cols = [ci for ci, k in enumerate(ks) if k < K - 1]
            if cols:
                km = [ks[ci] for ci in cols]
                k1 = [k + 1 for k in km]
                self._le(sep(corner_xy(X[0, k1], X[1, k1], X[2, k1], X[3, k1]), cols), label, "obstacle", k1)
                self._le(sep(corner_xy(*pose_at(km, 0.5)), cols), label, "obstacle", km)
                dcols = [ci for ci in cols if ks[ci] in dense_set]
                if dcols:
                    kd = [ks[ci] for ci in dcols]
                    for frac in (0.25, 0.75):
                        self._le(sep(corner_xy(*pose_at(kd, frac)), dcols), label, "obstacle", kd)
            obs = [n0 * qx + n1 * qy - b + half for qx, qy in piece.verts]
            opti.subject_to(ca.vec(ca.vertcat(*obs)) <= 0)
            opti.subject_to(ca.vec(n0 ** 2 + n1 ** 2) <= 1)
            self.pair_vars.append((o, ks, nvar))

        # waypoints
        idx = waypoint_indices(Ns)
        wps = traj.waypoints
        for j, wp in enumerate(wps):
            k = idx[j]
            if wp.translation_mode == "fixed":
                dx, dy = x[k] - wp.x, y[k] - wp.y
                tol = wp.tolerance
                label = f"Waypoint {j + 1} position"
                if tol.kind == "circle" and tol.radius > 0:
                    self._le(dx ** 2 + dy ** 2 - tol.radius ** 2, label, "waypoint", [k])
                elif tol.kind == "box" and (tol.dx > 0 or tol.dy > 0):
                    self._le(ca.vertcat(dx - tol.dx, -dx - tol.dx, dy - tol.dy, -dy - tol.dy), label, "waypoint", [k])
                else:
                    self._eq(ca.vertcat(dx, dy), label, "waypoint", [k])
            if wp.heading_mode == "fixed":
                ch, sh = math.cos(wp.heading), math.sin(wp.heading)
                label = f"Waypoint {j + 1} heading"
                if wp.heading_tolerance > 1e-4:
                    self._le(math.cos(wp.heading_tolerance) - (c[k] * ch + s[k] * sh), label, "heading", [k])
                else:
                    self._eq(s[k] * ch - c[k] * sh, label, "heading", [k])
                    self._le(-(c[k] * ch + s[k] * sh), label, "heading", [k])
            if j == 0 or wp.stop:
                self._eq(ca.vertcat(vx[k], vy[k], w[k]), f"Waypoint {j + 1} stop", "stop", [k])

        # Unit rotation at the first sample; the rotation dynamics preserve the
        # norm, so this keeps (cosθ, sinθ) on the unit circle everywhere. Heading
        # constraints only fix the direction, so this must always be present or
        # the solver can "shrink" the robot's corners.
        opti.subject_to(c[0] ** 2 + s[0] ** 2 == 1)

        # user constraints
        self.zone_used: dict[str, set[int]] = {}
        for con in traj.constraints:
            if not con.enabled:
                continue
            ks = scope_samples(con.scope, Ns, g)
            if con.scope.kind == "zone":
                extra = (opts.zone_extra or {}).get(con.id, ())
                ks = sorted(set(ks) | {int(k) for k in extra if 0 <= k < K})
                self.zone_used[con.id] = set(ks)
            if not ks:
                continue
            d = con.data
            lab = f"Constraint '{d.type}' ({con.id})"
            if isinstance(d, MaxVelocity):
                self._le((X[4, ks] ** 2 + X[5, ks] ** 2) / max(d.value, 1e-3) ** 2 - 1, lab, "user", ks)
            elif isinstance(d, MaxAcceleration):
                self._le((X[7, ks] ** 2 + X[8, ks] ** 2) / max(d.value, 1e-3) ** 2 - 1, lab, "user", ks)
            elif isinstance(d, MaxAngularVelocity):
                self._le(X[6, ks] ** 2 / max(d.value, 1e-3) ** 2 - 1, lab, "user", ks)
            elif isinstance(d, PointAt):
                ddx = d.x - X[0, ks]
                ddy = d.y - X[1, ks]
                dist = ca.sqrt(ddx ** 2 + ddy ** 2 + 1e-4)
                dot = X[2, ks] * ddx + X[3, ks] * ddy
                if d.flip:
                    dot = -dot
                self._le(math.cos(max(d.tolerance, 1e-3)) * dist - dot, lab, "user", ks)
            elif isinstance(d, KeepIn):
                poly = Polygon(d.points)
                if len(d.points) < 3 or not poly.is_valid:
                    continue
                hull = shapely.geometry.polygon.orient(poly.convex_hull, 1.0)
                pts = list(hull.exterior.coords)[:-1]
                exprs = []
                for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
                    # inside of CCW polygon: cross(edge, p - p1) >= 0
                    ex, ey = x2 - x1, y2 - y1
                    nrm = math.hypot(ex, ey)
                    for px, py in dt.bumper_corners:
                        cx = X[0, ks] + X[2, ks] * px - X[3, ks] * py
                        cy = X[1, ks] + X[3, ks] * px + X[2, ks] * py
                        exprs.append(-(ex * (cy - y1) - ey * (cx - x1)) / nrm)
                self._le(ca.vertcat(*exprs), lab, "keepin", ks)
            # KeepOut is handled as world geometry by the pipeline.

        # objective
        obj = T_total
        if opts.smoothing > 0 and K > 1:
            dF = Fs[:, 1:] - Fs[:, :-1]
            obj = obj + opts.smoothing * g.total_time * ca.sumsqr(dF) / (M * (K - 1))
        if self.slacks:
            weight = opts.penalty * max(g.total_time, 0.5)
            obj = obj + weight * sum(ca.sum1(ca.vec(sl.var)) for sl in self.slacks)
        opti.minimize(obj)

        # initial values
        th = g.th
        opti.set_initial(X, np.vstack([g.x, g.y, np.cos(th), np.sin(th), g.vx, g.vy, g.w, g.ax, g.ay, g.al]))
        Fs0 = np.zeros((2 * M, K))
        Fs0[0::2] = g.Fx / F_ref
        Fs0[1::2] = g.Fy / F_ref
        opti.set_initial(Fs, Fs0)
        opti.set_initial(h, h_guess)
        self._init_pairs(g)
        for sig, expr in self._pending_slack_init:
            try:
                val = np.asarray(opti.debug.value(expr, opti.initial()))
                opti.set_initial(sig, np.maximum(val, 0) + 1e-3)
            except Exception:
                opti.set_initial(sig, 1e-2)

        self.T_total = T_total

    def _init_pairs(self, g: Solution):
        dt = self.dt
        polys = bumper_polygons(dt.bumper_corners, g.x, g.y, g.th)
        for o, ks, nvar in self.pair_vars:
            piece = self.world.pieces[o]
            vals = np.zeros((3, len(ks)))
            cen = np.asarray(piece.poly.centroid.coords[0])
            K = len(g.x)
            prev = self.opts.plane_init or {}
            for col, k in enumerate(ks):
                if (o, k) in prev:
                    vals[:, col] = prev[(o, k)]
                    continue
                rob = polys[k] if k >= K - 1 else shapely.union(polys[k], polys[k + 1]).convex_hull
                if rob.intersects(piece.poly) or rob.distance(piece.poly) < 1e-6:
                    n = np.array([g.x[k], g.y[k]]) - cen
                else:
                    p, q = shapely.ops.nearest_points(rob, piece.poly)
                    n = np.array([p.x - q.x, p.y - q.y])
                nn = np.linalg.norm(n)
                n = n / nn if nn > 1e-9 else np.array([1.0, 0.0])
                n *= 0.999
                robc = np.asarray(rob.exterior.coords)[:-1] @ n
                obsc = piece.verts @ n
                vals[:2, col] = n
                vals[2, col] = 0.5 * (robc.min() + obsc.max())
            self.opti.set_initial(nvar, vals)

    # -- solve ---------------------------------------------------------------

    def solve(self) -> OCPResult:
        opti, opts = self.opti, self.opts
        ipopt = {
            "print_level": 0,
            "max_iter": opts.max_iter,
            "max_cpu_time": opts.time_limit,
            "tol": 1e-6,
            "acceptable_tol": 1e-4,
            "acceptable_iter": 8,
            "acceptable_constr_viol_tol": 1e-4,
            "mu_strategy": "adaptive",
            "nlp_scaling_method": "gradient-based",
            "sb": "yes",
        }
        lin = linear_solver()
        if lin != "mumps":
            ipopt["linear_solver"] = lin
        ipopt.update(_env_ipopt_options())
        opti.solver("ipopt", {"print_time": False, "error_on_fail": False}, ipopt)

        last = [0.0]
        if opts.progress is not None:
            X = self.X

            def cb(i):
                now = time.monotonic()
                if now - last[0] < opts.progress_period:
                    return
                last[0] = now
                try:
                    v = np.asarray(opti.debug.value(X[0:4, :]))
                    opts.progress(int(i), v)
                except Exception:
                    pass

            opti.callback(cb)

        t0 = time.monotonic()
        try:
            opti.solve()
        except RuntimeError:
            pass
        secs = time.monotonic() - t0
        stats = opti.stats()
        status = str(stats.get("return_status", "unknown"))
        iters = int(stats.get("iter_count", 0))
        sol = self._extract()
        slacks = self._slack_report()
        success = status in SUCCESS and np.all(np.isfinite(sol.x))
        if success and self.slacks and self.opts.mode != "elastic":
            # a soft solve "succeeds" only as a warm start; flag if slack remains
            pass
        planes = {}
        for o, ks, nvar in self.pair_vars:
            try:
                v = np.asarray(opti.debug.value(nvar)).reshape(3, -1)
            except Exception:
                continue
            for col, k in enumerate(ks):
                planes[(o, k)] = v[:, col].copy()
        return OCPResult(success, status, sol, iters, secs, slacks, planes)

    def _extract(self) -> Solution:
        opti, g, dt = self.opti, self.guess, self.dt
        val = opti.debug.value
        Xv = np.asarray(val(self.X))
        Fv = np.asarray(val(self.Fs)).reshape(2 * dt.n_modules, -1)
        hv = np.atleast_1d(np.asarray(val(self.h))).ravel()
        th = np.unwrap(np.arctan2(Xv[3], Xv[2]))
        F_ref = dt.max_wheel_force
        return Solution(list(g.Ns), hv, Xv[0], Xv[1], th, Xv[4], Xv[5], Xv[6], Xv[7], Xv[8], Xv[9],
                        Fv[0::2] * F_ref, Fv[1::2] * F_ref)

    def _slack_report(self):
        out = []
        for sl in self.slacks:
            try:
                v = np.asarray(self.opti.debug.value(sl.var)).reshape(sl.var.shape[0], -1)
            except Exception:
                continue
            total = float(np.sum(v))
            per_col = v.sum(axis=0) if v.ndim == 2 else v
            worst = int(np.argmax(per_col)) if per_col.size else 0
            k = sl.samples[worst] if sl.samples and worst < len(sl.samples) else (sl.samples[0] if sl.samples else -1)
            out.append((sl.label, sl.category, total, k))
        return out
