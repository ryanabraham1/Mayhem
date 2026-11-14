import { useMemo, useState, type ReactNode } from "react";
import { Pencil, Search, SlidersHorizontal } from "lucide-react";
import { editInfo } from "../core/review/edit.ts";
import { CATEGORY_NAMES, SAFETY_CATEGORIES, type Category, type Setting } from "../core/review/settings.ts";
import { Badge, EmptyState } from "../ui";
import type { EditTarget } from "./EditSetting";

export const ORDER = Object.keys(CATEGORY_NAMES) as Category[];

/** The label without what the section and card already say: "Front left drive motor CAN ID" → "Front left drive motor". */
export function shortLabel(label: string, subsystem: string, category: Category) {
  let text = label;
  if (category === "can-id") text = text.replace(/\s*CAN IDs?\b/, "");
  // Drop leading words that repeat the part's name ("Feeder motor left" on the Feeder card).
  const part = subsystem.toLowerCase().split(/\s+/).map((w) => w.replace(/s$/, ""));
  const words = text.split(/\s+/);
  let k = 0;
  while (k < words.length - 1 && k < part.length && words[k].toLowerCase().replace(/s$/, "") === part[k]) k++;
  text = words.slice(k).join(" ") || text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const where = (s: Setting) => `${s.file.split("/").pop()}:${s.line}${s.doc ? `\n${s.doc}` : ""}`;

/** Category sections, each with one card per part. */
export const sections = <T extends { category: Category; subsystem: string }>(rows: T[]) =>
  ORDER.map((category) => {
    const inCategory = rows.filter((r) => r.category === category);
    const parts = [...new Set(inCategory.map((r) => r.subsystem))].map((subsystem) => ({ subsystem, rows: inCategory.filter((r) => r.subsystem === subsystem) }));
    return { category, parts, count: inCategory.length };
  }).filter((g) => g.count);

/** A section heading with the safety chip, and its cards. */
export function SpecSection({ category, children }: { category: Category; children: ReactNode }) {
  return (
    <section className="mx-spec-section" aria-label={CATEGORY_NAMES[category]}>
      <h2>
        {CATEGORY_NAMES[category]}
        {SAFETY_CATEGORIES.has(category) && <Badge tone="bad">safety</Badge>}
      </h2>
      <div className="mx-spec-grid">{children}</div>
    </section>
  );
}

const count = (s: Setting) => s.list?.length ?? 1;

/**
 * Every value in the robot code as a spec sheet, with tabs for the kind of value (CAN IDs,
 * current limits…) and the part (Shooter, Drivetrain…) so one is quick to find among hundreds.
 */
export function ValuesBrowser({ settings, editable, editSetting }: { settings: Setting[]; editable: boolean; editSetting: (t: EditTarget) => void }) {
  const [query, setQuery] = useState("");
  const [showSim, setShowSim] = useState(false);
  const [kind, setKind] = useState<Category | "">("");
  const [part, setPart] = useState("");

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return settings.filter(
      (s) => (showSim || s.category !== "simulation") && (!q || `${s.subsystem} ${s.label} ${CATEGORY_NAMES[s.category]} ${s.display}`.toLowerCase().includes(q)),
    );
  }, [settings, query, showSim]);
  // Each tab row counts what the other row leaves, so a tab never leads to an empty page.
  const tally = <K extends string>(rows: Setting[], key: (s: Setting) => K) => {
    const n = new Map<K, number>();
    for (const s of rows) n.set(key(s), (n.get(key(s)) ?? 0) + count(s));
    return n;
  };
  const kinds = tally(part ? searched.filter((s) => s.subsystem === part) : searched, (s) => s.category);
  const parts = tally(kind ? searched.filter((s) => s.category === kind) : searched, (s) => s.subsystem);
  const shown = searched.filter((s) => (!kind || s.category === kind) && (!part || s.subsystem === part));

  const editButton = (s: Setting, index?: number) => {
    if (!editable) return null;
    const info = editInfo(s, index);
    if ("reason" in info) return <span className="mx-spec-edit-gap" />;
    return (
      <button type="button" className="mx-spec-edit" title="Edit in the robot code" aria-label={`Edit ${s.subsystem} ${s.label}`} onClick={() => editSetting({ setting: s, index })}>
        <Pencil size={12} />
      </button>
    );
  };

  const settingRows = (s: Setting) => {
    const label = shortLabel(s.label, s.subsystem, s.category);
    if (s.list)
      return s.list.map((v, i) => (
        <div key={`${s.key}:${i}`} className="mx-spec-row" title={where(s)}>
          <span>{s.elementNotes?.[i] ? `${label.replace(/s$/, "")} · ${s.elementNotes[i]}` : `${label.replace(/s$/, "")} ${i + 1}`}</span>
          <b>{v}</b>
          {editButton(s, i)}
        </div>
      ));
    if (s.table)
      return [
        <div key={s.key} className="mx-spec-row is-table" title={where(s)}>
          <span>
            {label}
            {s.tableUnits ? <small> ({s.tableUnits[0]} → {s.tableUnits[1]})</small> : null}
          </span>
          <span className="mx-spec-table">
            {s.table.map(([x, y]) => (
              <span key={x}>
                <small>{x}</small>
                <b>{y}</b>
              </span>
            ))}
          </span>
        </div>,
      ];
    return [
      <div key={s.key} className="mx-spec-row" title={where(s)}>
        <span>{label}</span>
        <b>{s.display}</b>
        {editButton(s)}
      </div>,
    ];
  };

  const total = (n: Map<string, number>) => [...n.values()].reduce((a, b) => a + b, 0);
  const tab = (active: boolean, label: string, n: number | undefined, pick: () => void, safety = false) => (
    <button key={label} type="button" role="tab" aria-selected={active} className={`mx-values-tab ${active ? "is-on" : ""} ${safety ? "is-safety" : ""}`} onClick={pick}>
      {label}
      <small>{n ?? 0}</small>
    </button>
  );
  const list = sections(shown);
  return (
    <div className="mx-values">
      <div className="mx-values-nav">
        <div className="mx-toolbar">
          <label className="mx-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: shooter current, CAN, slide…" aria-label="Search values" />
          </label>
          <label className="mx-check">
            <input type="checkbox" checked={showSim} onChange={(e) => setShowSim(e.target.checked)} /> Simulation-only values
          </label>
        </div>
        <div className="mx-values-tabs" role="tablist" aria-label="Kind of value">
          <span className="mx-values-tabs-label">Kind</span>
          {tab(!kind, "All", total(kinds), () => setKind(""))}
          {ORDER.filter((c) => kinds.has(c) || c === kind).map((c) => tab(kind === c, CATEGORY_NAMES[c], kinds.get(c), () => setKind(kind === c ? "" : c), SAFETY_CATEGORIES.has(c)))}
        </div>
        <div className="mx-values-tabs" role="tablist" aria-label="Part">
          <span className="mx-values-tabs-label">Part</span>
          {tab(!part, "All parts", total(parts), () => setPart(""))}
          {[...parts.keys(), ...(part && !parts.has(part) ? [part] : [])]
            .sort((a, b) => a.localeCompare(b))
            .map((p) => tab(part === p, p, parts.get(p), () => setPart(part === p ? "" : p)))}
        </div>
      </div>
      {!list.length && (
        <EmptyState icon={SlidersHorizontal} title="No values here">
          {query ? "Nothing matches the search." : "Pick another kind or part."}
        </EmptyState>
      )}
      {list.map(({ category, parts }) => (
        <SpecSection key={category} category={category}>
          {parts.map(({ subsystem, rows }) => (
            <article key={subsystem} className="mx-spec-card">
              <h3>{subsystem}</h3>
              {rows.flatMap(settingRows)}
            </article>
          ))}
        </SpecSection>
      ))}
      {list.length > 0 && <p className="mx-help">Hover a value to see where it's written in the robot code.</p>}
    </div>
  );
}
