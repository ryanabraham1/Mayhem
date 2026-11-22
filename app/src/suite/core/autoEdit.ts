/**
 * Small, targeted edits to autos for agents: set one field, move a goal, insert or remove a step
 * (exits rewired), or create a routine from a list of points, instead of rewriting the whole
 * project. Pure: returns the edited copy and what changed; the caller validates and saves.
 */
import type { AutoNode, AutoRoutine, Goal, Pose, SuiteProject, Transition } from "./model.ts";
import { validateProject } from "./model.ts";

/** A step in shorthand: `x`/`y`/`heading` (and `stop`, `markers`, …) make a pose step. */
export type StepSpec = Partial<Omit<AutoNode, "goal">> & {
  id: string;
  x?: number; y?: number; heading?: number;
  stop?: boolean;
  goal?: Partial<Goal>;
  markers?: Goal["markers"];
  headingMode?: Goal["headingMode"];
};
export type AutoEditOp =
  | { set: string; value: unknown }
  | { move: string; x?: number; y?: number; heading?: number }
  | { insert: StepSpec; after?: string; before?: string; exit?: string }
  | { remove: string }
  | { create: { id: string; name?: string; start?: Pose; steps: StepSpec[]; finish?: boolean; constraints?: AutoRoutine["constraints"] } };

const DEG = Math.PI / 180;

/** A full pose goal from shorthand; tolerances follow BLine (end 0.03 m / 2°, pass-through 0.1 m / 5°). */
function goalFrom(spec: StepSpec, final: boolean, like?: Goal): Goal {
  const stop = spec.stop ?? spec.goal?.stop ?? final;
  const base: Goal = {
    x: 0, y: 0, heading: 0,
    translationTolerance: stop ? 0.03 : 0.1,
    rotationTolerance: stop ? 2 * DEG : 5 * DEG,
    velocityTolerance: like?.velocityTolerance ?? 0.1,
    settleTime: stop ? (like?.settleTime ?? 0) : 0,
    handoffRadius: 0,
    headingMode: "fixed",
    profiled: true,
  };
  const goal: Goal = { ...base, ...(spec.goal ?? {}) } as Goal;
  if (spec.x !== undefined) goal.x = spec.x;
  if (spec.y !== undefined) goal.y = spec.y;
  if (spec.heading !== undefined) goal.heading = spec.heading;
  if (spec.headingMode) goal.headingMode = spec.headingMode;
  if (spec.markers) goal.markers = spec.markers;
  if (stop) goal.stop = true;
  else delete goal.stop;
  return goal;
}

function nodeFrom(spec: StepSpec, final: boolean, like?: AutoNode): AutoNode {
  const { x, y, heading, stop, goal, markers, headingMode, ...rest } = spec;
  const pose = x !== undefined || y !== undefined || goal !== undefined || (rest.kind ?? "pose") === "pose";
  const kind = rest.kind ?? (pose ? "pose" : "action");
  const node: AutoNode = { name: spec.id, timeout: kind === "finish" ? 1 : 5, ...rest, id: spec.id, kind } as AutoNode;
  if (kind === "pose") {
    if ((x === undefined || y === undefined) && (goal?.x === undefined || goal?.y === undefined))
      throw new Error(`Step ${spec.id}: a pose step needs x and y.`);
    node.goal = goalFrom(spec, final, like?.goal);
  }
  return node;
}

const findRoutine = (p: SuiteProject, id: string | undefined) => {
  const r = id ? p.routines.find((r) => r.id === id) : p.routines[0];
  if (!r) throw new Error(`Routine ${id ?? "(first)"} does not exist. Routines: ${p.routines.map((r) => r.id).join(", ") || "none"}.`);
  return r;
};

function findStep(routine: AutoRoutine, id: string): AutoNode {
  const n = routine.nodes.find((n) => n.id === id);
  if (!n) throw new Error(`Routine ${routine.id} has no step ${id}. Steps: ${routine.nodes.map((n) => n.id).join(", ")}.`);
  return n;
}
function ownStep(routine: AutoRoutine, id: string): AutoNode {
  const n = findStep(routine, id);
  if (n.fromGroup)
    throw new Error(`Step ${id} is produced by use "${n.fromGroup.use}" of a step group, and is regenerated from it: set "use:${n.fromGroup.use}.args.<param>" for a value that comes from a parameter, or "group:<group id>.nodes.${n.fromGroup.node}.<field>" to change every use.`);
  return n;
}

/** Walk `path` (dot-separated; an array segment is an index or an element `id`), creating objects. */
function setPath(root: Record<string, unknown>, path: string[], value: unknown, label: string) {
  let at: unknown = root;
  for (let k = 0; k < path.length; k++) {
    const seg = path[k], last = k === path.length - 1;
    if (Array.isArray(at)) {
      const i = /^\d+$/.test(seg) ? Number(seg) : at.findIndex((e) => e && typeof e === "object" && (e as { id?: string }).id === seg);
      if (i < 0 || i > at.length || (i === at.length && !last)) throw new Error(`${label}: no element "${seg}".`);
      if (last) {
        if (value === null) at.splice(i, 1);
        else at[i] = value;
        return;
      }
      at = at[i];
      continue;
    }
    if (!at || typeof at !== "object") throw new Error(`${label}: "${path.slice(0, k).join(".")}" is not an object.`);
    const obj = at as Record<string, unknown>;
    if (last) {
      if (value === null) delete obj[seg];
      else obj[seg] = value;
      return;
    }
    if (obj[seg] === undefined) obj[seg] = {};
    at = obj[seg];
  }
}

/**
 * Apply `ops` in order to a copy of `project`. `routine` is the default routine for step ops.
 * Paths for `set`: `<step id>.<field…>` (`pickup.constraints.stopDeceleration`, `pickup.goal.x`),
 * `routine.<field…>`, `robot.<field…>`, `use:<use id>.<field…>`, `group:<group id>.<field…>`.
 * `null` deletes. Throws on the first op that cannot apply or when the result is invalid.
 */
export function editAuto(project: SuiteProject, ops: AutoEditOp[], routineId?: string): { project: SuiteProject; changes: string[]; routines: string[] } {
  if (!Array.isArray(ops) || !ops.length) throw new Error("ops: list at least one edit.");
  const p = structuredClone(project);
  const changes: string[] = [];
  const touched = new Set<string>();
  let current = routineId;
  ops.forEach((op, k) => {
    const label = `ops[${k}]`;
    if ("create" in op) {
      const spec = op.create;
      if (!spec?.id || !Array.isArray(spec.steps) || !spec.steps.length) throw new Error(`${label}: create needs an id and steps.`);
      if (p.routines.some((r) => r.id === spec.id)) throw new Error(`${label}: routine ${spec.id} already exists; edit it instead.`);
      const nodes = spec.steps.map((s, i) => nodeFrom(s, i === spec.steps.length - 1 || (spec.steps[i + 1]?.kind ?? "pose") !== "pose"));
      if (spec.finish !== false) nodes.push({ id: `${spec.id}-done`, name: "Auto complete", kind: "finish", timeout: 1 });
      const transitions: Transition[] = nodes.slice(1).map((n, i) => ({ id: `${spec.id}-t${i + 1}`, from: nodes[i].id, to: n.id, condition: { kind: "always" } }));
      const routine: AutoRoutine = { id: spec.id, name: spec.name ?? spec.id, initial: nodes[0].id, nodes, transitions, ...(spec.start ? { start: spec.start } : {}), ...(spec.constraints ? { constraints: spec.constraints } : {}) };
      p.routines.push(routine);
      current = spec.id;
      touched.add(spec.id);
      changes.push(`Created routine ${spec.id} with ${nodes.length} steps.`);
      return;
    }
    if ("set" in op) {
      if (typeof op.set !== "string" || !op.set) throw new Error(`${label}: set needs a path.`);
      const [head, ...rest] = op.set.split(".");
      if (head === "robot") { setPath(p.robot as unknown as Record<string, unknown>, rest, op.value, label); p.routines.forEach((r) => touched.add(r.id)); }
      else if (head === "routine") { const r = findRoutine(p, current); setPath(r as unknown as Record<string, unknown>, rest, op.value, label); touched.add(r.id); }
      else if (head.startsWith("use:")) {
        const id = head.slice(4);
        const r = p.routines.find((r) => r.uses?.some((u) => u.id === id));
        if (!r) throw new Error(`${label}: no step group use ${id}.`);
        setPath(r.uses!.find((u) => u.id === id) as unknown as Record<string, unknown>, rest, op.value, label);
        touched.add(r.id);
      } else if (head.startsWith("group:")) {
        const g = p.groups?.find((g) => g.id === head.slice(6));
        if (!g) throw new Error(`${label}: no step group ${head.slice(6)}.`);
        setPath(g as unknown as Record<string, unknown>, rest, op.value, label);
        p.routines.filter((r) => r.uses?.some((u) => u.group === g.id)).forEach((r) => touched.add(r.id));
      } else {
        // Step IDs may contain dots (group uses: "c1.pickup"): the longest matching ID wins.
        const r = findRoutine(p, current);
        const parts = op.set.split(".");
        let n: AutoNode | undefined, at = 0;
        for (let i = parts.length - 1; i >= 1 && !n; i--) { n = r.nodes.find((x) => x.id === parts.slice(0, i).join(".")); at = i; }
        if (!n) throw new Error(`${label}: "${op.set}" does not start with a step of routine ${r.id} (or robot., routine., use:, group:). Steps: ${r.nodes.map((n) => n.id).join(", ")}.`);
        ownStep(r, n.id);
        setPath(n as unknown as Record<string, unknown>, parts.slice(at), op.value, label);
        touched.add(r.id);
      }
      changes.push(`${op.set} = ${op.value === null ? "(removed)" : JSON.stringify(op.value)}`);
      return;
    }
    const r = findRoutine(p, current);
    touched.add(r.id);
    if ("move" in op) {
      const n = ownStep(r, op.move);
      if (n.kind !== "pose" || !n.goal) throw new Error(`${label}: ${op.move} is not a pose step.`);
      for (const key of ["x", "y", "heading"] as const) if (op[key] !== undefined) {
        if (!Number.isFinite(op[key])) throw new Error(`${label}: ${key} must be a number.`);
        n.goal[key] = op[key]!;
      }
      changes.push(`Moved ${op.move} to (${n.goal.x}, ${n.goal.y}, ${n.goal.heading} rad).`);
      return;
    }
    if ("insert" in op) {
      const spec = op.insert;
      if (!spec?.id) throw new Error(`${label}: insert needs a step with an id.`);
      if (r.nodes.some((n) => n.id === spec.id)) throw new Error(`${label}: step ${spec.id} already exists.`);
      if (!!op.after === !!op.before) throw new Error(`${label}: give after or before (a step ID).`);
      const anchor = ownStep(r, (op.after ?? op.before)!);
      if (op.after) {
        // Into one of `after`'s exits: that exit now leads to the new step, which continues to its old target.
        const exits = r.transitions.filter((t) => t.from === anchor.id && (!op.exit || t.id === op.exit));
        if (exits.length !== 1) throw new Error(`${label}: ${anchor.id} has ${exits.length} exits${op.exit ? ` named ${op.exit}` : ""}; name the one to insert into with "exit" (${r.transitions.filter((t) => t.from === anchor.id).map((t) => t.id).join(", ") || "none"}).`);
        const exit = exits[0];
        const targetKind = r.nodes.find((n) => n.id === exit.to)?.kind;
        const node = nodeFrom(spec, targetKind !== "pose", anchor);
        r.nodes.splice(r.nodes.indexOf(anchor) + 1, 0, node);
        const old = exit.to;
        exit.to = node.id;
        r.transitions.push({ id: uniqueId(r, `${node.id}-to-${old}`), from: node.id, to: old, condition: { kind: "always" } });
        // The anchor was the end of its path; it now continues to the new pose step.
        if (anchor.goal?.stop && node.kind === "pose" && spec.stop === undefined && exit.condition.kind === "always" && !anchor.during?.length) {
          changes.push(`Note: ${anchor.id} is still a stop step (goal.stop); set "${anchor.id}.goal.stop" to null to drive through it.`);
        }
        changes.push(`Inserted ${node.id} after ${anchor.id} (into exit ${exit.id}, then on to ${old}).`);
      } else {
        // Before: every way into `before` now goes to the new step, which continues to it.
        const node = nodeFrom(spec, anchor.kind !== "pose", anchor);
        r.nodes.splice(r.nodes.indexOf(anchor), 0, node);
        for (const t of r.transitions) if (t.to === anchor.id) t.to = node.id;
        if (r.initial === anchor.id) r.initial = node.id;
        r.transitions.push({ id: uniqueId(r, `${node.id}-to-${anchor.id}`), from: node.id, to: anchor.id, condition: { kind: "always" } });
        changes.push(`Inserted ${node.id} before ${anchor.id}.`);
      }
      return;
    }
    if ("remove" in op) {
      const n = ownStep(r, op.remove);
      const exits = r.transitions.filter((t) => t.from === n.id);
      const into = r.transitions.filter((t) => t.to === n.id);
      if (exits.length > 1 || (exits.length === 0 && (into.length || r.initial === n.id)))
        throw new Error(`${label}: ${n.id} has ${exits.length} exits; remove only a step with one exit (its callers then go where it went), or rewire with set first.`);
      const next = exits[0]?.to;
      for (const t of into) t.to = next!;
      if (r.initial === n.id) r.initial = next!;
      r.transitions = r.transitions.filter((t) => t.from !== n.id);
      r.nodes = r.nodes.filter((x) => x !== n);
      changes.push(`Removed ${n.id}${next ? `; its ${into.length} incoming exits now go to ${next}` : ""}.`);
      return;
    }
    throw new Error(`${label}: unknown op; use set, move, insert, remove or create.`);
  });
  const errors = validateProject(p).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`The edit makes the project invalid:\n${errors.map((i) => `${i.path}: ${i.message}`).join("\n")}`);
  return { project: p, changes, routines: [...touched] };
}

function uniqueId(r: AutoRoutine, base: string) {
  let id = base, k = 2;
  while (r.transitions.some((t) => t.id === id)) id = `${base}-${k++}`;
  return id;
}
