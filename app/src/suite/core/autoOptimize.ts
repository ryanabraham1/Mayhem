/**
 * Path optimizer for agents: makes an auto faster without leaving the BLine model. It only
 * turns the knobs a person would turn in the editor (pass-through points removed, moved or
 * added, handoff radii, the braking fixes motion findings suggest) and scores every candidate
 * by driving it with the robot runner's own follower (`simulate`, native, path mode), so the
 * result is still pose-to-pose goals with handoff circles, never a time-parameterized
 * trajectory.
 *
 * Fixed: stop steps, action points, anything with event markers or `during` actions on its
 * segment, step-group steps, conditional pass-throughs and `lock`ed steps. A candidate is kept
 * only when it finishes, is not closer to obstacles or walls (robot footprint at its heading),
 * has no more motion warnings or heading warnings, and still fires every event. The output is a
 * list of `edit_auto` ops, so the change is reviewable and replayable.
 */
import type { AutoEditOp } from "./autoEdit.ts";
import { editAuto } from "./autoEdit.ts";
import { motionOfFrames, type MotionIssue } from "./autoMotion.ts";
import { headingLints } from "./headingLint.ts";
import type { AutoNode, AutoRoutine, Pose, Signals, SuiteProject } from "./model.ts";
import { resolveNodeConstraints } from "./model.ts";
import { routeSegments } from "./routes.ts";
import { autoNext, simulate, type Frame } from "./runtime.ts";
import { fieldMatches, seasonOf } from "./seasons.ts";

export type OptimizePhase = "motion" | "route" | "prune" | "move" | "handoff";
export const OPTIMIZE_PHASES: readonly OptimizePhase[] = ["motion", "route", "prune", "move", "handoff"];

export interface OptimizeOptions {
  routine?: string;
  /** Steps never moved, removed or retuned. */
  lock?: string[];
  /** Farthest a pass-through point may move from where it was, meters (default 1). */
  maxMove?: number;
  /** Extra margin around the robot footprint for obstacle and wall checks, meters (default 0.05). */
  clearance?: number;
  /** Which searches to run, in this order (default all). */
  phases?: OptimizePhase[];
  /** Most follower runs to spend (default 2500). */
  budget?: number;
  signals?: Signals;
}

export interface Clearance {
  /** Integral of footprint penetration over time, m·s (0 = clear). */
  cost: number;
  /** Deepest penetration, meters, and what it hit. */
  depth: number;
  hits: { obstacle: string; depth: number; time: number; step: string }[];
  /** Penetration per (step being driven to, obstacle), worst first. */
  segments: { step: string; obstacle: string; cost: number; depth: number }[];
}

export interface OptimizeScore {
  status: "running" | "completed" | "failed";
  time: number;
  /** Driven distance, meters. */
  distance: number;
  passThrough: number;
  warnings: number;
  headingWarnings: number;
  clearance: Clearance;
  events: string[];
  issues: MotionIssue[];
}

export interface OptimizeChange {
  phase: OptimizePhase;
  ops: AutoEditOp[];
  why: string;
  /** Seconds (negative is faster). */
  timeChange: number;
}

export interface OptimizeSuggestion {
  ops: AutoEditOp[];
  why: string;
  timeChange: number;
}

export interface OptimizeResult {
  routine: string;
  before: OptimizeScore;
  after: OptimizeScore;
  timeSaved: number;
  /** edit_auto ops that turn the routine into the optimized one, in order. */
  ops: AutoEditOp[];
  changes: OptimizeChange[];
  /** Faster changes the optimizer would not make on its own (they change what the auto does). */
  suggestions: OptimizeSuggestion[];
  /** Steps left alone and why. */
  fixed: { step: string; why: string }[];
  evaluations: number;
  project: SuiteProject;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const RADII = [0.15, 0.25, 0.35, 0.45, 0.6, 0.8, 1.0, 1.25];
const STEPS = [0.5, 0.25, 0.12, 0.06];
const DIRS = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)] as const);
/** Gains smaller than this are noise in a 20 ms loop. */
const MIN_GAIN = 0.004;
/**
 * Seconds a route may give up per m·s of footprint inside an obstacle it stops touching: about
 * 1.5 s to stop running 0.3 m into a wall for a quarter second. Anything left is in `after.clearance`.
 */
const CLEARANCE_WEIGHT = 20;

// ---------- clearance ----------

type P2 = [number, number];
function footprint(pose: Pose, length: number, width: number, margin: number): P2[] {
  const hl = length / 2 + margin, hw = width / 2 + margin;
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  return ([[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]] as const).map(([a, b]) => [pose.x + a * c - b * s, pose.y + a * s + b * c]);
}
/**
 * A point, segment or convex polygon `a` reaches strictly inside convex polygon `b` (SAT:
 * no axis separates them, and touching an edge or corner does not count).
 */
function crosses(a: P2[], b: P2[]): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y1 - y2, ny = x2 - x1, len = Math.hypot(nx, ny);
      if (len < 1e-12) continue;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, y] of a) { const d = (x * nx + y * ny) / len; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const [x, y] of b) { const d = (x * nx + y * ny) / len; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      if (aMax <= bMin + 1e-9 || aMin >= bMax - 1e-9) return false;
    }
  return true;
}
/** SAT penetration depth of two convex polygons (0 when apart). */
export function penetration(a: P2[], b: P2[]): number {
  let best = Infinity;
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      let nx = y1 - y2, ny = x2 - x1;
      const len = Math.hypot(nx, ny);
      if (len < 1e-12) continue;
      nx /= len; ny /= len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const [x, y] of b) { const d = x * nx + y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap <= 0) return 0;
      best = Math.min(best, overlap);
    }
  return best === Infinity ? 0 : best;
}

interface Obstacle { id: string; name: string; points: P2[] }
export function fieldObstacles(project: SuiteProject): Obstacle[] {
  const season = seasonOf(project.field);
  if (!fieldMatches(season, project.field)) return [];
  return season.field.obstacles
    .filter((o) => o.enabled && o.points.length >= 3)
    .map((o) => ({ id: o.id, name: o.name, points: o.points.map(([x, y]) => [x, y] as P2) }));
}

/** The polygon pushed out by `r` on every side (exact parallel offset of a convex polygon). */
export function inflate(points: P2[], r: number): P2[] {
  const n = points.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += points[i][0] * points[(i + 1) % n][1] - points[(i + 1) % n][0] * points[i][1];
  const ccw = area > 0 ? 1 : -1;
  const normal = (a: P2, b: P2): P2 => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [(ccw * dy) / l, (-ccw * dx) / l]; };
  return points.map((v, i) => {
    const n1 = normal(points[(i - 1 + n) % n], v), n2 = normal(v, points[(i + 1) % n]);
    const k = r / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [v[0] + (n1[0] + n2[0]) * k, v[1] + (n1[1] + n2[1]) * k];
  });
}
const inside = (p: P2, poly: P2[]) => crosses([p], poly);

/**
 * Shortest polyline from `a` to `b` that keeps the robot (radius `reach`) off every obstacle:
 * a visibility graph over the obstacles' corners pushed out by `reach + gap`. Returns the
 * interior points, or undefined when there is no way through. An obstacle that already holds
 * `a` or `b` (scoring against the hub) does not block the segments from that end.
 */
export function shortestRoute(a: P2, b: P2, obstacles: Obstacle[], reach: number, gap: number, field: { width: number; height: number }): P2[] | undefined {
  const blockers = obstacles.map((o) => inflate(o.points, reach));
  const holdsA = blockers.map((q) => inside(a, q)), holdsB = blockers.map((q) => inside(b, q));
  const nodes: P2[] = [a, b];
  for (const o of obstacles)
    for (const v of inflate(o.points, reach + gap))
      if (v[0] > reach && v[1] > reach && v[0] < field.width - reach && v[1] < field.height - reach && !blockers.some((q) => inside(v, q))) nodes.push(v);
  const clear = (i: number, j: number) =>
    blockers.every((q, k) => ((i === 0 || j === 0) && holdsA[k]) || ((i === 1 || j === 1) && holdsB[k]) || !crosses([nodes[i], nodes[j]], q));
  const dist = nodes.map(() => Infinity), prev = nodes.map(() => -1), done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return undefined;
    if (u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || v === u) continue;
      const d = dist[u] + Math.hypot(nodes[v][0] - nodes[u][0], nodes[v][1] - nodes[u][1]);
      if (d < dist[v] && clear(u, v)) { dist[v] = d; prev[v] = u; }
    }
  }
  const out: P2[] = [];
  for (let v = prev[1]; v > 0; v = prev[v]) out.unshift(nodes[v]);
  return out;
}

export function clearanceOf(project: SuiteProject, frames: Frame[], margin = 0.05, obstacles = fieldObstacles(project)): Clearance {
  const { length, width } = project.robot;
  const L = project.field.width, W = project.field.height;
  let cost = 0, depth = 0;
  const worst = new Map<string, Clearance["hits"][number]>();
  const segments = new Map<string, Clearance["segments"][number]>();
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i], dt = f.time - frames[i - 1].time;
    const box = footprint(f.pose, length, width, margin);
    const hit = (obstacle: string, d: number) => {
      if (d <= 1e-6) return;
      cost += d * dt;
      depth = Math.max(depth, d);
      const w = worst.get(obstacle);
      if (!w || d > w.depth) worst.set(obstacle, { obstacle, depth: r3(d), time: r3(f.time), step: f.node });
      const key = `${f.node}\u0000${obstacle}`;
      const seg = segments.get(key) ?? { step: f.node, obstacle, cost: 0, depth: 0 };
      seg.cost += d * dt;
      seg.depth = Math.max(seg.depth, r3(d));
      segments.set(key, seg);
    };
    let wall = 0;
    for (const [x, y] of box) wall = Math.max(wall, -x, x - L, -y, y - W);
    hit("Field wall", wall);
    for (const o of obstacles) hit(o.name, penetration(box, o.points));
  }
  return { cost, depth: r3(depth), hits: [...worst.values()].sort((a, b) => b.depth - a.depth), segments: [...segments.values()].sort((a, b) => b.cost - a.cost) };
}

// ---------- scoring ----------

const blank = (s: Signals | undefined, project: SuiteProject): Signals => ({ ...Object.fromEntries(project.signals.map((x) => [x.key, x.initial])), ...(s ?? {}) });

export function scoreRoutine(project: SuiteProject, routine: AutoRoutine, options: { signals?: Signals; clearance?: number; obstacles?: Obstacle[] } = {}): OptimizeScore {
  const run = simulate(project, routine, blank(options.signals, project), { mode: "path", follower: "native" });
  const motion = motionOfFrames(project, routine, run.frames);
  let distance = 0;
  for (let i = 1; i < run.frames.length; i++)
    distance += Math.hypot(run.frames[i].pose.x - run.frames[i - 1].pose.x, run.frames[i].pose.y - run.frames[i - 1].pose.y);
  const events = [...new Set(run.frame.events.filter((e) => e.kind === "event").map((e) => e.message.replace(/^Event trigger /, "")))].sort();
  return {
    status: run.status,
    time: r3(run.frame.time),
    distance: r3(distance),
    passThrough: routine.nodes.filter((n) => n.kind === "pose" && autoNext(routine, n)).length,
    warnings: motion.issues.filter((i) => i.severity === "warning").length,
    headingWarnings: headingLints(run.frames).length,
    clearance: clearanceOf(project, run.frames, options.clearance ?? 0.05, options.obstacles),
    events,
    issues: motion.issues,
  };
}

/** `a` is no worse than `b` on everything but time. */
function safe(a: OptimizeScore, b: OptimizeScore, events: string[]) {
  return a.status === "completed" &&
    a.clearance.cost <= b.clearance.cost + 1e-4 &&
    a.clearance.depth <= b.clearance.depth + 0.005 &&
    a.warnings <= b.warnings &&
    a.headingWarnings <= b.headingWarnings &&
    events.every((e) => a.events.includes(e));
}

// ---------- step rules ----------

const hasEvents = (n?: AutoNode) => !!n?.goal?.markers?.some((m) => m.kind === "event");
const hasMarkers = (n?: AutoNode) => !!n?.goal?.markers?.length;

/** Why a pose step cannot be touched by `kind` of change, or undefined when it can. */
function fixedReason(routine: AutoRoutine, n: AutoNode, locked: Set<string>, kind: "move" | "remove" | "handoff"): string | undefined {
  if (n.kind !== "pose" || !n.goal) return "not a pose step";
  if (locked.has(n.id)) return "locked";
  if (n.fromGroup) return `made by step group use ${n.fromGroup.use}`;
  const next = autoNext(routine, n);
  if (!next) return n.goal.handoffRadius > 0 ? "conditional pass-through" : "the robot stops here";
  if (kind === "handoff") return undefined;
  if (hasEvents(n) || hasEvents(next)) return "an event marker on its segments fires by progress along them";
  if (kind === "move") return undefined;
  if (n.during?.length) return "actions run during it";
  if (hasMarkers(n) || hasMarkers(next)) return "rotation markers on its segments";
  if (n.constraints?.maxVelocity !== undefined || n.robotSpeedLimit) return "it carries a speed limit";
  return undefined;
}

function previousPose(project: SuiteProject, routine: AutoRoutine, id: string): Pose | undefined {
  return routeSegments(project, routine).find((s) => s.toId === id)?.from;
}

// ---------- search ----------

export function optimizeAuto(project: SuiteProject, options: OptimizeOptions = {}): OptimizeResult {
  const routineId = options.routine ?? project.routines[0]?.id;
  const first = project.routines.find((r) => r.id === routineId);
  if (!first) throw new Error(`Routine ${routineId ?? "(first)"} does not exist. Routines: ${project.routines.map((r) => r.id).join(", ") || "none"}.`);
  const phases = new Set(options.phases ?? OPTIMIZE_PHASES);
  for (const p of phases) if (!OPTIMIZE_PHASES.includes(p)) throw new Error(`Unknown phase ${p}; use ${OPTIMIZE_PHASES.join(", ")}.`);
  const maxMove = options.maxMove ?? 1;
  const budget = options.budget ?? 2500;
  const locked = new Set(options.lock ?? []);
  for (const id of locked) if (!first.nodes.some((n) => n.id === id)) throw new Error(`lock: routine ${first.id} has no step ${id}.`);
  const obstacles = fieldObstacles(project);
  const scoreOpts = { signals: options.signals, clearance: options.clearance ?? 0.05, obstacles };
  const routineOf = (p: SuiteProject) => p.routines.find((r) => r.id === routineId)!;

  let evaluations = 0;
  const evaluate = (p: SuiteProject) => { evaluations++; return scoreRoutine(p, routineOf(p), scoreOpts); };
  const tryOps = (p: SuiteProject, ops: AutoEditOp[]) => {
    if (evaluations >= budget) return undefined;
    try {
      const edited = editAuto(p, ops, routineId).project;
      return { project: edited, score: evaluate(edited) };
    } catch {
      return undefined;
    }
  };

  const before = evaluate(project);
  if (before.status !== "completed")
    throw new Error(`Routine ${routineId} does not finish when its path is driven (${before.status} at ${before.time} s); fix that first (simulate_auto).`);
  const events = before.events;
  let cur = { project, score: before };
  const changes: OptimizeChange[] = [];
  const keep = (phase: OptimizePhase, ops: AutoEditOp[], next: { project: SuiteProject; score: OptimizeScore }, why: string) => {
    changes.push({ phase, ops, why, timeChange: r3(next.score.time - cur.score.time) });
    cur = next;
  };
  const origin = new Map(first.nodes.filter((n) => n.goal).map((n) => [n.id, { x: n.goal!.x, y: n.goal!.y }]));
  const nodes = () => routineOf(cur.project).nodes;
  let inserted = 0;

  // 1. The fixes motion findings size from the run (overshoot, creeping in), one finding at a time.
  const findings = () => {
    let any = false;
    for (let round = 0; round < 6 && evaluations < budget; round++) {
      let kept = false;
      for (const issue of cur.score.issues) {
        if (!issue.suggest?.length || locked.has(issue.step)) continue;
        const ops = issue.suggest.map((s) => ({ set: s.set, value: s.value }));
        const next = tryOps(cur.project, ops);
        if (!next || next.score.status !== "completed" || next.score.clearance.cost > cur.score.clearance.cost + 1e-4 ||
          next.score.headingWarnings > cur.score.headingWarnings || !events.every((e) => next.score.events.includes(e))) continue;
        const fewer = next.score.warnings < cur.score.warnings;
        if (!fewer && (next.score.warnings > cur.score.warnings || next.score.time > cur.score.time - MIN_GAIN)) continue;
        keep("motion", ops, next, `${issue.message} ${issue.fix}`);
        kept = any = true;
        break;
      }
      if (!kept) break;
    }
    return any;
  };
  if (phases.has("motion")) findings();

  // 1b. The runner's braking profile on stop steps (within the robot's own acceleration limit).
  if (phases.has("motion"))
    for (const n of routineOf(cur.project).nodes) {
      const routine = routineOf(cur.project);
      if (n.kind !== "pose" || !n.goal || autoNext(routine, n) || locked.has(n.id) || n.fromGroup || n.robotSpeedLimit) continue;
      const c = resolveNodeConstraints(cur.project, routine, n);
      if (c.stopDeceleration > 0) continue;
      let best: { project: SuiteProject; score: OptimizeScore; value: number } | undefined;
      for (const f of [0.5, 0.65, 0.8, 0.9]) {
        const value = Math.round(c.maxAcceleration * f * 2) / 2;
        if (value <= 0 || best?.value === value) continue;
        const next = tryOps(cur.project, [{ set: `${n.id}.constraints.stopDeceleration`, value }]);
        if (!next || !safe(next.score, cur.score, events) || next.score.time > cur.score.time - MIN_GAIN) continue;
        if (!best || next.score.time < best.score.time) best = { ...next, value };
      }
      if (best) keep("motion", [{ set: `${n.id}.constraints.stopDeceleration`, value: best.value }], best,
        `${n.name}: braking profile at ${best.value} m/s² (robot max acceleration ${c.maxAcceleration}); without it the P law brakes late and the robot overshoots and comes back. Set it to what the robot really brakes at.`);
    }

  // 2. Route around obstacles the driven path runs into.
  const clearAt = (p: SuiteProject, g: Pose) =>
    clearanceOf(p, [{ time: 0, pose: g } as Frame, { time: 1, pose: g } as Frame], scoreOpts.clearance, obstacles).cost === 0;
  const viable = (next: { score: OptimizeScore } | undefined): next is { project: SuiteProject; score: OptimizeScore } =>
    !!next && next.score.status === "completed" && next.score.warnings <= cur.score.warnings && events.every((e) => next.score.events.includes(e)) &&
    next.score.clearance.cost < cur.score.clearance.cost - 1e-4 && cost(next.score) < cost(cur.score) - MIN_GAIN;
  /** Time plus clearance at CLEARANCE_WEIGHT seconds per m·s inside something: a detour has to be worth it. */
  const cost = (s: OptimizeScore) => s.time + CLEARANCE_WEIGHT * s.clearance.cost;
  const better = (a: { score: OptimizeScore }, b?: { score: OptimizeScore }) => !b || cost(a.score) < cost(b.score);
  const outward = (o: Obstacle) => {
    const cx = o.points.reduce((s, p) => s + p[0], 0) / o.points.length, cy = o.points.reduce((s, p) => s + p[1], 0) / o.points.length;
    return { cx, cy };
  };
  const reach = Math.hypot(project.robot.length, project.robot.width) / 2 + (options.clearance ?? 0.05);
  /** Pass-through chains that may be replaced: removable points between two fixed ones. */
  const chains = () => {
    const routine = routineOf(cur.project);
    const removable = (n?: AutoNode) => !!n && !fixedReason(routine, n, locked, "remove");
    const out: { points: AutoNode[]; to: AutoNode; from: Pose }[] = [];
    for (const n of routine.nodes) {
      if (!removable(n) || routine.nodes.some((p) => autoNext(routine, p)?.id === n.id && removable(p))) continue;
      const points = [n];
      let next = autoNext(routine, n)!;
      while (removable(next)) { points.push(next); next = autoNext(routine, next)!; }
      out.push({ points, to: next, from: previousPose(cur.project, routine, n.id) ?? routine.start ?? cur.project.robot.start });
    }
    // Fixed point to fixed point with nothing between (a path straight through an obstacle).
    for (const seg of cur.score.clearance.segments) {
      const to = routine.nodes.find((n) => n.id === seg.step);
      if (!to?.goal || to.fromGroup || locked.has(to.id) || out.some((c) => c.to.id === to.id)) continue;
      if (routine.nodes.some((p) => autoNext(routine, p)?.id === to.id && removable(p))) continue;
      out.push({ points: [], to, from: previousPose(cur.project, routine, to.id) ?? routine.start ?? cur.project.robot.start });
    }
    return out;
  };
  const reroute = () => {
    let any = false;
    for (const chain of chains()) {
      if (evaluations >= budget) break;
      const routine = routineOf(cur.project);
      const to = routine.nodes.find((n) => n.id === chain.to.id);
      if (!to?.goal) continue;
      let best: { project: SuiteProject; score: OptimizeScore; ops: AutoEditOp[]; n: number } | undefined;
      for (const gap of [0.1, 0.25, 0.45, 0.7]) {
        const way = shortestRoute([chain.from.x, chain.from.y], [to.goal.x, to.goal.y], obstacles, reach, gap, cur.project.field);
        if (!way) continue;
        let k = 0;
        const ops: AutoEditOp[] = [
          ...chain.points.map((n) => ({ remove: n.id })),
          ...way.map(([x, y], i) => ({
            insert: { id: `opt-${inserted + ++k}`, name: `Route point ${inserted + k}`, x: r3(x), y: r3(y), heading: r3(Math.atan2(to.goal!.y - (i ? way[i - 1][1] : chain.from.y), to.goal!.x - (i ? way[i - 1][0] : chain.from.x))), headingMode: "free" as const },
            before: to.id,
          })),
        ];
        if (!ops.length) continue;
        const next = tryOps(cur.project, ops);
        if (!next || next.score.status !== "completed" || next.score.warnings > cur.score.warnings || next.score.headingWarnings > cur.score.headingWarnings || !events.every((e) => next.score.events.includes(e))) continue;
        const clearer = next.score.clearance.cost < cur.score.clearance.cost - 1e-4 && cost(next.score) < cost(cur.score) - MIN_GAIN;
        const faster = next.score.clearance.cost <= cur.score.clearance.cost + 1e-4 && next.score.time < cur.score.time - MIN_GAIN;
        if (!clearer && !faster) continue;
        if (better(next, best)) best = { ...next, ops, n: way.length };
      }
      if (!best) continue;
      for (const o of best.ops) if ("insert" in o) origin.set(o.insert.id, { x: o.insert.x!, y: o.insert.y! });
      inserted += best.n;
      const was = chain.points.length ? `${chain.points.length} pass-through point${chain.points.length > 1 ? "s" : ""} (${chain.points.map((n) => n.name).join(", ")})` : "a straight line";
      keep("route", best.ops, best, `Rerouted the way to ${to.name}: ${was} → the shortest way around the field's obstacles, ${best.n} point${best.n === 1 ? "" : "s"} (heading free).`);
      any = true;
    }
    return any;
  };
  const route = () => {
    let any = reroute();
    for (let round = 0; round < 6 && cur.score.clearance.cost > 1e-4 && evaluations < budget; round++) {
      const routine = routineOf(cur.project);
      let done = false;
      // A pass-through point placed against an obstacle: push it out (or drop it).
      for (const n of routine.nodes) {
        if (done || fixedReason(routine, n, locked, "move") || clearAt(cur.project, n.goal!)) continue;
        const g = n.goal!;
        let best: { project: SuiteProject; score: OptimizeScore; ops: AutoEditOp[] } | undefined;
        const candidates: AutoEditOp[][] = fixedReason(routine, n, locked, "remove") ? [] : [[{ remove: n.id }]];
        for (const o of obstacles) {
          const { cx, cy } = outward(o);
          const dx = g.x - cx, dy = g.y - cy, d = Math.hypot(dx, dy) || 1;
          for (const push of [0.15, 0.3, 0.5, 0.8]) candidates.push([{ move: n.id, x: r3(g.x + (dx / d) * push), y: r3(g.y + (dy / d) * push) }]);
        }
        for (const ops of candidates) {
          const m = ops[0];
          if ("move" in m && origin.has(n.id) && Math.hypot(m.x! - origin.get(n.id)!.x, m.y! - origin.get(n.id)!.y) > maxMove + 1e-9) continue;
          const next = tryOps(cur.project, ops);
          if (viable(next) && better(next, best)) best = { ...next, ops };
        }
        if (best) {
          const m = best.ops[0];
          keep("route", best.ops, best, "move" in m ? `${n.name} sat against an obstacle; moved it clear to (${m.x}, ${m.y}).` : `${n.name} sat against an obstacle; the path is clearer without it.`);
          done = any = true;
        }
      }
      if (done) continue;
      // A segment that cuts through an obstacle: add a pass-through point around it.
      for (const seg of cur.score.clearance.segments) {
        if (done || seg.obstacle === "Field wall") continue;
        const target = routine.nodes.find((n) => n.id === seg.step);
        if (!target?.goal || locked.has(target.id) || target.fromGroup || !clearAt(cur.project, target.goal)) continue;
        const obstacle = obstacles.find((o) => o.name === seg.obstacle)!;
        const from = previousPose(cur.project, routine, target.id) ?? routine.start ?? cur.project.robot.start;
        const { cx, cy } = outward(obstacle);
        const reach = Math.hypot(cur.project.robot.length, cur.project.robot.width) / 2 + scoreOpts.clearance;
        const id = `opt-${inserted + 1}`;
        const heading = r3(Math.atan2(target.goal.y - from.y, target.goal.x - from.x));
        let best: { project: SuiteProject; score: OptimizeScore; ops: AutoEditOp[] } | undefined;
        for (const extra of [0.1, 0.3, 0.6])
          obstacle.points.forEach(([x, y], k) => {
            const [nx, ny] = obstacle.points[(k + 1) % obstacle.points.length];
            for (const [px, py] of [[x, y], [(x + nx) / 2, (y + ny) / 2]]) {
              const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1;
              const qx = r3(px + (dx / d) * (reach + extra)), qy = r3(py + (dy / d) * (reach + extra));
              if (qx < 0 || qy < 0 || qx > cur.project.field.width || qy > cur.project.field.height) continue;
              const ops: AutoEditOp[] = [{ insert: { id, name: `Around ${obstacle.name}`, x: qx, y: qy, heading, headingMode: "free" }, before: target.id }];
              const next = tryOps(cur.project, ops);
              if (viable(next) && better(next, best)) best = { ...next, ops };
            }
          });
        if (best) {
          inserted++;
          const ins = (best.ops[0] as { insert: { x: number; y: number } }).insert;
          origin.set(id, { x: ins.x, y: ins.y });
          keep("route", best.ops, best, `The path to ${target.name} ran ${seg.depth} m into ${obstacle.name}; added a pass-through point around it (heading free, so it is not a rotation target).`);
          done = any = true;
        }
      }
      if (!done) break;
    }
    return any;
  };
  if (phases.has("route")) route();


  const prune = () => {
    let any = false;
    for (const n of [...nodes()]) {
      if (fixedReason(routineOf(cur.project), n, locked, "remove")) continue;
      // Removing a point that only costs a hair is still worth it: fewer handoffs to tune.
      const next = tryOps(cur.project, [{ remove: n.id }]);
      if (!next || !safe(next.score, cur.score, events) || next.score.time > cur.score.time + 0.01) continue;
      keep("prune", [{ remove: n.id }], next, `${n.name} was not needed: the path is ${next.score.time <= cur.score.time ? "as fast or faster" : "within 0.01 s"} and no closer to anything without it.`);
      any = true;
    }
    return any;
  };

  const move = () => {
    let any = false;
    for (const id of nodes().map((n) => n.id)) {
      const n = nodes().find((x) => x.id === id);
      if (!n || fixedReason(routineOf(cur.project), n, locked, "move")) continue;
      const home = origin.get(id) ?? { x: n.goal!.x, y: n.goal!.y };
      const start = { x: n.goal!.x, y: n.goal!.y }, t0 = cur.score.time;
      for (const step of STEPS) {
        let moved = true;
        while (moved && evaluations < budget) {
          moved = false;
          const g = nodes().find((x) => x.id === id)!.goal!;
          const candidates: P2[] = DIRS.map(([dx, dy]) => [g.x + dx * step, g.y + dy * step]);
          // Toward the chord between its neighbors: straightens the corner it makes.
          const prev = previousPose(cur.project, routineOf(cur.project), id);
          const nxt = autoNext(routineOf(cur.project), nodes().find((x) => x.id === id)!)?.goal;
          if (prev && nxt) {
            const vx = nxt.x - prev.x, vy = nxt.y - prev.y, len2 = vx * vx + vy * vy || 1;
            const t = Math.max(0, Math.min(1, ((g.x - prev.x) * vx + (g.y - prev.y) * vy) / len2));
            const px = prev.x + t * vx, py = prev.y + t * vy, d = Math.hypot(px - g.x, py - g.y);
            if (d > 1e-3) candidates.push([g.x + ((px - g.x) / d) * Math.min(step, d), g.y + ((py - g.y) / d) * Math.min(step, d)]);
          }
          let best: { project: SuiteProject; score: OptimizeScore; x: number; y: number } | undefined;
          for (const [x, y] of candidates) {
            if (Math.hypot(x - home.x, y - home.y) > maxMove + 1e-9) continue;
            if (x < 0 || y < 0 || x > cur.project.field.width || y > cur.project.field.height) continue;
            const next = tryOps(cur.project, [{ move: id, x: r3(x), y: r3(y) }]);
            if (!next || !safe(next.score, cur.score, events) || next.score.time > cur.score.time - MIN_GAIN) continue;
            if (!best || next.score.time < best.score.time) best = { ...next, x: r3(x), y: r3(y) };
          }
          if (best) { cur = best; moved = true; any = true; }
        }
      }
      const end = nodes().find((x) => x.id === id)!.goal!;
      if (end.x !== start.x || end.y !== start.y) {
        changes.push({ phase: "move", ops: [{ move: id, x: end.x, y: end.y }], why: `Moved ${n.name} ${r3(Math.hypot(end.x - start.x, end.y - start.y))} m (to (${end.x}, ${end.y})).`, timeChange: r3(cur.score.time - t0) });
      }
    }
    return any;
  };

  const handoff = () => {
    let any = false;
    for (const n of [...nodes()]) {
      const routine = routineOf(cur.project);
      if (fixedReason(routine, n, locked, "handoff")) continue;
      const path = n.goal!.handoffRadius > 0 ? `${n.id}.goal.handoffRadius` : `${n.id}.constraints.handoffRadius`;
      const now = n.goal!.handoffRadius > 0 ? n.goal!.handoffRadius : resolveNodeConstraints(cur.project, routine, n).handoffRadius;
      let best: { project: SuiteProject; score: OptimizeScore; r: number } | undefined;
      for (const r of RADII) {
        if (Math.abs(r - now) < 1e-6) continue;
        const next = tryOps(cur.project, [{ set: path, value: r }]);
        if (!next || !safe(next.score, cur.score, events) || next.score.time > cur.score.time - MIN_GAIN) continue;
        if (!best || next.score.time < best.score.time) best = { ...next, r };
      }
      if (best) {
        keep("handoff", [{ set: path, value: best.r }], best, `Handoff radius of ${n.name} ${r3(now)} → ${best.r} m.`);
        any = true;
      }
    }
    return any;
  };

  for (let round = 0; round < 3 && evaluations < budget; round++) {
    let any = false;
    if (phases.has("prune")) any = prune() || any;
    if (phases.has("move")) any = move() || any;
    if (phases.has("handoff")) any = handoff() || any;
    if (phases.has("route") && cur.score.clearance.cost > 1e-4) any = route() || any;
    if (phases.has("motion")) any = findings() || any;
    if (!any) break;
  }

  // Changes that would make it faster but change what the auto does: reported, not applied.
  const suggestions: OptimizeSuggestion[] = [];
  const routine = routineOf(cur.project);
  for (const n of routine.nodes) {
    if (n.kind !== "pose" || !n.goal?.stop || n.fromGroup || n.during?.length) continue;
    const out = routine.transitions.filter((t) => t.from === n.id);
    const next = out.length === 1 && out[0].condition.kind === "always" ? routine.nodes.find((x) => x.id === out[0].to) : undefined;
    if (next?.kind !== "pose") continue;
    const ops: AutoEditOp[] = [{ set: `${n.id}.goal.stop`, value: null }];
    const tried = tryOps(cur.project, ops);
    if (tried && tried.score.status === "completed" && tried.score.time < cur.score.time - 0.05)
      suggestions.push({ ops, why: `${n.name} stops and then drives straight on to ${next.name}. If nothing has to happen there, drive through it.`, timeChange: r3(tried.score.time - cur.score.time) });
  }
  const limit = cur.project.robot.constraints.maxVelocity;
  for (const n of routine.nodes) {
    const cap = n.constraints?.maxVelocity;
    if (cap === undefined || cap >= limit || n.robotSpeedLimit || n.fromGroup) continue;
    const ops: AutoEditOp[] = [{ set: `${n.id}.constraints.maxVelocity`, value: null }];
    const tried = tryOps(cur.project, ops);
    if (tried && safe(tried.score, cur.score, events) && tried.score.time < cur.score.time - 0.05)
      suggestions.push({ ops, why: `${n.name} is capped at ${cap} m/s (robot ${limit} m/s). If nothing needs it slow, remove the cap.`, timeChange: r3(tried.score.time - cur.score.time) });
  }

  const ops = compactOps(changes.flatMap((c) => c.ops));
  // The ops alone must reproduce the result.
  const replay = ops.length ? editAuto(project, ops, routineId).project : project;
  const after = scoreRoutine(replay, routineOf(replay), scoreOpts);

  const fixed: OptimizeResult["fixed"] = [];
  for (const n of first.nodes) {
    if (n.kind !== "pose") continue;
    const why = fixedReason(first, n, locked, "move");
    if (why) fixed.push({ step: n.id, why });
  }
  return { routine: routineId!, before, after, timeSaved: r3(before.time - after.time), ops, changes, suggestions, fixed, evaluations, project: replay };
}

/**
 * The ops in order, with every move and handoff of a step folded into its last value (at the
 * end, after the steps exist) and an inserted-then-removed point dropped.
 */
function compactOps(all: AutoEditOp[]): AutoEditOp[] {
  const removed = new Set(all.flatMap((o) => ("remove" in o ? [o.remove] : [])));
  const insertedIds = new Set(all.flatMap((o) => ("insert" in o ? [o.insert.id] : [])));
  const gone = (id: string) => removed.has(id);
  const structural: AutoEditOp[] = [];
  const moves = new Map<string, { x: number; y: number }>();
  const sets = new Map<string, unknown>();
  for (const o of all) {
    if ("insert" in o) { if (!gone(o.insert.id)) structural.push(o); continue; }
    if ("remove" in o) { if (!insertedIds.has(o.remove)) structural.push(o); continue; }
    if ("move" in o) { moves.set(o.move, { x: o.x!, y: o.y! }); continue; }
    if ("set" in o) {
      const step = o.set.split(".")[0];
      if (/\.(goal|constraints)\.handoffRadius$/.test(o.set)) { if (!gone(step)) { sets.delete(o.set); sets.set(o.set, o.value); } continue; }
      structural.push(o);
    }
  }
  return [
    ...structural,
    ...[...moves].filter(([id]) => !gone(id)).map(([id, p]) => ({ move: id, x: p.x, y: p.y })),
    ...[...sets].map(([set, value]) => ({ set, value })),
  ];
}
