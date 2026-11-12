import { previewPath } from "./preview.ts";
import type { AutoNode, AutoRoutine, SuiteProject } from "../model.ts";
import { autoRadiiCapSolveInput } from "./constraints/autoConstraintGeneration";
import type { PathModel } from "./model/path";

/** Manual inputs only. Generated outputs must not make themselves stale. */
export function constraintSignature(
  project: SuiteProject,
  routine: AutoRoutine,
): string {
  return JSON.stringify({
    robot: project.robot,
    start: routine.start,
    constraints: routine.constraints,
    initial: routine.initial,
    nodes: routine.nodes.map(({ id, kind, goal, constraints }) => ({
      id,
      kind,
      goal,
      constraints,
    })),
    transitions: routine.transitions,
  });
}
export interface GeneratedLimit {
  id: string;
  maxVelocity?: number;
  handoffRadius?: number;
}
export interface GeneratedResult {
  signature: string;
  status: "valid" | "best-effort" | "unsolvable";
  limits: GeneratedLimit[];
}

/** Each uninterrupted pose chain is generated independently; actions and stops
 * are true path boundaries, so the generator cannot cut through a stopped action. */
export function generateConstraints(
  project: SuiteProject,
  routine: AutoRoutine,
): GeneratedResult {
  const next = (n: AutoNode) => {
    if (n.goal?.stop) return undefined;
    const edges = routine.transitions.filter((t) => t.from === n.id);
    if (edges.length !== 1 || edges[0].condition.kind !== "always")
      return undefined;
    return routine.nodes.find(
      (other) => other.id === edges[0].to && other.kind === "pose",
    );
  };
  const poses = routine.nodes.filter((n) => n.kind === "pose" && n.goal);
  const predecessors = new Set(poses.map((n) => next(n)?.id).filter(Boolean));
  const ordered = [
    ...poses.filter((n) => !predecessors.has(n.id)),
    ...poses.filter((n) => predecessors.has(n.id)),
  ];
  const visited = new Set<string>();
  const limits: GeneratedLimit[] = [];
  let status: GeneratedResult["status"] = "valid";
  for (const first of ordered) {
    if (visited.has(first.id)) continue;
    const nodes: AutoNode[] = [];
    let current: AutoNode | undefined = first;
    while (current && !visited.has(current.id)) {
      nodes.push(current);
      visited.add(current.id);
      current = next(current);
    }
    if (
      nodes.some(
        (n) =>
          n.goal?.headingMode === "motion" || n.goal?.headingMode === "pointAt",
      )
    )
      throw new Error(
        "Use fixed or translation-only headings to generate constraints.",
      );
    const queue = [first.id];
    const seen = new Set(queue);
    let previous: AutoNode | undefined;
    while (queue.length && !previous) {
      const id = queue.shift()!;
      for (const t of routine.transitions.filter((t) => t.to === id)) {
        const n = routine.nodes.find((n) => n.id === t.from);
        if (n?.goal) {
          previous = n;
          break;
        }
        if (n && !seen.has(n.id)) {
          seen.add(n.id);
          queue.push(n.id);
        }
      }
    }
    const start =
      first.id === routine.initial
        ? (routine.start ?? project.robot.start)
        : (previous?.goal ?? routine.start ?? project.robot.start);
    const path = previewPath(project, nodes, start, routine);
    prepareForGeneration(path, nodes);
    const solved = autoRadiiCapSolveInput(
      path,
      {
        gui: {
          robot: {
            length_meters: project.robot.length,
            width_meters: project.robot.width,
            drive_type: "swerve",
          },
        },
      },
      {
        velocitySafetyFactor: 1,
        accelerationSafetyFactor: 1,
        mergeToleranceMps: 0.3,
      },
    );
    if (solved.status === "unsolvable") status = "unsolvable";
    else if (solved.status === "best-effort" && status === "valid")
      status = "best-effort";
    const anchors = solved.path.path_elements
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "translation" || e.type === "waypoint");
    nodes.forEach((n, i) => {
      const cap = solved.profile.segmentCaps.find(
        (c) => c.targetOrdinal === i + 2,
      );
      const radius = solved.radii.find(
        (r) => r.elementIndex === anchors[i + 1]?.i,
      )?.radiusMeters;
      limits.push({
        id: n.id,
        ...(n.constraints?.maxVelocity === undefined && cap && cap.value > 0
          ? { maxVelocity: cap.value }
          : {}),
        ...(i < nodes.length - 1 && radius && radius > 0
          ? { handoffRadius: radius }
          : {}),
      });
    });
  }
  return { signature: constraintSignature(project, routine), status, limits };
}
function prepareForGeneration(path: PathModel, nodes: AutoNode[]) {
  // Canonicalize degree conversion noise and omit inherited no-op ranges. This
  // presents the same native inputs as authoring these limits by hand.
  for (const key of [
    "max_velocity_deg_per_sec",
    "max_acceleration_deg_per_sec2",
  ] as const)
    if (path.constraints[key] !== null)
      path.constraints[key] = Number(path.constraints[key]!.toFixed(10));
  path.ranged_constraints = path.ranged_constraints.filter((c) => {
    if (
      c.key === "max_velocity_deg_per_sec" ||
      c.key === "max_acceleration_deg_per_sec2"
    )
      c.value = Number(c.value.toFixed(10));
    return (
      c.key === "max_velocity_meters_per_sec" ||
      c.value !== path.constraints[c.key]
    );
  });
  path.ranged_constraints = path.ranged_constraints.filter(
    (c) =>
      c.key !== "max_velocity_meters_per_sec" ||
      nodes[c.start_ordinal - 2]?.constraints?.maxVelocity !== undefined,
  );
  let ordinal = -1;
  for (const e of path.path_elements) {
    if (e.type !== "waypoint" && e.type !== "translation") continue;
    const t = e.type === "waypoint" ? e.translation_target : e;
    const node = nodes[ordinal++];
    const manual =
      node &&
      (node.goal!.handoffRadius > 0 ||
        node.constraints?.handoffRadius !== undefined);
    t.handoff_radius_source = manual ? "manual" : "auto";
    if (!manual) t.intermediate_handoff_radius_meters = null;
  }
}
