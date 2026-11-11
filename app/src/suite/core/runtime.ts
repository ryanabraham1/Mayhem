import {
  evaluate,
  type SuiteProject,
  type AutoRoutine,
  type Pose,
  type Velocity,
  type Signals,
  type Constraints,
  type Goal,
} from "./model.ts";
export const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
export interface ControllerState extends Velocity {
  settled: number;
}
export interface ControlResult {
  command: Velocity;
  state: ControllerState;
  reached: boolean;
  valid: boolean;
}
/** Browser reference implementation. Native counterpart: lib-cpp/pose_controller.hpp. */
export function control(
  pose: Pose,
  measured: Velocity,
  goal: Goal,
  c: Constraints,
  prior: ControllerState,
  dt: number,
): ControlResult {
  const invalid = (): ControlResult => ({
    command: { vx: 0, vy: 0, omega: 0 },
    state: { vx: 0, vy: 0, omega: 0, settled: 0 },
    reached: false,
    valid: false,
  });
  const values = [
    pose.x,
    pose.y,
    pose.heading,
    measured.vx,
    measured.vy,
    measured.omega,
    goal.x,
    goal.y,
    goal.heading,
    goal.translationTolerance,
    goal.rotationTolerance,
    goal.velocityTolerance,
    goal.settleTime,
    goal.handoffRadius,
    prior.vx,
    prior.vy,
    prior.omega,
    prior.settled,
    dt,
    ...Object.values(c),
  ];
  if (
    values.some((v) => !Number.isFinite(v)) ||
    dt <= 0 ||
    dt > 0.1 ||
    Object.values(c).some((v) => v <= 0) ||
    goal.translationTolerance <= 0 ||
    goal.rotationTolerance <= 0 ||
    goal.velocityTolerance <= 0 ||
    goal.settleTime < 0 ||
    goal.handoffRadius < 0 ||
    (goal.headingMode === "pointAt" &&
      (!Number.isFinite(goal.aimX) || !Number.isFinite(goal.aimY)))
  )
    return invalid();
  const dx = goal.x - pose.x,
    dy = goal.y - pose.y,
    distance = Math.hypot(dx, dy);
  const desiredHeading =
    goal.headingMode === "pointAt"
      ? Math.atan2(
          (goal.aimY ?? goal.y) - pose.y,
          (goal.aimX ?? goal.x) - pose.x,
        )
      : goal.headingMode === "motion" && distance > goal.translationTolerance
        ? Math.atan2(dy, dx)
        : goal.heading;
  const angle =
    goal.headingMode === "free" ? 0 : wrap(desiredHeading - pose.heading);
  if (!Number.isFinite(distance) || !Number.isFinite(angle)) return invalid();
  const handoff = goal.handoffRadius > 0;
  const inPose =
    distance <= (handoff ? goal.handoffRadius : goal.translationTolerance) &&
    Math.abs(angle) <= goal.rotationTolerance;
  const slow =
    Math.hypot(measured.vx, measured.vy) <= goal.velocityTolerance &&
    (goal.headingMode === "free" ||
      Math.abs(measured.omega) <= goal.velocityTolerance);
  const settled = inPose && (handoff || slow) ? prior.settled + dt : 0;
  const reached = inPose && (handoff || (slow && settled >= goal.settleTime));
  if (reached && !handoff)
    return {
      command: { vx: 0, vy: 0, omega: 0 },
      state: { vx: 0, vy: 0, omega: 0, settled },
      reached,
      valid: true,
    };
  const speed = handoff
    ? c.maxVelocity
    : Math.min(
        c.maxVelocity,
        c.translationKp * distance,
        Math.sqrt(
          2 *
            c.maxAcceleration *
            Math.max(0, distance - goal.translationTolerance / 2),
        ),
      );
  let vx = distance > 1e-9 ? (speed * dx) / distance : 0,
    vy = distance > 1e-9 ? (speed * dy) / distance : 0;
  const change = Math.hypot(vx - prior.vx, vy - prior.vy),
    maxChange = c.maxAcceleration * dt;
  if (change > maxChange) {
    vx = prior.vx + ((vx - prior.vx) * maxChange) / change;
    vy = prior.vy + ((vy - prior.vy) * maxChange) / change;
  }
  const angularSpeed = Math.min(
    c.maxAngularVelocity,
    c.rotationKp * Math.abs(angle),
    Math.sqrt(2 * c.maxAngularAcceleration * Math.abs(angle)),
  );
  const desired = Math.sign(angle) * angularSpeed;
  const omega =
    prior.omega +
    Math.max(
      -c.maxAngularAcceleration * dt,
      Math.min(c.maxAngularAcceleration * dt, desired - prior.omega),
    );
  if (![vx, vy, omega].every(Number.isFinite)) return invalid();
  return {
    command: { vx, vy, omega },
    state: { vx, vy, omega, settled },
    reached,
    valid: true,
  };
}
export interface TraceEvent {
  time: number;
  kind: "enter" | "transition" | "failure" | "complete";
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
    controller: { vx: 0, vy: 0, omega: 0, settled: 0 },
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
  if (node.kind === "pose" && node.goal) {
    const result = control(
      frame.pose,
      frame.velocity,
      node.goal,
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
    next.controller = result.state;
    next.reached = result.reached;
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
      // Preserve velocity across intermediate pose handoffs, reset arrival settling.
      next.controller = { ...next.velocity, settled: 0 };
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
