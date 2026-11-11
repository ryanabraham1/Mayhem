import season from "./rebuilt-2026.json";
import type { AutoRoutine, Pose, SuiteProject } from "./model.ts";
export interface RouteSegment {
  from: Pose;
  to: Pose;
  fromId?: string;
  toId: string;
}
/** Follow graph edges through mechanism states; branches remain separate routes. */
export function routeSegments(
  project: SuiteProject,
  routine: AutoRoutine,
): RouteSegment[] {
  const nodes = new Map(routine.nodes.map((n) => [n.id, n])),
    outgoing = new Map<string, string[]>();
  for (const t of routine.transitions)
    outgoing.set(t.from, [...(outgoing.get(t.from) ?? []), t.to]);
  const result: RouteSegment[] = [],
    seenPairs = new Set<string>();
  const walk = (source: Pose, fromId: string | undefined, starts: string[]) => {
    const visited = new Set<string>(),
      queue = [...starts];
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const n = nodes.get(id);
      if (!n) continue;
      if (n.kind === "pose" && n.goal) {
        const key = `${fromId ?? "@start"}:${id}`;
        if (!seenPairs.has(key)) {
          result.push({ from: source, to: n.goal, fromId, toId: id });
          seenPairs.add(key);
        }
      } else if (n.kind !== "finish") queue.push(...(outgoing.get(id) ?? []));
    }
  };
  walk(routine.start ?? project.robot.start, undefined, [routine.initial]);
  for (const n of routine.nodes)
    if (n.kind === "pose" && n.goal)
      walk(n.goal, n.id, outgoing.get(n.id) ?? []);
  return result;
}
export interface RouteWarning {
  nodeId: string;
  message: string;
}
export function routeWarnings(
  project: SuiteProject,
  routine: AutoRoutine,
): RouteWarning[] {
  if (
    Math.abs(project.field.width - season.length) > 0.05 ||
    Math.abs(project.field.height - season.width) > 0.05
  )
    return [];
  const radius =
    Math.hypot(project.robot.length, project.robot.width) / 2 + 0.03;
  const blocked = (
    a: Pose,
    b: Pose,
    box: { minX: number; maxX: number; minY: number; maxY: number },
  ) => {
    let lower = 0,
      upper = 1;
    for (const [origin, delta, min, max] of [
      [a.x, b.x - a.x, box.minX, box.maxX],
      [a.y, b.y - a.y, box.minY, box.maxY],
    ]) {
      if (Math.abs(delta) < 1e-10) {
        if (origin < min || origin > max) return false;
        continue;
      }
      const u = (min - origin) / delta,
        v = (max - origin) / delta;
      lower = Math.max(lower, Math.min(u, v));
      upper = Math.min(upper, Math.max(u, v));
      if (lower > upper) return false;
    }
    return true;
  };
  const warnings: RouteWarning[] = [];
  for (const segment of routeSegments(project, routine))
    for (const obstacle of season.obstacles.filter((o) => o.enabled)) {
      const points = obstacle.points;
      if (!points.length) continue;
      const box = {
        minX: Math.min(...points.map((p) => p[0])) - radius,
        maxX: Math.max(...points.map((p) => p[0])) + radius,
        minY: Math.min(...points.map((p) => p[1])) - radius,
        maxY: Math.max(...points.map((p) => p[1])) + radius,
      };
      if (blocked(segment.from, segment.to, box))
        warnings.push({
          nodeId: segment.toId,
          message: `Route to ${routine.nodes.find((n) => n.id === segment.toId)?.name} is close to ${obstacle.name}. Check the robot footprint and approach.`,
        });
    }
  return warnings;
}
