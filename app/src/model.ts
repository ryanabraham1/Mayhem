import type {
  Constraint, ConstraintData, ConstraintType, Field, Marker, Obstacle, Project, RobotConfig, Sample,
  Trajectory, TrajectoryOutput, Vec2, Waypoint,
} from "./types";

export const uid = (prefix = "") =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export const wrap = (a: number) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

export function newWaypoint(x: number, y: number, heading = 0, extra: Partial<Waypoint> = {}): Waypoint {
  return {
    id: uid("w"), x, y, heading, translationMode: "fixed", headingMode: "fixed", headingTolerance: 0,
    tolerance: { kind: "none", radius: 0.1, dx: 0.1, dy: 0.1 }, stop: false, split: false, intervals: null,
    ...extra,
  };
}

export function newTrajectory(name: string): Trajectory {
  return {
    formatVersion: 1, name, waypoints: [], constraints: [], markers: [],
    settings: { targetDt: 0.08, smoothing: 0.02, candidates: 3, maxIterations: 1500, timeLimit: 60 },
    output: null,
  };
}

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  maxVelocity: "Max velocity",
  maxAcceleration: "Max acceleration",
  maxAngularVelocity: "Max angular velocity",
  pointAt: "Point at",
  keepIn: "Keep in region",
  keepOut: "Keep out region",
};

export function defaultConstraintData(type: ConstraintType, at?: Vec2): ConstraintData {
  const [x, y] = at ?? [8.27, 4.03];
  const sq: Vec2[] = [[x - 0.5, y - 0.5], [x + 0.5, y - 0.5], [x + 0.5, y + 0.5], [x - 0.5, y + 0.5]];
  switch (type) {
    case "maxVelocity": return { type, value: 2 };
    case "maxAcceleration": return { type, value: 3 };
    case "maxAngularVelocity": return { type, value: 3 };
    case "pointAt": return { type, x, y, tolerance: 0.05, flip: false };
    case "keepIn": return { type, points: sq.map(([a, b]) => [a + (a - x) * 2, b + (b - y) * 2] as Vec2) };
    case "keepOut": return { type, points: sq, margin: 0.03 };
  }
}

export function newConstraint(type: ConstraintType, waypointCount: number, at?: Vec2): Constraint {
  return {
    id: uid("c"), enabled: true,
    scope: { kind: "range", from: 0, to: Math.max(0, waypointCount - 1), region: [] },
    data: defaultConstraintData(type, at),
  };
}

export function newMarker(waypoint: number): Marker {
  return {
    id: uid("m"), name: "event", command: "", waypoint, offset: 0, endWaypoint: null, endOffset: 0,
    recoveryPolicy: "fireAtJoin", mustHit: false,
  };
}

export function newObstacle(points: Vec2[], name = "Obstacle"): Obstacle {
  return { id: uid("o"), name, kind: "polygon", points, center: [0, 0], radius: 0.5, margin: 0.03, enabled: true };
}

// ------------------------------------------------------------------ geometry

export function footprint(robot: RobotConfig, x: number, y: number, heading: number): Vec2[] {
  const b = robot.bumper;
  const c = Math.cos(heading), s = Math.sin(heading);
  const corners: Vec2[] = [[b.front, b.left], [-b.back, b.left], [-b.back, -b.right], [b.front, -b.right]];
  return corners.map(([px, py]) => [x + c * px - s * py, y + s * px + c * py]);
}

export function circlePoints(o: Obstacle, n = 32): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [o.center[0] + o.radius * Math.cos(a), o.center[1] + o.radius * Math.sin(a)] as Vec2;
  });
}

export function obstaclePoints(o: Obstacle): Vec2[] {
  return o.kind === "circle" ? circlePoints(o) : o.points;
}

export function centroid(pts: Vec2[]): Vec2 {
  const n = pts.length || 1;
  return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n];
}

export function pointInPolygon([x, y]: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]);
}

/** Index to insert a new waypoint so it lands on the nearest leg of the path. */
export function insertionIndex(wps: Waypoint[], p: Vec2): number {
  if (wps.length < 2) return wps.length;
  let best = wps.length, bestD = Infinity;
  for (let i = 0; i + 1 < wps.length; i++) {
    const d = distToSegment(p, [wps[i].x, wps[i].y], [wps[i + 1].x, wps[i + 1].y]);
    if (d < bestD) { bestD = d; best = i + 1; }
  }
  const dEnd = Math.hypot(p[0] - wps[wps.length - 1].x, p[1] - wps[wps.length - 1].y);
  return bestD < 0.6 && bestD < dEnd ? best : wps.length;
}

// ------------------------------------------------------------------ sampling

/** State at time t using the optimizer's constant-acceleration model between samples. */
export function sampleAt(out: TrajectoryOutput, t: number): Sample {
  const s = out.samples;
  if (t <= s[0].t) return s[0];
  const last = s[s.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = s[lo], b = s[hi];
  const tau = t - a.t;
  const u = b.t > a.t ? tau / (b.t - a.t) : 0;
  return {
    t, x: a.x + a.vx * tau + 0.5 * a.ax * tau * tau, y: a.y + a.vy * tau + 0.5 * a.ay * tau * tau,
    heading: a.heading + a.omega * tau + 0.5 * a.alpha * tau * tau,
    vx: a.vx + a.ax * tau, vy: a.vy + a.ay * tau, omega: a.omega + a.alpha * tau,
    ax: a.ax, ay: a.ay, alpha: a.alpha,
    fx: a.fx.map((f, i) => f + (b.fx[i] - f) * u), fy: a.fy.map((f, i) => f + (b.fy[i] - f) * u),
  };
}

export function totalTime(out: TrajectoryOutput | null | undefined): number {
  return out ? out.samples[out.samples.length - 1].t : 0;
}

// ------------------------------------------------------------------ alliance flip

export function flipPoint(f: Field, [x, y]: Vec2): Vec2 {
  return f.symmetry === "rotational" ? [f.length - x, f.width - y] : [f.length - x, y];
}

export function flipHeading(f: Field, h: number): number {
  return f.symmetry === "rotational" ? h + Math.PI : Math.PI - h;
}

// ------------------------------------------------------------------ motors (WPILib DCMotor)

const MOTORS: Record<string, [number, number, number, number, number]> = {
  krakenX60: [12, 7.09, 366, 2, 6000],
  krakenX60Foc: [12, 9.37, 483, 2, 5800],
  krakenX44: [12, 4.05, 275, 1.4, 7530],
  falcon500: [12, 4.69, 257, 1.5, 6380],
  falcon500Foc: [12, 5.84, 304, 1.5, 6080],
  neo: [12, 2.6, 105, 1.8, 5676],
  neoVortex: [12, 3.6, 211, 3.6, 6784],
};

export const MOTOR_LABELS: Record<string, string> = {
  krakenX60: "Kraken X60", krakenX60Foc: "Kraken X60 (FOC)", krakenX44: "Kraken X44",
  falcon500: "Falcon 500", falcon500Foc: "Falcon 500 (FOC)", neo: "NEO", neoVortex: "NEO Vortex",
};

/** Estimated drive stator current per module [A] from the longitudinal wheel force. */
export function moduleCurrents(robot: RobotConfig, s: Sample): number[] {
  const [, tStall, iStall] = MOTORS[robot.motor.type];
  const kt = tStall / iStall;
  const c = Math.cos(s.heading), sn = Math.sin(s.heading);
  return robot.modules.map(([mx, my], i) => {
    const rx = c * mx - sn * my, ry = sn * mx + c * my;
    const vwx = s.vx - s.omega * ry, vwy = s.vy + s.omega * rx;
    const sp = Math.hypot(vwx, vwy);
    const fx = s.fx[i] ?? 0, fy = s.fy[i] ?? 0;
    const fLong = sp > 0.05 ? (fx * vwx + fy * vwy) / sp : Math.hypot(fx, fy);
    const torque = (Math.abs(fLong) * robot.wheelRadius) / (robot.motor.gearing * robot.motor.efficiency);
    return torque / kt;
  });
}

export function defaultProjectName(dir: string) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "Mayhem Project";
}

export type { Project };
