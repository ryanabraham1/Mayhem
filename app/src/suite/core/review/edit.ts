/**
 * Edits one setting in robot C++ source: only the literal that holds it changes (the rest of the
 * file, its comments and formatting are untouched). Values computed from other values are not
 * editable here; the person edits the input instead.
 */
import { splitTop } from "./cpp.ts";
import type { Setting } from "./settings.ts";

export interface EditInfo {
  kind: "number" | "integer" | "bool" | "enum";
  /** The literal as written (`80_A`, `true`, `signals::NeutralModeValue::Coast`). */
  literal: string;
  /** Number without its unit suffix, `true`/`false`, or the enum leaf. */
  current: string;
  unit?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

const ENUMS: Record<string, { value: string; label: string }[]> = {
  NeutralModeValue: [
    { value: "Brake", label: "Brake" },
    { value: "Coast", label: "Coast" },
  ],
  InvertedValue: [
    { value: "Clockwise_Positive", label: "Clockwise" },
    { value: "CounterClockwise_Positive", label: "Counter-clockwise" },
  ],
  GravityTypeValue: [
    { value: "Elevator_Static", label: "Elevator (constant)" },
    { value: "Arm_Cosine", label: "Arm (cosine)" },
  ],
};

const NUMBER = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(_\w+)?$/;

/** Why a setting cannot be edited here, or how to edit it. `index` picks a list element. */
export function editInfo(setting: Setting, index?: number): EditInfo | { reason: string } {
  if (setting.category === "simulation") return { reason: "Simulation-only values don't run on the robot." };
  if (setting.table) return { reason: "Lookup tables are edited as code for now." };
  let literal = setting.expression.trim();
  if (setting.list) {
    if (index === undefined) return { reason: "Pick one entry of the list." };
    const items = splitTop(literal.replace(/^\{\s*|\s*\}$/g, ""));
    if (index < 0 || index >= items.length) return { reason: "No such entry." };
    literal = items[index];
  } else if (/^\{.*\}$/.test(literal)) literal = literal.slice(1, -1).trim();
  if (literal === "true" || literal === "false") return { kind: "bool", literal, current: literal };
  const enumMatch = /(\w+Value)::(\w+)$/.exec(literal);
  if (enumMatch && ENUMS[enumMatch[1]] && /^[\w:]+$/.test(literal))
    return { kind: "enum", literal, current: enumMatch[2], options: ENUMS[enumMatch[1]] };
  const number = NUMBER.exec(literal);
  if (!number) {
    const refs = setting.refs.map((r) => r.split("::").pop()).join(", ");
    return { reason: refs ? `Computed from ${refs}. Edit that instead.` : "Not a plain value (it's computed in code)." };
  }
  const integer = setting.category === "can-id";
  return {
    kind: integer ? "integer" : "number",
    literal,
    current: number[1],
    ...(setting.unit || number[2] ? { unit: setting.unit ?? number[2]!.slice(1) } : {}),
    ...(setting.category === "can-id" ? { min: 0, max: 62 } : {}),
    ...(setting.category === "current-limit" ? { min: 0, max: 200 } : {}),
    ...(setting.category === "gear-ratio" ? { min: 0.001 } : {}),
  };
}

/** Checks a proposed value; returns a problem to show, or undefined when it can be written. */
export function checkValue(info: EditInfo, value: string): string | undefined {
  if (info.kind === "bool") return value === "true" || value === "false" ? undefined : "Choose on or off.";
  if (info.kind === "enum") return info.options?.some((o) => o.value === value) ? undefined : "Choose one of the options.";
  if (!NUMBER.test(value.trim()) || /_/.test(value)) return "Enter a number.";
  const n = Number(value);
  if (info.kind === "integer" && !Number.isInteger(n)) return "Enter a whole number.";
  if (info.min !== undefined && n < info.min) return `Must be at least ${info.min}.`;
  if (info.max !== undefined && n > info.max) return `Must be at most ${info.max}.`;
  return undefined;
}

function newLiteral(info: EditInfo, value: string) {
  if (info.kind === "bool") return value;
  if (info.kind === "enum") return info.literal.replace(/\w+$/, value);
  const suffix = NUMBER.exec(info.literal)?.[2] ?? "";
  return `${String(Number(value.trim()))}${suffix}`;
}

/** Index just past the comment or string starting at `k`, or `k` when there is none. */
function skip(text: string, k: number): number {
  if (text.startsWith("//", k)) {
    const end = text.indexOf("\n", k);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith("/*", k)) {
    const end = text.indexOf("*/", k + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (text[k] === '"' || text[k] === "'") {
    let j = k + 1;
    while (j < text.length && text[j] !== text[k]) j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return k;
}

/** The balanced span after an opening bracket at `open` (exclusive of both brackets). */
function balanced(text: string, open: number): [number, number] {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]];
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const j = skip(text, k);
    if (j !== k) {
      k = j - 1;
      continue;
    }
    if (text[k] === text[open]) depth++;
    else if (text[k] === close && --depth === 0) return [open + 1, k];
  }
  throw new Error("Unbalanced brackets in the source.");
}

const lineStart = (text: string, line: number) => {
  let k = 0;
  for (let n = 1; n < line && k >= 0; n++) k = text.indexOf("\n", k) + 1;
  return Math.max(0, k);
};

/** The declaration or function starting on `line`: [start, end) up to its `;` or closing `}`. */
function statementSpan(text: string, line: number): [number, number] {
  const start = lineStart(text, line);
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    const j = skip(text, k);
    if (j !== k) {
      k = j - 1;
      continue;
    }
    const ch = text[k];
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) {
      depth--;
      if (depth === 0 && ch === "}" && !/^\s*;/.test(text.slice(k + 1, k + 40))) {
        // A function body ends here unless it was a brace initializer (`x{…};`).
        const before = text.slice(start, k);
        const firstBrace = before.indexOf("{");
        if (firstBrace >= 0 && /\)\s*(const|noexcept|override|\s)*$/.test(text.slice(start, start + firstBrace))) return [start, k + 1];
      }
    } else if (ch === ";" && depth === 0) return [start, k + 1];
  }
  return [start, text.length];
}

/** Top-level element spans inside a brace list's body [from, to). */
function elementSpans(text: string, from: number, to: number): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0,
    begin = from;
  const push = (end: number) => {
    // Trim whitespace and comments around the element.
    let a = begin,
      b = end;
    for (;;) {
      while (a < b && /\s/.test(text[a])) a++;
      const j = skip(text, a);
      if (j !== a && j <= b && (text.startsWith("//", a) || text.startsWith("/*", a))) a = j;
      else break;
    }
    const piece = text.slice(a, b).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    b = a + piece.trimEnd().length;
    if (b > a) spans.push([a, b]);
  };
  for (let k = from; k < to; k++) {
    const j = skip(text, k);
    if (j !== k) {
      k = j - 1;
      continue;
    }
    const ch = text[k];
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      push(k);
      begin = k + 1;
    }
  }
  push(to);
  return spans;
}

/** Where the setting's literal is in `text`: [start, end). */
export function locate(text: string, setting: Setting, index?: number): [number, number] {
  const { origin } = setting;
  const [start, end] = statementSpan(text, origin.line);
  if (origin.path) {
    let range: [number, number] = [start, end];
    const segments = origin.path.split(".");
    for (const [i, segment] of segments.entries()) {
      const pattern = new RegExp(`\\.With${segment}\\s*\\(`, "g");
      pattern.lastIndex = range[0];
      let hit: RegExpExecArray | null,
        last: RegExpExecArray | undefined;
      const body = text.slice(0, range[1]);
      while ((hit = pattern.exec(body))) {
        last = hit;
        if (i < segments.length - 1) break; // groups: the first; values: the last write wins
      }
      if (!last) {
        if (i < segments.length - 1) continue; // written without its group (`c.WithKP(…)`)
        throw new Error(`Could not find .With${segment}(…) in ${origin.file}:${origin.line}.`);
      }
      range = balanced(text, last.index + last[0].length - 1);
    }
    const raw = text.slice(range[0], range[1]);
    const lead = raw.length - raw.trimStart().length;
    return [range[0] + lead, range[0] + raw.trimEnd().length];
  }
  const declaration = new RegExp(`\\b${origin.name}\\s*(=|\\{)`, "g");
  declaration.lastIndex = start;
  const found = declaration.exec(text.slice(0, end));
  if (!found) throw new Error(`Could not find ${origin.name} in ${origin.file}:${origin.line}.`);
  let from = found.index + found[0].length;
  let to = end - 1; // the `;`
  if (found[1] === "{") {
    [from, to] = balanced(text, found.index + found[0].length - 1);
  } else {
    while (/\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
  }
  if (setting.list) {
    if (text[from] === "{") [from, to] = balanced(text, from);
    const spans = elementSpans(text, from, to);
    if (index === undefined || !spans[index]) throw new Error("No such list entry.");
    return spans[index];
  }
  if (text[from] === "{" && text[to - 1] === "}") [from, to] = balanced(text, from);
  const raw = text.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  return [from + lead, from + raw.trimEnd().length];
}

/** The file with the setting changed to `value`; throws when the source does not match. */
export function applyEdit(text: string, setting: Setting, value: string, index?: number): string {
  const info = editInfo(setting, index);
  if ("reason" in info) throw new Error(info.reason);
  const problem = checkValue(info, value);
  if (problem) throw new Error(problem);
  const [from, to] = locate(text, setting, index);
  const written = text.slice(from, to).trim();
  if (written !== info.literal)
    throw new Error(`The source changed since it was read (found "${written}", expected "${info.literal}"). Reload and try again.`);
  return text.slice(0, from) + newLiteral(info, value) + text.slice(to);
}
