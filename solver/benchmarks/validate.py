"""Independent checks of a solved TrajectoryOutput.

These re-derive everything from the exported samples (not from solver internals), so
a "success" in the benchmark means the output is physically valid and collision-free.
"""

from __future__ import annotations

import math

import numpy as np
import shapely
from shapely.geometry import Polygon

from mayhem_solver import geometry as geo
from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import (MaxAcceleration, MaxAngularVelocity, MaxVelocity, PointAt, Project, StraightLine,
                                  Trajectory, TrajectoryOutput)
from mayhem_solver.pipeline import make_world

REL = 2e-3  # relative tolerance on physical limits (IPOPT tol is 1e-6 on scaled constraints)


def _arr(out: TrajectoryOutput, k: str) -> np.ndarray:
    return np.array([getattr(s, k) for s in out.samples], dtype=float)


def check_output(project: Project, traj: Trajectory, out: TrajectoryOutput, sub: int = 10) -> tuple[list[str], dict]:
    """Returns (violations, metrics)."""
    d = build_drivetrain(project.robot)
    world = make_world(project, traj)
    viol: list[str] = []
    t, x, y, th = (_arr(out, k) for k in ("t", "x", "y", "heading"))
    vx, vy, w, ax, ay, al = (_arr(out, k) for k in ("vx", "vy", "omega", "ax", "ay", "alpha"))
    Fx = np.array([s.fx for s in out.samples]).T
    Fy = np.array([s.fy for s in out.samples]).T
    h = np.diff(t)
    if np.any(h <= 0):
        viol.append("non-increasing time")

    # --- dynamics consistency (constant acceleration per interval) ---
    xp = x[:-1] + vx[:-1] * h + 0.5 * ax[:-1] * h * h
    yp = y[:-1] + vy[:-1] * h + 0.5 * ay[:-1] * h * h
    thp = th[:-1] + w[:-1] * h + 0.5 * al[:-1] * h * h
    err_p = float(np.max(np.hypot(xp - x[1:], yp - y[1:]))) if len(h) else 0.0
    err_th = float(np.max(np.abs(np.angle(np.exp(1j * (thp - th[1:])))))) if len(h) else 0.0
    err_v = float(np.max(np.hypot(vx[:-1] + ax[:-1] * h - vx[1:], vy[:-1] + ay[:-1] * h - vy[1:]))) if len(h) else 0.0
    if err_p > 1e-3 or err_th > 1e-3 or err_v > 1e-3:
        viol.append(f"dynamics mismatch (pos {err_p:.2e}, heading {err_th:.2e}, vel {err_v:.2e})")

    # --- Newton-Euler ---
    c, s = np.cos(th), np.sin(th)
    if np.max(np.abs(Fx.sum(0) - d.mass * ax)) > 1e-3 * d.mass * max(1.0, np.max(np.abs(ax))) + 1e-2:
        viol.append("Newton x mismatch")
    if np.max(np.abs(Fy.sum(0) - d.mass * ay)) > 1e-3 * d.mass * max(1.0, np.max(np.abs(ay))) + 1e-2:
        viol.append("Newton y mismatch")
    tau = np.zeros_like(t)
    for i, (mx, my) in enumerate(d.modules):
        rx, ry = c * mx - s * my, s * mx + c * my
        tau += rx * Fy[i] - ry * Fx[i]
    if np.max(np.abs(tau - d.moi * al)) > 1e-3 * d.moi * max(1.0, np.max(np.abs(al))) + 1e-2:
        viol.append("Euler (torque) mismatch")

    # --- module limits ---
    vrx, vry = c * vx + s * vy, -s * vx + c * vy
    worst = {"wheel": 0.0, "friction": 0.0, "motor": 0.0, "current": 0.0}
    for i, (mx, my) in enumerate(d.modules):
        vw = np.hypot(vrx - w * my, vry + w * mx)
        worst["wheel"] = max(worst["wheel"], float(np.max(vw / d.wheel_free_speed)))
        F = np.hypot(Fx[i], Fy[i])
        if d.cog_height <= 0:
            worst["friction"] = max(worst["friction"], float(np.max(F / d.friction_force)))
        rx, ry = c * mx - s * my, s * mx + c * my
        vfx, vfy = vx - w * ry, vy + w * rx
        sw = np.sqrt(vfx ** 2 + vfy ** 2 + 1e-4)
        long_f = (Fx[i] * vfx + Fy[i] * vfy) / sw  # longitudinal force
        # torque-speed line (same smoothing as the NLP)
        cap = d.wheel_stall_force * (1 - sw / d.wheel_free_speed)
        worst["motor"] = max(worst["motor"], float(np.max(long_f - cap) / d.wheel_stall_force) + 1.0)
        # stator current limit on the total module force (lateral force needs current too)
        worst["current"] = max(worst["current"], float(np.max(F) / d.wheel_current_force))
    for k, v in worst.items():
        if v > 1 + REL:
            viol.append(f"{k} limit exceeded ({v:.4f}x)")

    # --- swept collision: dense constant-acceleration poses ---
    taus = np.arange(sub) / sub
    xs, ys, ths = [], [], []
    for k in range(len(h)):
        tt = taus * h[k]
        xs.append(x[k] + vx[k] * tt + 0.5 * ax[k] * tt * tt)
        ys.append(y[k] + vy[k] * tt + 0.5 * ay[k] * tt * tt)
        ths.append(th[k] + w[k] * tt + 0.5 * al[k] * tt * tt)
    xs = np.concatenate(xs + [x[-1:]])
    ys = np.concatenate(ys + [y[-1:]])
    ths = np.concatenate(ths + [th[-1:]])
    polys = geo.bumper_polygons(d.bumper_corners, xs, ys, ths)
    min_clear = math.inf
    for piece in world.pieces:
        dist = shapely.distance(polys, piece.poly)
        inter = shapely.intersects(polys, piece.poly)
        if np.any(inter):
            viol.append(f"bumper hits '{piece.name}'")
        min_clear = min(min_clear, float(np.min(dist)))
    b = shapely.bounds(polys)
    wall_clear = float(min(b[:, 0].min(), b[:, 1].min(), world.length - b[:, 2].max(), world.width - b[:, 3].max()))
    if wall_clear < -1e-6:
        viol.append(f"bumper leaves field ({wall_clear:.4f} m)")

    # --- waypoints ---
    wi = [int(np.argmin(np.abs(t - wt))) for wt in out.waypoint_times]
    for j, (wp, k) in enumerate(zip(traj.waypoints, wi)):
        if wp.translation_mode == "fixed":
            dx, dy = x[k] - wp.x, y[k] - wp.y
            tol = wp.tolerance
            if tol.kind == "circle" and tol.radius > 0:
                ok = math.hypot(dx, dy) <= tol.radius + 1e-3
            elif tol.kind == "box" and (tol.dx > 0 or tol.dy > 0):
                ok = abs(dx) <= tol.dx + 1e-3 and abs(dy) <= tol.dy + 1e-3
            else:
                ok = math.hypot(dx, dy) <= 1e-3
            if not ok:
                viol.append(f"waypoint {j + 1} position missed")
        if wp.heading_mode == "fixed":
            e = abs(math.remainder(th[k] - wp.heading, 2 * math.pi))
            if e > max(wp.heading_tolerance, 0.0) + 2e-3:
                viol.append(f"waypoint {j + 1} heading missed ({e:.3f} rad)")
        if j == 0 or wp.stop:
            if max(abs(vx[k]), abs(vy[k]), abs(w[k])) > 1e-3:
                viol.append(f"waypoint {j + 1} not stopped")

    # --- user constraints ---
    wk = wi
    for con in traj.constraints:
        if not con.enabled:
            continue
        sc = con.scope
        if sc.kind == "zone":
            if len(sc.region) < 3:
                continue
            reg = Polygon(sc.region).buffer(-0.02)
            ks = np.where(shapely.contains_xy(reg, x, y))[0]
        elif sc.kind == "waypoint":
            ks = np.array([wk[min(max(sc.from_, 0), len(wk) - 1)]])
        else:
            a, bb = sorted((min(max(sc.from_, 0), len(wk) - 1), min(max(sc.to, 0), len(wk) - 1)))
            ks = np.arange(wk[a], wk[bb] + 1)
        if len(ks) == 0:
            continue
        dd = con.data
        if isinstance(dd, MaxVelocity):
            m = float(np.max(np.hypot(vx[ks], vy[ks])))
            if m > dd.value * (1 + REL) + 1e-3:
                viol.append(f"maxVelocity {con.id} exceeded ({m:.3f} > {dd.value})")
        elif isinstance(dd, MaxAcceleration):
            m = float(np.max(np.hypot(ax[ks], ay[ks])))
            if m > dd.value * (1 + REL) + 1e-3:
                viol.append(f"maxAcceleration {con.id} exceeded ({m:.3f} > {dd.value})")
        elif isinstance(dd, MaxAngularVelocity):
            m = float(np.max(np.abs(w[ks])))
            if m > dd.value * (1 + REL) + 1e-5:
                viol.append(f"maxAngularVelocity {con.id} exceeded ({m:.4f} > {dd.value})")
        elif isinstance(dd, StraightLine) and sc.kind == "range":
            a, bb = sorted((sc.from_, sc.to))
            if 0 <= a < bb < len(traj.waypoints):
                pa, pb = traj.waypoints[a], traj.waypoints[bb]
                ex, ey = pb.x - pa.x, pb.y - pa.y
                seg = math.hypot(ex, ey)
                if seg > 1e-6:
                    off = float(np.max(np.abs(ex * (y[ks] - pa.y) - ey * (x[ks] - pa.x)))) / seg
                    if off > dd.tolerance * (1 + REL) + 1e-5:
                        viol.append(f"straightLine {con.id} left the line ({off:.4f} m > {dd.tolerance})")
        elif isinstance(dd, PointAt):
            ang = np.arctan2(dd.y - y[ks], dd.x - x[ks]) + (math.pi if dd.flip else 0.0)
            e = float(np.max(np.abs(np.angle(np.exp(1j * (th[ks] - ang))))))
            if e > dd.tolerance + 5e-3:
                viol.append(f"pointAt {con.id} missed ({e:.3f} rad)")

    metrics = {
        "min_obstacle_clearance": round(min_clear, 4) if math.isfinite(min_clear) else None,
        "min_wall_clearance": round(wall_clear, 4),
        "max_speed": round(float(np.max(np.hypot(vx, vy))), 3),
        "samples": len(t),
    }
    return viol, metrics
