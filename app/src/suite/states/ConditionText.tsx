import { Fragment, type ReactNode } from "react";
import { INPUT_CATEGORIES, type InputCategory } from "../core/inputCategories.ts";

// Quoted string values, then identifiers (input keys may contain dots, slashes and dashes).
const TOKENS = /"(?:[^"\\]|\\.)*"|[A-Za-z_][\w./-]*/g;

/** Split condition text into plain runs and input keys. */
function tokens(text: string, isKey: (word: string) => boolean): { text: string; key?: boolean }[] {
  const out: { text: string; key?: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    const word = m[0];
    if (word.startsWith('"') || !isKey(word)) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: word, key: true });
    last = m.index! + word.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const NBSP = "\u00A0";
/**
 * Keep conditions readable when they wrap: an operator stays with the term after it
 * (`a ∧ b` breaks only before `∧`), and a comparison (`stateTime > 2.5`) never splits.
 */
export function bind(text: string): string {
  return text
    .replace(/ ([∧∨]) /g, ` $1${NBSP}`)
    .replace(/ ([<>=]) /g, `${NBSP}$1${NBSP}`)
    .replace(/ (…) /g, ` $1${NBSP}`);
}

/** Plain text with each input followed by its category (for titles and messages). */
export function glyphText(text: string, isKey: (key: string) => boolean, categoryOf: (key: string) => InputCategory): string {
  return tokens(text, isKey)
    .map((t) => (t.key ? `${t.text} (${INPUT_CATEGORIES[categoryOf(t.text)].label.toLowerCase()})` : t.text))
    .join("");
}
/** Small colored letter badge for a category. */
function Badge({ category }: { category: InputCategory }) {
  const meta = INPUT_CATEGORIES[category];
  return (
    <span className={`mx-term-badge is-${category}`} aria-label={meta.label} role="img">
      {meta.letter}
    </span>
  );
}

/**
 * Condition text (as produced by compactCondition/edgeLabels) with each input key drawn in
 * its category color and prefixed with a letter badge, so the source is visible without
 * relying on color.
 */
export function ConditionText({
  text,
  isKey,
  categoryOf,
}: {
  text: string;
  isKey: (key: string) => boolean;
  categoryOf: (key: string) => InputCategory;
}) {
  // Each input becomes one unbreakable group with the operator before it ("∧ ¬", "(") and any
  // comparison after it ("> 2.5"), so wrapping happens only between whole terms.
  const parts = tokens(text, isKey).map((t) => (t.key ? t : { text: bind(t.text) }));
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.key) continue;
    const before = parts[i - 1] && !parts[i - 1].key ? parts[i - 1].text : "";
    const lead = /(?:[∧∨…]\u00A0)?[¬(]*$/.exec(before)![0];
    const after = parts[i + 1] && !parts[i + 1].key ? parts[i + 1].text : "";
    const trail = /^(?:\u00A0[<>=]\u00A0(?:"(?:[^"\\]|\\.)*"|[^\s)]+))?\)*/.exec(after)![0];
    if (before) parts[i - 1] = { text: before.slice(0, before.length - lead.length) };
    if (after) parts[i + 1] = { text: after.slice(trail.length) };
    const category = categoryOf(part.text);
    const meta = INPUT_CATEGORIES[category];
    out.push(
      <span key={`k${i}`} className="mx-term-group">
        {lead}
        <span className={`mx-term is-${category}`} title={`${meta.label}: ${meta.description}`}>
          <Badge category={category} />
          {part.text}
        </span>
        {trail}
      </span>,
    );
  }
  // Interleave the remaining plain text (spaces between groups) in order.
  const result: ReactNode[] = [];
  let k = 0;
  parts.forEach((part, i) => {
    if (part.key) result.push(out[k++]);
    else if (part.text) result.push(<Fragment key={`t${i}`}>{part.text}</Fragment>);
  });
  return <>{result}</>;
}

/** Legend for the categories used by a machine. */
export function CategoryLegend({ categories }: { categories: InputCategory[] }) {
  if (!categories.length) return null;
  return (
    <div className="mx-category-legend" aria-label="Input sources">
      {categories.map((c) => (
        <span key={c} className={`mx-term is-${c}`} title={INPUT_CATEGORIES[c].description}>
          <Badge category={c} />
          {INPUT_CATEGORIES[c].label}
        </span>
      ))}
    </div>
  );
}
