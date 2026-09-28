// Fuel (game piece) physics for playback. Our solved path and any other robots in the project's
// fuel sim setup (allies and opponents running simple curved autos) drive through the fuel on the
// field: bumpers and deployed intakes shove the balls around, and each intake swallows only as many
// as its rate allows. The rest get pushed, which is what happens to a real robot in a big pile.
//
// The whole run is simulated once and recorded, so scrubbing is just a lookup.

import { DEFAULT_INTAKE, flipPoint, intakeCorners, sampleAt, totalTime, uid } from "./model";
import type { FuelSimConfig, Field, RobotConfig, SimRobot, TrajectoryOutput, Vec2 } from "./types";

export const DEFAULT_FUEL_SIM: FuelSimConfig = { intakeRate: 10, capacity: 0, robots: [] };

export interface FuelSim {
  n: number;
  radius: number;
  /** Seconds simulated: until the last robot stops and the fuel comes to rest (at most SETTLE_TIME more). */
  duration: number;
  /** Seconds between recorded frames. */
  frameDt: number;
  frames: number;
  /** frames × n × (x, y) */
  pos: Float32Array;
  /** Time each ball was intaken; Infinity if never. */
  takenAt: Float64Array;
  /** Sorted intake times per robot: key "us" or a SimRobot id. */
  taken: Record<string, number[]>;
}

// FUEL: 5.91 in high-density polyurethane foam, 215 g nominal (FIRST/AndyMark 2026 Scoring Element
// Inspection Testing Report), so about 121 kg/m³. Mass only matters here through air drag: all balls
// weigh the same and robots are far heavier, so it cancels out of every collision.
const SUBSTEP = 1 / 240;
const FRAME_DT = 1 / 60;
const FUEL_MASS = 0.215; // kg
const ROLL_DECEL = 0.35; // m/s², carpet rolling resistance (Crr ≈ 0.036; as tuned in open-source REBUILT sims)
const AIR_DRAG = (0.5 * 1.225 * 0.47 * Math.PI * 0.075 * 0.075) / FUEL_MASS; // 1/m: ½ρ·Cd·A/m, smooth sphere
// Extra speed-proportional loss (carpet pile, foam hysteresis, small hops). Not measured: set so a
// ball kicked at 5 m/s rolls ~7 m. Calibrate this one against match video.
const CARPET_LOSS = 0.5; // 1/s
const E_BALL = 0.45; // ball-ball restitution (open-source REBUILT sims use 0.45-0.5)
const E_ROBOT = 0.2; // bumpers are fabric over pool noodles, so they soak up most of a hit
const E_WALL = 0.4; // field perimeter and structures
const TANGENT_GRIP = 0.4; // how much of the surface's sliding speed a ball picks up on contact
const SLEEP_SPEED = 0.01;
const SLEEP_STEPS = 24; // substeps a ball must stay slow before it stops being simulated
const BURST = 1.5; // an intake can take this many balls at once before the rate limit kicks in
const SIM_INTAKE_DEPTH = 0.25; // how far other robots' intakes reach past their bumper
/** Most seconds simulated after the last robot stops, while pushed fuel rolls to rest. */
export const SETTLE_TIME = 6;

interface Rect { x0: number; x1: number; y0: number; y1: number }
interface Seg { a: Vec2; b: Vec2 }
interface Pose { x: number; y: number; heading: number; vx: number; vy: number; omega: number }
type Side = "front" | "back" | "left" | "right";

/** A robot in the sim: a kinematic rectangle that follows a pose function. */
interface Agent {
  key: string;
  pose(t: number): Pose;
  body: Rect;
  intake: Rect | null;
  side: Side;
  intakeOn(t: number): boolean;
  rate: number;
  capacity: number;
  reach: number;
  tokens: number;
  held: number;
}

/** Balls to simulate: the field's `fuel` circle decorations. */
export function fuelStart(field: Field): { pts: Vec2[]; radius: number } {
  const balls = (field.decorations ?? []).filter((d) => d.style === "fuel" && d.kind === "circle");
  return { pts: balls.map((d) => [d.center[0], d.center[1]] as Vec2), radius: balls[0]?.radius ?? 0.075 };
}

/** Obstacle edges the balls bounce off (enabled obstacles only, matching what the paths avoid). */
function wallSegments(field: Field): Seg[] {
  const segs: Seg[] = [];
  for (const o of field.obstacles) {
    if (!o.enabled) continue;
    let p = o.points;
    if (o.kind === "circle") {
      p = [];
      for (let i = 0; i < 16; i++) p.push([o.center[0] + o.radius * Math.cos((i / 16) * 2 * Math.PI), o.center[1] + o.radius * Math.sin((i / 16) * 2 * Math.PI)]);
    }
    for (let i = 0; i < p.length; i++) segs.push({ a: p[i], b: p[(i + 1) % p.length] });
  }
  return segs;
}

const rectCorners = (R: Rect): Vec2[] => [[R.x0, R.y0], [R.x1, R.y0], [R.x1, R.y1], [R.x0, R.y1]];

function bounds(pts: Vec2[]): Rect {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function reachOf(body: Rect, intake: Rect | null, r: number) {
  const pts = [...rectCorners(body), ...(intake ? rectCorners(intake) : [])];
  return Math.max(...pts.map(([x, y]) => Math.hypot(x, y))) + r + 0.05;
}

// ------------------------------------------------------------------ other robots' paths

/** Cubic Bézier segments of the smooth curve (Catmull-Rom) through the points: [p0, c1, c2, p1] each. */
export function simRobotBeziers(points: Vec2[]): [Vec2, Vec2, Vec2, Vec2][] {
  const out: [Vec2, Vec2, Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    out.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return out;
}

/** SVG path data for a sim robot's curve. */
export function simRobotPathD(points: Vec2[]): string {
  const segs = simRobotBeziers(points);
  if (!segs.length) return "";
  const f = (p: Vec2) => `${p[0]},${p[1]}`;
  return `M ${f(segs[0][0])} ` + segs.map(([, a, b, c]) => `C ${f(a)} ${f(b)} ${f(c)}`).join(" ");
}

export interface SimTrack {
  /** Dense points along the curve with cumulative arc length. */
  pts: Vec2[];
  s: number[];
  length: number;
  /** Direction the robot faces at each point (along the curve). */
  dir: number[];
  /** Speed at each point, peak speed within each stretch to the next, and time each point is reached (after the delay). */
  v: number[];
  vp: number[];
  t: number[];
  /** Seconds from the robot's start (after its delay) to reaching the end. */
  driveTime: number;
  robot: SimRobot;
}

/** Fastest other robots turn, since they face along their curve: one rotation per second. */
const SIM_MAX_OMEGA = 2 * Math.PI;

export function simRobotTrack(robot: SimRobot): SimTrack {
  const pts: Vec2[] = [];
  for (const [a, b, c, d] of simRobotBeziers(robot.points)) {
    for (let k = pts.length ? 1 : 0; k <= 24; k++) {
      const u = k / 24, v = 1 - u;
      const w0 = v * v * v, w1 = 3 * v * v * u, w2 = 3 * v * u * u, w3 = u * u * u;
      pts.push([w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]]);
    }
  }
  if (!pts.length && robot.points[0]) pts.push(robot.points[0]);
  const n = pts.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = s[n - 1] ?? 0;
  const vm = Math.max(0.1, robot.maxVelocity), am = Math.max(0.1, robot.maxAcceleration);
  const at = (i: number) => pts[Math.max(0, Math.min(n - 1, i))];
  const chord = (i: number, j: number) => Math.atan2(at(j)[1] - at(i)[1], at(j)[0] - at(i)[0]);
  const dir = pts.map((_, i) => chord(i - 1, i + 1));

  // Speed limit from how hard the curve bends (κ, from the turn between neighboring chords): the
  // sideways acceleration v²κ stays within the robot's acceleration and the turn rate vκ within
  // SIM_MAX_OMEGA. Then forward/backward passes so it speeds up and brakes into bends at its accel.
  const kappa = pts.map((_, j) => {
    const i = Math.max(1, Math.min(n - 2, j));
    const l = s[i + 1] - s[i - 1];
    return n < 3 || !(l > 1e-9) ? 0 : Math.abs(wrapAngle(chord(i, i + 1) - chord(i - 1, i))) / (l / 2);
  });
  const cap = kappa.map((k) => (k > 1e-9 ? Math.max(0.05, Math.min(vm, Math.sqrt(am / k), SIM_MAX_OMEGA / k)) : vm));
  const v = [...cap];
  v[0] = 0;
  for (let i = 0; i + 1 < n; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * am * (s[i + 1] - s[i])));
  v[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * am * (s[i + 1] - s[i])));

  // each stretch between points is its own little trapezoid: up to vp, cruise, down to the next speed
  const vp: number[] = [], t = [0];
  for (let i = 0; i + 1 < n; i++) {
    const v0 = v[i], v1 = v[i + 1], ds = s[i + 1] - s[i];
    const peak = Math.max(v0, v1, Math.min(cap[i], cap[i + 1], Math.sqrt((v0 * v0 + v1 * v1) / 2 + am * ds)));
    vp.push(peak);
    const xc = Math.max(0, ds - (2 * peak * peak - v0 * v0 - v1 * v1) / (2 * am));
    t.push(t[i] + (2 * peak - v0 - v1) / am + (peak > 0 ? xc / peak : 0));
  }
  return { pts, s, length, dir, v, vp, t, driveTime: t[n - 1] ?? 0, robot };
}

/** Distance along the curve, the index of the stretch it's in, and speed at time t (from the start of the auto). */
function motion(tr: SimTrack, time: number): [number, number, number] {
  const tau = time - tr.robot.startDelay, last = tr.pts.length - 1;
  if (tau <= 0 || last < 1) return [0, 0, 0];
  if (tau >= tr.driveTime) return [tr.length, last - 1, 0];
  const am = Math.max(0.1, tr.robot.maxAcceleration);
  let i = 0, hi = last;
  while (hi - i > 1) {
    const mid = (i + hi) >> 1;
    if (tr.t[mid] <= tau) i = mid; else hi = mid;
  }
  const v0 = tr.v[i], v1 = tr.v[i + 1], p = tr.vp[i], ds = tr.s[i + 1] - tr.s[i];
  const ta = (p - v0) / am, xa = (p * p - v0 * v0) / (2 * am);
  const xc = Math.max(0, ds - xa - (p * p - v1 * v1) / (2 * am)), tc = p > 0 ? xc / p : 0;
  const u = tau - tr.t[i];
  let x: number, sp: number;
  if (u < ta) [x, sp] = [v0 * u + 0.5 * am * u * u, v0 + am * u];
  else if (u < ta + tc) [x, sp] = [xa + p * (u - ta), p];
  else {
    const w = Math.min((p - v1) / am, u - ta - tc);
    [x, sp] = [xa + xc + p * w - 0.5 * am * w * w, p - am * w];
  }
  return [tr.s[i] + Math.min(ds, x), i, sp];
}

/** Where another robot is at time t; it faces along its curve. */
export function simRobotPose(tr: SimTrack, t: number): Pose {
  const [d, i, v] = motion(tr, t);
  const { pts, s, dir } = tr;
  if (pts.length < 2) return { x: pts[0]?.[0] ?? 0, y: pts[0]?.[1] ?? 0, heading: dir[0] ?? 0, vx: 0, vy: 0, omega: 0 };
  const ds = s[i + 1] - s[i], u = ds > 0 ? Math.max(0, Math.min(1, (d - s[i]) / ds)) : 0;
  const a = pts[i], b = pts[i + 1];
  const turn = wrapAngle(dir[i + 1] - dir[i]), heading = dir[i] + turn * u;
  const move = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return {
    x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, heading,
    vx: v * Math.cos(move), vy: v * Math.sin(move), omega: ds > 0 ? (v * turn) / ds : 0,
  };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Time the robot reaches the end of its curve. */
export const simRobotEnd = (tr: SimTrack) => tr.robot.startDelay + tr.driveTime;

// ------------------------------------------------------------------ simulation

export function simulateFuel(field: Field, robot: RobotConfig, out: TrajectoryOutput | null, cfg: FuelSimConfig): FuelSim | null {
  const { pts, radius: r } = fuelStart(field);
  const n = pts.length;
  const agents: Agent[] = [];

  if (out && out.samples.length) {
    const b = robot.bumper;
    const body: Rect = { x0: -b.back, x1: b.front, y0: -b.right, y1: b.left };
    const ic = intakeCorners(robot);
    const intake = ic.length ? bounds(ic) : null;
    const spans = out.intake ?? [];
    agents.push({
      key: "us", body, intake, side: (robot.intake ?? DEFAULT_INTAKE).side,
      pose: (t) => sampleAt(out, t),
      intakeOn: (t) => spans.some((sp) => t >= sp.t - 1e-6 && t <= sp.endT + 1e-6),
      rate: cfg.intakeRate, capacity: cfg.capacity, reach: reachOf(body, intake, r), tokens: BURST, held: 0,
    });
  }
  let duration = totalTime(out);
  for (const bot of cfg.robots) {
    if (!bot.enabled || bot.points.length < 1) continue;
    const tr = simRobotTrack(bot);
    const h = bot.size / 2;
    const body: Rect = { x0: -h, x1: h, y0: -h, y1: h };
    const intake: Rect | null = bot.intake ? { x0: h, x1: h + SIM_INTAKE_DEPTH, y0: -h, y1: h } : null;
    const end = simRobotEnd(tr);
    duration = Math.max(duration, end);
    agents.push({
      key: bot.id, body, intake, side: "front",
      pose: (t) => simRobotPose(tr, t),
      intakeOn: (t) => t >= bot.startDelay && t <= end,
      rate: bot.intakeRate, capacity: bot.capacity, reach: reachOf(body, intake, r), tokens: BURST, held: 0,
    });
  }
  if (!n || !(duration > 0)) return null;
  const robotsDone = duration;
  duration += SETTLE_TIME;

  const px = new Float64Array(n), py = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const awake = new Uint8Array(n), still = new Uint8Array(n), alive = new Uint8Array(n).fill(1);
  const takenAt = new Float64Array(n).fill(Infinity);
  const taken: Record<string, number[]> = Object.fromEntries(agents.map((a) => [a.key, [] as number[]]));
  pts.forEach(([x, y], i) => { px[i] = x; py[i] = y; });

  const segs = wallSegments(field);
  const L = field.length, W = field.width;

  // uniform grid broadphase for ball-ball contacts
  const cell = 2 * r * 1.05;
  const gx = Math.max(1, Math.ceil(L / cell) + 2), gy = Math.max(1, Math.ceil(W / cell) + 2);
  const head = new Int32Array(gx * gy), next = new Int32Array(n);
  const cellX = (x: number) => Math.min(gx - 1, Math.max(0, Math.floor(x / cell) + 1));
  const cellY = (y: number) => Math.min(gy - 1, Math.max(0, Math.floor(y / cell) + 1));

  const frames = Math.floor(duration / FRAME_DT) + 1;
  const pos = new Float32Array(frames * n * 2);
  const record = (f: number) => {
    const o = f * n * 2;
    for (let i = 0; i < n; i++) { pos[o + 2 * i] = px[i]; pos[o + 2 * i + 1] = py[i]; }
  };
  record(0);

  /**
   * Resolve ball i against a robot-frame rectangle of agent `ag` at pose `rob`. (rx, ry) is the ball
   * in robot frame and c, s the heading's cos/sin. Returns true on contact.
   */
  const hitRect = (i: number, ag: Agent, R: Rect, rx: number, ry: number, c: number, s: number, rob: Pose, canEat: boolean, t: number): boolean => {
    const qx = Math.min(R.x1, Math.max(R.x0, rx)), qy = Math.min(R.y1, Math.max(R.y0, ry));
    let nx = rx - qx, ny = ry - qy;
    const d = Math.hypot(nx, ny);
    let depth: number;
    if (d > 1e-9) {
      if (d >= r) return false;
      nx /= d; ny /= d;
      depth = r - d;
    } else {
      // center inside: leave through the nearest face
      const faces = [rx - R.x0, R.x1 - rx, ry - R.y0, R.y1 - ry];
      const k = faces.indexOf(Math.min(...faces));
      nx = k === 0 ? -1 : k === 1 ? 1 : 0;
      ny = k === 2 ? -1 : k === 3 ? 1 : 0;
      depth = faces[k] + r;
    }

    if (canEat) {
      // Only balls meeting the mouth face get pulled in, and only as fast as the intake can go.
      const side = ag.side;
      const mouth = side === "front" ? nx > 0.7 : side === "back" ? nx < -0.7 : side === "left" ? ny > 0.7 : ny < -0.7;
      if (mouth && ag.tokens >= 1 && (ag.capacity <= 0 || ag.held < ag.capacity)) {
        ag.tokens -= 1;
        ag.held += 1;
        alive[i] = 0;
        awake[i] = 0;
        takenAt[i] = t;
        taken[ag.key].push(t);
        return true;
      }
    }

    const wnx = c * nx - s * ny, wny = s * nx + c * ny;
    px[i] += wnx * depth;
    py[i] += wny * depth;
    const cxw = px[i] - wnx * r - rob.x, cyw = py[i] - wny * r - rob.y;
    const svx = rob.vx - rob.omega * cyw, svy = rob.vy + rob.omega * cxw;
    const rvx = vx[i] - svx, rvy = vy[i] - svy;
    const vn = rvx * wnx + rvy * wny;
    if (vn < 0) {
      vx[i] -= (1 + E_ROBOT) * vn * wnx;
      vy[i] -= (1 + E_ROBOT) * vn * wny;
      // a sliding bumper drags the ball along a bit
      const tvx = rvx - vn * wnx, tvy = rvy - vn * wny;
      vx[i] -= TANGENT_GRIP * tvx;
      vy[i] -= TANGENT_GRIP * tvy;
    }
    awake[i] = 1;
    still[i] = 0;
    return true;
  };

  let frame = 1;
  const steps = Math.ceil(duration / SUBSTEP);
  const dt = SUBSTEP;
  for (let step = 1; step <= steps; step++) {
    const t = Math.min(duration, step * SUBSTEP);

    // integrate
    for (let i = 0; i < n; i++) {
      if (!alive[i] || !awake[i]) continue;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp < SLEEP_SPEED) {
        if (++still[i] >= SLEEP_STEPS) { vx[i] = 0; vy[i] = 0; awake[i] = 0; continue; }
      } else still[i] = 0;
      if (sp < 1e-9) continue;
      const k = Math.max(0, sp - (ROLL_DECEL + CARPET_LOSS * sp + AIR_DRAG * sp * sp) * dt) / sp;
      vx[i] *= k; vy[i] *= k;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
    }

    // robots: bumpers and intakes
    for (const ag of agents) {
      const rob = ag.pose(t);
      const c = Math.cos(rob.heading), s = Math.sin(rob.heading);
      const eating = !!ag.intake && ag.intakeOn(t);
      ag.tokens = Math.min(BURST, ag.tokens + ag.rate * dt);
      for (let i = 0; i < n; i++) {
        if (!alive[i]) continue;
        const dx = px[i] - rob.x, dy = py[i] - rob.y;
        if (dx * dx + dy * dy > ag.reach * ag.reach) continue;
        const rx = c * dx + s * dy, ry = -s * dx + c * dy;
        if (eating && hitRect(i, ag, ag.intake!, rx, ry, c, s, rob, true, t)) continue;
        hitRect(i, ag, ag.body, rx, ry, c, s, rob, false, t);
      }
    }

    // ball-ball
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const k = cellY(py[i]) * gx + cellX(px[i]);
      next[i] = head[k];
      head[k] = i;
    }
    for (let i = 0; i < n; i++) {
      if (!alive[i] || !awake[i]) continue;
      const cx = cellX(px[i]), cy = cellY(py[i]);
      for (let oy = -1; oy <= 1; oy++) {
        const yy = cy + oy;
        if (yy < 0 || yy >= gy) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = cx + ox;
          if (xx < 0 || xx >= gx) continue;
          for (let j = head[yy * gx + xx]; j !== -1; j = next[j]) {
            if (j === i || (awake[j] && j < i)) continue; // awake pairs are handled once
            let nx = px[j] - px[i], ny = py[j] - py[i];
            const d2 = nx * nx + ny * ny;
            if (d2 >= 4 * r * r) continue;
            const d = Math.sqrt(d2) || 1e-6;
            nx /= d; ny /= d;
            const push = (2 * r - d) / 2;
            px[i] -= nx * push; py[i] -= ny * push;
            px[j] += nx * push; py[j] += ny * push;
            const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
            if (vn < 0) {
              const imp = ((1 + E_BALL) * vn) / 2;
              vx[i] += imp * nx; vy[i] += imp * ny;
              vx[j] -= imp * nx; vy[j] -= imp * ny;
            }
            if (!awake[j]) { awake[j] = 1; still[j] = 0; }
          }
        }
      }
    }

    // field walls and obstacles
    for (let i = 0; i < n; i++) {
      if (!alive[i] || !awake[i]) continue;
      if (px[i] < r) { px[i] = r; if (vx[i] < 0) vx[i] *= -E_WALL; }
      if (px[i] > L - r) { px[i] = L - r; if (vx[i] > 0) vx[i] *= -E_WALL; }
      if (py[i] < r) { py[i] = r; if (vy[i] < 0) vy[i] *= -E_WALL; }
      if (py[i] > W - r) { py[i] = W - r; if (vy[i] > 0) vy[i] *= -E_WALL; }
      for (const sg of segs) {
        const ex = sg.b[0] - sg.a[0], ey = sg.b[1] - sg.a[1];
        const len2 = ex * ex + ey * ey || 1e-12;
        const u = Math.max(0, Math.min(1, ((px[i] - sg.a[0]) * ex + (py[i] - sg.a[1]) * ey) / len2));
        let nx = px[i] - (sg.a[0] + u * ex), ny = py[i] - (sg.a[1] + u * ey);
        const d = Math.hypot(nx, ny);
        if (d >= r || d < 1e-9) continue;
        nx /= d; ny /= d;
        px[i] += nx * (r - d); py[i] += ny * (r - d);
        const vn = vx[i] * nx + vy[i] * ny;
        if (vn < 0) { vx[i] -= (1 + E_WALL) * vn * nx; vy[i] -= (1 + E_WALL) * vn * ny; }
      }
    }

    while (frame < frames && frame * FRAME_DT <= t + 1e-9) record(frame++);
    // once the robots are done, stop as soon as every ball is at rest
    if (t >= robotsDone && !awake.some((a, i) => a && alive[i])) {
      if (frame < frames) record(frame++);
      duration = Math.max(robotsDone, (frame - 1) * FRAME_DT);
      break;
    }
  }
  const used = Math.min(frames, Math.floor(duration / FRAME_DT + 1e-9) + 1);
  while (frame < used) record(frame++);

  return { n, radius: r, duration, frameDt: FRAME_DT, frames: used, pos: pos.subarray(0, used * n * 2), takenAt, taken };
}

/** Ball positions at time t (linear between recorded frames). */
export function fuelAt(sim: FuelSim, t: number): Float32Array {
  const f = Math.max(0, Math.min(sim.frames - 1, t / sim.frameDt));
  const a = Math.floor(f), b = Math.min(sim.frames - 1, a + 1), u = f - a;
  const n2 = sim.n * 2, oa = a * n2, ob = b * n2;
  const res = new Float32Array(n2);
  for (let k = 0; k < n2; k++) res[k] = sim.pos[oa + k] + (sim.pos[ob + k] - sim.pos[oa + k]) * u;
  return res;
}

/** How many balls a robot ("us" or a SimRobot id) has picked up by time t. */
export function intakenBy(sim: FuelSim, key: string, t: number): number {
  const times = sim.taken[key] ?? [];
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ setup helpers

// Default autos for new robots, blue side: out through a trench or over a bump into the neutral-zone fuel.
const ALLY_ROUTES: Vec2[][] = [
  [[3.5, 7.4], [6.2, 7.4], [7.7, 6.0]],
  [[3.5, 0.65], [6.2, 0.65], [7.7, 2.1]],
  [[3.4, 5.5], [6.4, 5.6], [8.0, 4.7]],
];

/** A new ally (blue) or opponent (red) robot with a default auto, mirrored for red by the field's symmetry. */
export function newSimRobot(field: Field, alliance: "blue" | "red", existing: SimRobot[]): SimRobot {
  const k = existing.filter((r) => r.alliance === alliance).length;
  const route = ALLY_ROUTES[k % ALLY_ROUTES.length];
  return {
    id: uid("r"), name: `${alliance === "blue" ? "Ally" : "Opponent"} ${k + 1}`, alliance,
    points: alliance === "blue" ? route.map((p) => [...p] as Vec2) : route.map((p) => flipPoint(field, p)),
    maxVelocity: 3, maxAcceleration: 3, startDelay: 0, size: 0.9, intake: true, intakeRate: 10, capacity: 0, enabled: true,
  };
}
