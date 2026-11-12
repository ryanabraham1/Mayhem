import type { Condition, Transition } from "./model.ts";

/** Nested groups of the same kind are one group: all(all(a, b), c) reads as a ∧ b ∧ c. */
function terms(c: Condition, kind: "all" | "any"): Condition[] {
  return c.kind === kind ? c.conditions.flatMap((x) => terms(x, kind)) : [c];
}
const value = (v: boolean | number | string) => (typeof v === "string" ? JSON.stringify(v) : String(v));

/**
 * Compact symbolic condition: `deploy ∧ ¬hoodClear`, `stateTime > 2.5`, `shotDemand ∨ ¬enabled`.
 * Boolean `= true` is dropped and `= false` becomes ¬. Same meaning as conditionLabel.
 * `signalLabel` can swap keys for display names; a name with spaces is parenthesized after ¬.
 */
export function compactCondition(c: Condition, signalLabel: (key: string) => string = (key) => key): string {
  const inner = (x: Condition, parent: "all" | "any" | "not") => {
    const text = compactCondition(x, signalLabel);
    const group = x.kind === "all" || x.kind === "any";
    return group && (parent === "not" || x.kind !== parent) ? `(${text})` : text;
  };
  const negated = (key: string) => {
    const label = signalLabel(key);
    return /\s/.test(label) ? `¬(${label})` : `¬${label}`;
  };
  if (c.kind === "always") return "Always";
  if (c.kind === "signal") {
    if (c.op === "eq" && typeof c.value === "boolean") return c.value ? signalLabel(c.key) : negated(c.key);
    return `${signalLabel(c.key)} ${c.op === "eq" ? "=" : c.op === "gt" ? ">" : "<"} ${value(c.value)}`;
  }
  if (c.kind === "not") {
    const x = c.condition;
    if (x.kind === "signal" && x.op === "eq" && typeof x.value === "boolean") return x.value ? negated(x.key) : signalLabel(x.key);
    if (x.kind === "signal") return `¬(${compactCondition(x, signalLabel)})`;
    return `¬${inner(x, "not")}`;
  }
  return terms(c, c.kind)
    .map((x) => inner(x, c.kind as "all" | "any"))
    .join(c.kind === "all" ? " ∧ " : " ∨ ");
}

/** Shorten by removing the middle, on term boundaries when possible, so both ends survive. */
export function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const parts = text.split(/( [∧∨] )/);
  if (parts.length >= 3) {
    // Keep the last term, then add terms from the front while they fit.
    const last = parts[parts.length - 1];
    let head = parts[0];
    for (let i = 1; i + 1 < parts.length - 1; i += 2) {
      const next = head + parts[i] + parts[i + 1];
      if (next.length + 3 + last.length > max) break;
      head = next;
    }
    const candidate = `${head} … ${last}`;
    if (candidate.length <= max) return candidate;
    const tail = `… ${last}`;
    if (tail.length <= max) return tail;
  }
  const words = text.split(" ");
  let head = words.shift() ?? text;
  while (words.length && head.length + words[0].length + 2 <= max) head += ` ${words.shift()}`;
  return words.length ? `${head} …` : head;
}

export interface EdgeLabel {
  /** Short text for the wire. */
  label: string;
  /** Full condition, always complete. */
  condition: string;
  /** Hover text: name, full condition, description. */
  title: string;
  /** Position among the source state's outgoing edges (priority, 1-based). */
  priority: number;
}

/** Top-level ∧ terms of a condition, each rendered compactly; other conditions are one term. */
function termTexts(c: Condition, signalLabel: (key: string) => string): string[] {
  if (c.kind !== "all") return [compactCondition(c, signalLabel)];
  return terms(c, "all").map((x) => {
    const text = compactCondition(x, signalLabel);
    return x.kind === "any" ? `(${text})` : text;
  });
}

/**
 * The fewest terms of `own` (taken from the end, where priority-ordered guards keep their
 * specific part) that rule out every sibling: a sibling is ruled out once a chosen term is
 * missing from its terms. Returns null when nothing can be dropped.
 */
function distinguishing(own: string[], siblings: string[][]): string[] | null {
  const chosen = new Set<number>();
  let remaining = siblings.slice();
  for (let i = own.length - 1; i >= 0 && remaining.length; i--) {
    if (remaining.some((other) => !other.includes(own[i]))) {
      chosen.add(i);
      remaining = remaining.filter((other) => other.includes(own[i]));
    }
  }
  // Siblings whose terms contain all of ours can't be ruled out by our terms; that's fine,
  // their own labels will differ. Keep at least the last term.
  if (!chosen.size) chosen.add(own.length - 1);
  if (chosen.size === own.length) return null;
  return own.filter((_, i) => chosen.has(i));
}

/**
 * Labels for every transition. An edge shows its `name` when present, else a compact condition.
 * A condition longer than `max` keeps only the terms that tell it apart from the other edges of
 * the same state (with "…" marking dropped terms), then elides in the middle. Edges leaving the
 * same state never get the same text: names that collide get their condition appended, and
 * identical edges get their target state, then their priority.
 */
export function edgeLabels(transitions: Transition[], max = 40, stateName: (id: string) => string = (id) => id, signalLabel: (key: string) => string = (key) => key): Map<string, EdgeLabel> {
  const out = new Map<string, EdgeLabel>();
  const bySource = new Map<string, Transition[]>();
  for (const t of transitions) bySource.set(t.from, [...(bySource.get(t.from) ?? []), t]);
  for (const siblings of bySource.values()) {
    const full = siblings.map((t) => compactCondition(t.condition, signalLabel));
    const split = siblings.map((t) => termTexts(t.condition, signalLabel));
    const conditionLabel = (i: number) => {
      if (full[i].length <= max) return full[i];
      const others = split.filter((_, j) => j !== i);
      const kept = distinguishing(split[i], others);
      if (!kept) return elideMiddle(full[i], max);
      const shown = split[i].map((term) => (kept.includes(term) ? term : null));
      // Render kept terms in order, collapsing each run of dropped terms into one "…".
      const parts: string[] = [];
      for (const term of shown) if (term !== null) parts.push(term);
      else if (parts[parts.length - 1] !== "…") parts.push("…");
      return elideMiddle(parts.join(" ∧ ").replace(/… ∧ /g, "… ").replace(/ ∧ …$/, " …"), max);
    };
    const labels = siblings.map((t, i) => (t.name ? elideMiddle(t.name, max) : conditionLabel(i)));
    const duplicated = () => labels.map((l, i) => labels.some((m, j) => j !== i && m === l));
    let dup = duplicated();
    siblings.forEach((t, i) => {
      if (dup[i] && t.name) labels[i] = `${elideMiddle(t.name, 18)} · ${conditionLabel(i)}`;
    });
    dup = duplicated();
    siblings.forEach((t, i) => {
      if (dup[i]) labels[i] = `${labels[i]} → ${stateName(t.to)}`;
    });
    dup = duplicated();
    siblings.forEach((_, i) => {
      if (dup[i]) labels[i] = `${labels[i]} #${i + 1}`;
    });
    siblings.forEach((t, i) =>
      out.set(t.id, {
        label: t.condition.kind === "always" && !t.name ? "" : labels[i],
        condition: full[i],
        title: [t.name, full[i], t.description].filter(Boolean).join("\n"),
        priority: i + 1,
      }),
    );
  }
  return out;
}
