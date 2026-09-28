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
from .geometry import World, bumper_polygons, robot_polygons
from .guess import Solution
from .models import (IntakeExtended, KeepIn, MaxAcceleration, MaxAngularVelocity, MaxVelocity, PointAt, RoughTerrain,
                     StraightLine, Trajectory)

SOFT_MODES = {
    "hard": set(),
    "soft_geometry": {"obstacle", "wall", "keepin", "waypoint"},
    "elastic": {"obstacle", "wall", "keepin", "waypoint", "heading", "stop", "user", "wheel", "force", "motor"},
}

SUCCESS = {"Solve_Succeeded", "Solved_To_Acceptable_Level"}

# Smallest robot-obstacle separation used by the hyperplane constraints [m], whatever the
# obstacle's margin (a zero margin makes the degenerate plane n = 0 feasible).
MIN_SEPARATION = 1e-2

# Per-category slack weights. In elastic (diagnostic) solves, moving a fixed waypoint is made
# expensive so the report blames the conflicting constraint rather than relocating the robot
# (e.g. parking it on a point-at target, where the heading constraint degenerates).
SLACK_WEIGHTS = {"elastic": {"waypoint": 10.0}}


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
    planes: dict = field(default_factory=dict)  # {(piece, k[, "intake"]): (n0, n1, b)}
    # constraint multipliers of this solve, for warm-starting a re-solve on the same mesh
    duals: Optional["Duals"] = None


@dataclass
class Duals:
    """Constraint multipliers keyed by constraint block, so they carry over to a re-solve that
    adds or drops blocks and samples (zone membership, obstacle pairs, quarter-point checks)."""

    blocks: dict  # (key, ordinal) -> (offset, rows, rows_per_sample, samples tuple or None)
    lam_g: np.ndarray


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
    # multipliers of a converged hard solve on the same mesh; switches IPOPT to a warm start
    dual_init: Optional[Duals] = None


# IPOPT settings for a re-solve that starts from a converged solution and its multipliers
# (see OCPOptions.dual_init). A cold start re-estimates every multiplier and starts the
# barrier high, so it walks away from the optimum it was given and spends about as many
# iterations getting back as a cold solve. Tighter bound pushes than IPOPT's warm-start
# defaults (1e-3) stall when the re-solve adds violated constraints (new zone samples).
WARM_START_OPTIONS = {
    "warm_start_init_point": "yes",
    "mu_init": 1e-2,
}

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


def intake_samples(traj: Trajectory, sol: Solution, extra: Optional[dict[str, set[int]]] = None) -> set[int]:
    """Samples where an enabled intakeExtended constraint has the intake out.

    `extra` adds zone members by constraint id (sticky zone membership, see OCPOptions.zone_extra).
    """
    out: set[int] = set()
    K = sol.K
    for con in traj.constraints:
        if con.enabled and isinstance(con.data, IntakeExtended):
            out.update(scope_samples(con.scope, sol.Ns, sol))
            if con.scope.kind == "zone" and extra:
                out.update(int(k) for k in extra.get(con.id, ()) if 0 <= k < K)
    return out


def user_limit_violations(traj: Trajectory, sol: Solution, rel: float = 1e-2) -> list[str]:
    """User limits (velocity, acceleration, angular velocity, straight line) a solution breaks.

    Re-checks the solved samples against the limits as the user wrote them, independently of
    how OCP._build formulates the rows, so a mis-scaled or mis-signed row fails the solve
    instead of shipping a path that breaks the limit. `rel` is a relative allowance well above
    IPOPT's feasibility tolerance.
    """
    wps = traj.waypoints
    out = []
    for con in traj.constraints:
        d = con.data
        if not con.enabled or not isinstance(d, (MaxVelocity, MaxAcceleration, MaxAngularVelocity, StraightLine)):
            continue
        ks = np.asarray(scope_samples(con.scope, sol.Ns, sol), dtype=int)
        if ks.size == 0:
            continue
        name = f"'{d.type}' ({con.id})"
        if isinstance(d, (MaxVelocity, MaxAcceleration, MaxAngularVelocity)):
            if isinstance(d, MaxVelocity):
                val, unit = np.hypot(sol.vx[ks], sol.vy[ks]), "m/s"
            elif isinstance(d, MaxAcceleration):
                val, unit = np.hypot(sol.ax[ks], sol.ay[ks]), "m/s²"
            else:
                val, unit = np.abs(sol.w[ks]), "rad/s"
            lim = max(d.value, 1e-3)
            if float(val.max()) > lim * (1 + rel):
                out.append(f"{name} reaches {float(val.max()):.4g} {unit} (limit {lim:.4g})")
            continue
        # StraightLine: same applicability rules as OCP._build
        if con.scope.kind != "range":
            continue
        a, b = sorted((con.scope.from_, con.scope.to))
        if a < 0 or b >= len(wps) or a == b:
            continue
        ex, ey = wps[b].x - wps[a].x, wps[b].y - wps[a].y
        seg = math.hypot(ex, ey)
        if seg < 1e-6:
            continue
        tol = max(d.tolerance, 1e-3) * (1 + rel)
        rx, ry = sol.x[ks] - wps[a].x, sol.y[ks] - wps[a].y
        off = float(np.max(np.abs(ex * ry - ey * rx))) / seg
        proj = (ex * rx + ey * ry) / seg
        if off > tol:
            out.append(f"{name} strays {off:.4g} m from the line (tolerance {d.tolerance:.4g})")
        elif float(proj.min()) < -tol or float(proj.max()) > seg + tol:
            out.append(f"{name} leaves the segment between waypoints {a + 1} and {b + 1}")
    return out


def intake_interval_mask(ext: set[int], K: int) -> np.ndarray:
    """Per interval k -> k+1 (and the last sample): True if the intake is out at either end.

    The intake deploys or retracts somewhere inside the boundary intervals, so they are
    checked with it out.
    """
    m = np.zeros(K, dtype=bool)
    for k in ext:
        if 0 <= k < K:
            m[k] = True
            if k > 0:
                m[k - 1] = True
    return m


def select_pairs(world: World, dt: Drivetrain, sol: Solution, activation: float,
                 ext: Optional[set[int]] = None) -> dict[int, list[int]]:
    """Broad phase: piece index -> list of samples near that piece (bumper or extended intake)."""
    mask = intake_interval_mask(ext, sol.K) if ext and dt.intake_corners else None
    polys = robot_polygons(dt.bumper_corners, sol.x, sol.y, sol.th, dt.intake_corners, mask)
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
        self._blocks: dict = {}
        self._key_count: dict[str, int] = {}
        self._ng = 0
        self._build(pairs)

    # -- constraint helpers ------------------------------------------------

    def _con(self, con, key: str, samples=None):
        """opti.subject_to(con), recording where its rows land in g (see Duals).

        Opti stacks constraints in call order, each one vec'd (column-major), so a block whose
        expression has one column per sample has rows_per_sample consecutive rows per sample.
        """
        self.opti.subject_to(con)
        n = int(con.numel())
        ordinal = self._key_count.get(key, 0)
        self._key_count[key] = ordinal + 1
        per = n // len(samples) if samples and n % len(samples) == 0 else 0
        self._blocks[(key, ordinal)] = (self._ng, n, per, tuple(samples) if per else None)
        self._ng += n

    def _le(self, expr, label: str, cat: str, samples: list[int] | None = None, key: str | None = None):
        """expr <= 0 (elementwise). `key` names the block for dual warm starts (default: label)."""
        key = key or label
        if cat in self.soft:
            sig = self.opti.variable(expr.shape[0], expr.shape[1])
            self._con(ca.vec(sig) >= 0, key + "/slack", samples)
            self._con(ca.vec(expr - sig) <= 0, key, samples)
            self.slacks.append(Slack(label, cat, sig, samples or []))
            self._pending_slack_init.append((sig, expr))
        else:
            self._con(ca.vec(expr) <= 0, key, samples)

    def _eq(self, expr, label: str, cat: str, samples: list[int] | None = None, key: str | None = None):
        key = key or label
        if cat in self.soft:
            sig = self.opti.variable(expr.shape[0], expr.shape[1])
            self._con(ca.vec(sig) >= 0, key + "/slack", samples)
            self._con(ca.vec(expr - sig) <= 0, key + "/+", samples)
            self._con(ca.vec(-expr - sig) <= 0, key + "/-", samples)
            self.slacks.append(Slack(label, cat, sig, samples or []))
            self._pending_slack_init.append((sig, ca.fabs(expr)))
        else:
            self._con(ca.vec(expr) == 0, key, samples)

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
        self._con(opti.bounded(2e-3, h, 1.0), "h", list(range(S)))

        # dynamics (always hard)
        a_ = slice(0, K - 1)
        b_ = slice(1, K)
        iv = list(range(K - 1))
        self._con(x[b_] == x[a_] + vx[a_] * hk + 0.5 * ax[a_] * hk ** 2, "dyn", iv)
        self._con(y[b_] == y[a_] + vy[a_] * hk + 0.5 * ay[a_] * hk ** 2, "dyn", iv)
        self._con(vx[b_] == vx[a_] + ax[a_] * hk, "dyn", iv)
        self._con(vy[b_] == vy[a_] + ay[a_] * hk, "dyn", iv)
        self._con(w[b_] == w[a_] + al[a_] * hk, "dyn", iv)
        dth = w[a_] * hk + 0.5 * al[a_] * hk ** 2
        self._con(c[b_] == c[a_] * ca.cos(dth) - s[a_] * ca.sin(dth), "dyn", iv)
        self._con(s[b_] == s[a_] * ca.cos(dth) + c[a_] * ca.sin(dth), "dyn", iv)

        # Newton-Euler
        Fx = [Fs[2 * i, :] for i in range(M)]
        Fy = [Fs[2 * i + 1, :] for i in range(M)]
        sum_fx = sum(Fx[1:], Fx[0])
        sum_fy = sum(Fy[1:], Fy[0])
        all_k = list(range(K))
        self._con(sum_fx * (F_ref / m) == ax, "newton", all_k)
        self._con(sum_fy * (F_ref / m) == ay, "newton", all_k)
        tau = 0
        rix, riy = [], []
        for i, (mx, my) in enumerate(dt.modules):
            rx = c * mx - s * my
            ry = s * mx + c * my
            rix.append(rx)
            riy.append(ry)
            tau = tau + (rx * Fy[i] - ry * Fx[i])
        self._con(tau * (F_ref / J) == al, "newton", all_k)

        # module limits
        vrx = c * vx + s * vy
        vry = -s * vx + c * vy
        arx = c * ax + s * ay
        ary = -s * ax + c * ay
        mods = np.asarray(dt.modules)
        sx2 = float(np.sum(mods[:, 0] ** 2)) or 1.0
        sy2 = float(np.sum(mods[:, 1] ** 2)) or 1.0
        eps = 1e-2
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
            # Current limit on the total module force. Capping only the longitudinal part
            # (F . v_wheel) leaves lateral force free and is a no-op at v ~ 0, which lets
            # low-current-limit paths weave on "unmotored" side force.
            self._le((Fx[i] ** 2 + Fy[i] ** 2) * (F_ref / F_curr) ** 2 - 1, "Motor current limit", "motor", all_k)

        # samples / intervals where the intake is extended (a second robot part for collisions)
        self.zone_used: dict[str, set[int]] = {}
        intake = dt.intake_corners
        ext: set[int] = set()
        if intake:
            ext = intake_samples(traj, g, opts.zone_extra)
            for con in traj.constraints:
                if con.enabled and isinstance(con.data, IntakeExtended) and con.scope.kind == "zone":
                    self.zone_used[con.id] = set(scope_samples(con.scope, Ns, g)) | {
                        int(k) for k in (opts.zone_extra or {}).get(con.id, ()) if 0 <= k < K}
        ext_iv = intake_interval_mask(ext, K)
        self.intake_samples = ext

        def pose_at(km: list[int], frac: float):
            """Pose a fraction of the way through intervals km (exact constant-acceleration model)."""
            hm = hk[0, km] * frac
            xm = X[0, km] + X[4, km] * hm + 0.5 * X[7, km] * hm ** 2
            ym = X[1, km] + X[5, km] * hm + 0.5 * X[8, km] * hm ** 2
            dm = X[6, km] * hm + 0.5 * X[9, km] * hm ** 2
            cm = X[2, km] * ca.cos(dm) - X[3, km] * ca.sin(dm)
            sm = X[3, km] * ca.cos(dm) + X[2, km] * ca.sin(dm)
            return xm, ym, cm, sm

        def corner_xy(xs, ys, cs, ss, corners=dt.bumper_corners):
            return [(xs + cs * px - ss * py, ys + ss * px + cs * py) for px, py in corners]

        dense = sorted({int(k) for k in (opts.dense_intervals or ()) if 0 <= k < K - 1})
        dense_set = set(dense)

        # field walls on every bumper corner at every sample ...
        L, W, wm = world.length, world.width, world.wall_margin

        def wall_exprs(corners):
            return ca.vertcat(*[ca.vertcat(wm - cx, cx - (L - wm), wm - cy, cy - (W - wm)) for cx, cy in corners])

        ki_all = [k for k in all_k if ext_iv[k]]
        if not os.environ.get("MAYHEM_NOWALL"):
            self._le(wall_exprs(corner_xy(x, y, c, s)), "Field wall", "wall", all_k)
            if ki_all:
                self._le(wall_exprs(corner_xy(X[0, ki_all], X[1, ki_all], X[2, ki_all], X[3, ki_all], intake)),
                         "Field wall (intake)", "wall", ki_all)
        # ... and mid-interval (plus quarter points on dense intervals) near the walls, where
        # a rotating or curving robot's corners can bulge past the wall between samples.
        rad = dt.extended_circumradius if ext else dt.circumradius
        reach = rad + wm + 0.3 + float(np.max(np.hypot(g.vx, g.vy)) * np.max(g.h) if K > 1 else 0.0)
        near = np.minimum.reduce([g.x, L - g.x, g.y, W - g.y]) < reach
        km_wall = [k for k in range(K - 1) if near[k] or near[k + 1] or k in dense_set]
        kd_wall = [k for k in km_wall if k in dense_set]
        for part, lab, keep in ((dt.bumper_corners, "Field wall", None), (intake, "Field wall (intake)", ext_iv)):
            kmw = [k for k in km_wall if keep is None or keep[k]]
            if not part or not kmw:
                continue
            self._le(wall_exprs(corner_xy(*pose_at(kmw, 0.5), part)), lab, "wall", kmw, key=f"{lab}@0.5")
            kdw = [k for k in kd_wall if keep is None or keep[k]]
            for frac in (0.25, 0.75) if kdw else ():
                self._le(wall_exprs(corner_xy(*pose_at(kdw, frac), part)), lab, "wall", kdw, key=f"{lab}@{frac}")

        # obstacles: one separating hyperplane per (piece, interval k -> k+1). The robot
        # footprint at k, at the interval midpoint and at k+1 must all lie on the far side
        # (with the full margin), so the convex hull of the footprints - which is exactly
        # the swept area of a translating robot - clears the piece. Dense intervals also
        # check the quarter points.
        # The intake is a second convex part with its own planes, on the pairs' samples whose
        # interval has it extended.
        self.pair_vars = []
        parts = [(o, sorted(set(int(k) for k in ks)), False) for o, ks in pairs.items()]
        if intake:
            parts += [(o, [k for k in ks if ext_iv[k]], True) for o, ks, _ in list(parts)]
        for o, ks, is_intake in parts:
            if not ks:
                continue
            piece = world.pieces[o]
            corners = intake if is_intake else dt.bumper_corners
            nvar = opti.variable(3, len(ks))
            n0, n1, b = nvar[0, :], nvar[1, :], nvar[2, :]
            # a zero margin would let n = 0, b = 0 satisfy every separation constraint
            half = max(piece.margin, MIN_SEPARATION) / 2
            label = f"Obstacle '{piece.name}'" + (" (intake)" if is_intake else "")
            bk = f"obs{o}" + ("i" if is_intake else "")  # block key: piece names can repeat

            def sep(corners, cols):
                n0c, n1c, bc = nvar[0, cols], nvar[1, cols], nvar[2, cols]
                return ca.vertcat(*[half - (n0c * cx + n1c * cy - bc) for cx, cy in corners])

            all_cols = list(range(len(ks)))
            self._le(sep(corner_xy(X[0, ks], X[1, ks], X[2, ks], X[3, ks], corners), all_cols), label, "obstacle", ks,
                     key=bk)
            cols = [ci for ci, k in enumerate(ks) if k < K - 1]
            if cols:
                km = [ks[ci] for ci in cols]
                k1 = [k + 1 for k in km]
                self._le(sep(corner_xy(X[0, k1], X[1, k1], X[2, k1], X[3, k1], corners), cols), label, "obstacle", k1,
                         key=bk + "@1")
                self._le(sep(corner_xy(*pose_at(km, 0.5), corners), cols), label, "obstacle", km, key=bk + "@0.5")
                dcols = [ci for ci in cols if ks[ci] in dense_set]
                if dcols:
                    kd = [ks[ci] for ci in dcols]
                    for frac in (0.25, 0.75):
                        self._le(sep(corner_xy(*pose_at(kd, frac), corners), dcols), label, "obstacle", kd,
                                 key=f"{bk}@{frac}")
            obs = [n0 * qx + n1 * qy - b + half for qx, qy in piece.verts]
            self._con(ca.vec(ca.vertcat(*obs)) <= 0, bk + "/plane", ks)
            self._con(ca.vec(n0 ** 2 + n1 ** 2) <= 1, bk + "/norm", ks)
            self.pair_vars.append((o, ks, nvar, is_intake))

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
        self._con(c[0] ** 2 + s[0] ** 2 == 1, "unit")

        # user constraints
        for con in traj.constraints:
            if not con.enabled or isinstance(con.data, (RoughTerrain, IntakeExtended)):
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
                # |ω| <= limit as two linear rows. The squared form ω²/limit² has curvature
                # 2/limit² (2e4 for 0.01 rad/s): a guess that turns in the range violates it by
                # ~1e3, and IPOPT stalls regularizing that Hessian until the time limit.
                v = max(d.value, 1e-3)
                self._le(ca.vertcat(X[6, ks], -X[6, ks]) / v - 1, lab, "user", ks)
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
                for corners, kk in ((dt.bumper_corners, ks), (intake, [k for k in ks if k in ext])):
                    if not corners or not kk:
                        continue
                    exprs = []
                    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
                        # inside of CCW polygon: cross(edge, p - p1) >= 0
                        ex, ey = x2 - x1, y2 - y1
                        nrm = math.hypot(ex, ey)
                        for px, py in corners:
                            cx = X[0, kk] + X[2, kk] * px - X[3, kk] * py
                            cy = X[1, kk] + X[3, kk] * px + X[2, kk] * py
                            exprs.append(-(ex * (cy - y1) - ey * (cx - x1)) / nrm)
                    self._le(ca.vertcat(*exprs), lab, "keepin", kk)
            elif isinstance(d, StraightLine):
                # range scope only (validate() warns about other scopes); line through the
                # two end waypoints' positions
                if con.scope.kind != "range":
                    continue
                a, b = sorted((con.scope.from_, con.scope.to))
                if a < 0 or b >= len(wps) or a == b:
                    continue
                px, py = wps[a].x, wps[a].y
                ex, ey = wps[b].x - px, wps[b].y - py
                seg = math.hypot(ex, ey)
                if seg < 1e-6:
                    continue
                tol = max(d.tolerance, 1e-3)
                rx, ry = X[0, ks] - px, X[1, ks] - py
                # signed perpendicular distance within +/- tolerance (linear, see MaxAngularVelocity)
                dist = (ex * ry - ey * rx) / seg
                self._le(ca.vertcat(dist, -dist) / tol - 1, lab, "user", ks)
                # projection onto the segment stays within [0, length] (+/- tolerance)
                proj = (ex * rx + ey * ry) / seg
                self._le(ca.vertcat(-proj - tol, proj - seg - tol) / tol, lab, "user", ks)
            # KeepOut is handled as world geometry by the pipeline.

        # objective
        obj = T_total
        if opts.smoothing > 0 and K > 1:
            dF = Fs[:, 1:] - Fs[:, :-1]
            obj = obj + opts.smoothing * g.total_time * ca.sumsqr(dF) / (M * (K - 1))
        if self.slacks:
            weight = opts.penalty * max(g.total_time, 0.5)
            cw = SLACK_WEIGHTS.get(opts.mode, {})
            obj = obj + weight * sum(cw.get(sl.category, 1.0) * ca.sum1(ca.vec(sl.var)) for sl in self.slacks)
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
        bumper = bumper_polygons(dt.bumper_corners, g.x, g.y, g.th)
        intake = bumper_polygons(dt.intake_corners, g.x, g.y, g.th) if dt.intake_corners else None
        for o, ks, nvar, is_intake in self.pair_vars:
            polys = intake if is_intake else bumper
            piece = self.world.pieces[o]
            vals = np.zeros((3, len(ks)))
            cen = np.asarray(piece.poly.centroid.coords[0])
            K = len(g.x)
            prev = self.opts.plane_init or {}
            for col, k in enumerate(ks):
                key = (o, k, "intake") if is_intake else (o, k)
                if key in prev:
                    vals[:, col] = prev[key]
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
            # Stop once the path is feasible (the same 1e-4 violation bound as a full solve)
            # and the objective has stopped moving for two iterations. Otherwise IPOPT spends
            # the last ~10% of its iterations polishing multipliers of a path that no longer
            # changes.
            "acceptable_tol": 1e-2,
            "acceptable_iter": 2,
            "acceptable_obj_change_tol": 1e-4,
            "acceptable_constr_viol_tol": 1e-4,
            "mu_strategy": "adaptive",
            "nlp_scaling_method": "gradient-based",
            "sb": "yes",
        }
        lin = linear_solver()
        if lin != "mumps":
            ipopt["linear_solver"] = lin
        else:
            # AMF fill-reducing ordering. MUMPS's automatic choice (PORD for these KKT systems)
            # makes each factorization about twice as slow; the benchmark paths are unchanged.
            ipopt["mumps_pivot_order"] = 2
        if opts.dual_init is not None:
            opti.set_initial(opti.lam_g, self._map_duals(opts.dual_init))
            ipopt.update(WARM_START_OPTIONS)
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
        for o, ks, nvar, is_intake in self.pair_vars:
            try:
                v = np.asarray(opti.debug.value(nvar)).reshape(3, -1)
            except Exception:
                continue
            for col, k in enumerate(ks):
                planes[(o, k, "intake") if is_intake else (o, k)] = v[:, col].copy()
        duals = None
        if success and not self.slacks:
            try:
                duals = Duals(dict(self._blocks), np.asarray(opti.debug.value(opti.lam_g)).ravel().copy())
            except Exception:
                pass
        return OCPResult(success, status, sol, iters, secs, slacks, planes, duals)

    def _map_duals(self, prev: Duals) -> np.ndarray:
        """Multipliers for this problem from a previous solve's, matched by block and sample.

        Blocks and samples the previous problem did not have start at zero.
        """
        lam = np.zeros(self._ng)
        for key, (off, n, per, samples) in self._blocks.items():
            old = prev.blocks.get(key)
            if old is None:
                continue
            poff, pn, pper, psamples = old
            if samples is not None and psamples is not None and per == pper:
                where = {k: c for c, k in enumerate(psamples)}
                for c, k in enumerate(samples):
                    pc = where.get(k)
                    if pc is not None:
                        lam[off + c * per:off + (c + 1) * per] = prev.lam_g[poff + pc * per:poff + (pc + 1) * per]
            elif n == pn:
                lam[off:off + n] = prev.lam_g[poff:poff + n]
        return lam

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
