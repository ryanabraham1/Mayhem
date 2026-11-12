import { Fragment } from "react";
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
  return (
    <>
      {tokens(text, isKey).map((t, i) => {
        if (!t.key) return <Fragment key={i}>{t.text}</Fragment>;
        const category = categoryOf(t.text);
        const meta = INPUT_CATEGORIES[category];
        return (
          <span key={i} className={`mx-term is-${category}`} title={`${meta.label}: ${meta.description}`}>
            <Badge category={category} />
            {t.text}
          </span>
        );
      })}
    </>
  );
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
