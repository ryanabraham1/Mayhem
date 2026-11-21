/**
 * Reusable step groups: a project-level template of steps and exits with parameters, used any
 * number of times by a routine (three scoring cycles that differ only in poses and the level).
 *
 * The file stores the template (`project.groups`), each use and its arguments
 * (`routine.uses`), and the steps they produce, written into `routine.nodes` /
 * `routine.transitions` and marked `fromGroup`. Everything downstream (validation, preview,
 * simulate, the C++ exporter, older app versions) reads the produced steps as ordinary ones.
 * The template and arguments are the source: `syncGroups` regenerates the produced steps.
 *
 * In a template any JSON value that is the string "$name" of a declared parameter is replaced
 * by that use's argument (a whole goal, an action ID, a number, the next step's ID).
 */
import type { AutoNode, AutoRoutine, GroupUse, StepGroup, SuiteProject, Transition } from "./model.ts";

type Json = unknown;
const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** Step fields that belong to one use, not the template (constraint generator output). */
const LOCAL_KEYS = new Set(["generatedConstraints"]);

/** ID of the step (or exit) a use produces from the template's `inner` step. */
export const groupStepId = (use: string, inner: string) => `${use}.${inner}`;
const label = (use: GroupUse) => use.name ?? use.id;
/** Name shown for a produced step: "Approach (Cycle 2)". */
const producedName = (name: string, use: GroupUse) => `${name} (${label(use)})`;

const paramOf = (group: StepGroup, value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.startsWith("$")) return undefined;
  const name = value.slice(1);
  return group.params.some((p) => p.name === name) ? name : undefined;
};
/** A use's value for each parameter: its argument, else the parameter's default. */
export function groupArgs(group: StepGroup, use: GroupUse): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const p of group.params) {
    if (use.args && p.name in use.args) out[p.name] = use.args[p.name];
    else if ("default" in p) out[p.name] = p.default;
  }
  return out;
}
function substitute(group: StepGroup, args: Record<string, Json>, value: Json): Json {
  const param = paramOf(group, value);
  if (param !== undefined) return structuredClone(args[param]);
  if (Array.isArray(value)) return value.map((v) => substitute(group, args, v));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(group, args, v)]));
  return value;
}

/** Top-level fields of a template step that hold a parameter (their value differs per use). */
export function groupParamFields(group: StepGroup, template: AutoNode): string[] {
  const holds = (v: Json): boolean =>
    paramOf(group, v) !== undefined || (Array.isArray(v) ? v.some(holds) : isRecord(v) && Object.values(v).some(holds));
  return Object.entries(template).flatMap(([k, v]) => (holds(v) ? [k] : []));
}
/** The steps and exits one use produces. An exit's `to`/`from` naming a step of the group is that use's step. */
export function instantiate(group: StepGroup, use: GroupUse): { nodes: AutoNode[]; transitions: Transition[] } {
  const args = groupArgs(group, use);
  const inner = new Set(group.nodes.map((n) => n.id));
  const endpoint = (template: unknown): Json => {
    const value = substitute(group, args, template);
    return paramOf(group, template) === undefined && typeof value === "string" && inner.has(value) ? groupStepId(use.id, value) : value;
  };
  const nodes = group.nodes.map((n) => {
    const { id, name, ...rest } = n;
    const resolved = substitute(group, args, name);
    return {
      ...(substitute(group, args, rest) as object),
      id: groupStepId(use.id, id),
      name: producedName(typeof resolved === "string" ? resolved : String(id), use),
      fromGroup: { use: use.id, node: id },
    } as AutoNode;
  });
  const transitions = group.transitions.map((t) => {
    const { id, from, to, ...rest } = t;
    return {
      ...(substitute(group, args, rest) as object),
      id: groupStepId(use.id, id),
      from: endpoint(from),
      to: endpoint(to),
      fromGroup: { use: use.id, transition: id },
    } as Transition;
  });
  return { nodes, transitions };
}

/** Replace each produced item in place (keeping its position), append new ones, drop orphans. */
function merge<T extends { id: string; fromGroup?: { use: string } }>(existing: T[], produced: T[], keep: (old: T, next: T) => T): T[] {
  const byId = new Map(produced.map((p) => [p.id, p]));
  const out: T[] = [];
  for (const item of existing) {
    const next = byId.get(item.id);
    if (next) {
      out.push(keep(item, next));
      byId.delete(item.id);
    } else if (!item.fromGroup) out.push(item);
  }
  return [...out, ...byId.values()];
}

/**
 * Regenerate every routine's produced steps and exits from the group templates and each use's
 * arguments (the template wins over whatever the file held for them). Mutates and returns
 * `project`. Uses of unknown groups produce nothing (validateProject reports them).
 */
export function syncGroups<P extends SuiteProject>(project: P): P {
  if (!isRecord(project) || !Array.isArray(project.routines)) return project;
  const groups = new Map<string, StepGroup>();
  for (const g of Array.isArray(project.groups) ? project.groups : [])
    if (isRecord(g) && typeof g.id === "string" && Array.isArray(g.nodes) && Array.isArray(g.transitions) && Array.isArray(g.params))
      groups.set(g.id, g as StepGroup);
  for (const routine of project.routines) {
    if (!isRecord(routine) || !Array.isArray(routine.nodes) || !Array.isArray(routine.transitions)) continue;
    const uses = Array.isArray(routine.uses) ? routine.uses.filter((u) => isRecord(u) && typeof u.id === "string") : [];
    const produced = uses.flatMap((u) => {
      const group = groups.get(u.group);
      try {
        return group ? [instantiate(group, u)] : [];
      } catch {
        return [];
      }
    });
    if (!produced.length && !routine.nodes.some((n) => isRecord(n) && n.fromGroup) && !routine.transitions.some((t) => isRecord(t) && t.fromGroup)) continue;
    const valid = <T,>(items: T[]) => items.filter((i) => isRecord(i) && typeof (i as any).id === "string");
    routine.nodes = [
      ...merge(valid(routine.nodes), produced.flatMap((p) => p.nodes), (old, next) => {
        const local = Object.fromEntries(Object.entries(old).filter(([k]) => LOCAL_KEYS.has(k)));
        return { ...next, ...local };
      }),
      ...routine.nodes.filter((n) => !valid([n]).length),
    ];
    routine.transitions = [
      ...merge(valid(routine.transitions), produced.flatMap((p) => p.transitions), (_old, next) => next),
      ...routine.transitions.filter((t) => !valid([t]).length),
    ];
  }
  return project;
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Fold an edited produced value back into its template: where the template holds a parameter
 * the edit becomes this use's argument, everywhere else it changes the template (all uses).
 */
function fold(group: StepGroup, args: Record<string, Json>, template: Json, actual: Json): Json {
  const param = paramOf(group, template);
  if (param !== undefined) {
    args[param] = structuredClone(actual);
    return template;
  }
  if (isRecord(template) && isRecord(actual))
    return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, k in template ? fold(group, args, template[k], v) : v]));
  if (Array.isArray(template) && Array.isArray(actual) && template.length === actual.length)
    return actual.map((v, i) => fold(group, args, template[i], v));
  return actual;
}
const strip = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);

/**
 * After an edit made directly to produced steps (the app's inspector, a drag on the field):
 * write each change back to its group template or its use's arguments, then regenerate, so the
 * edit shows in every use it belongs to. A produced step that was deleted comes back; remove
 * the use (or detach it) instead. Mutates and returns `project`.
 */
export function reconcileGroups<P extends SuiteProject>(project: P): P {
  if (!project.groups?.length) return syncGroups(project);
  // What every use produced before this edit, so a change to the template made for one use is
  // not mistaken for an edit of the next.
  const pristine = structuredClone(project.groups);
  for (const routine of project.routines) {
    for (const use of routine.uses ?? []) {
      const group: StepGroup | undefined = project.groups.find((g) => g.id === use.group);
      const original = pristine.find((g) => g.id === use.group);
      if (!group || !original) continue;
      const expected = instantiate(original, structuredClone(use));
      const args = { ...use.args };
      let changed = false;
      const inner = new Set(group.nodes.map((n) => n.id));
      for (const want of expected.nodes) {
        const got = routine.nodes.find((n) => n.id === want.id);
        const local = (n: AutoNode) => Object.fromEntries(Object.entries(n).filter(([k]) => !LOCAL_KEYS.has(k)));
        if (!got || same(local(got), local(want))) continue;
        const index = group.nodes.findIndex((n) => n.id === want.fromGroup!.node);
        const template = group.nodes[index];
        const { id: _i, name, fromGroup: _g, ...rest } = local(got) as AutoNode;
        const { id, name: templateName, ...templateRest } = template;
        const suffix = ` (${label(use)})`;
        const renamed = name !== want.name;
        group.nodes[index] = {
          ...(fold(group, args, templateRest, rest) as object),
          id,
          name: renamed ? (fold(group, args, templateName, name.endsWith(suffix) ? name.slice(0, -suffix.length) : name) as string) : templateName,
        } as AutoNode;
        changed = true;
      }
      for (const want of expected.transitions) {
        const got = routine.transitions.find((t) => t.id === want.id);
        if (!got || same(got, want)) continue;
        const index = group.transitions.findIndex((t) => t.id === want.fromGroup!.transition);
        const template = group.transitions[index];
        const { id: _i, from, to, fromGroup: _g, ...rest } = got;
        const { id, from: templateFrom, to: templateTo, ...templateRest } = template;
        // An endpoint inside this use goes back to the template as the group's own step ID.
        const endpoint = (templateValue: string, value: string) => {
          if (paramOf(group, templateValue) !== undefined) return fold(group, args, templateValue, value) as string;
          const own = strip(value, `${use.id}.`);
          return own !== value && inner.has(own) ? own : value;
        };
        group.transitions[index] = {
          ...(fold(group, args, templateRest, rest) as object),
          id,
          from: endpoint(templateFrom, from),
          to: endpoint(templateTo, to),
        } as Transition;
        changed = true;
      }
      if (changed) use.args = args;
    }
  }
  return syncGroups(project);
}

/** Add another use of a group to a routine, with the arguments of `like` (or the defaults). */
export function addGroupUse(project: SuiteProject, routine: AutoRoutine, groupId: string, like?: GroupUse): GroupUse {
  const taken = new Set([...(routine.uses ?? []).map((u) => u.id), ...routine.nodes.map((n) => n.id.split(".")[0])]);
  let n = (routine.uses ?? []).filter((u) => u.group === groupId).length + 1;
  while (taken.has(`${groupId}${n}`)) n++;
  const group = project.groups?.find((g) => g.id === groupId);
  const use: GroupUse = {
    id: `${groupId}${n}`,
    group: groupId,
    name: `${group?.name ?? groupId} ${n}`,
    args: structuredClone(like?.args ?? {}),
  };
  routine.uses = [...(routine.uses ?? []), use];
  syncGroups(project);
  return use;
}
/**
 * Remove a use, its steps and every exit that touches them. Another use whose argument named
 * one of its steps (the cycle before it) continues to where the removed use led.
 */
export function removeGroupUse(project: SuiteProject, routine: AutoRoutine, useId: string) {
  const ids = new Set(routine.nodes.filter((n) => n.fromGroup?.use === useId).map((n) => n.id));
  const onward = routine.transitions.find((t) => ids.has(t.from) && !ids.has(t.to))?.to;
  routine.uses = (routine.uses ?? []).filter((u) => u.id !== useId);
  if (onward !== undefined)
    for (const use of routine.uses)
      for (const [name, value] of Object.entries(use.args)) if (typeof value === "string" && ids.has(value)) use.args[name] = onward;
  if (ids.has(routine.initial) && onward !== undefined) routine.initial = onward;
  if (!routine.uses.length) delete routine.uses;
  routine.transitions = routine.transitions.filter((t) => !ids.has(t.from) && !ids.has(t.to) && t.fromGroup?.use !== useId);
  syncGroups(project);
}
/** Turn a use's steps into ordinary steps of the routine (no longer tied to the group). */
export function detachGroupUse(project: SuiteProject, routine: AutoRoutine, useId: string) {
  routine.uses = (routine.uses ?? []).filter((u) => u.id !== useId);
  if (!routine.uses.length) delete routine.uses;
  for (const n of routine.nodes) if (n.fromGroup?.use === useId) delete n.fromGroup;
  for (const t of routine.transitions) if (t.fromGroup?.use === useId) delete t.fromGroup;
  syncGroups(project);
}

/**
 * Make a group out of steps of a routine: the steps and the exits between or out of them become
 * the template, and the routine keeps them as the group's first use. `params` names the values
 * that differ per use, by JSON path inside a step or exit ("pickup.goal", "arm.action",
 * "exit:next.to"): each becomes "$name" in the template and an argument of the use.
 */
export function createGroup(
  project: SuiteProject,
  routine: AutoRoutine,
  spec: { id: string; name?: string; use?: string; steps: string[]; params?: Record<string, string> },
): StepGroup {
  if (project.groups?.some((g) => g.id === spec.id)) throw new Error(`Group ${spec.id} already exists.`);
  const useId = spec.use ?? `${spec.id}1`;
  const steps = new Set(spec.steps);
  const missing = spec.steps.filter((id) => !routine.nodes.some((n) => n.id === id));
  if (missing.length) throw new Error(`Unknown steps: ${missing.join(", ")}.`);
  if (routine.nodes.some((n) => steps.has(n.id) && (n.fromGroup || n.kind === "finish")))
    throw new Error("A group cannot contain a finish step or a step that already belongs to a group.");
  const taken = new Set(routine.nodes.filter((n) => !steps.has(n.id)).map((n) => n.id));
  if (spec.steps.some((id) => taken.has(groupStepId(useId, id)))) throw new Error(`Step IDs ${useId}.* are taken.`);
  const nodes = structuredClone(routine.nodes.filter((n) => steps.has(n.id))).map((n) => {
    for (const k of LOCAL_KEYS) delete (n as any)[k];
    return n;
  });
  const transitions = structuredClone(routine.transitions.filter((t) => steps.has(t.from)));
  const group: StepGroup = { id: spec.id, name: spec.name ?? spec.id, params: [], nodes, transitions };
  const args: Record<string, Json> = {};
  for (const [name, path] of Object.entries(spec.params ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Parameter name ${name} must be a plain identifier.`);
    const exit = path.startsWith("exit:");
    // IDs may contain dots: the longest ID that starts the path is the step or exit meant.
    const rest = exit ? path.slice(5) : path;
    const items: { id: string }[] = exit ? transitions : nodes;
    let target: any = items.filter((i) => rest.startsWith(i.id + ".")).sort((a, b) => b.id.length - a.id.length)[0];
    const keys = target ? rest.slice(target.id.length + 1).split(".") : [];
    if (!target || !keys.length) throw new Error(`Parameter ${name}: nothing at ${path}.`);
    for (const key of keys.slice(0, -1)) target = target?.[key];
    const last = keys[keys.length - 1];
    if ((!isRecord(target) && !Array.isArray(target)) || !(last in target)) throw new Error(`Parameter ${name}: nothing at ${path}.`);
    const holder = target as Record<string, Json>;
    args[name] = holder[last];
    holder[last] = "$" + name;
    group.params.push({ name });
  }
  project.groups = [...(project.groups ?? []), group];
  // The routine's own steps become the first use: same steps under the use's IDs.
  const rename = (id: string) => (steps.has(id) ? groupStepId(useId, id) : id);
  const exits = new Set(transitions.map((t) => t.id));
  const position = routine.nodes.findIndex((n) => steps.has(n.id));
  const use: GroupUse = { id: useId, group: group.id, name: `${group.name} 1`, args };
  const produced = instantiate(group, use);
  // An exit parameter (the next step) pointing back into the group keeps pointing at this use.
  for (const [name, value] of Object.entries(args)) if (typeof value === "string" && steps.has(value)) args[name] = rename(value);
  const rest = routine.nodes.filter((n) => !steps.has(n.id));
  routine.nodes = [...rest.slice(0, position), ...instantiate(group, use).nodes, ...rest.slice(position)];
  routine.transitions = [
    ...routine.transitions.filter((t) => !exits.has(t.id) || !steps.has(t.from)).map((t) => ({ ...t, to: rename(t.to) })),
    ...produced.transitions,
  ];
  routine.initial = rename(routine.initial);
  routine.uses = [...(routine.uses ?? []), use];
  syncGroups(project);
  return group;
}
