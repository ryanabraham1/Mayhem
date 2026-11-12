import {
  resolveConstraints,
  resolveNodeConstraints,
  type AutoNode,
  type AutoRoutine,
  type Pose,
  type SuiteProject,
} from "../model.ts";
import type { ControllerState } from "../runtime.ts";
import {
  createPathModel,
  createRotationTarget,
  createTranslationTarget,
  createWaypoint,
  type PathModel,
} from "./model/path";
import { simulatePathWithTrace } from "./sim/simulatePath";
import type { SimulationTraceSample } from "./sim/types";

/** Convert one uninterrupted pose chain into the native editor model.
 * An explicit start waypoint keeps the measured starting heading (otherwise
 * treats its first authored anchor as the start, rather than a target to drive to).
 */
export function previewPath(
  project: SuiteProject,
  nodes: AutoNode[],
  start: Pose,
  routine?: AutoRoutine,
): PathModel {
  const base = resolveConstraints(
    project.robot.constraints,
    routine?.constraints,
  );
  const path = createPathModel({
    path_elements: [
      createWaypoint({
        translation_target: createTranslationTarget({
          x_meters: start.x,
          y_meters: start.y,
        }),
        rotation_target: createRotationTarget({
          rotation_radians: start.heading,
        }),
      }),
    ],
  });
  path.constraints.max_velocity_meters_per_sec = base.maxVelocity;
  path.constraints.max_acceleration_meters_per_sec2 = base.maxAcceleration;
  path.constraints.min_velocity_meters_per_sec = base.minVelocity;
  path.constraints.max_velocity_deg_per_sec =
    (base.maxAngularVelocity * 180) / Math.PI;
  path.constraints.max_acceleration_deg_per_sec2 =
    (base.maxAngularAcceleration * 180) / Math.PI;
  nodes.forEach((node, i) => {
    const g = node.goal!;
    const k = resolveNodeConstraints(project, routine, node);
    for (const m of g.markers ?? []) {
      path.path_elements.push(
        m.kind === "rotation"
          ? createRotationTarget({
              t_ratio: m.t,
              rotation_radians: m.heading,
              profiled_rotation: m.profiled ?? true,
            })
          : { type: "event_trigger", t_ratio: m.t, lib_key: m.key },
      );
    }
    const translation = createTranslationTarget({
      x_meters: g.x,
      y_meters: g.y,
      intermediate_handoff_radius_meters:
        g.handoffRadius > 0 ? g.handoffRadius : k.handoffRadius,
      handoff_mode: g.projectedHandoff ? "progress" : "radius",
    });
    path.path_elements.push(
      g.headingMode === "free"
        ? translation
        : createWaypoint({
            translation_target: translation,
            rotation_target: createRotationTarget({
              rotation_radians: g.heading,
              profiled_rotation: g.profiled ?? true,
            }),
          }),
    );
    // ranged translation constraints select the TARGET anchor ordinal.
    for (const [key, value] of [
      ["max_velocity_meters_per_sec", k.maxVelocity],
      ["min_velocity_meters_per_sec", k.minVelocity],
      ["max_acceleration_meters_per_sec2", k.maxAcceleration],
    ] as const)
      path.ranged_constraints.push({
        key,
        value,
        start_ordinal: i + 2,
        end_ordinal: i + 2,
      });
    // Rotation ranges use rotation-event ordinals, not translation ordinals.
    const firstRotation =
      path.path_elements
        .slice(0, -(1 + (g.markers?.length ?? 0)))
        .filter((e) => e.type === "rotation" || e.type === "waypoint").length +
      1;
    const lastRotation = path.path_elements.filter(
      (e) => e.type === "rotation" || e.type === "waypoint",
    ).length;
    if (lastRotation >= firstRotation)
      for (const [key, value] of [
        ["max_velocity_deg_per_sec", (k.maxAngularVelocity * 180) / Math.PI],
        [
          "max_acceleration_deg_per_sec2",
          (k.maxAngularAcceleration * 180) / Math.PI,
        ],
      ] as const)
        path.ranged_constraints.push({
          key,
          value,
          start_ordinal: firstRotation,
          end_ordinal: lastRotation,
        });
  });
  return path;
}

interface Plan {
  project: SuiteProject;
  routine: AutoRoutine;
  nodes: AutoNode[];
  samples: SimulationTraceSample[];
  markers: { s: number; key: string }[];
  dt: number;
}
interface Cursor {
  plan: Plan;
  index: number;
  previousS: number;
}
// Runtime-only cache: projects and exported traces never acquire simulator internals.
const cursors = new WeakMap<ControllerState, Cursor>();
export interface PreviewTick {
  pose: Pose;
  velocity: { vx: number; vy: number; omega: number };
  state: ControllerState;
  passed: AutoNode[];
  active: AutoNode;
  reached: boolean;
  fired: string[];
}

export function previewTick(
  project: SuiteProject,
  routine: AutoRoutine,
  node: AutoNode,
  pose: Pose,
  prior: ControllerState,
  dt: number,
  initial = false,
): PreviewTick | undefined {
  let cursor = cursors.get(prior);
  if (
    !cursor ||
    cursor.plan.project !== project ||
    cursor.plan.routine !== routine ||
    cursor.plan.dt !== dt
  ) {
    const nodes = [node];
    const seen = new Set([node.id]);
    let current = node;
    while (!current.goal?.stop && nodes.length < 64) {
      const exits = routine.transitions.filter((t) => t.from === current.id);
      if (exits.length !== 1 || exits[0].condition.kind !== "always") break;
      const next = routine.nodes.find((n) => n.id === exits[0].to);
      if (next?.kind !== "pose" || !next.goal || seen.has(next.id)) break;
      nodes.push(next);
      seen.add(next.id);
      current = next;
    }
    // Live aiming and explicit open-ended handoffs are Mayhem extensions, not
    // editor paths. They continue to use the measured-pose controller.
    const finalExits = routine.transitions.filter((t) => t.from === current.id);
    const openEnded =
      !current.goal?.stop &&
      current.goal!.handoffRadius > 0 &&
      (finalExits.length !== 1 || finalExits[0].condition.kind !== "always");
    if (
      nodes.some(
        (n) =>
          !n.goal ||
          (n.goal.headingMode &&
            !["fixed", "free"].includes(n.goal.headingMode)),
      ) ||
      openEnded
    )
      return undefined;
    const path = previewPath(project, nodes, pose, routine);
    const result = simulatePathWithTrace(path, {}, { dt_s: dt });
    let s = 0,
      previous = pose;
    const markers: Plan["markers"] = [];
    for (const n of nodes) {
      const g = n.goal!,
        length = Math.hypot(g.x - previous.x, g.y - previous.y);
      for (const m of g.markers ?? [])
        if (m.kind === "event")
          markers.push({ s: s + m.t * length, key: m.key });
      s += length;
      previous = g;
    }
    cursor = {
      plan: { project, routine, nodes, samples: result.trace, markers, dt },
      index: 1,
      previousS: -1e-9,
    };
  }
  const { plan, previousS } = cursor;
  const index = initial ? 0 : cursor.index;
  const sample = plan.samples[Math.min(index, plan.samples.length - 1)];
  if (!sample) return undefined;
  const active =
    plan.nodes[Math.min(sample.segment_index, plan.nodes.length - 1)];
  const currentIndex = plan.nodes.findIndex((n) => n.id === node.id);
  const activeIndex = plan.nodes.indexOf(active);
  const last = index >= plan.samples.length - 1;
  const settled = last ? prior.settled + dt : 0;
  const state: ControllerState = {
    vx: sample.vx_mps,
    vy: sample.vy_mps,
    omega: sample.omega_radps,
    settled,
  };
  cursors.set(state, {
    plan,
    index: index + 1,
    previousS: initial ? -1e-9 : sample.global_s_m,
  });
  const endNode = plan.nodes.at(-1)!;
  const end = endNode.goal!;
  const rollingEnd =
    resolveNodeConstraints(project, routine, endNode).minVelocity > 0;
  return {
    pose: { x: sample.x_m, y: sample.y_m, heading: sample.theta_rad },
    velocity:
      last && sample.snapped_position && sample.snapped_rotation
        ? { vx: 0, vy: 0, omega: 0 }
        : { vx: state.vx, vy: state.vy, omega: state.omega },
    state,
    passed: plan.nodes.slice(Math.max(0, currentIndex), activeIndex),
    active,
    reached:
      last &&
      sample.snapped_position &&
      (rollingEnd || sample.snapped_rotation) &&
      settled + 1e-9 >= end.settleTime,
    fired: plan.markers
      .filter((m) => m.s > previousS && m.s <= sample.global_s_m + 1e-9)
      .map((m) => m.key),
  };
}
