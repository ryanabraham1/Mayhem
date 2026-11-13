import type { AutoNode, AutoRoutine } from "../core/model.ts";

/** A run of pass-through pose steps shown as one "Drive path" card. */
export interface PathRun {
  id: string;
  nodes: AutoNode[];
  /** Path length through the goals, meters. */
  length: number;
}
export const PATH_PREFIX = "@path:";

/**
 * A pass-through pose: drives on to the next step on its own (one unconditional exit, one way
 * in), carries no event marker, `during` action, stop or settle. Steps that do something
 * (markers, actions, stops, branches) stay their own cards.
 */
function passThrough(n: AutoNode, r: AutoRoutine) {
  const out = r.transitions.filter((t) => t.from === n.id);
  const into = r.transitions.filter((t) => t.to === n.id);
  const g = n.goal;
  return (
    n.kind === "pose" &&
    !!g &&
    !g.stop &&
    !(g.settleTime > 0) &&
    !g.markers?.length &&
    !n.during?.length &&
    out.length === 1 &&
    out[0].condition.kind === "always" &&
    into.length <= 1
  );
}

/**
 * The routine as the graph shows it: each run of 2+ consecutive pass-through poses becomes one
 * path node (unless expanded). The project's nodes are unchanged; this is only the view.
 */
export function collapsePaths(r: AutoRoutine, expanded: Set<string>) {
  const runs = new Map<string, PathRun>();
  const runOf = new Map<string, string>();
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const next = (id: string) => r.transitions.find((t) => t.from === id)?.to;
  const seen = new Set<string>();
  for (const n of r.nodes) {
    if (seen.has(n.id) || !passThrough(n, r)) continue;
    // Only start a run where the previous step is not itself a pass-through link of this chain.
    const prev = r.transitions.find((t) => t.to === n.id)?.from;
    if (prev && passThrough(byId.get(prev)!, r) && !seen.has(prev)) continue;
    const run: AutoNode[] = [];
    for (let id: string | undefined = n.id; id && byId.has(id) && !seen.has(id); id = next(id)) {
      const node = byId.get(id)!;
      if (!passThrough(node, r)) {
        // The step a run drives into (e.g. the stop at its end) closes the path; keep it separate.
        break;
      }
      run.push(node);
      seen.add(id);
    }
    if (run.length < 2) continue;
    const id = PATH_PREFIX + run[0].id;
    if (expanded.has(id)) continue;
    let length = 0;
    for (let i = 1; i < run.length; i++)
      length += Math.hypot(run[i].goal!.x - run[i - 1].goal!.x, run[i].goal!.y - run[i - 1].goal!.y);
    runs.set(id, { id, nodes: run, length });
    for (const node of run) runOf.set(node.id, id);
  }
  if (!runs.size) return { graph: r, runs, runOf };
  const view = (id: string) => runOf.get(id) ?? id;
  const nodes: AutoNode[] = [];
  for (const n of r.nodes) {
    const run = runOf.get(n.id);
    if (!run) nodes.push(n);
    else if (runs.get(run)!.nodes[0] === n)
      nodes.push({ ...n, id: run, name: "Drive path", kind: "pose" });
  }
  const transitions = r.transitions
    .filter((t) => !(runOf.has(t.from) && runOf.get(t.from) === runOf.get(t.to)))
    .map((t) => ({ ...t, from: view(t.from), to: view(t.to) }));
  return { graph: { ...r, initial: view(r.initial), nodes, transitions }, runs, runOf };
}

/** Node order along a routine that is a single chain from its initial step, else undefined. */
export function chainOrder(r: AutoRoutine): string[] | undefined {
  if (r.transitions.length !== r.nodes.length - 1) return undefined;
  const order: string[] = [];
  for (let id: string | undefined = r.initial; id && !order.includes(id); id = r.transitions.find((t) => t.from === id)?.to)
    order.push(id);
  return order.length === r.nodes.length && r.transitions.every((t) => order.indexOf(t.to) === order.indexOf(t.from) + 1)
    ? order
    : undefined;
}
