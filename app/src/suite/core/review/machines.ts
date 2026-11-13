/**
 * State machine differences between two revisions of `tools/mayhem/machines.json` (the specs the
 * robot's C++ machines are generated from), plus one merged machine to draw them in a single graph.
 */
import { formatCondition, machineFromSpec, type MachineSpec } from "../authoring.ts";
import type { MachineManifest } from "../machines.ts";
import { leavesState, type Transition } from "../model.ts";

export type Mark = "added" | "removed" | "changed";

export interface StateChange {
  id: string;
  name: string;
  kind: Mark;
  /** What changed on a kept state: `name`, `description`. */
  fields: string[];
}

export interface TransitionChange {
  /** `FROM -> TO #n` (the n-th transition between the same pair). */
  key: string;
  kind: Mark;
  from: string;
  to: string;
  before?: string;
  after?: string;
  nameBefore?: string;
  nameAfter?: string;
  /** Checked earlier or later than before among the transitions leaving the same state. */
  priority?: { before: number; after: number };
  /** The condition reads a driver input. */
  driver: boolean;
}

export interface InputChange {
  key: string;
  kind: Mark;
  category: string;
  before?: string;
  after?: string;
}

export interface MachineDiff {
  id: string;
  name: string;
  kind: Mark | "same";
  states: StateChange[];
  transitions: TransitionChange[];
  inputs: InputChange[];
  /** Driver (operator) inputs or the transitions they trigger changed. */
  controls: boolean;
  /** Union of both revisions for one graph; removed transitions have ids `removed:<id>`. */
  merged?: MachineManifest;
  marks: { states: Record<string, Mark>; edges: Record<string, Mark> };
  error?: string;
}

export function parseMachineSpecs(text: string | undefined): { machines: MachineManifest[]; error?: string } {
  if (text === undefined) return { machines: [] };
  try {
    const value = JSON.parse(text);
    const specs: MachineSpec[] = Array.isArray(value) ? value : Array.isArray(value?.machines) ? value.machines : [value];
    return { machines: specs.map(machineFromSpec) };
  } catch (e) {
    return { machines: [], error: (e as Error).message };
  }
}

const keyed = (m: MachineManifest) => {
  const count = new Map<string, number>();
  return m.transitions.map((t) => {
    const pair = `${t.from} -> ${t.to}`;
    const n = (count.get(pair) ?? 0) + 1;
    count.set(pair, n);
    return { key: n > 1 ? `${pair} #${n}` : pair, t };
  });
};

const conditionText = (t: Transition) =>
  `${formatCondition(t.condition)}${t.except?.length ? ` (except ${t.except.join(", ")})` : ""}`;

/** Position of each transition among those checked when leaving each state (priority order). */
function priorities(m: MachineManifest) {
  const out = new Map<string, number>();
  const rows = keyed(m);
  for (const state of m.states)
    rows.filter(({ t }) => leavesState(t, state.id)).forEach(({ key }, k) => out.set(`${state.id}\u0000${key}`, k));
  return out;
}

export function diffMachine(before: MachineManifest | undefined, after: MachineManifest | undefined): MachineDiff {
  const m = (after ?? before)!;
  const marks: MachineDiff["marks"] = { states: {}, edges: {} };
  if (!before || !after) {
    const kind: Mark = before ? "removed" : "added";
    for (const s of m.states) marks.states[s.id] = kind;
    for (const t of m.transitions) marks.edges[t.id] = kind;
    const driver = m.inputs.some((i) => i.category === "operator");
    return {
      id: m.id,
      name: m.name,
      kind,
      states: m.states.map((s) => ({ id: s.id, name: s.name, kind, fields: [] })),
      transitions: keyed(m).map(({ key, t }) => ({ key, kind, from: t.from, to: t.to, [before ? "before" : "after"]: conditionText(t), driver: false })),
      inputs: m.inputs.map((i) => ({ key: i.key, kind, category: i.category ?? "", [before ? "before" : "after"]: i.name })),
      controls: driver,
      merged: m,
      marks,
    };
  }
  const operator = new Set([...before.inputs, ...after.inputs].filter((i) => i.category === "operator").map((i) => i.key));
  const readsDriver = (t?: Transition) => !!t && JSON.stringify(t.condition).match(/"key":"([^"]+)"/g)?.some((k) => operator.has(k.slice(7, -1))) === true;

  const states: StateChange[] = [];
  const oldStates = new Map(before.states.map((s) => [s.id, s]));
  const newStates = new Map(after.states.map((s) => [s.id, s]));
  for (const s of after.states) {
    const o = oldStates.get(s.id);
    if (!o) states.push({ id: s.id, name: s.name, kind: "added", fields: [] });
    else {
      const fields = (["name", "description"] as const).filter((f) => (o[f] ?? "") !== (s[f] ?? ""));
      if (fields.length) states.push({ id: s.id, name: s.name, kind: "changed", fields });
    }
  }
  for (const s of before.states) if (!newStates.has(s.id)) states.push({ id: s.id, name: s.name, kind: "removed", fields: [] });

  const transitions: TransitionChange[] = [];
  const oldRows = new Map(keyed(before).map((r) => [r.key, r.t]));
  const newRows = new Map(keyed(after).map((r) => [r.key, r.t]));
  const oldOrder = priorities(before),
    newOrder = priorities(after);
  for (const [key, t] of newRows) {
    const o = oldRows.get(key);
    const driver = readsDriver(t) || readsDriver(o);
    if (!o) {
      transitions.push({ key, kind: "added", from: t.from, to: t.to, after: conditionText(t), nameAfter: t.name, driver });
      marks.edges[t.id] = "added";
      continue;
    }
    const moved = [...newOrder.keys()]
      .filter((k) => k.endsWith(`\u0000${key}`))
      .map((k) => ({ before: oldOrder.get(k), after: newOrder.get(k)! }))
      .find((p) => p.before !== undefined && p.before !== p.after);
    const textChanged = conditionText(o) !== conditionText(t) || (o.name ?? "") !== (t.name ?? "");
    if (textChanged || moved) {
      transitions.push({
        key,
        kind: "changed",
        from: t.from,
        to: t.to,
        before: conditionText(o),
        after: conditionText(t),
        nameBefore: o.name,
        nameAfter: t.name,
        ...(moved ? { priority: { before: moved.before!, after: moved.after } } : {}),
        driver,
      });
      marks.edges[t.id] = "changed";
    }
  }
  const removedEdges: Transition[] = [];
  for (const [key, o] of oldRows)
    if (!newRows.has(key)) {
      transitions.push({ key, kind: "removed", from: o.from, to: o.to, before: conditionText(o), nameBefore: o.name, driver: readsDriver(o) });
      removedEdges.push({ ...o, id: `removed:${o.id}` });
      marks.edges[`removed:${o.id}`] = "removed";
    }

  const inputs: InputChange[] = [];
  const oldInputs = new Map(before.inputs.map((i) => [i.key, i]));
  const newInputs = new Map(after.inputs.map((i) => [i.key, i]));
  for (const i of after.inputs) {
    const o = oldInputs.get(i.key);
    if (!o) inputs.push({ key: i.key, kind: "added", category: i.category ?? "", after: i.name });
    else if (o.name !== i.name || o.category !== i.category || o.type !== i.type)
      inputs.push({ key: i.key, kind: "changed", category: i.category ?? "", before: o.name, after: i.name });
  }
  for (const i of before.inputs) if (!newInputs.has(i.key)) inputs.push({ key: i.key, kind: "removed", category: i.category ?? "", before: i.name });

  for (const s of states) marks.states[s.id] = s.kind;
  const merged: MachineManifest = {
    ...after,
    states: [...after.states, ...before.states.filter((s) => !newStates.has(s.id))],
    transitions: [...after.transitions, ...removedEdges],
    inputs: [...after.inputs, ...before.inputs.filter((i) => !newInputs.has(i.key))],
  };
  const changed = states.length + transitions.length + inputs.length > 0 || before.name !== after.name || before.initial !== after.initial;
  return {
    id: after.id,
    name: after.name,
    kind: changed ? "changed" : "same",
    states,
    transitions,
    inputs,
    controls: inputs.some((i) => i.category === "operator") || transitions.some((t) => t.driver),
    merged,
    marks,
  };
}

export function diffMachines(before: string | undefined, after: string | undefined): { machines: MachineDiff[]; errors: string[] } {
  const a = parseMachineSpecs(before),
    b = parseMachineSpecs(after);
  const errors = [a.error && `Before: ${a.error}`, b.error && `After: ${b.error}`].filter(Boolean) as string[];
  const ids = [...new Set([...b.machines.map((m) => m.id), ...a.machines.map((m) => m.id)])];
  return {
    machines: ids.map((id) => diffMachine(a.machines.find((m) => m.id === id), b.machines.find((m) => m.id === id))),
    errors,
  };
}
