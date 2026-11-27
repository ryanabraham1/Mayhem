/**
 * Model check for state machines: every state, under every combination of the inputs its exits
 * read, the way a TLA+ model checks that all states are handled. Inputs are finite here: a boolean
 * is true or false, a number takes the values either side of each threshold the conditions compare
 * it with, a string each value the conditions name plus one they don't. Each combination runs one
 * robot loop (`settleMachine`, as `mayhem::StateMachine::Settle`), so the results are exact for
 * the machine as written, not for the robot code that computes its inputs.
 *
 * Problems, each with the inputs that show it:
 * - `unreachable`: no inputs ever lead from the initial state to this state.
 * - `no-exit`: once there, no inputs ever leave it (a trap, unless it is meant to be final).
 * - `never-fires`: a transition that is never the one taken: an earlier one in priority order is
 *   true whenever it is.
 * - `loops`: inputs under which one loop never settles (A → B → A …): the state flickers.
 * - `unknown-input`: a condition reads a key the machine has no input for.
 */
import { checkedIn, type Condition, type SignalValue, type Signals, type Transition } from "../model.ts";
import { settleMachine, type MachineManifest } from "../machines.ts";

export type ModelProblemKind = "unreachable" | "no-exit" | "never-fires" | "loops" | "unknown-input";

export interface ModelProblem {
  kind: ModelProblemKind;
  machine: string;
  /** Stable across runs (kind, machine and state or transition), for comparing two versions. */
  id: string;
  state?: string;
  transition?: string;
  /** Inputs that show it (a loop's inputs; for never-fires, the transition that wins instead). */
  inputs?: Signals;
  text: string;
}

export interface ModelCheck {
  machines: { machine: string; states: number; reachable: number; combinations: number; partial?: boolean }[];
  problems: ModelProblem[];
}

/** Combinations tried per state; past this the check samples at random (and says so). */
const LIMIT = 1 << 17;
const TIMER = "stateTime";

function domains(m: MachineManifest): Map<string, SignalValue[]> {
  const values = new Map<string, Set<SignalValue>>();
  const add = (key: string, v: SignalValue) => (values.get(key) ?? values.set(key, new Set()).get(key)!).add(v);
  for (const i of m.inputs) {
    if (i.type === "boolean") [true, false].forEach((v) => add(i.key, v));
    else add(i.key, i.initial);
  }
  const known = new Set([...m.inputs.map((i) => i.key), TIMER]);
  const visit = (c: Condition) => {
    if (c.kind === "signal") {
      // A key the machine has no input for is never set on the robot: it stays missing (false).
      if (!known.has(c.key)) return;
      if (typeof c.value === "number") {
        const step = Math.max(1e-3, Math.abs(c.value) * 1e-3);
        [c.value - step, c.value, c.value + step].forEach((v) => add(c.key, v));
      } else if (typeof c.value === "string") [c.value, `${c.value}\u0000other`].forEach((v) => add(c.key, v));
      else [true, false].forEach((v) => add(c.key, v));
    } else if (c.kind === "all" || c.kind === "any") c.conditions.forEach(visit);
    else if (c.kind === "not") visit(c.condition);
  };
  m.transitions.forEach((t) => visit(t.condition));
  return new Map([...values].map(([k, v]) => [k, [...v]]));
}

function keysOf(c: Condition, out = new Set<string>()): Set<string> {
  if (c.kind === "signal") out.add(c.key);
  else if (c.kind === "all" || c.kind === "any") c.conditions.forEach((x) => keysOf(x, out));
  else if (c.kind === "not") keysOf(c.condition, out);
  return out;
}

/** Every combination of `keys` over their domains, or LIMIT of them at random (seeded) past that. */
function combinations(keys: string[], domain: Map<string, SignalValue[]>, base: Signals): { all: Signals[]; partial: boolean } {
  const sizes = keys.map((k) => domain.get(k)?.length ?? 1);
  const total = sizes.reduce((n, x) => n * x, 1);
  const pick = (index: (i: number) => number): Signals => {
    const s: Signals = { ...base };
    keys.forEach((k, i) => (s[k] = (domain.get(k) ?? [base[k]])[index(i)]));
    return s;
  };
  if (total <= LIMIT) {
    const all: Signals[] = [];
    for (let n = 0; n < total; n++) {
      let rest = n;
      all.push(pick((i) => { const v = rest % sizes[i]; rest = Math.floor(rest / sizes[i]); return v; }));
    }
    return { all, partial: false };
  }
  let seed = 0x9e3779b9;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0) >>> 0) / 2 ** 32;
  return { all: Array.from({ length: LIMIT }, () => pick((i) => Math.floor(random() * sizes[i]))), partial: true };
}

const label = (t: Transition) => t.name ?? t.id;
const shown = (s: Signals, keys: string[]) => Object.fromEntries(keys.filter((k) => k in s).map((k) => [k, s[k]]));

export function checkMachine(m: MachineManifest): { summary: ModelCheck["machines"][number]; problems: ModelProblem[] } {
  const priority = m.selection === "priority";
  const problems: ModelProblem[] = [];
  const known = new Set([...m.inputs.map((i) => i.key), TIMER]);
  const reported = new Set<string>();
  for (const t of m.transitions)
    for (const key of keysOf(t.condition))
      if (!known.has(key) && !reported.has(key)) {
        reported.add(key);
        problems.push({ kind: "unknown-input", machine: m.name, id: `unknown-input:${m.id}:${key}`, transition: label(t), text: `${m.name}: “${label(t)}” reads “${key}”, which is not one of its inputs. It is never true on the robot; add the input or fix the key.` });
      }
  const domain = domains(m);
  const base: Signals = Object.fromEntries(m.inputs.map((i) => [i.key, i.initial]));
  base[TIMER] ??= 0;
  const stateIds = m.states.map((s) => s.id);
  const taken = new Set<Transition>();
  const exits = new Map<string, Set<string>>();
  const loops = new Map<string, { inputs: Signals; path: string[] }>();
  let count = 0,
    partial = false;
  for (const state of stateIds) {
    const here = m.transitions.filter((t) => checkedIn(t, state, priority));
    // The inputs read here and in the states one step away: a loop needs both ends' conditions.
    const next1 = new Set(here.map((t) => t.to));
    const near = m.transitions.filter((t) => here.includes(t) || [...next1].some((s) => checkedIn(t, s, priority)));
    const keys = [...new Set(near.flatMap((t) => [...keysOf(t.condition)]))].filter((k) => domain.has(k)).sort();
    const combos = combinations(keys, domain, base);
    partial ||= combos.partial;
    count += combos.all.length;
    const next = new Set<string>();
    for (const inputs of combos.all) {
      // The transition this loop takes first (what `settleMachine` would take from here).
      const first = here.find((t) => evalSafe(t.condition, inputs));
      if (first) taken.add(first);
      const settled = settleMachine(m, state, inputs);
      settled.path.slice(1).forEach((s) => next.add(s));
      if (!settled.settled && !loops.has(state)) {
        // Shrink: put back every input that isn't needed for the loop, so the example names the cause.
        const small: Signals = { ...inputs };
        for (const k of keys) {
          if (small[k] === base[k]) continue;
          const tried = { ...small, [k]: base[k] };
          if (!settleMachine(m, state, tried).settled) small[k] = base[k];
        }
        const changed = keys.filter((k) => small[k] !== base[k]);
        loops.set(state, { inputs: shown(small, changed.length ? changed : keys), path: settleMachine(m, state, small).path });
      }
    }
    exits.set(state, next);
  }
  // Reachability from the initial state, one loop at a time.
  const reachable = new Set([m.initial]);
  for (let queue = [m.initial]; queue.length; ) for (const s of exits.get(queue.shift()!) ?? []) if (!reachable.has(s)) (reachable.add(s), queue.push(s));
  const name = (id: string) => m.states.find((s) => s.id === id)?.name ?? id;
  for (const s of stateIds) {
    if (!reachable.has(s))
      problems.push({ kind: "unreachable", machine: m.name, id: `unreachable:${m.id}:${s}`, state: s, text: `${m.name}: nothing leads to ${name(s)} from ${name(m.initial)}, whatever the inputs. Remove it or add the transition that should reach it.` });
    else if (!(exits.get(s)?.size))
      problems.push({ kind: "no-exit", machine: m.name, id: `no-exit:${m.id}:${s}`, state: s, text: `${m.name}: once in ${name(s)}, no inputs ever leave it. If it is not meant to be final, add the transition out (disable, cancel, done).` });
  }
  for (const t of m.transitions) {
    if (taken.has(t)) continue;
    // What wins instead: the earlier row that is true whenever this one is, in the first state where it's checked.
    const state = stateIds.find((s) => checkedIn(t, s, priority));
    if (!state) {
      problems.push({ kind: "never-fires", machine: m.name, id: `never-fires:${m.id}:${t.id}`, transition: label(t), text: `${m.name}: “${label(t)}” leaves no state (its from/except leave nothing to check it in).` });
      continue;
    }
    const before = m.transitions.slice(0, m.transitions.indexOf(t)).filter((x) => checkedIn(x, state, priority));
    const keys = [...new Set([t, ...before].flatMap((x) => [...keysOf(x.condition)]))].sort();
    const witness = combinations(keys, domain, base).all.find((s) => evalSafe(t.condition, s));
    const winner = witness && before.find((x) => evalSafe(x.condition, witness));
    problems.push({
      kind: "never-fires",
      machine: m.name,
      id: `never-fires:${m.id}:${t.id}`,
      transition: label(t),
      ...(witness ? { inputs: shown(witness, keys) } : {}),
      text: winner
        ? `${m.name}: “${label(t)}” (${name(t.from === "*" ? state : t.from)} → ${name(t.to)}) never fires: “${label(winner)}” comes first in priority order and is true whenever it is. Reorder them, or make the conditions exclude each other.`
        : `${m.name}: “${label(t)}” (→ ${name(t.to)}) is never true, whatever the inputs. Check its condition.`,
    });
  }
  // One problem per cycle (the states it repeats), shown with the fewest inputs that cause it.
  const cycles = new Map<string, { state: string; inputs: Signals; path: string[] }>();
  for (const [state, loop] of loops) {
    const key = [...new Set(loop.path.slice(-4))].sort().join("\u0000");
    const best = cycles.get(key);
    if (!best || Object.keys(loop.inputs).length < Object.keys(best.inputs).length) cycles.set(key, { state, ...loop });
  }
  for (const [cycle, { state, inputs, path }] of cycles)
    problems.push({
      kind: "loops",
      machine: m.name,
      id: `loops:${m.id}:${cycle.replace(/\u0000/g, "+")}`,
      state,
      inputs,
      text: `${m.name}: from ${name(state)} with ${Object.entries(inputs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "its initial inputs"} (other inputs at their initial values), one loop never settles (${path.slice(0, 6).map(name).join(" → ")} …): the state flickers. Make the conditions of those transitions exclude each other.`,
    });
  return { summary: { machine: m.name, states: stateIds.length, reachable: reachable.size, combinations: count, ...(partial ? { partial: true } : {}) }, problems };
}

/** `evaluate`, but an unknown value (a missing input) reads as false, as on the robot. */
function evalSafe(c: Condition, s: Signals): boolean {
  if (c.kind === "always") return true;
  if (c.kind === "not") return !evalSafe(c.condition, s);
  if (c.kind === "all" || c.kind === "any") return c.kind === "all" ? c.conditions.every((x) => evalSafe(x, s)) : c.conditions.some((x) => evalSafe(x, s));
  if (c.kind !== "signal") return false;
  const v = s[c.key];
  if (v === undefined || typeof v !== typeof c.value) return false;
  if (c.op === "eq") return v === c.value;
  return typeof v === "number" && typeof c.value === "number" && (c.op === "gt" ? v > c.value : v < c.value);
}

export function checkMachines(machines: MachineManifest[]): ModelCheck {
  const out: ModelCheck = { machines: [], problems: [] };
  for (const m of machines) {
    const r = checkMachine(m);
    out.machines.push(r.summary);
    out.problems.push(...r.problems);
  }
  return out;
}
