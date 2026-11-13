/**
 * Autonomous routine differences between two revisions of the robot's Mayhem project, with the
 * path each version drives in Mayhem's path preview (the same follower the robot runs), so old and
 * new can be drawn over each other on the field.
 */
import { formatCondition } from "../authoring.ts";
import { parseProject, type AutoNode, type AutoRoutine, type Pose, type SuiteProject } from "../model.ts";
import { simulate } from "../runtime.ts";

export interface DrivenPath {
  status: "running" | "completed" | "failed";
  /** Seconds until the preview finished (or stopped). */
  time: number;
  /** Meters driven. */
  distance: number;
  /** Every ~0.1 s: x, y, heading. */
  poses: Pose[];
  end: Pose;
}

export interface StepChange {
  id: string;
  name: string;
  kind: "added" | "removed" | "changed";
  /** Plain descriptions: `moved 0.42 m`, `heading 90° → 120°`, `action intake → shoot`. */
  details: string[];
}

export interface RoutineDiff {
  id: string;
  name: string;
  kind: "added" | "removed" | "changed" | "same";
  steps: StepChange[];
  before?: DrivenPath;
  after?: DrivenPath;
  /** Start pose moved this far (m). */
  startMoved?: number;
}

const deg = (r: number) => Math.round((r * 180) / Math.PI);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function drivenPath(project: SuiteProject, routine: AutoRoutine): DrivenPath | undefined {
  try {
    const result = simulate(project, routine, {}, { mode: "path", maxSeconds: 60 });
    const poses: Pose[] = [];
    let distance = 0;
    result.frames.forEach((f, i) => {
      if (i) distance += dist(f.pose, result.frames[i - 1].pose);
      if (i % 5 === 0 || i === result.frames.length - 1) poses.push({ x: f.pose.x, y: f.pose.y, heading: f.pose.heading });
    });
    return { status: result.status, time: result.frame.time, distance, poses, end: result.frame.pose };
  } catch {
    return undefined;
  }
}

function stepDetails(a: AutoNode, b: AutoNode): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`renamed "${a.name}" → "${b.name}"`);
  if (a.kind !== b.kind) out.push(`type ${a.kind} → ${b.kind}`);
  if (a.goal && b.goal) {
    const moved = dist(a.goal, b.goal);
    if (moved > 0.005) out.push(`target moved ${moved.toFixed(2)} m`);
    if (Math.abs(deg(a.goal.heading) - deg(b.goal.heading)) >= 1) out.push(`heading ${deg(a.goal.heading)}° → ${deg(b.goal.heading)}°`);
    if ((a.goal.headingMode ?? "fixed") !== (b.goal.headingMode ?? "fixed")) out.push(`heading mode ${a.goal.headingMode ?? "fixed"} → ${b.goal.headingMode ?? "fixed"}`);
    const tolerance = (g: typeof a.goal) => JSON.stringify([g.translationTolerance, g.rotationTolerance, g.velocityTolerance, g.settleTime, g.handoffRadius, g.stop]);
    if (tolerance(a.goal) !== tolerance(b.goal)) out.push("arrival tolerance changed");
  }
  if ((a.action ?? "") !== (b.action ?? "")) out.push(`action ${a.action ?? "none"} → ${b.action ?? "none"}`);
  if (a.timeout !== b.timeout) out.push(`time limit ${a.timeout} s → ${b.timeout} s`);
  if ((a.onTimeout ?? "fail") !== (b.onTimeout ?? "fail")) out.push(`when time runs out: ${a.onTimeout ?? "fail"} → ${b.onTimeout ?? "fail"}`);
  if (JSON.stringify(a.constraints ?? {}) !== JSON.stringify(b.constraints ?? {})) out.push("speed limits changed");
  if (JSON.stringify(a.during ?? []) !== JSON.stringify(b.during ?? [])) out.push(`runs alongside: ${(a.during ?? []).join(", ") || "nothing"} → ${(b.during ?? []).join(", ") || "nothing"}`);
  return out;
}

export function diffRoutine(before: { project: SuiteProject; routine: AutoRoutine } | undefined, after: { project: SuiteProject; routine: AutoRoutine } | undefined): RoutineDiff {
  const r = (after ?? before)!.routine;
  const pathBefore = before && drivenPath(before.project, before.routine);
  const pathAfter = after && drivenPath(after.project, after.routine);
  const base = { id: r.id, name: r.name, ...(pathBefore ? { before: pathBefore } : {}), ...(pathAfter ? { after: pathAfter } : {}) };
  if (!before || !after) {
    const kind = before ? "removed" : "added";
    return { ...base, kind, steps: r.nodes.map((n) => ({ id: n.id, name: n.name, kind, details: [] })) };
  }
  const steps: StepChange[] = [];
  const old = new Map(before.routine.nodes.map((n) => [n.id, n]));
  const now = new Map(after.routine.nodes.map((n) => [n.id, n]));
  for (const n of after.routine.nodes) {
    const o = old.get(n.id);
    if (!o) steps.push({ id: n.id, name: n.name, kind: "added", details: [] });
    else {
      const details = stepDetails(o, n);
      const exits = (route: AutoRoutine, id: string) =>
        route.transitions.filter((t) => t.from === id).map((t) => `${t.to}${t.condition.kind === "always" ? "" : ` when ${formatCondition(t.condition)}`}`).join("; ");
      const was = exits(before.routine, n.id),
        is = exits(after.routine, n.id);
      if (was !== is) details.push(`next: ${was || "end"} → ${is || "end"}`);
      if (details.length) steps.push({ id: n.id, name: n.name, kind: "changed", details });
    }
  }
  for (const n of before.routine.nodes) if (!now.has(n.id)) steps.push({ id: n.id, name: n.name, kind: "removed", details: [] });
  const startBefore = before.routine.start ?? before.project.robot.start;
  const startAfter = after.routine.start ?? after.project.robot.start;
  const startMoved = dist(startBefore, startAfter);
  const pathMoved =
    !!pathBefore && !!pathAfter &&
    (Math.abs(pathBefore.time - pathAfter.time) > 0.05 || dist(pathBefore.end, pathAfter.end) > 0.02 || Math.abs(pathBefore.distance - pathAfter.distance) > 0.02);
  const robotChanged = JSON.stringify(before.project.robot.constraints) !== JSON.stringify(after.project.robot.constraints);
  const changed = steps.length > 0 || startMoved > 0.005 || before.routine.name !== after.routine.name || pathMoved || robotChanged ||
    JSON.stringify(before.routine.constraints ?? {}) !== JSON.stringify(after.routine.constraints ?? {});
  return { ...base, kind: changed ? "changed" : "same", steps, ...(startMoved > 0.005 ? { startMoved } : {}) };
}

export function readProject(text: string | undefined): { project?: SuiteProject; error?: string } {
  if (text === undefined) return {};
  try {
    return { project: parseProject(text) };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  }
}

export function diffRoutines(before: string | undefined, after: string | undefined): { routines: RoutineDiff[]; errors: string[]; field?: SuiteProject["field"] } {
  const a = readProject(before),
    b = readProject(after);
  const errors = [a.error && `Before: ${a.error}`, b.error && `After: ${b.error}`].filter(Boolean) as string[];
  const ids = [...new Set([...(b.project?.routines ?? []), ...(a.project?.routines ?? [])].map((r) => r.id))];
  const pick = (p: SuiteProject | undefined, id: string) => {
    const routine = p?.routines.find((r) => r.id === id);
    return p && routine ? { project: p, routine } : undefined;
  };
  return {
    routines: ids.map((id) => diffRoutine(pick(a.project, id), pick(b.project, id))),
    errors,
    ...((b.project ?? a.project) ? { field: (b.project ?? a.project)!.field } : {}),
  };
}
