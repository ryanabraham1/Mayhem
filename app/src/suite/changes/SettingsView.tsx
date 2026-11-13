import { useMemo, useState } from "react";
import { Pencil, Search, SlidersHorizontal } from "lucide-react";
import { editInfo } from "../core/review/edit.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { CATEGORY_NAMES, SAFETY_CATEGORIES, type Category, type Setting, type SettingChange } from "../core/review/settings.ts";
import { Badge, EmptyState, Segmented } from "../ui";
import type { EditTarget } from "./EditSetting";
import type { Review } from "./useReview";

const ORDER = Object.keys(CATEGORY_NAMES) as Category[];

/** The label without what the section and card already say: "Front left drive motor CAN ID" → "Front left drive motor". */
function shortLabel(label: string, subsystem: string, category: Category) {
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

const where = (s: Setting) => `${s.file.split("/").pop()}:${s.line}${s.doc ? `\n${s.doc}` : ""}`;

function ChangeValue({ c }: { c: SettingChange }) {
  if (c.rows?.length)
    return (
      <span className="mx-spec-change">
        {c.rows.map((r) => (
          <span key={r.input}>
            at {r.input}
            {c.after?.tableUnits?.[0] ? ` ${c.after.tableUnits[0]}` : ""}: <s>{r.before ?? "—"}</s> {r.after ?? "—"}
          </span>
        ))}
      </span>
    );
  if (c.kind === "added") return <b>{c.after!.display} <small>new</small></b>;
  if (c.kind === "removed") return <span className="mx-spec-change"><s>{c.before!.display}</s> removed</span>;
  return (
    <span className="mx-spec-change" title={c.because?.length ? `Because ${c.because.map((k) => k.split("::").pop()).join(", ")} changed` : undefined}>
      <s>{c.before!.display}</s> <b>{c.after!.display}</b>
    </span>
  );
}

export function SettingsView({ report, review, editSetting }: { report: ReviewReport; review: Review; editSetting: (t: EditTarget) => void }) {
  const [mode, setMode] = useState<"changes" | "all">(report.settings.some((c) => c.category !== "simulation") ? "changes" : "all");
  const [query, setQuery] = useState("");
  const [showSim, setShowSim] = useState(false);
  const changes = report.settings.filter((c) => showSim || c.category !== "simulation");
  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    return review.settingsAfter.filter(
      (s) => (showSim || s.category !== "simulation") && (!q || `${s.subsystem} ${s.label} ${CATEGORY_NAMES[s.category]} ${s.display}`.toLowerCase().includes(q)),
    );
  }, [review.settingsAfter, query, showSim]);

  const editButton = (s: Setting, index?: number) => {
    if (!review.editable) return null;
    const info = editInfo(s, index);
    if ("reason" in info) return <span className="mx-spec-edit-gap" />;
    return (
      <button type="button" className="mx-spec-edit" title="Edit in the robot code" aria-label={`Edit ${s.subsystem} ${s.label}`} onClick={() => editSetting({ setting: s, index })}>
        <Pencil size={12} />
      </button>
    );
  };

  /** Category sections, each with one card per part. */
  const sections = <T extends { category: Category; subsystem: string }>(rows: T[]) =>
    ORDER.map((category) => {
      const inCategory = rows.filter((r) => r.category === category);
      const parts = [...new Set(inCategory.map((r) => r.subsystem))].map((subsystem) => ({ subsystem, rows: inCategory.filter((r) => r.subsystem === subsystem) }));
      return { category, parts, count: inCategory.length };
    }).filter((g) => g.count);

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

  const list = mode === "changes" ? sections(changes) : sections(all);
  return (
    <div className="mx-settings-view">
      <div className="mx-toolbar">
        <Segmented
          label="Which values"
          value={mode}
          onChange={setMode}
          options={[
            { value: "changes", label: `Changed (${changes.length})` },
            { value: "all", label: "All values" },
          ]}
        />
        {mode === "all" && (
          <label className="mx-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: shooter current, CAN, slide…" aria-label="Search values" />
          </label>
        )}
        <label className="mx-check">
          <input type="checkbox" checked={showSim} onChange={(e) => setShowSim(e.target.checked)} /> Simulation-only values
        </label>
      </div>
      {mode === "changes" && !changes.length && (
        <EmptyState icon={SlidersHorizontal} title="No values changed">
          Constants and motor settings are the same in both versions.
        </EmptyState>
      )}
      {list.map(({ category, parts }) => (
        <section key={category} className="mx-spec-section" aria-label={CATEGORY_NAMES[category]}>
          <h2>
            {CATEGORY_NAMES[category]}
            {SAFETY_CATEGORIES.has(category) && <Badge tone="bad">safety</Badge>}
          </h2>
          <div className="mx-spec-grid">
            {parts.map(({ subsystem, rows }) => (
              <article key={subsystem} className="mx-spec-card">
                <h3>{subsystem}</h3>
                {mode === "changes"
                  ? (rows as SettingChange[]).map((c) => {
                      const s = (c.after ?? c.before)!;
                      return (
                        <div key={c.key} className={`mx-spec-row is-${c.kind}`} title={where(s)}>
                          <span>{shortLabel(c.label, c.subsystem, c.category)}</span>
                          <ChangeValue c={c} />
                        </div>
                      );
                    })
                  : (rows as Setting[]).flatMap(settingRows)}
              </article>
            ))}
          </div>
        </section>
      ))}
      {list.length > 0 && <p className="mx-help">Hover a value to see where it's written in the robot code.</p>}
    </div>
  );
}
