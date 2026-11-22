/**
 * How each pose step of an auto actually moved: overshooting its goal and crawling back, swinging
 * past its heading, or creeping in for the last few centimeters. One detector reads both the
 * preview (`simulate` frames) and a log (the runner's `Mayhem/Goals/<routine>/…` channels from a
 * sim proof run or a match), so an agent sees the same finding, with the same id, in either.
 */
import type { Channel, Recording } from "./analysis.ts";
import { valueAt } from "./analysis.ts";
import type { AutoRoutine, SuiteProject } from "./model.ts";
import { resolveNodeConstraints } from "./model.ts";
import type { Frame } from "./runtime.ts";
import { isIntermediate, wrap } from "./runtime.ts";

/** One tick of progress toward the active goal. */
export interface GoalSample {
  time: number;
  /** Active goal (step ID). */
  goal: string;
  /** Distance to the goal, meters. */
  error: number;
  /** |heading error|, radians (omit when the step has no heading target). */
  rotation?: number;
  /** Measured speed, m/s (estimated from `error` when missing). */
  speed?: number;
  reached?: boolean;
}

/** What the project says about a step, for thresholds and fixes. */
export interface GoalInfo {
  name: string;
  tolerance: number;
  rotationTolerance: number;
  /** End of a path: the robot is meant to stop here. */
  stop: boolean;
  stopDeceleration: number;
  stopLag: number;
  maxAcceleration: number;
  minVelocity: number;
  /** Heading target is fixed (not motion/free). */
  fixedHeading: boolean;
}

export interface StepMotion {
  step: string;
  name: string;
  start: number;
  end: number;
  /** Distance to the goal when the step began, and the closest it got. */
  startError: number;
  closest: number;
  endError: number;
  peakSpeed: number;
  reached: boolean;
  /** End of a path (the robot stops here), not a pass-through point. */
  stop: boolean;
  /** Meters past the closest approach before coming back (overshoot), when any. */
  overshoot?: number;
  /** Degrees the heading swung back out after its closest approach. */
  headingOvershoot?: number;
}

export type MotionKind = "overshoot" | "heading-overshoot" | "slow-settle";
export interface MotionIssue {
  kind: MotionKind;
  severity: "warning" | "info";
  step: string;
  name: string;
  /** When it went wrong (closest approach before the overshoot; start of the creep). */
  time: number;
  /** Step span, for plots and log queries. */
  start: number;
  end: number;
  /** Meters (overshoot), degrees (heading-overshoot) or seconds (slow-settle). */
  amount: number;
  /** Seconds spent after the closest approach getting back (overshoot) or creeping in. */
  timeLost: number;
  message: string;
  fix: string;
  /** Project edits that should fix it, ready for edit_auto (`set` paths and values). */
  suggest?: { set: string; value: number }[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const deg = (v: number) => (v * 180) / Math.PI;
const DEFAULT_INFO: Omit<GoalInfo, "name"> = {
  tolerance: 0.03, rotationTolerance: (2 * Math.PI) / 180, stop: true, stopDeceleration: 0, stopLag: 0,
  maxAcceleration: 12, minVelocity: 0, fixedHeading: true,
};

/** Per-step thresholds and limits from the project. */
export function goalInfos(project: SuiteProject, routine: AutoRoutine): Map<string, GoalInfo> {
  const out = new Map<string, GoalInfo>();
  for (const n of routine.nodes) {
    if (n.kind !== "pose" || !n.goal) continue;
    const c = resolveNodeConstraints(project, routine, n);
    out.set(n.id, {
      name: n.name,
      tolerance: n.goal.translationTolerance,
      rotationTolerance: n.goal.rotationTolerance,
      stop: !isIntermediate(routine, n),
      stopDeceleration: c.stopDeceleration,
      stopLag: c.stopLag,
      maxAcceleration: c.maxAcceleration,
      minVelocity: c.minVelocity,
      fixedHeading: (n.goal.headingMode ?? "fixed") === "fixed",
    });
  }
  return out;
}

/** Preview frames as goal samples (pose steps only). */
export function framesToSamples(routine: AutoRoutine, frames: Frame[]): GoalSample[] {
  const nodes = new Map(routine.nodes.map((n) => [n.id, n]));
  const out: GoalSample[] = [];
  frames.forEach((f, i) => {
    const n = nodes.get(f.node);
    if (n?.kind !== "pose" || !n.goal) return;
    const fixed = (n.goal.headingMode ?? "fixed") === "fixed";
    // The tick that leaves a step resets `reached`: the step was done on its last tick.
    const after = frames[i + 1];
    out.push({
      time: f.time, goal: n.id, error: Math.hypot(f.pose.x - n.goal.x, f.pose.y - n.goal.y),
      ...(fixed ? { rotation: Math.abs(wrap(f.pose.heading - n.goal.heading)) } : {}),
      speed: Math.hypot(f.velocity.vx, f.velocity.vy), reached: f.reached || (!!after && after.node !== f.node && after.status !== "failed"),
    });
  });
  return out;
}

const goalChannel = (recording: Recording, routine: string | undefined, leaf: string) =>
  recording.channels
    .filter((c) => c.samples.length && new RegExp(`(^|/)Mayhem/Goals/${routine ? routine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[^/]+"}/${leaf}$`).test(c.name))
    .sort((a, b) => Number(a.name.startsWith("NT:")) - Number(b.name.startsWith("NT:")) || b.samples.length - a.samples.length)[0];

/** Every runner that logged goal progress (`Mayhem/Goals/<name>/translationError`). */
export function goalRunners(recording: Recording): string[] {
  const names = new Set<string>();
  for (const c of recording.channels)
    if (c.samples.length) {
      const m = /(?:^|\/)Mayhem\/Goals\/([^/]+)\/translationError$/.exec(c.name);
      if (m) names.add(m[1]);
    }
  return [...names];
}

/** The runner's logged goal progress as goal samples. */
export function logToSamples(recording: Recording, runner: string): { samples: GoalSample[]; channels: string[] } {
  const id = goalChannel(recording, runner, "id");
  const err = goalChannel(recording, runner, "translationError");
  const rot = goalChannel(recording, runner, "rotationError");
  const reached = goalChannel(recording, runner, "reached");
  if (!id || !err) return { samples: [], channels: [] };
  const samples: GoalSample[] = [];
  for (const s of err.samples) {
    const goal = valueAt(id, s.time);
    if (typeof goal !== "string" || !goal || typeof s.value !== "number") continue;
    const r = rot && valueAt(rot, s.time);
    const done = reached && valueAt(reached, s.time);
    samples.push({ time: s.time, goal, error: Math.abs(s.value), ...(typeof r === "number" ? { rotation: Math.abs(r) } : {}), ...(typeof done === "boolean" ? { reached: done } : {}) });
  }
  return { samples, channels: [id, err, rot, reached].filter((c): c is Channel => !!c).map((c) => c.name) };
}

/** Speeds from successive errors where none were measured (approach speed toward the goal). */
function speeds(seg: GoalSample[]): number[] {
  return seg.map((s, i) => {
    if (s.speed !== undefined) return s.speed;
    const a = seg[Math.max(0, i - 2)], b = seg[Math.min(seg.length - 1, i + 2)];
    return b.time > a.time ? Math.abs(b.error - a.error) / (b.time - a.time) : 0;
  });
}

/**
 * Split samples into steps and find the motion problems. `info` gives a step's tolerances and
 * limits (defaults: BLine's 0.03 m / 2°, a stop step).
 */
export function analyzeMotion(samples: GoalSample[], info: (goal: string) => GoalInfo | undefined = () => undefined): { steps: StepMotion[]; issues: MotionIssue[] } {
  const segments: GoalSample[][] = [];
  for (const s of samples) {
    const last = segments[segments.length - 1];
    if (last && last[0].goal === s.goal) last.push(s);
    else segments.push([s]);
  }
  const steps: StepMotion[] = [];
  const issues: MotionIssue[] = [];
  segments.forEach((seg, index) => {
    const g = seg[0].goal;
    const i = info(g) ?? { name: g, ...DEFAULT_INFO };
    const v = speeds(seg);
    const start = seg[0].time, end = seg[seg.length - 1].time;
    // The step's end: it was reached, or the next step took over (a later segment starts).
    const reached = seg.some((s) => s.reached) || index < segments.length - 1;
    const step: StepMotion = {
      step: g, name: i.name, start: r2(start), end: r2(end), startError: r3(seg[0].error),
      closest: r3(Math.min(...seg.map((s) => s.error))), endError: r3(seg[seg.length - 1].error),
      peakSpeed: r2(Math.max(0, ...v)), reached, stop: i.stop,
    };
    steps.push(step);
    if (seg.length < 4) return;

    // Translation: closest approach, then out again by more than the tolerance, then back.
    let min = Infinity, minAt = 0, best = { rise: 0, peakAt: 0, from: 0, fromAt: 0 };
    seg.forEach((s, k) => {
      if (s.error < min) { min = s.error; minAt = k; }
      const rise = s.error - min;
      if (rise > best.rise) best = { rise, peakAt: k, from: min, fromAt: minAt };
    });
    const e0 = seg[0].error;
    const approached = e0 - best.from >= 0.1 && best.from <= Math.max(0.3, 4 * i.tolerance);
    const backAfter = seg.slice(best.peakAt).some((s) => s.error <= best.from + best.rise * 0.5) || seg[seg.length - 1].reached;
    const peak = best.from + best.rise;
    if (i.stop && approached && backAfter && best.rise >= Math.max(0.02, 0.5 * i.tolerance) && peak > i.tolerance) {
      step.overshoot = r3(best.rise);
      const at = seg[best.fromAt].time, lost = end - at;
      // Average braking the robot really managed: from its fastest approach to the far point.
      let vk = 0;
      for (let k = 0; k <= best.fromAt; k++) if (v[k] > v[vk]) vk = k;
      const room = seg[vk].error + best.rise;
      const achieved = room > 0 && v[vk] > 0.3 ? (v[vk] * v[vk]) / (2 * room) : undefined;
      const suggest: MotionIssue["suggest"] = [];
      let fix: string;
      if (achieved !== undefined && (i.stopDeceleration <= 0 || i.stopDeceleration > achieved * 0.9)) {
        const value = Math.max(0.5, Math.floor(achieved * 0.85 * 2) / 2);
        suggest.push({ set: `${g}.constraints.stopDeceleration`, value });
        fix = `It slowed from ${r2(v[vk])} m/s over ${r2(room)} m (about ${r2(achieved)} m/s² of braking), less than the follower asked for. ${i.stopDeceleration > 0 ? `Lower constraints.stopDeceleration from ${i.stopDeceleration} to ${value}` : `Set constraints.stopDeceleration to ${value}`} m/s² on this step (or the routine) so it brakes in time${i.stopLag > 0 ? "" : "; if it still overshoots, set constraints.stopLag to the drivetrain lag (≈0.05–0.1 s)"}. Lowering this step's maxVelocity also works.`;
      } else if (i.stopLag <= 0) {
        suggest.push({ set: `${g}.constraints.stopLag`, value: 0.08 });
        fix = `Its braking profile (stopDeceleration ${i.stopDeceleration} m/s²) is within what it managed, so the drivetrain is trailing its command: set constraints.stopLag (≈0.05–0.1 s) on this step, or lower its maxVelocity.`;
      } else fix = `Lower this step's maxVelocity, or raise constraints.stopLag (now ${i.stopLag} s); check the drive's velocity tracking (log_diagnose tracking findings).`;
      issues.push({
        kind: "overshoot", severity: best.rise >= Math.max(0.05, i.tolerance) || lost >= 0.25 ? "warning" : "info",
        step: g, name: i.name, time: r2(at), start: r2(start), end: r2(end), amount: r3(best.rise), timeLost: r2(lost),
        message: `${i.name}: got within ${r3(best.from)} m of the goal at ${r2(at)} s, overshot ${r3(best.rise)} m past it, and took ${r2(lost)} s to come back${reached ? "" : " (never settled)"}.`,
        fix, ...(suggest.length ? { suggest } : {}),
      });
    } else if (i.stop && reached && e0 > 0.2) {
      // Creeping in: the last few centimeters take long (P law near the goal).
      const near = Math.max(0.1, 3 * i.tolerance);
      const k = seg.findIndex((s) => s.error <= near);
      const creep = k >= 0 ? end - seg[k].time : 0;
      if (creep >= 0.6)
        issues.push({
          kind: "slow-settle", severity: "info", step: g, name: i.name, time: r2(seg[k].time), start: r2(start), end: r2(end),
          amount: r2(creep), timeLost: r2(creep),
          message: `${i.name}: spent ${r2(creep)} s covering the last ${r3(near)} m.`,
          fix: `${i.minVelocity > 0 ? `Raise constraints.minVelocity (now ${i.minVelocity} m/s)` : "Set constraints.minVelocity (a speed floor outside the end tolerance, e.g. 0.3 m/s)"} on this step, or loosen goal.translationTolerance / velocityTolerance if that precision is not needed.`,
          suggest: [{ set: `${g}.constraints.minVelocity`, value: Math.max(0.3, i.minVelocity + 0.2) }],
        });
    }

    // Heading: closest to the target heading, then swinging back out.
    if (i.fixedHeading && seg.every((s) => s.rotation !== undefined)) {
      let rmin = Infinity, rminAt = 0, rb = { rise: 0, peakAt: 0, from: 0, fromAt: 0 };
      seg.forEach((s, k) => {
        if (s.rotation! < rmin) { rmin = s.rotation!; rminAt = k; }
        const rise = s.rotation! - rmin;
        if (rise > rb.rise) rb = { rise, peakAt: k, from: rmin, fromAt: rminAt };
      });
      const threshold = Math.max((3 * Math.PI) / 180, i.rotationTolerance);
      const turned = seg[0].rotation! - rb.from >= (5 * Math.PI) / 180 && rb.from <= Math.max((10 * Math.PI) / 180, 3 * i.rotationTolerance);
      const back = seg.slice(rb.peakAt).some((s) => s.rotation! <= rb.from + rb.rise * 0.5) || seg[seg.length - 1].reached;
      if (turned && back && rb.rise >= threshold && rb.from + rb.rise > i.rotationTolerance) {
        step.headingOvershoot = r2(deg(rb.rise));
        const at = seg[rb.fromAt].time;
        issues.push({
          kind: "heading-overshoot", severity: deg(rb.rise) >= 8 ? "warning" : "info",
          step: g, name: i.name, time: r2(at), start: r2(start), end: r2(end), amount: r2(deg(rb.rise)), timeLost: r2(end - at),
          message: `${i.name}: heading came within ${r2(deg(rb.from))}° of its target at ${r2(at)} s, then swung ${r2(deg(rb.rise))}° back out.`,
          fix: "The rotation controller asks for more angular braking than the robot gives: lower maxAngularVelocity or rotationKp on this step, or start the turn earlier with a rotation marker so it finishes slowly.",
        });
      }
    }
  });
  return { steps, issues };
}

/** Motion of a preview run. */
export function motionOfFrames(project: SuiteProject, routine: AutoRoutine, frames: Frame[]) {
  const infos = goalInfos(project, routine);
  return analyzeMotion(framesToSamples(routine, frames), (g) => infos.get(g));
}

/**
 * Motion of every runner in a log. With a project, the routine whose steps the log's goals name
 * supplies names, tolerances and current limits (for the suggested fix).
 */
export function motionOfLog(recording: Recording, project?: SuiteProject) {
  return goalRunners(recording).map((runner) => {
    const { samples, channels } = logToSamples(recording, runner);
    const goals = new Set(samples.map((s) => s.goal));
    const routine = project?.routines.find((r) => r.nodes.some((n) => goals.has(n.id)));
    const infos = project && routine ? goalInfos(project, routine) : undefined;
    return { runner, routine: routine?.id, channels, ...analyzeMotion(samples, (g) => infos?.get(g)) };
  }).filter((m) => m.steps.length);
}

const normName = (name: string) => name.replace(/^NT:/, "").replace(/^\/+/, "").replace(/^(AdvantageKit\/)?RealOutputs\//, "");
/**
 * The robot's pose in a log: `prefix` (".../Pose" with /x, /y and optionally /heading or
 * /rotation), else the most-sampled robot pose channel that is not a target or vision estimate.
 */
export function logPose(recording: Recording, prefix?: string): { channel: string; x: Channel; y: Channel; heading?: Channel } | undefined {
  const numeric = (c: Channel) => c.samples.length > 1 && typeof c.samples[0].value === "number";
  const xs = recording.channels.filter((c) => numeric(c) && (prefix
    ? c.name === `${prefix}/x` || normName(c.name) === `${normName(prefix)}/x`
    : /(^|\/)(Robot|Drive|Odometry)?(State\/)?(Robot)?Pose(Estimate|Estimator|2d)?\/x$|(^|\/)Odometry\/Robot\/x$/i.test(normName(c.name)) && !/target|lookahead|vision|camera|reference|setpoint|goal|observation/i.test(c.name)));
  const x = xs.sort((a, b) => Number(a.name.startsWith("NT:")) - Number(b.name.startsWith("NT:")) || b.samples.length - a.samples.length)[0];
  if (!x) return undefined;
  const base = x.name.slice(0, -2);
  const y = recording.channels.find((c) => c.name === `${base}/y`);
  if (!y) return undefined;
  const heading = recording.channels.find((c) => numeric(c) && [`${base}/heading`, `${base}/rotation`, `${base}/rotation/value`, `${base}/theta`].includes(c.name));
  return { channel: base, x, y, heading };
}
