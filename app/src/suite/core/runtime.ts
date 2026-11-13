/*
 * Portions ported from BLine-Lib (https://github.com/edanliahovetsky/BLine-Lib):
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2025, Edan Liahovetsky
 * Copyright (c) 2025, Rebel Robotics (FRC 2638)
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
import {
  evaluate,
  type SuiteProject,
  type AutoRoutine,
  type Pose,
  type Velocity,
  type Signals,
  type Constraints,
  type Goal,
  type AutoNode,
  resolveConstraints, resolveNodeConstraints,
} from "./model.ts";
import { previewTick } from "./pathing/preview.ts";
export const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
export interface ControllerState extends Velocity {
  settled: number;
  /** Start of the active segment (previous anchor, or the pose at path entry). */
  sx?: number;
  sy?: number;
  /** Last rotation target passed and the remaining path distance where it applied. */
  rotHeading?: number;
  rotRemaining?: number;
  /** Event markers already fired on the active segment. */
  events?: number;
  /** Smallest remaining path distance reached; rotation progress is monotonic. */
  acceptedRemaining?: number;
  /**
   * Set while a path is driven by follow() (the native follower). The rest of that path
   * stays on follow() across handoffs; switching to the kinematic preview mid-path would
   * restart it from rest.
   */
  native?: boolean;
}
export interface ControlResult {
  command: Velocity;
  state: ControllerState;
  /** Final anchor settled, or intermediate anchor handed off. */
  reached: boolean;
  handoff: boolean;
  valid: boolean;
  /** Event trigger keys fired this tick. */
  fired: string[];
  /** Projected progress on the active segment and remaining path distance. */
  progress: number;
  remaining: number;
  /** Heading the follower is steering toward this tick. */
  targetHeading: number;
}
/**
 * The anchors ahead of the robot: anchors[0] is the active translation target.
 * `final` means anchors.at(-1) is where the path ends; otherwise the route
 * continues past the known anchors (an explicit handoff before a conditional exit).
 */
export interface PathAhead {
  anchors: Goal[];
  final: boolean;
  /** Max velocity of the step owning each anchor (caps[i] applies on the segment into anchors[i]). */
  caps?: number[];
}
/** Below this distance to the target, Motion heading follows the segment direction instead. */
export const MOTION_MIN_DISTANCE = 0.1;
/** Heading that faces the direction of travel toward `T` (Motion mode), before any offset. */
function motionHeading(T: Goal, pose: Pose, sx: number, sy: number, fallback: number): number {
  const dx = T.x - pose.x,
    dy = T.y - pose.y;
  if (Math.hypot(dx, dy) > Math.max(T.translationTolerance, MOTION_MIN_DISTANCE)) return Math.atan2(dy, dx);
  return Math.hypot(T.x - sx, T.y - sy) > 1e-9 ? Math.atan2(T.y - sy, T.x - sx) : fallback;
}
export const freshState = (pose: Pose, v: Velocity = { vx: 0, vy: 0, omega: 0 }): ControllerState => ({
  ...v,
  settled: 0,
  sx: pose.x,
  sy: pose.y,
  rotHeading: pose.heading,
  rotRemaining: Number.NaN,
  events: 0,
});
const hasHeading = (g: Goal) => !g.headingMode || g.headingMode === "fixed";
/**
 * Path follower ported from BLine-Lib's FollowPath, RotationProgress and
 * ChassisRateLimiter (BSD 3-Clause, Copyright (c) 2025 Edan Liahovetsky and
 * Rebel Robotics (FRC 2638); see THIRD_PARTY_NOTICES.md). The native
 * counterpart is PathFollower in lib-cpp/include/mayhem/pose_controller.hpp.
 *
 * Translation: P on remaining polyline distance clamped to max velocity,
 * pointed at the active target, plus cross-track correction; speeds are capped
 * and their change limited by the accelerations. Intermediate targets hand off
 * once the robot enters their radius (projected-progress handoff is opt-in).
 * Rotation: heading interpolates between rotation targets by monotonic path
 * progress. Completion: final target within translation and rotation tolerance.
 */
/** Longest step follow() integrates; longer steps are clamped (C++ PathFollower::kDefaultMaxDt). */
export const MAX_FOLLOW_DT = 0.1;
export function follow(
  pose: Pose,
  measured: Velocity,
  path: PathAhead,
  c: Constraints,
  prior: ControllerState,
  dt: number,
): ControlResult {
  const k = resolveConstraints(c);
  const invalid = (): ControlResult => ({
    command: { vx: 0, vy: 0, omega: 0 },
    state: { vx: 0, vy: 0, omega: 0, settled: 0 },
    reached: false,
    handoff: false,
    valid: false,
    fired: [],
    progress: 0,
    remaining: 0,
    targetHeading: pose.heading,
  });
  const T = path.anchors[0];
  if (!T) return invalid();
  const sx = prior.sx ?? pose.x,
    sy = prior.sy ?? pose.y;
  const numbers = [
    pose.x, pose.y, pose.heading, measured.vx, measured.vy, measured.omega,
    prior.vx, prior.vy, prior.omega, prior.settled, sx, sy, dt,
    k.maxVelocity, k.maxAcceleration, k.maxAngularVelocity, k.maxAngularAcceleration,
    k.translationKp, k.rotationKp, k.handoffRadius, k.crossTrackKp, k.minVelocity,
  ];
  for (const g of path.anchors)
    numbers.push(g.x, g.y, g.heading, g.translationTolerance, g.rotationTolerance,
      g.velocityTolerance, g.settleTime, g.handoffRadius);
  if (
    numbers.some((v) => !Number.isFinite(v)) ||
    dt <= 0 ||
    [k.maxVelocity, k.maxAcceleration, k.maxAngularVelocity, k.maxAngularAcceleration,
      k.translationKp, k.rotationKp, k.handoffRadius, k.crossTrackKp].some((v) => v <= 0) ||
    k.minVelocity < 0 ||
    path.anchors.some(
      (g) =>
        g.translationTolerance <= 0 ||
        g.rotationTolerance <= 0 ||
        g.velocityTolerance <= 0 ||
        g.settleTime < 0 ||
        g.handoffRadius < 0 ||
        (g.headingMode === "pointAt" &&
          (!Number.isFinite(g.aimX) || !Number.isFinite(g.aimY))) ||
        (g.markers ?? []).some(
          (m) =>
            !Number.isFinite(m.t) ||
            (m.kind === "rotation" && !Number.isFinite(m.heading)),
        ),
    )
  )
    return invalid();
  // A loop overrun integrates as 0.1 s, like PathFollower::kDefaultMaxDt.
  dt = Math.min(dt, MAX_FOLLOW_DT);
  // Geometry of the active segment S -> T.
  const segX = T.x - sx,
    segY = T.y - sy,
    L = Math.hypot(segX, segY);
  const ux = L > 1e-9 ? segX / L : 0,
    uy = L > 1e-9 ? segY / L : 0;
  const rx = pose.x - sx,
    ry = pose.y - sy;
  const progress = L > 1e-9 ? Math.min(1, Math.max(0, (rx * ux + ry * uy) / L)) : 1;
  const crossTrack = L > 1e-9 ? ux * ry - uy * rx : 0;
  const dx = T.x - pose.x,
    dy = T.y - pose.y,
    distance = Math.hypot(dx, dy);
  // Remaining polyline length after T (segment lengths of anchors ahead).
  let tail = 0;
  for (let i = 1; i < path.anchors.length; i++)
    tail += Math.hypot(
      path.anchors[i].x - path.anchors[i - 1].x,
      path.anchors[i].y - path.anchors[i - 1].y,
    );
  const isFinal = path.final && path.anchors.length === 1;
  const remaining = path.final ? distance + tail : Number.POSITIVE_INFINITY;
  const along = (1 - progress) * L + tail; // remaining measured along the polyline
  const radius = T.handoffRadius > 0 ? T.handoffRadius : k.handoffRadius;
  const handoff =
    !isFinal &&
    (L <= 1e-9 ||
      distance <= radius ||
      ((T.projectedHandoff ?? false) && L > 1e-9 && progress >= Math.min(1, Math.max(0, 1 - radius / L))));
  // Event triggers on this segment fire in list order once progress passes t.
  const fired: string[] = [];
  let events = prior.events ?? 0;
  const markers = T.markers ?? [];
  for (; events < markers.length; events++) {
    const m = markers[events];
    if (m.kind === "event" && m.t > progress && !handoff) break;
    if (m.kind === "event") fired.push(m.key);
  }
  // Rotation: from the last passed target to the next target ahead, by progress.
  // Rotation progress never moves backward along the path (BLine RotationProgress).
  const progressAlong = Math.min(along, prior.acceptedRemaining ?? along);
  let fromHeading = prior.rotHeading ?? pose.heading;
  let fromRemaining = Number.isFinite(prior.rotRemaining ?? Number.NaN)
    ? (prior.rotRemaining as number)
    : along;
  for (const m of markers)
    if (m.kind === "rotation" && m.t <= progress) {
      fromHeading = m.heading;
      fromRemaining = (1 - m.t) * L + tail;
    }
  let next: { heading: number; remaining: number; profiled: boolean } | undefined;
  {
    let segStartX = sx,
      segStartY = sy,
      after = tail + L;
    for (let i = 0; i < path.anchors.length && !next; i++) {
      const g = path.anchors[i];
      const len = i === 0 ? L : Math.hypot(g.x - segStartX, g.y - segStartY);
      after -= len;
      for (const m of g.markers ?? [])
        if (m.kind === "rotation" && (i > 0 || m.t > progress)) {
          next = { heading: m.heading, remaining: (1 - m.t) * len + after, profiled: m.profiled ?? true };
          break;
        }
      if (!next && hasHeading(g))
        next = { heading: g.heading, remaining: after, profiled: g.profiled ?? true };
      // A Motion step ahead: face its direction of travel by the handoff into its segment
      // (the previous anchor's handoff circle), so the heading never steps at the handoff.
      if (!next && i > 0 && g.headingMode === "motion" && len > 1e-9) {
        const before = path.anchors[i - 1];
        next = {
          heading: Math.atan2(g.y - segStartY, g.x - segStartX) + (g.headingOffset ?? 0),
          remaining: after + len + (before.handoffRadius > 0 ? before.handoffRadius : k.handoffRadius),
          profiled: true,
        };
      }
      segStartX = g.x;
      segStartY = g.y;
    }
  }
  let desiredHeading = fromHeading;
  const rotationTargeted = !!next || markers.some((m) => m.kind === "rotation");
  if (next) {
    if (!next.profiled) desiredHeading = next.heading;
    else {
      const span = fromRemaining - next.remaining;
      const f = span > 1e-9 ? Math.min(1, Math.max(0, (fromRemaining - progressAlong) / span)) : 1;
      desiredHeading = fromHeading + wrap(next.heading - fromHeading) * f;
    }
  }
  // The heading requested by path progress, before per-step overrides.
  const interpolated = desiredHeading;
  if (T.headingMode === "pointAt")
    desiredHeading = Math.atan2((T.aimY ?? T.y) - pose.y, (T.aimX ?? T.x) - pose.x) + (T.headingOffset ?? 0);
  else if (T.headingMode === "motion")
    desiredHeading = motionHeading(T, pose, sx, sy, interpolated) + (T.headingOffset ?? 0);
  if (isFinal && hasHeading(T) && distance <= T.translationTolerance)
    desiredHeading = T.heading;
  const angle = wrap(desiredHeading - pose.heading);
  // Completion of the final anchor: tolerances only, optional settle dwell.
  const inPose =
    isFinal &&
    distance <= T.translationTolerance &&
    ((T.headingMode === "free" && !rotationTargeted) || Math.abs(angle) <= T.rotationTolerance);
  const slow =
    Math.hypot(measured.vx, measured.vy) <= T.velocityTolerance &&
    Math.abs(measured.omega) <= T.velocityTolerance;
  const settled = inPose && (T.settleTime <= 0 || slow) ? prior.settled + dt : 0;
  const done = inPose && (T.settleTime <= 0 || settled >= T.settleTime);
  if (done)
    return {
      command: { vx: 0, vy: 0, omega: 0 },
      state: { ...prior, vx: 0, vy: 0, omega: 0, settled, events },
      reached: true,
      handoff: false,
      valid: true,
      fired,
      progress,
      remaining,
      targetHeading: desiredHeading,
    };
  // Translation (BLine FollowPath phase 4): P on remaining polyline distance,
  // clamped to max velocity, with an optional speed floor, pointed at the
  // active target, plus cross-track correction along the segment normal.
  let speed = Math.min(k.translationKp * remaining, k.maxVelocity);
  // Optional: be at or below each slower step's cap when reaching its handoff point.
  if (k.anticipateSpeedCaps && path.caps) {
    // Distance to the slower step's handoff point, less one step of travel (the rate
    // limiter applies a speed change one tick after it is requested).
    let d = distance - radius - speed * dt;
    for (let i = 1; i < path.anchors.length; i++) {
      const cap = path.caps[i];
      if (Number.isFinite(cap) && cap < speed)
        speed = Math.min(speed, Math.sqrt(cap * cap + 2 * k.maxAcceleration * Math.max(0, d)));
      d += Math.hypot(path.anchors[i].x - path.anchors[i - 1].x, path.anchors[i].y - path.anchors[i - 1].y);
    }
  }
  if (k.minVelocity > 0 && remaining > T.translationTolerance)
    speed = Math.max(speed, Math.min(k.minVelocity, k.maxVelocity));
  let vx = distance > 1e-9 ? (speed * dx) / distance : 0,
    vy = distance > 1e-9 ? (speed * dy) / distance : 0;
  if (L > 1e-9) {
    // Positive cross-track is left of the segment; correct along its right normal.
    vx += k.crossTrackKp * crossTrack * uy;
    vy -= k.crossTrackKp * crossTrack * ux;
  }
  // Rotation: P on heading error, clamped to max angular velocity.
  let omegaDesired = Math.max(-k.maxAngularVelocity, Math.min(k.maxAngularVelocity, k.rotationKp * angle));
  // Rate limiting (BLine ChassisRateLimiter): cap speeds, then limit the change
  // in the translation vector and in angular velocity by the accelerations.
  const mag = Math.hypot(vx, vy);
  if (mag > k.maxVelocity) {
    vx *= k.maxVelocity / mag;
    vy *= k.maxVelocity / mag;
  }
  const change = Math.hypot(vx - prior.vx, vy - prior.vy),
    maxChange = k.maxAcceleration * dt;
  if (change > maxChange) {
    vx = prior.vx + ((vx - prior.vx) * maxChange) / change;
    vy = prior.vy + ((vy - prior.vy) * maxChange) / change;
  }
  omegaDesired = prior.omega + Math.max(-k.maxAngularAcceleration * dt, Math.min(k.maxAngularAcceleration * dt, omegaDesired - prior.omega));
  const omega = omegaDesired;
  if (![vx, vy, omega].every(Number.isFinite)) return invalid();
  // On handoff, the next segment starts at T and inherits the rotation context.
  // An early handoff continues from the heading requested right now (including a
  // Motion or point-at override), so the heading target never jumps.
  const carry = handoff
    ? { rotHeading: desiredHeading, rotRemaining: tail }
    : { rotHeading: prior.rotHeading ?? pose.heading, rotRemaining: Number.isFinite(prior.rotRemaining ?? Number.NaN) ? prior.rotRemaining : along };
  return {
    command: { vx, vy, omega },
    state: handoff
      ? { vx, vy, omega, settled: 0, sx: T.x, sy: T.y, events: 0, acceptedRemaining: Math.min(progressAlong, tail), ...carry }
      : { vx, vy, omega, settled, sx, sy, events, acceptedRemaining: progressAlong, ...carry },
    reached: handoff,
    handoff,
    valid: true,
    fired,
    progress,
    remaining,
    targetHeading: desiredHeading,
  };
}
/** Drive to a single pose (one-anchor path). Kept for robot code and tests. */
export function control(
  pose: Pose,
  measured: Velocity,
  goal: Goal,
  c: Constraints,
  prior: ControllerState,
  dt: number,
): ControlResult {
  return follow(pose, measured, { anchors: [goal], final: !(goal.handoffRadius > 0) }, c, prior, dt);
}
const MAX_LOOKAHEAD = 64;
/** The next pose step reached only through a single unconditional transition. */
export function autoNext(routine: AutoRoutine, node: AutoNode): AutoNode | undefined {
  if (node.kind !== "pose" || node.goal?.stop) return undefined;
  const out = routine.transitions.filter((t) => t.from === node.id);
  if (out.length !== 1 || out[0].condition.kind !== "always") return undefined;
  const next = routine.nodes.find((n) => n.id === out[0].to);
  return next?.kind === "pose" && next.goal ? next : undefined;
}
/** Whether the robot passes through this pose step instead of stopping on it. */
export const isIntermediate = (routine: AutoRoutine, node: AutoNode) =>
  node.kind === "pose" && !!node.goal && !node.goal.stop &&
  (!!autoNext(routine, node) || node.goal.handoffRadius > 0);
/** Anchors ahead of a pose step, following unconditional pose chains. */
export function pathAhead(routine: AutoRoutine, node: AutoNode, project?: SuiteProject): PathAhead {
  const anchors: Goal[] = [node.goal!];
  const nodes = [node];
  const seen = new Set([node.id]);
  let current = node;
  const result = (final: boolean): PathAhead => ({
    anchors,
    final,
    ...(project ? { caps: nodes.map((n) => resolveNodeConstraints(project, routine, n).maxVelocity) } : {}),
  });
  while (anchors.length < MAX_LOOKAHEAD && isIntermediate(routine, current)) {
    const next = autoNext(routine, current);
    if (!next || seen.has(next.id)) return result(false);
    seen.add(next.id);
    anchors.push(next.goal!);
    nodes.push(next);
    current = next;
  }
  return result(!isIntermediate(routine, current));
}
export interface TraceEvent {
  time: number;
  kind: "enter" | "transition" | "failure" | "complete" | "event";
  node: string;
  message: string;
  transition?: string;
}
export type ActionStatus = "running" | "succeeded" | "failed";
export type PreviewMode = "path" | "routine";
export interface PreviewOptions {
  mode?: PreviewMode;
  actions?: Record<string, ActionStatus>;
}
export const MAX_PREVIEW_SECONDS = 600;
export const MAX_PREVIEW_EVENTS = 1000;
export interface Frame {
  actions: Record<string, ActionStatus>;
  time: number;
  node: string;
  pose: Pose;
  velocity: Velocity;
  controller: ControllerState;
  signals: Signals;
  status: "running" | "completed" | "failed";
  reached: boolean;
  enteredAt: number;
  events: TraceEvent[];
}
export function initialFrame(
  project: SuiteProject,
  routine: AutoRoutine,
): Frame {
  const start = routine.start ?? project.robot.start;
  const state = freshState(start);
  const first = routine.nodes.find(n => n.id === routine.initial);
  const preview = first?.kind === "pose" && first.goal
    ? previewTick(project, routine, first, start, state, 0.02, true)
    : undefined;
  return {
    actions: {},
    time: 0,
    node: routine.initial,
    pose: { ...(preview?.pose ?? start) },
    velocity: { vx: 0, vy: 0, omega: 0 },
    controller: preview?.state ?? state,
    signals: Object.fromEntries(project.signals.map((s) => [s.key, s.initial])),
    status:
      routine.nodes.find((n) => n.id === routine.initial)?.kind === "finish"
        ? "completed"
        : "running",
    reached: false,
    enteredAt: 0,
    events: [
      {
        time: 0,
        kind: "enter",
        node: routine.initial,
        message: "Routine started",
      },
    ],
  };
}
/** Deterministic ideal-kinematics preview; custom actions require external signals. */
export function step(
  project: SuiteProject,
  routine: AutoRoutine,
  frame: Frame,
  signals: Signals,
  dt = 0.02,
  freezeDrive = false,
  options: PreviewOptions = {},
): Frame {
  if (frame.status !== "running") return frame;
  if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1)
    throw new Error("Control step must be in (0, 0.1] seconds.");
  let node = routine.nodes.find((n) => n.id === frame.node);
  if (!node) throw new Error(`Unknown state ${frame.node}`);
  const time = frame.time + dt;
  let next: Frame = { ...frame, time, signals: { ...signals } };
  const event = (
    kind: TraceEvent["kind"],
    message: string,
    transition?: string,
  ) => {
    next.events = [
      ...next.events,
      { time, kind, node: next.node, message, transition },
    ];
  };
  if (node.kind === "finish") {
    next.status = "completed";
    next.velocity = { vx: 0, vy: 0, omega: 0 };
    event("complete", "Routine completed");
    return next;
  }
  if (frame.events.length >= MAX_PREVIEW_EVENTS) {
    next.status = "failed";
    next.velocity = { vx: 0, vy: 0, omega: 0 };
    event("failure", "Preview stopped after 1000 execution events. Check for a transition cycle.");
    return next;
  }
  if (time >= MAX_PREVIEW_SECONDS) {
    next.status = "failed";
    next.velocity = { vx: 0, vy: 0, omega: 0 };
    event(
      "failure",
      "Preview stopped at the 600 second limit. Check for a transition cycle.",
    );
    return next;
  }
  // onTimeout "succeed" (action/custom steps): the window ended, so the step is done.
  const windowEnded =
    time - frame.enteredAt >= node.timeout &&
    node.onTimeout === "succeed" &&
    (node.kind === "action" || node.kind === "custom");
  if (windowEnded && node.action && frame.actions[node.action] !== "succeeded")
    event("event", `${node.name}: ${node.timeout} s window ended; continuing`);
  if (time - frame.enteredAt >= node.timeout && !windowEnded) {
    next.status = "failed";
    next.velocity = { vx: 0, vy: 0, omega: 0 };
    event(
      "failure",
      `${node.name}: watchdog expired; goal/condition was not satisfied`,
    );
    return next;
  }
  const preview = node.kind === "pose" && node.goal && !freezeDrive && !frame.controller.native
    ? previewTick(project, routine, node, frame.pose, frame.controller, dt)
    : undefined;
  // BLine resolves all intermediate handoffs before calculating movement.
  // Keep the routine trace and action ownership on the same active target.
  if (preview) {
    for (const passed of preview.passed) {
      const transition = routine.transitions.find(t => t.from === passed.id && t.condition.kind === "always");
      if (!transition) break;
      event("transition", `${passed.name} → ${routine.nodes.find(n => n.id === transition.to)?.name}`, transition.id);
      next.node = transition.to;
      next.enteredAt = time;
      next.actions = {};
    }
    node = preview.active;
  }
  if (options.mode !== "path") {
    next.actions = { ...next.actions };
    const callbacks = [
      ...(node.during ?? []),
      ...((node.kind === "action" || node.kind === "custom") && node.action
        ? [node.action]
        : []),
    ];
    for (const id of callbacks) {
      const status =
        next.actions[id] === "succeeded" || (windowEnded && id === node.action && !node.during?.includes(id))
          ? "succeeded"
          : (options.actions?.[id] ?? "running");
      next.actions[id] = status;
      if (status === "failed") {
        next.status = "failed";
        next.velocity = { vx: 0, vy: 0, omega: 0 };
        event("failure", `${node.name}: action ${id} failed`);
        return next;
      }
    }
  }
  let handedOff = false;
  if (preview) {
    next.pose = preview.pose;
    next.velocity = preview.velocity;
    next.controller = preview.state;
    next.reached = preview.reached;
    for (const key of preview.fired) event("event", `Event trigger ${key}`);
  } else if (node.kind === "pose" && node.goal) {
    const result = follow(
      frame.pose,
      frame.velocity,
      pathAhead(routine, node, project),
      resolveNodeConstraints(project, routine, node),
      frame.controller,
      dt,
    );
    if (!result.valid) {
      next.status = "failed";
      next.velocity = { vx: 0, vy: 0, omega: 0 };
      event("failure", "Invalid controller configuration or measurement");
      return next;
    }
    for (const key of result.fired) event("event", `Event trigger ${key}`);
    next.controller = { ...result.state, native: true };
    next.reached = result.reached;
    handedOff = result.handoff;
    next.velocity = freezeDrive ? { vx: 0, vy: 0, omega: 0 } : result.command;
    next.pose = {
      x: frame.pose.x + next.velocity.vx * dt,
      y: frame.pose.y + next.velocity.vy * dt,
      heading: wrap(frame.pose.heading + next.velocity.omega * dt),
    };
  } else {
    next.reached =
      options.mode === "path" ||
      (!!node.action && next.actions[node.action] === "succeeded");
    next.velocity = { vx: 0, vy: 0, omega: 0 };
  }
  if (next.reached) {
    const transition = routine.transitions.find(
      (t) =>
        t.from === node.id &&
        (options.mode === "path" || evaluate(t.condition, signals)),
    );
    if (transition) {
      event(
        "transition",
        `${node.name} → ${routine.nodes.find((n) => n.id === transition.to)?.name}`,
        transition.id,
      );
      next.node = transition.to;
      next.enteredAt = time;
      next.reached = false;
      next.actions = {};
      if (
        routine.nodes.find((n) => n.id === transition.to)?.kind === "finish"
      ) {
        next.status = "completed";
        next.velocity = { vx: 0, vy: 0, omega: 0 };
        event("complete", "Routine completed");
      }
      // A handoff continues the same path: the next segment starts at the
      // anchor just passed. Anything else starts a new path from the live pose.
      const target = routine.nodes.find((n) => n.id === transition.to);
      next.controller =
        handedOff && target?.kind === "pose"
          ? next.controller
          : freshState(next.pose, next.velocity);
    }
  }
  return next;
}
export function simulate(
  project: SuiteProject,
  routine: AutoRoutine,
  signals: Signals,
  options: PreviewOptions & { maxSeconds?: number; freezeDrive?: boolean } = {},
) {
  if (
    options.maxSeconds !== undefined &&
    (!Number.isFinite(options.maxSeconds) ||
      options.maxSeconds <= 0 ||
      options.maxSeconds > MAX_PREVIEW_SECONDS)
  )
    throw new Error("maxSeconds must be in (0,600].");
  let frame = initialFrame(project, routine);
  const frames: Frame[] = [frame];
  const count = Math.min(30000, Math.ceil((options.maxSeconds ?? 40) / 0.02));
  for (let i = 0; i < count && frame.status === "running"; i++) {
    frame = step(
      project,
      routine,
      frame,
      signals,
      0.02,
      options.freezeDrive,
      options,
    );
    frames.push(frame);
  }
  return { status: frame.status, frame, frames };
}
