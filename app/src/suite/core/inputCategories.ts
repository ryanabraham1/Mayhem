import { evaluate, type Condition, type InputCategory, type Signals, type Transition } from "./model.ts";
import { conditionSignals } from "./machines.ts";

export type { InputCategory } from "./model.ts";
export { inputSourceProblem } from "./model.ts";
export const INPUT_CATEGORY_ORDER: InputCategory[] = ["operator", "auto", "sensor", "internal", "timer"];
// ⚙ and ⏱ carry U+FE0F so they render as emoji, the same size as the others.
export const INPUT_CATEGORIES: Record<InputCategory, { label: string; glyph: string; letter: string; description: string }> = {
  operator: { label: "Operator", glyph: "🎮", letter: "O", description: "Driver or controller request" },
  auto: { label: "Autonomous", glyph: "🤖", letter: "A", description: "Request made by the autonomous routine" },
  sensor: { label: "Sensor", glyph: "📡", letter: "S", description: "Measured: encoders, beam breaks, flywheel at speed, pose" },
  internal: { label: "Internal", glyph: "⚙\uFE0F", letter: "I", description: "Code-derived state: latched intent, zone flags, other machines" },
  timer: { label: "Timer", glyph: "⏱\uFE0F", letter: "T", description: "Time in the current state" },
};
export const isInputCategory = (v: unknown): v is InputCategory =>
  typeof v === "string" && v in INPUT_CATEGORIES;

/** Optional input metadata shared by project signals and machine inputs. */
export interface InputSource {
  key: string;
  category?: InputCategory;
  /** Inputs this (usually internal) flag is computed from. */
  derivedFrom?: string[];
}

/** Category of an input; missing means "internal", except the built-in `stateTime` (timer). */
export function categoryOf(input: InputSource | undefined, key = input?.key): InputCategory {
  if (input?.category) return input.category;
  return key === "stateTime" ? "timer" : "internal";
}
/** Key → category for a machine's or project's inputs. Unknown keys follow categoryOf(). */
export function categoryLookup(inputs: InputSource[]): (key: string) => InputCategory {
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  return (key) => categoryOf(byKey.get(key), key);
}

/** Signal keys a condition reads, in order of first appearance. */
export function conditionKeys(c: Condition): string[] {
  return [...new Set(conditionSignals(c))];
}

export interface TransitionCause {
  transition: Transition;
  /** Inputs that explain the change: those whose value changed, else the deciding ones. */
  keys: string[];
}

/**
 * Why the machine went from `from` to `to`: the highest-priority `from → to` edge that is
 * true with `after` (or the first such edge when the inputs were not observed), and the
 * inputs it reads whose values changed since `before`. With no change, a `stateTime`
 * guard is the cause; otherwise every input it reads.
 */
export function transitionCause(
  transitions: Transition[],
  from: string,
  to: string,
  before: Signals,
  after: Signals,
): TransitionCause | undefined {
  const edges = transitions.filter((t) => t.from === from && t.to === to);
  if (!edges.length) return undefined;
  const transition = edges.find((t) => evaluate(t.condition, after)) ?? edges[0];
  const keys = conditionKeys(transition.condition);
  const changed = keys.filter((k) => before[k] !== after[k] && k !== "stateTime");
  if (changed.length) return { transition, keys: changed };
  if (keys.includes("stateTime")) return { transition, keys: ["stateTime"] };
  return { transition, keys };
}
