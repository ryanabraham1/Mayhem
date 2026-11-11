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
  resolveConstraints,
} from "./model.ts";
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
}
/**
 * The anchors ahead of the robot: anchors[0] is the active translation target.
 * `final` means anchors.at(-1) is where the path ends; otherwise the route
 * continues past the known anchors (an explicit handoff before a conditional exit).
 */
export interface PathAhead {
  anchors: Goal[];
  final: boolean;
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
/** Fraction of max acceleration used for the stopping-distance limit. */
export const BRAKING_SHARE = 0.75;
const hasHeading = (g: Goal) => !g.headingMode || g.headingMode === "fixed";
/**
 * BLine-style path follower. Browser reference implementation; the native
 * counterpart is PathFollower in lib-cpp/include/mayhem/pose_controller.hpp.
 *
 * Translation: speed from remaining polyline distance (P gain, capped by max
 * velocity and a stopping-distance limit), pointed at the active anchor, plus a
 * cross-track correction toward the active segment; the change in command is
 * limited by max acceleration. Intermediate anchors hand off inside their
 * radius (or, optionally, at projected progress 1 - r/L) without slowing.
 * Rotation: heading interpolates between rotation targets by path progress.
 * Completion: final anchor within translation and rotation tolerance.
 */
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
    dt > 0.1 ||
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
    (distance <= radius ||
      ((T.projectedHandoff ?? true) && L > 1e-9 && progress >= Math.min(1, Math.max(0, 1 - radius / L))));
  // Event triggers on this segment fire in list order once progress passes t.
  const fired: string[] = [];
  let events = prior.events ?? 0;
  const markers = T.markers ?? [];
  for (; events < markers.length; events++) {
    const m = markers[events];
    if (m.t > progress && !handoff) break;
    if (m.kind === "event") fired.push(m.key);
  }
  // Rotation: from the last passed target to the next target ahead, by progress.
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
      segStartX = g.x;
      segStartY = g.y;
    }
  }
  let desiredHeading = fromHeading;
  if (next) {
    if (!next.profiled) desiredHeading = next.heading;
    else {
      const span = fromRemaining - next.remaining;
      const f = span > 1e-9 ? Math.min(1, Math.max(0, (fromRemaining - along) / span)) : 1;
      desiredHeading = fromHeading + wrap(next.heading - fromHeading) * f;
    }
  }
  if (T.headingMode === "pointAt")
    desiredHeading = Math.atan2((T.aimY ?? T.y) - pose.y, (T.aimX ?? T.x) - pose.x);
  else if (T.headingMode === "motion" && distance > T.translationTolerance)
    desiredHeading = Math.atan2(dy, dx);
  if (isFinal && hasHeading(T) && distance <= T.translationTolerance)
    desiredHeading = T.heading;
  const angle = wrap(desiredHeading - pose.heading);
  // Completion of the final anchor: tolerances only, optional settle dwell.
  const inPose =
    isFinal &&
    distance <= T.translationTolerance &&
    (T.headingMode === "free" || Math.abs(angle) <= T.rotationTolerance);
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
    };
  // Translation command.
  let speed = Math.min(
    k.maxVelocity,
    k.translationKp * remaining,
    // Brake on part of the acceleration budget so steering still has headroom.
    Math.sqrt(2 * BRAKING_SHARE * k.maxAcceleration * Math.max(0, remaining - T.translationTolerance / 2)),
  );
  if (k.minVelocity > 0 && remaining > T.translationTolerance)
    speed = Math.max(speed, Math.min(k.minVelocity, k.maxVelocity));
  let vx = distance > 1e-9 ? (speed * dx) / distance : 0,
    vy = distance > 1e-9 ? (speed * dy) / distance : 0;
  if (L > 1e-9 && distance > T.translationTolerance) {
    vx += k.crossTrackKp * crossTrack * uy;
    vy -= k.crossTrackKp * crossTrack * ux;
  }
  // Cross-track steers; it never adds speed beyond the profiled request.
  const mag = Math.hypot(vx, vy);
  if (mag > speed && mag > 1e-9) {
    vx *= speed / mag;
    vy *= speed / mag;
  }
  const change = Math.hypot(vx - prior.vx, vy - prior.vy),
    maxChange = k.maxAcceleration * dt;
  if (change > maxChange) {
    vx = prior.vx + ((vx - prior.vx) * maxChange) / change;
    vy = prior.vy + ((vy - prior.vy) * maxChange) / change;
  }
  const angularSpeed = Math.min(
    k.maxAngularVelocity,
    k.rotationKp * Math.abs(angle),
    Math.sqrt(2 * k.maxAngularAcceleration * Math.abs(angle)),
  );
  const desired = Math.sign(angle) * angularSpeed;
  const omega =
    prior.omega +
    Math.max(
      -k.maxAngularAcceleration * dt,
      Math.min(k.maxAngularAcceleration * dt, desired - prior.omega),
    );
  if (![vx, vy, omega].every(Number.isFinite)) return invalid();
  // On handoff, the next segment starts at T and inherits the rotation context.
  const carry = handoff
    ? hasHeading(T)
      ? { rotHeading: T.heading, rotRemaining: tail }
      : { rotHeading: fromHeading, rotRemaining: fromRemaining }
    : { rotHeading: prior.rotHeading ?? pose.heading, rotRemaining: Number.isFinite(prior.rotRemaining ?? Number.NaN) ? prior.rotRemaining : along };
  return {
    command: { vx, vy, omega },
    state: handoff
      ? { vx, vy, omega, settled: 0, sx: T.x, sy: T.y, events: 0, ...carry }
      : { vx, vy, omega, settled, sx, sy, events, ...carry },
    reached: handoff,
    handoff,
    valid: true,
    fired,
    progress,
    remaining,
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
export function pathAhead(routine: AutoRoutine, node: AutoNode): PathAhead {
  const anchors: Goal[] = [node.goal!];
  const seen = new Set([node.id]);
  let current = node;
  while (anchors.length < MAX_LOOKAHEAD && isIntermediate(routine, current)) {
    const next = autoNext(routine, current);
    if (!next || seen.has(next.id)) return { anchors, final: false };
    seen.add(next.id);
    anchors.push(next.goal!);
    current = next;
  }
  return { anchors, final: !isIntermediate(routine, current) };
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
  return {
    actions: {},
    time: 0,
    node: routine.initial,
    pose: { ...(routine.start ?? project.robot.start) },
    velocity: { vx: 0, vy: 0, omega: 0 },
    controller: freshState(routine.start ?? project.robot.start),
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
  const node = routine.nodes.find((n) => n.id === frame.node);
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
  if (time - frame.enteredAt >= node.timeout) {
    next.status = "failed";
    next.velocity = { vx: 0, vy: 0, omega: 0 };
    event(
      "failure",
      `${node.name}: watchdog expired; goal/condition was not satisfied`,
    );
    return next;
  }
  if (options.mode !== "path") {
    next.actions = { ...frame.actions };
    const callbacks = [
      ...(node.during ?? []),
      ...((node.kind === "action" || node.kind === "custom") && node.action
        ? [node.action]
        : []),
    ];
    for (const id of callbacks) {
      const status =
        frame.actions[id] === "succeeded"
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
  if (node.kind === "pose" && node.goal) {
    const result = follow(
      frame.pose,
      frame.velocity,
      pathAhead(routine, node),
      { ...project.robot.constraints, ...node.constraints },
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
    next.controller = result.state;
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
