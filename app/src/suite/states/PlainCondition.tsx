import { Fragment, type ReactNode } from "react";
import { INPUT_CATEGORIES, type InputCategory } from "../core/inputCategories.ts";
import type { Condition } from "../core/model.ts";

/** What a condition needs about each input: its human name, unit and source. */
export interface InputInfo {
  name: (key: string) => string;
  unit?: (key: string) => string | undefined;
  category: (key: string) => InputCategory;
}

type Part = { text: string; key?: string };

/** A condition as words: input names, "and" / "or" / "not", units on numbers. */
function parts(c: Condition, info: InputInfo, nested = false): Part[] {
  if (c.kind === "always") return [{ text: "always" }];
  if (c.kind === "signal") {
    const term: Part = { text: info.name(c.key), key: c.key };
    const unit = info.unit?.(c.key);
    const value = typeof c.value === "number" ? `${c.value}${unit ? ` ${unit}` : ""}` : JSON.stringify(c.value);
    if (typeof c.value === "boolean" && c.op === "eq") return c.value ? [term] : [{ text: "not " }, term];
    if (c.op === "eq") return [term, { text: typeof c.value === "string" ? ` is ${value}` : ` = ${value}` }];
    return [term, { text: ` ${c.op === "gt" ? "over" : "under"} ${value}` }];
  }
  if (c.kind === "not") {
    const inner = c.condition;
    if (inner.kind === "signal" && typeof inner.value === "boolean" && inner.op === "eq")
      return parts({ ...inner, value: !inner.value }, info, nested);
    return [{ text: "not (" }, ...parts(inner, info), { text: ")" }];
  }
  const joined = c.conditions.flatMap((x, i) => [
    ...(i ? [{ text: c.kind === "all" ? " and " : " or " }] : []),
    ...parts(x, info, true),
  ]);
  return nested && c.conditions.length > 1 ? [{ text: "(" }, ...joined, { text: ")" }] : joined;
}

/** Plain-text version, for titles and tests. */
export function plainText(c: Condition, info: InputInfo): string {
  return parts(c, info).map((p) => p.text).join("");
}

/** A condition in words, each input shown by name with its source's letter badge (O, S, I, T, A). */
export function PlainCondition({ condition, info }: { condition: Condition; info: InputInfo }) {
  const out: ReactNode[] = parts(condition, info).map((p, i) => {
    if (!p.key) return <Fragment key={i}>{p.text}</Fragment>;
    const category = info.category(p.key);
    const meta = INPUT_CATEGORIES[category];
    return (
      <span key={i} className={`mx-term mx-plain is-${category}`} title={`${meta.label}: ${meta.description} (${p.key})`}>
        <span className={`mx-term-badge is-${category}`} aria-label={meta.label} role="img">
          {meta.letter}
        </span>
        {p.text}
      </span>
    );
  });
  return <>{out}</>;
}
