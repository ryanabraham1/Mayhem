/**
 * Programmatic authoring for agents and scripts: compact machine specs with readable conditions,
 * and autonomous routines from solved classic-planner `.mtraj` passes. Pure functions; the CLI
 * and MCP server (`scripts/mayhem.mjs machine apply`, `route import-mtraj`) do the file IO.
 */
import {
  INPUT_CATEGORY_KEYS,
  validateProject,
  type AutoNode,
  type AutoRoutine,
  type Condition,
  type Constraints,
  type InputCategory,
  type InputRef,
  type PathMarker,
  type SignalValue,
  type SuiteProject,
  type Transition,
} from "./model.ts";
import { ANY_STATE } from "./model.ts";
import { parseMachineManifest, type MachineManifest } from "./machines.ts";

// ---------------------------------------------------------------------------------------------
// Conditions as text: `enabled && deploy && !hoodClear`, `stateTime > 2.5`, `mode == "hub"`.

type InputTypes = Map<string, "boolean" | "number" | "string">;
type Token = { kind: "op" | "key" | "number" | "string" | "word"; text: string; value?: SignalValue; at: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(&&|\|\||==|!=|>=|<=|[()!<>])|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new Error(`Cannot read the condition at "${text.slice(at).trim()}" in: ${text}`);
    const start = at + m[0].length - (m[1] ?? m[2] ?? m[3] ?? m[4]).length;
    if (m[1]) tokens.push({ kind: "op", text: m[1], at: start });
    else if (m[2]) {
      const body = m[2].slice(1, -1).replace(/\\(.)/g, "$1");
      tokens.push({ kind: "string", text: m[2], value: body, at: start });
    } else if (m[3]) tokens.push({ kind: "number", text: m[3], value: Number(m[3]), at: start });
    else {
      const word = m[4];
      const lower = word.toLowerCase();
      if (lower === "and") tokens.push({ kind: "op", text: "&&", at: start });
      else if (lower === "or") tokens.push({ kind: "op", text: "||", at: start });
      else if (lower === "not") tokens.push({ kind: "op", text: "!", at: start });
      else if (word === "true" || word === "false") tokens.push({ kind: "word", text: word, value: word === "true", at: start });
      else if (word === "always") tokens.push({ kind: "word", text: word, at: start });
      else tokens.push({ kind: "key", text: word, at: start });
    }
    at = re.lastIndex;
  }
  return tokens;
}

/**
 * Parse a readable condition into the project's condition tree. Operators: `&&`/`and`, `||`/`or`,
 * `!`/`not`, parentheses, and comparisons `==`, `!=`, `>`, `<`, `>=`, `<=` against `true`/`false`,
 * numbers or quoted strings. A bare boolean input means `== true` and `!input` means `== false`;
 * `!=`, `>=` and `<=` become `not` of `==`, `<` and `>`. `always` is the always-true condition.
 * Every input must be declared in `types` with a matching type (`stateTime` is a number).
 */
export function parseCondition(text: string, types: InputTypes): Condition {
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const fail = (message: string): never => {
    throw new Error(`${message} in condition: ${text}`);
  };
  const expect = (op: string) => {
    if (peek()?.kind !== "op" || peek().text !== op) fail(`Expected "${op}"${peek() ? ` before "${peek().text}"` : " at the end"}`);
    i++;
  };
  const group = (kind: "all" | "any", parts: Condition[]): Condition => {
    const flat = parts.flatMap((p) => (p.kind === kind ? p.conditions : [p]));
    return flat.length === 1 ? flat[0] : { kind, conditions: flat };
  };
  const negate = (c: Condition): Condition =>
    c.kind === "signal" && c.op === "eq" && typeof c.value === "boolean" ? { ...c, value: !c.value } : { kind: "not", condition: c };
  const typeOf = (key: string) => types.get(key) ?? (key === "stateTime" ? "number" : undefined);
  const or = (): Condition => {
    const parts = [and()];
    while (peek()?.kind === "op" && peek().text === "||") i++, parts.push(and());
    return group("any", parts);
  };
  const and = (): Condition => {
    const parts = [unary()];
    while (peek()?.kind === "op" && peek().text === "&&") i++, parts.push(unary());
    return group("all", parts);
  };
  const unary = (): Condition => {
    if (peek()?.kind === "op" && peek().text === "!") {
      i++;
      return negate(unary());
    }
    return primary();
  };
  const primary = (): Condition => {
    const t = peek();
    if (!t) return fail("Expected an input");
    if (t.kind === "op" && t.text === "(") {
      i++;
      const inner = or();
      expect(")");
      return inner;
    }
    if (t.kind === "word" && (t.text === "always" || t.text === "true")) {
      i++;
      return { kind: "always" };
    }
    if (t.kind !== "key") return fail(`Expected an input, not "${t.text}"`);
    i++;
    const key = t.text;
    const type = typeOf(key);
    if (!type) return fail(`Unknown input "${key}" (declare it under inputs)`);
    const op = peek()?.kind === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(peek().text) ? tokens[i++].text : undefined;
    if (!op) {
      if (type !== "boolean") return fail(`"${key}" is a ${type}; compare it (for example ${key} > 1)`);
      return { kind: "signal", key, op: "eq", value: true };
    }
    const lit = peek();
    if (!lit || !["word", "number", "string"].includes(lit.kind) || lit.text === "always")
      return fail(`Expected a value after "${key} ${op}"`);
    i++;
    const value = lit.value!;
    if (typeof value !== type) return fail(`"${key}" is a ${type} but is compared with ${lit.text}`);
    if ([">", "<", ">=", "<="].includes(op) && type !== "number") return fail(`"${key} ${op}" needs a number input`);
    const base = (o: "eq" | "gt" | "lt"): Condition => ({ kind: "signal", key, op: o, value });
    if (op === "==") return base("eq");
    if (op === "!=") return negate(base("eq"));
    if (op === ">") return base("gt");
    if (op === "<") return base("lt");
    if (op === ">=") return negate(base("lt"));
    return negate(base("gt"));
  };
  const result = or();
  if (i < tokens.length) fail(`Unexpected "${tokens[i].text}"`);
  return result;
}

/** The readable text of a condition; `parseCondition` reads it back to the same tree. */
export function formatCondition(c: Condition): string {
  const literal = (v: SignalValue) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const atom = (c: Condition, parent: "all" | "any" | "not"): string => {
    const text = formatCondition(c);
    const needs = (c.kind === "any" && parent !== "any") || (c.kind === "all" && parent === "not");
    return needs ? `(${text})` : text;
  };
  if (c.kind === "always") return "always";
  if (c.kind === "signal") {
    if (c.op === "eq" && typeof c.value === "boolean") return c.value ? c.key : `!${c.key}`;
    return `${c.key} ${c.op === "eq" ? "==" : c.op === "gt" ? ">" : "<"} ${literal(c.value)}`;
  }
  if (c.kind === "not") {
    const inner = c.condition;
    if (inner.kind === "signal" && typeof inner.value !== "boolean")
      return `${inner.key} ${inner.op === "eq" ? "!=" : inner.op === "gt" ? "<=" : ">="} ${literal(inner.value)}`;
    if (inner.kind === "signal" || inner.kind === "always") return `!${formatCondition(inner)}`;
    return `!(${formatCondition(inner)})`;
  }
  return c.conditions.map((x) => atom(x, c.kind)).join(c.kind === "all" ? " && " : " || ");
}

// ---------------------------------------------------------------------------------------------
// Machine specs.

export interface InputSpec {
  name?: string;
  type?: "boolean" | "number" | "string";
  initial?: SignalValue;
  unit?: string;
  /** One-shot press or request: visible to the first step of a loop only. */
  event?: boolean;
  channel?: string;
  /** Same-machine keys, `"<Machine>::<key>"`, or `{ machine, key }`. */
  derivedFrom?: (string | { machine: string; key: string })[];
}
export interface StateSpec {
  name?: string;
  description?: string;
  source?: string;
}
export interface TransitionSpec {
  id?: string;
  from: string;
  to: string;
  /** Readable condition (see parseCondition). */
  when: string;
  name?: string;
  description?: string;
  except?: string[];
}
/** A `mayhem-machine` in a few lines; `machineFromSpec` expands it. */
export interface MachineSpec {
  id: string;
  name?: string;
  description?: string;
  /** Default: the first state. */
  initial?: string;
  selection?: "priority";
  stateChannel?: string;
  /** Default `source` (code reference) for every state. */
  source?: string;
  /** Default input channel; `{machine}` and `{key}` are replaced. */
  inputChannel?: string;
  /** Category → key → display name or details. Categories: operator, sensor, internal, timer, auto. */
  inputs: Partial<Record<InputCategory, Record<string, string | InputSpec>>>;
  /** State ID → display name or details (declaration order), or a list of IDs / `{ id, ... }`. */
  states: Record<string, string | StateSpec> | (string | (StateSpec & { id: string }))[];
  /** `"FROM -> TO: condition  # name"`, `"* except A, B -> TO: condition"`, or objects. */
  transitions: (string | TransitionSpec)[];
}

/** Parse the shorthand `"FROM -> TO: condition  # name"`. */
export function parseTransitionLine(line: string): TransitionSpec {
  const arrow = line.indexOf("->");
  const colon = arrow < 0 ? -1 : line.indexOf(":", arrow);
  if (arrow < 0 || colon < 0) throw new Error(`Expected "FROM -> TO: condition" in transition: ${line}`);
  const head = line.slice(0, arrow).trim();
  const to = line.slice(arrow + 2, colon).trim();
  let rest = line.slice(colon + 1);
  // A "#" outside quotes starts the edge name.
  let name: string | undefined;
  let quote = "";
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") {
      name = rest.slice(k + 1).trim() || undefined;
      rest = rest.slice(0, k);
      break;
    }
  }
  const except = /^\*\s+except\s+(.+)$/i.exec(head);
  const from = except ? ANY_STATE : head;
  if (!from || !to || /\s/.test(from) || /\s/.test(to)) throw new Error(`State IDs in the shorthand cannot contain spaces; use an object: ${line}`);
  return {
    from,
    to,
    when: rest.trim(),
    ...(name ? { name } : {}),
    ...(except ? { except: except[1].split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

const defaultInitial = (type: "boolean" | "number" | "string") => (type === "boolean" ? false : type === "number" ? 0 : "");

/** Expand a spec into a validated `mayhem-machine` manifest. */
export function machineFromSpec(spec: MachineSpec): MachineManifest {
  if (!spec || typeof spec !== "object" || typeof spec.id !== "string" || !spec.id)
    throw new Error("A machine spec needs an id.");
  const where = (message: string) => new Error(`Machine ${spec.id}: ${message}`);
  // States.
  const stateList: (StateSpec & { id: string })[] = Array.isArray(spec.states)
    ? spec.states.map((s) => (typeof s === "string" ? { id: s } : s))
    : Object.entries(spec.states ?? {}).map(([id, s]) => (typeof s === "string" ? { id, name: s } : { id, ...s }));
  if (!stateList.length) throw where("declare at least one state.");
  const states = stateList.map((s) => ({
    id: s.id,
    name: s.name ?? s.id,
    ...(s.description ? { description: s.description } : {}),
    ...((s.source ?? spec.source) ? { source: s.source ?? spec.source } : {}),
  }));
  // Inputs, in category order as written.
  if (!spec.inputs || typeof spec.inputs !== "object" || Array.isArray(spec.inputs))
    throw where('inputs must map categories ("operator", "sensor", "internal", "timer", "auto") to inputs.');
  const inputs: MachineManifest["inputs"] = [];
  for (const [category, group] of Object.entries(spec.inputs)) {
    if (!(INPUT_CATEGORY_KEYS as readonly string[]).includes(category))
      throw where(`unknown input category "${category}" (use ${INPUT_CATEGORY_KEYS.join(", ")}).`);
    for (const [key, value] of Object.entries(group ?? {})) {
      const d: InputSpec = typeof value === "string" ? { name: value } : value;
      const type = d.type ?? (d.initial !== undefined ? (typeof d.initial as "boolean" | "number" | "string") : key === "stateTime" ? "number" : "boolean");
      const channel = d.channel ?? spec.inputChannel?.replaceAll("{machine}", spec.id).replaceAll("{key}", key);
      const derivedFrom: InputRef[] | undefined = d.derivedFrom?.map((r) => {
        if (typeof r !== "string") return r;
        const split = r.indexOf("::");
        return split > 0 ? { machine: r.slice(0, split), key: r.slice(split + 2) } : r;
      });
      inputs.push({
        key,
        name: d.name ?? key,
        type,
        initial: d.initial ?? defaultInitial(type),
        category: category as InputCategory,
        ...(d.unit ? { unit: d.unit } : {}),
        ...(d.event ? { event: true } : {}),
        ...(channel ? { channel } : {}),
        ...(derivedFrom?.length ? { derivedFrom } : {}),
      });
    }
  }
  const types: InputTypes = new Map(inputs.map((i) => [i.key, i.type]));
  // Transitions.
  const usedIds = new Set<string>();
  const transitions: Transition[] = (spec.transitions ?? []).map((t, index) => {
    const row = typeof t === "string" ? parseTransitionLine(t) : t;
    if (!row || typeof row.when !== "string") throw where(`transition ${index + 1} needs "when".`);
    let condition: Condition;
    try {
      condition = parseCondition(row.when, types);
    } catch (e) {
      throw where(`transition ${index + 1} (${row.from} -> ${row.to}): ${(e as Error).message}`);
    }
    const base = row.id ?? `${row.from === ANY_STATE ? "any" : row.from}-to-${row.to}`;
    let id = base;
    for (let k = 2; usedIds.has(id); k++) id = `${base}-${k}`;
    usedIds.add(id);
    return {
      id,
      from: row.from,
      to: row.to,
      condition,
      ...(row.name ? { name: row.name } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.except?.length ? { except: row.except } : {}),
    };
  });
  // stateTime is built in: declare it when a condition uses it and the spec did not.
  const usesTime = JSON.stringify(transitions.map((t) => t.condition)).includes('"key":"stateTime"');
  if (usesTime && !types.has("stateTime")) {
    const channel = spec.inputChannel?.replaceAll("{machine}", spec.id).replaceAll("{key}", "stateTime");
    inputs.push({ key: "stateTime", name: "Seconds in this state", type: "number", initial: 0, unit: "s", category: "timer", ...(channel ? { channel } : {}) });
  }
  const manifest = {
    format: "mayhem-machine" as const,
    version: 1 as const,
    id: spec.id,
    name: spec.name ?? spec.id,
    ...(spec.description ? { description: spec.description } : {}),
    initial: spec.initial ?? states[0].id,
    ...(spec.selection ? { selection: spec.selection } : {}),
    ...(spec.stateChannel ? { stateChannel: spec.stateChannel } : {}),
    states,
    inputs,
    transitions,
  };
  try {
    return parseMachineManifest(manifest);
  } catch (e) {
    throw where((e as Error).message);
  }
}

/** The spec of an existing manifest, for editing and re-applying (conditions as text). */
export function specFromMachine(m: MachineManifest): MachineSpec {
  // A state source and an input channel pattern shared by every state / input are written once.
  const sources = new Set(m.states.map((s) => s.source));
  const source = sources.size === 1 ? [...sources][0] : undefined;
  const template = (() => {
    const first = m.inputs.find((i) => i.channel);
    if (!first?.channel?.endsWith(first.key)) return undefined;
    const t = first.channel.slice(0, first.channel.length - first.key.length) + "{key}";
    return m.inputs.every((i) => i.channel === t.replace("{key}", i.key)) ? t : undefined;
  })();
  const inputs: MachineSpec["inputs"] = {};
  for (const i of m.inputs) {
    const category = i.category ?? (i.key === "stateTime" ? "timer" : "internal");
    const derivedFrom = i.derivedFrom?.map((r) => (typeof r === "string" ? r : `${r.machine}::${r.key}`));
    const channel = template ? undefined : i.channel;
    const plain = i.type === "boolean" && i.initial === false && !i.unit && !i.event && !channel && !derivedFrom?.length;
    (inputs[category] ??= {})[i.key] = plain
      ? i.name
      : {
          name: i.name,
          ...(i.type !== "boolean" ? { type: i.type } : {}),
          ...(i.initial !== defaultInitial(i.type) ? { initial: i.initial } : {}),
          ...(i.unit ? { unit: i.unit } : {}),
          ...(i.event ? { event: true } : {}),
          ...(channel ? { channel } : {}),
          ...(derivedFrom?.length ? { derivedFrom } : {}),
        };
  }
  const extra = m as MachineManifest & { description?: string };
  return {
    id: m.id,
    ...(m.name !== m.id ? { name: m.name } : {}),
    ...(extra.description ? { description: extra.description } : {}),
    ...(m.initial !== m.states[0].id ? { initial: m.initial } : {}),
    ...(m.selection ? { selection: m.selection } : {}),
    ...(m.stateChannel ? { stateChannel: m.stateChannel } : {}),
    ...(source ? { source } : {}),
    ...(template ? { inputChannel: template } : {}),
    inputs,
    states: Object.fromEntries(
      m.states.map((s) => {
        const own = source ? undefined : s.source;
        return [s.id, !s.description && !own ? s.name : { name: s.name, ...(s.description ? { description: s.description } : {}), ...(own ? { source: own } : {}) }];
      }),
    ),
    transitions: m.transitions.map((t) => {
      const generated = `${t.from === ANY_STATE ? "any" : t.from}-to-${t.to}`;
      return {
        ...(t.id !== generated ? { id: t.id } : {}),
        from: t.from,
        to: t.to,
        when: formatCondition(t.condition),
        ...(t.name ? { name: t.name } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(t.except?.length ? { except: t.except } : {}),
      };
    }),
  };
}

/** Replace (in place) or append each spec's machine in `extensions.machines`; validates the project. */
export function applyMachineSpecs(project: SuiteProject, specs: MachineSpec[]): { project: SuiteProject; machines: string[]; warnings: string[] } {
  const next = structuredClone(project);
  const list: unknown[] = Array.isArray(next.extensions.machines) ? next.extensions.machines : [];
  const warnings: string[] = [];
  const machines: string[] = [];
  for (const spec of specs) {
    const manifest = machineFromSpec(spec);
    const used = new Set(JSON.stringify(manifest.transitions.map((t) => t.condition)).match(/"key":"[^"]*"/g)?.map((k) => k.slice(7, -1)));
    for (const i of manifest.inputs) if (!used.has(i.key)) warnings.push(`${manifest.id}: input ${i.key} is declared but no transition reads it.`);
    const at = list.findIndex((m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === manifest.id);
    if (at >= 0) list[at] = manifest;
    else list.push(manifest);
    machines.push(manifest.id);
  }
  next.extensions.machines = list;
  const errors = validateProject(next).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(errors.map((i) => `${i.path}: ${i.message}`).join("\n"));
  return { project: next, machines, warnings };
}

// ---------------------------------------------------------------------------------------------
// Routines from solved `.mtraj` passes.

/** The parts of a classic `.mtraj` file the importer reads (generated output). */
export interface Mtraj {
  name?: string;
  output: {
    samples: { t: number; x: number; y: number; heading: number; vx: number; vy: number }[];
    waypointTimes: number[];
    events?: { name: string; command?: string; t: number }[];
  };
}
export interface ImportOptions {
  /** Max distance (m) between the solved pass and the straight line through kept points. */
  pathTolerance?: number;
  /** Max heading difference (deg) from the heading interpolated between kept points. */
  headingTolerance?: number;
  /** Points closer than this in time (s) are merged. */
  minDt?: number;
  /** Segment cap = fastest solved speed on the segment × speedScale, clamped to [minSpeed, maxSpeed]. */
  speedScale?: number;
  minSpeed?: number;
  /** Default: the robot's maxVelocity. */
  maxSpeed?: number;
  /** Speed cap of each pass's last segment. */
  finalSpeed?: number;
  /** Handoff radius of pass-through points. */
  cornerRadius?: number;
  pointTolerance?: number;
  pointHeadingTolerance?: number;
  finalTolerance?: number;
  finalHeadingTolerance?: number;
  settleTime?: number;
  stepTimeout?: number;
}
export const IMPORT_DEFAULTS: Required<Omit<ImportOptions, "maxSpeed">> = {
  pathTolerance: 0.15,
  headingTolerance: 10,
  minDt: 0.15,
  speedScale: 1,
  minSpeed: 0.8,
  finalSpeed: 3,
  cornerRadius: 0.3,
  pointTolerance: 0.12,
  pointHeadingTolerance: 0.2,
  finalTolerance: 0.15,
  finalHeadingTolerance: 0.08,
  settleTime: 0.04,
  stepTimeout: 5,
};
export interface PassSpec {
  /** Path to the solved `.mtraj` (resolved by the caller). */
  mtraj: string;
  /** Steps appended after this pass, e.g. an aim-and-shoot custom step. IDs default to `<routine>-pass<n>-after<k>`. */
  after?: (Partial<AutoNode> & { kind: AutoNode["kind"] })[];
}
export interface RouteSpec {
  /** Routine ID; created when missing. */
  routine: string;
  name?: string;
  passes: PassSpec[];
  /** `.mtraj` event name → event marker key (e.g. { "intake": "superstructure.intake" }); others are skipped. */
  events?: Record<string, string>;
  /** Event marker keys fired at the end of every pass (t = 1 on its last step). */
  endEvents?: string[];
  options?: ImportOptions;
  /** Merged into the routine's path constraints. */
  constraints?: Partial<Constraints>;
  /** Append a finish step (default true; an object sets its id and name). */
  finish?: boolean | { id?: string; name?: string };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Key waypoints of one solved pass: its original waypoint times, plus the fewest points that keep
 * the driven line within `pathTolerance` and the heading within `headingTolerance` of the solve
 * (Douglas-Peucker between waypoints), merged when closer than `minDt`. Returns sample times.
 */
export function keyTimes(m: Mtraj, o: Required<Omit<ImportOptions, "maxSpeed">>): number[] {
  const s = m.output.samples;
  if (s.length < 2) throw new Error(`${m.name ?? ".mtraj"}: the pass has no solved samples; solve it first.`);
  const T = s[s.length - 1].t;
  const keep: number[] = [];
  const off = (a: number, b: number, k: number) => {
    const ax = s[a].x, ay = s[a].y, bx = s[b].x, by = s[b].y;
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const u = L2 > 1e-18 ? Math.min(1, Math.max(0, ((s[k].x - ax) * (bx - ax) + (s[k].y - ay) * (by - ay)) / L2)) : 0;
    const dist = Math.hypot(s[k].x - ax - u * (bx - ax), s[k].y - ay - u * (by - ay));
    const h = s[a].heading + u * wrapAngle(s[b].heading - s[a].heading);
    return Math.max(dist / o.pathTolerance, Math.abs((wrapAngle(s[k].heading - h) * 180) / Math.PI) / o.headingTolerance);
  };
  const simplify = (a: number, b: number): void => {
    if (b - a < 2) return;
    let worst = -1, at = -1;
    for (let k = a + 1; k < b; k++) {
      const e = off(a, b, k);
      if (e > worst) (worst = e), (at = k);
    }
    if (worst > 1) {
      keep.push(s[at].t);
      simplify(a, at);
      simplify(at, b);
    }
  };
  const nearest = (t: number) => s.reduce((best, x, i) => (Math.abs(x.t - t) < Math.abs(s[best].t - t) ? i : best), 0);
  const fixed = [...new Set([0, s.length - 1, ...m.output.waypointTimes.map(nearest)])].sort((a, b) => a - b);
  for (let k = 1; k < fixed.length; k++) simplify(fixed[k - 1], fixed[k]);
  keep.push(...m.output.waypointTimes.slice(1));
  const end = round(T, 3);
  const times = [...new Set(keep.filter((t) => t > 0.05).map((t) => round(t, 3)))].sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of times) {
    if (merged.length && t - merged[merged.length - 1] < o.minDt) {
      if (t === end) merged.pop();
      else continue;
    }
    merged.push(t);
  }
  if (merged[merged.length - 1] !== end) merged.push(end);
  return merged;
}

/** Build (or rebuild) a routine from solved passes; `load` returns each pass's parsed `.mtraj`. */
export function routineFromMtraj(project: SuiteProject, spec: RouteSpec, load: (path: string) => Mtraj): { project: SuiteProject; routine: string; steps: number; warnings: string[] } {
  if (!spec || typeof spec.routine !== "string" || !spec.routine) throw new Error("A route spec needs a routine ID.");
  if (!Array.isArray(spec.passes) || !spec.passes.length) throw new Error(`Routine ${spec.routine}: list at least one pass.`);
  const o = { ...IMPORT_DEFAULTS, ...(spec.options ?? {}) };
  const maxSpeed = spec.options?.maxSpeed ?? project.robot.constraints.maxVelocity;
  const warnings: string[] = [];
  const nodes: AutoNode[] = [];
  let start: { x: number; y: number; heading: number } | undefined;
  spec.passes.forEach((pass, pi) => {
    const m = load(pass.mtraj);
    const label = m.name ?? pass.mtraj;
    const s = m.output.samples;
    const times = keyTimes(m, o);
    const at = (t: number) => s.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), s[0]);
    const speed = (x: { vx: number; vy: number }) => Math.hypot(x.vx, x.vy);
    start ??= { x: s[0].x, y: s[0].y, heading: wrapAngle(s[0].heading) };
    const events = (m.output.events ?? []).flatMap((e) => {
      const key = spec.events?.[e.name] ?? (e.command ? spec.events?.[e.command] : undefined);
      if (!key) {
        warnings.push(`${label}: event "${e.name}" at ${e.t.toFixed(2)} s has no mapping in "events"; skipped.`);
        return [];
      }
      return [{ t: e.t, key }];
    });
    let previous = 0;
    times.forEach((t, i) => {
      const x = at(t);
      const final = i === times.length - 1;
      const onSegment = s.filter((y) => y.t > previous && y.t <= t);
      const cap = final
        ? o.finalSpeed
        : Math.min(maxSpeed, Math.max(o.minSpeed, Math.max(...(onSegment.length ? onSegment : [x]).map(speed)) * o.speedScale));
      const markers: PathMarker[] = [];
      for (const e of events)
        if ((e.t >= previous && e.t < t) || (i === 0 && e.t <= 0) || (final && e.t >= t))
          markers.push({ kind: "event", t: round(e.t <= previous ? 0 : Math.min(1, (e.t - previous) / Math.max(t - previous, 1e-9)), 3), key: e.key });
      if (final) for (const key of spec.endEvents ?? []) markers.push({ kind: "event", t: 1, key });
      markers.sort((a, b) => a.t - b.t);
      nodes.push({
        id: `${spec.routine}-pass${pi + 1}-p${i + 1}`,
        name: `Pass ${pi + 1} · ${final ? "end" : `point ${i + 1}`}`,
        kind: "pose",
        goal: {
          x: round(x.x, 3),
          y: round(x.y, 3),
          heading: round(wrapAngle(x.heading), 4),
          translationTolerance: final ? o.finalTolerance : o.pointTolerance,
          rotationTolerance: final ? o.finalHeadingTolerance : o.pointHeadingTolerance,
          velocityTolerance: 0.3,
          settleTime: final ? o.settleTime : 0,
          handoffRadius: 0,
          headingMode: "fixed",
          stop: final,
          profiled: true,
          ...(markers.length ? { markers } : {}),
        },
        timeout: o.stepTimeout,
        description: `From the solved ${label} pass at ${t.toFixed(2)} s: position, heading and speed.`,
        constraints: { maxVelocity: round(cap, 2), ...(final ? {} : { handoffRadius: o.cornerRadius }) },
      });
      previous = t;
    });
    (pass.after ?? []).forEach((step, k) =>
      nodes.push({
        id: `${spec.routine}-pass${pi + 1}-after${k + 1}`,
        name: step.name ?? step.action ?? step.kind,
        timeout: 5,
        ...step,
      } as AutoNode),
    );
  });
  if (spec.finish !== false) {
    const finish = typeof spec.finish === "object" ? spec.finish : {};
    nodes.push({ id: finish.id ?? `${spec.routine}-done`, name: finish.name ?? "Auto complete", kind: "finish", timeout: 1 });
  }
  const transitions: Transition[] = nodes.slice(1).map((n, i) => ({ id: `t${i}`, from: nodes[i].id, to: n.id, condition: { kind: "always" } }));
  const next = structuredClone(project);
  const existing = next.routines.find((r) => r.id === spec.routine);
  const routine: AutoRoutine = existing ?? { id: spec.routine, name: spec.name ?? spec.routine, initial: nodes[0].id, nodes: [], transitions: [] };
  if (spec.name) routine.name = spec.name;
  routine.nodes = nodes;
  routine.transitions = transitions;
  routine.initial = nodes[0].id;
  routine.start = start;
  delete routine.constraintGeneration;
  if (spec.constraints) routine.constraints = { ...(routine.constraints ?? {}), ...spec.constraints };
  if (!existing) next.routines.push(routine);
  const errors = validateProject(next).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(errors.map((i) => `${i.path}: ${i.message}`).join("\n"));
  return { project: next, routine: spec.routine, steps: nodes.length, warnings };
}
