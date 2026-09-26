"""Full-state initial guesses and solution containers."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

from .drivetrain import Drivetrain
from .models import Trajectory


def wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


@dataclass
class Solution:
    Ns: list[int]
    h: np.ndarray  # (S,) interval duration per segment
    x: np.ndarray
    y: np.ndarray
    th: np.ndarray  # unwrapped heading
    vx: np.ndarray
    vy: np.ndarray
    w: np.ndarray
    ax: np.ndarray
    ay: np.ndarray
    al: np.ndarray
    Fx: np.ndarray  # (M, K) field frame [N]
    Fy: np.ndarray

    @property
    def K(self) -> int:
        return len(self.x)

    def seg_start(self, j: int) -> int:
        return int(sum(self.Ns[:j]))

    def times(self) -> np.ndarray:
        dts = np.concatenate([np.full(n, h) for n, h in zip(self.Ns, self.h)]) if self.Ns else np.zeros(0)
        return np.concatenate([[0.0], np.cumsum(dts)])

    @property
    def total_time(self) -> float:
        return float(np.dot(self.Ns, self.h))

    def interval_h(self) -> np.ndarray:
        return np.concatenate([np.full(n, h) for n, h in zip(self.Ns, self.h)])


# ---------------------------------------------------------------------------
# Trapezoidal profile helpers
# ---------------------------------------------------------------------------


@dataclass
class Trap:
    L: float
    vmax: float
    amax: float

    def __post_init__(self):
        L, v, a = max(self.L, 0.0), self.vmax, self.amax
        ta = v / a
        if L < v * ta:  # triangular
            ta = math.sqrt(L / a) if L > 0 else 0.0
            self.vp = a * ta
            self.tc = 0.0
        else:
            self.vp = v
            self.tc = (L - v * ta) / v
        self.ta = ta
        self.T = 2 * ta + self.tc

    def s(self, t: float) -> float:
        a, ta, tc, vp = self.amax, self.ta, self.tc, self.vp
        t = min(max(t, 0.0), self.T)
        if t < ta:
            return 0.5 * a * t * t
        if t < ta + tc:
            return 0.5 * a * ta * ta + vp * (t - ta)
        td = self.T - t
        return self.L - 0.5 * a * td * td

    def v(self, t: float) -> float:
        a, ta, tc, vp = self.amax, self.ta, self.tc, self.vp
        if t <= 0 or t >= self.T:
            return 0.0
        if t < ta:
            return a * t
        if t < ta + tc:
            return vp
        return a * (self.T - t)

    def t_of_s(self, s: float) -> float:
        a, ta, tc, vp = self.amax, self.ta, self.tc, self.vp
        s = min(max(s, 0.0), self.L)
        s1 = 0.5 * a * ta * ta
        if s <= s1:
            return math.sqrt(2 * s / a) if a > 0 else 0.0
        if s <= s1 + vp * tc:
            return ta + (s - s1) / vp
        rem = self.L - s
        return self.T - math.sqrt(max(2 * rem / a, 0.0))


def trap_time(dist: float, vmax: float, amax: float) -> float:
    return Trap(abs(dist), vmax, amax).T


class Polyline:
    def __init__(self, pts):
        self.pts = np.asarray(pts, dtype=float)
        if len(self.pts) == 1:
            self.pts = np.vstack([self.pts, self.pts])
        seg = np.diff(self.pts, axis=0)
        self.seglen = np.hypot(seg[:, 0], seg[:, 1])
        self.cum = np.concatenate([[0.0], np.cumsum(self.seglen)])
        self.length = float(self.cum[-1])

    def at(self, s: float):
        """Point and unit tangent at arc length s."""
        s = min(max(s, 0.0), self.length)
        i = int(np.searchsorted(self.cum, s, side="right") - 1)
        i = min(max(i, 0), len(self.seglen) - 1)
        L = self.seglen[i]
        a, b = self.pts[i], self.pts[i + 1]
        if L < 1e-12:
            # find any non-degenerate tangent
            nz = np.where(self.seglen > 1e-12)[0]
            tan = (self.pts[nz[0] + 1] - self.pts[nz[0]]) / self.seglen[nz[0]] if len(nz) else np.zeros(2)
            return a.copy(), tan
        u = (s - self.cum[i]) / L
        return a + u * (b - a), (b - a) / L


# ---------------------------------------------------------------------------
# Guess construction
# ---------------------------------------------------------------------------


def resolve_headings(traj: Trajectory, lengths: list[float]) -> list[float]:
    wps = traj.waypoints
    n = len(wps)
    cum = np.concatenate([[0.0], np.cumsum(lengths)])
    fixed = [i for i, w in enumerate(wps) if w.heading_mode == "fixed"]
    if not fixed:
        return [0.0] * n
    # unwrap fixed headings along the path
    unwrapped = {fixed[0]: wps[fixed[0]].heading}
    for a, b in zip(fixed[:-1], fixed[1:]):
        unwrapped[b] = unwrapped[a] + wrap(wps[b].heading - wps[a].heading)
    out = []
    for i in range(n):
        if i in unwrapped:
            out.append(unwrapped[i])
            continue
        prev = max((f for f in fixed if f < i), default=None)
        nxt = min((f for f in fixed if f > i), default=None)
        if prev is None:
            out.append(unwrapped[nxt])
        elif nxt is None:
            out.append(unwrapped[prev])
        else:
            span = cum[nxt] - cum[prev]
            u = (cum[i] - cum[prev]) / span if span > 1e-9 else 0.5
            out.append(unwrapped[prev] + u * (unwrapped[nxt] - unwrapped[prev]))
    return out


def build_guess(
    traj: Trajectory,
    routes: list[list[tuple[float, float]]],
    dt: Drivetrain,
    point_at_members: list[tuple[list[int], float, float, bool]] | None = None,
    Ns_override: list[int] | None = None,
) -> Solution:
    """routes[j] = polyline from waypoint j to j+1 (inclusive of both ends)."""
    wps = traj.waypoints
    S = len(wps) - 1
    polys = [Polyline(r) for r in routes]
    lengths = [p.length for p in polys]
    headings = resolve_headings(traj, lengths)

    vg = 0.7 * dt.max_speed
    ag = 0.5 * dt.max_linear_accel
    wg = 0.5 * dt.max_angular_velocity
    alg = 0.4 * dt.max_angular_accel

    # Split into runs between stop waypoints.
    stops = sorted({0, S} | {i for i, w in enumerate(wps) if w.stop})
    seg_T = [0.0] * S
    seg_t0 = [0.0] * S
    seg_prof: list[tuple[Trap, float, float, float]] = [None] * S  # (trap, scale, run_s0, seg_s0)
    t_run0 = 0.0
    for a, b in zip(stops[:-1], stops[1:]):
        L = sum(lengths[a:b])
        trap = Trap(L, vg, ag)
        # time scale so each segment has enough time to rotate
        seg_s = np.concatenate([[0.0], np.cumsum(lengths[a:b])])
        seg_times = [trap.t_of_s(seg_s[i + 1]) - trap.t_of_s(seg_s[i]) for i in range(b - a)]
        f = 1.0
        for i, j in enumerate(range(a, b)):
            dth = abs(headings[j + 1] - headings[j])
            t_rot = trap_time(dth, wg, alg) if dth > 1e-6 else 0.0
            if seg_times[i] > 1e-9:
                f = max(f, t_rot / seg_times[i])
            elif t_rot > 0:
                f = max(f, 1.0)
        # pure rotation runs
        if trap.T < 1e-6:
            total_rot = sum(trap_time(abs(headings[j + 1] - headings[j]), wg, alg) for j in range(a, b))
            total_rot = max(total_rot, 0.2 * (b - a))
            for i, j in enumerate(range(a, b)):
                seg_T[j] = total_rot / (b - a)
                seg_t0[j] = t_run0 + i * seg_T[j]
                seg_prof[j] = (trap, 1.0, 0.0, 0.0)
            t_run0 += total_rot
            continue
        for i, j in enumerate(range(a, b)):
            t0 = trap.t_of_s(seg_s[i]) * f
            t1 = trap.t_of_s(seg_s[i + 1]) * f
            seg_T[j] = max(t1 - t0, 0.05)
            seg_t0[j] = t_run0 + t0
            seg_prof[j] = (trap, f, t_run0, seg_s[i])
        t_run0 += trap.T * f

    target = traj.settings.target_dt
    if Ns_override is not None:
        Ns = list(Ns_override)
    else:
        Ns = []
        for j in range(S):
            if wps[j].intervals:
                Ns.append(max(2, int(wps[j].intervals)))
            else:
                Ns.append(max(4, int(math.ceil(seg_T[j] / target))))

    K = sum(Ns) + 1
    x = np.zeros(K)
    y = np.zeros(K)
    th = np.zeros(K)
    vx = np.zeros(K)
    vy = np.zeros(K)
    t_arr = np.zeros(K)
    idx = 0
    for j in range(S):
        trap, f, run_t0, seg_s0 = seg_prof[j]
        n = Ns[j]
        last = j == S - 1
        for k in range(n + (1 if last else 0)):
            tt = seg_t0[j] + seg_T[j] * k / n
            u = k / n
            if trap.T < 1e-6:
                s_local, speed = 0.0, 0.0
            else:
                tau = (tt - run_t0) / f
                s_local = trap.s(tau) - seg_s0
                speed = trap.v(tau) / f
            p, tan = polys[j].at(s_local)
            x[idx], y[idx] = p
            vx[idx], vy[idx] = speed * tan
            sm = u * u * (3 - 2 * u)
            th[idx] = headings[j] + (headings[j + 1] - headings[j]) * sm
            t_arr[idx] = tt
            idx += 1

    if point_at_members:
        for members, px, py, flip in point_at_members:
            for k in members:
                ang = math.atan2(py - y[k], px - x[k]) + (math.pi if flip else 0.0)
                th[k] = ang
        th = np.unwrap(th)
        # re-anchor to preserve first heading's branch
    th = np.unwrap(th)

    h = np.array([seg_T[j] / Ns[j] for j in range(S)])
    t_grid = np.concatenate([[0.0], np.cumsum(np.concatenate([np.full(n, hh) for n, hh in zip(Ns, h)]))])
    w = np.gradient(th, t_grid) if K > 2 else np.zeros(K)
    ax = np.gradient(vx, t_grid) if K > 2 else np.zeros(K)
    ay = np.gradient(vy, t_grid) if K > 2 else np.zeros(K)
    al = np.gradient(w, t_grid) if K > 2 else np.zeros(K)
    for arr in (vx, vy, w):
        arr[0] = 0.0
    last_stop = wps[-1].stop
    if last_stop:
        vx[-1] = vy[-1] = w[-1] = 0.0

    Fx, Fy = distribute_forces(dt, th, ax, ay, al)
    return Solution(Ns, h, x, y, th, vx, vy, w, ax, ay, al, Fx, Fy)


def distribute_forces(dt: Drivetrain, th, ax, ay, al):
    M = dt.n_modules
    mods = np.asarray(dt.modules)
    c, s = np.cos(th), np.sin(th)
    Fx = np.tile(dt.mass * ax / M, (M, 1))
    Fy = np.tile(dt.mass * ay / M, (M, 1))
    r2 = float(np.sum(mods ** 2))
    for i, (mx, my) in enumerate(mods):
        rx = c * mx - s * my
        ry = s * mx + c * my
        # tangential force so that sum r x F = J alpha
        k = dt.moi * al / r2
        Fx[i] += -ry * k
        Fy[i] += rx * k
    return Fx, Fy


def resample(sol: Solution, Ns_new: list[int]) -> Solution:
    """Linear re-interpolation of a solution onto a new per-segment grid."""
    t_old = sol.times()
    parts_t = []
    T0 = 0.0
    for j, (n_old, n_new) in enumerate(zip(sol.Ns, Ns_new)):
        Tj = n_old * sol.h[j]
        last = j == len(Ns_new) - 1
        parts_t.append(T0 + Tj * np.arange(n_new + (1 if last else 0)) / n_new)
        T0 += Tj
    t_new = np.concatenate(parts_t)

    def I(a):
        return np.interp(t_new, t_old, a)

    Fx = np.vstack([I(r) for r in sol.Fx])
    Fy = np.vstack([I(r) for r in sol.Fy])
    h_new = np.array([sol.Ns[j] * sol.h[j] / Ns_new[j] for j in range(len(Ns_new))])
    return Solution(list(Ns_new), h_new, I(sol.x), I(sol.y), I(sol.th), I(sol.vx), I(sol.vy),
                    I(sol.w), I(sol.ax), I(sol.ay), I(sol.al), Fx, Fy)


def dense(sol: Solution, sub: int = 4):
    """Dense poses using the constant-acceleration interval model."""
    t = sol.times()
    hs = sol.interval_h()
    ts, xs, ys, ths, idx = [], [], [], [], []
    for k in range(sol.K - 1):
        h = hs[k]
        for m in range(sub):
            tau = h * m / sub
            ts.append(t[k] + tau)
            xs.append(sol.x[k] + sol.vx[k] * tau + 0.5 * sol.ax[k] * tau * tau)
            ys.append(sol.y[k] + sol.vy[k] * tau + 0.5 * sol.ay[k] * tau * tau)
            ths.append(sol.th[k] + sol.w[k] * tau + 0.5 * sol.al[k] * tau * tau)
            idx.append(k)
    ts.append(t[-1]); xs.append(sol.x[-1]); ys.append(sol.y[-1]); ths.append(sol.th[-1]); idx.append(sol.K - 2)
    return np.array(ts), np.array(xs), np.array(ys), np.array(ths), np.array(idx)


def with_Ns(sol: Solution, Ns: list[int]) -> Solution:
    return resample(sol, Ns) if list(Ns) != list(sol.Ns) else replace(sol)
