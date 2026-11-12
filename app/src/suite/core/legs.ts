import type { AutoRoutine, SuiteProject } from "./model.ts";
import { routeSegments } from "./routes.ts";
import { isIntermediate } from "./runtime.ts";
/** A run of pose steps the robot drives without stopping; the last one is where it stops. */
export interface Leg {
  /** Id of the leg's last pose step, stable while earlier legs are edited. */
  id: string;
  nodeIds: string[];
  name: string;
}
/**
 * Split a routine into legs at every pose step the robot stops on (or that
 * hands off to an action), in driving order. Branches start a new leg.
 */
export function routineLegs(project: SuiteProject, routine: AutoRoutine): Leg[] {
  const next = new Map<string, string[]>();
  for (const s of routeSegments(project, routine)) {
    const from = s.fromId ?? "@start";
    next.set(from, [...(next.get(from) ?? []), s.toId]);
  }
  const order: string[] = [],
    seen = new Set<string>();
  const visit = (id: string) => {
    for (const to of next.get(id) ?? [])
      if (!seen.has(to)) {
        seen.add(to);
        order.push(to);
        visit(to);
      }
  };
  visit("@start");
  for (const n of routine.nodes)
    if (n.kind === "pose" && n.goal && !seen.has(n.id)) {
      seen.add(n.id);
      order.push(n.id);
    }
  const nodes = new Map(routine.nodes.map((n) => [n.id, n]));
  const legs: Leg[] = [];
  let current: string[] = [];
  order.forEach((id, i) => {
    current.push(id);
    const following = order[i + 1];
    if (
      !isIntermediate(routine, nodes.get(id)!) ||
      following === undefined ||
      !(next.get(id) ?? []).includes(following)
    ) {
      legs.push({ id, nodeIds: current, name: nodes.get(id)!.name });
      current = [];
    }
  });
  return legs;
}
