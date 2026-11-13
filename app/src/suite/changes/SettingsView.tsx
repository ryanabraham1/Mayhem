import { useMemo, useState } from "react";
import { Pencil, Search, SlidersHorizontal } from "lucide-react";
import { editInfo } from "../core/review/edit.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { CATEGORY_NAMES, SAFETY_CATEGORIES, type Category, type Setting, type SettingChange } from "../core/review/settings.ts";
import { Badge, EmptyState, Segmented } from "../ui";
import type { EditTarget } from "./EditSetting";
import type { Review } from "./useReview";

const ORDER = Object.keys(CATEGORY_NAMES) as Category[];

function ChangeValue({ c }: { c: SettingChange }) {
  if (c.rows?.length)
    return (
      <table className="mx-lut">
        <thead>
          <tr>
            <th>{c.after?.tableUnits?.[0] ? `Input (${c.after.tableUnits[0]})` : "Input"}</th>
            <th>Before</th>
            <th>After{c.after?.tableUnits?.[1] ? ` (${c.after.tableUnits[1]})` : ""}</th>
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.input}>
              <td>{r.input}</td>
              <td>{r.before ?? "—"}</td>
              <td>{r.after ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  if (c.kind === "added") return <span>New: {c.after!.display}</span>;
  if (c.kind === "removed") return <span className="mx-before-after"><s>{c.before!.display}</s> removed</span>;
  return (
    <span className="mx-before-after">
      <s>{c.before!.display}</s> {c.after!.display}
      {c.because?.length ? <small> (because {c.because.map((k) => k.split("::").pop()).join(", ")} changed)</small> : null}
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
    return (
      <button
        type="button"
        className="mx-cell-edit"
        disabled={"reason" in info}
        title={"reason" in info ? info.reason : "Edit in the robot code"}
        aria-label={`Edit ${s.subsystem} ${s.label}`}
        onClick={() => editSetting({ setting: s, index })}
      >
        <Pencil size={12} />
      </button>
    );
  };

  const grouped = <T extends { category: Category }>(rows: T[]) =>
    ORDER.map((category) => ({ category, rows: rows.filter((r) => r.category === category) })).filter((g) => g.rows.length);

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
      {(mode === "changes" ? grouped(changes) : grouped(all)).map(({ category, rows }) => (
        <section key={category} className="mx-panel is-flush mx-settings-group">
          <header className="mx-panel-head">
            <h2>
              {CATEGORY_NAMES[category]}
              {SAFETY_CATEGORIES.has(category) && <Badge tone="bad">safety</Badge>}
            </h2>
            <small className="mx-help">{rows.length}</small>
          </header>
          <div className="mx-value-grid">
            {mode === "changes"
              ? (rows as SettingChange[]).map((c) => {
                  const s = (c.after ?? c.before)!;
                  return (
                    <article key={c.key} className={`mx-value is-${c.kind} ${c.rows?.length ? "is-wide" : ""}`} title={s.doc}>
                      <header>
                        <strong>{c.label}</strong>
                      </header>
                      <div className="mx-value-main">
                        <ChangeValue c={c} />
                      </div>
                      <footer>
                        {c.subsystem} · {s.file.split("/").pop()}:{s.line}
                      </footer>
                    </article>
                  );
                })
              : (rows as Setting[]).map((s) => (
                  <article key={s.key} className={`mx-value ${s.table || (s.list && s.list.length > 3) ? "is-wide" : ""}`} title={s.doc}>
                    <header>
                      <strong>{s.label}</strong>
                      {!s.list && editButton(s)}
                    </header>
                    <div className="mx-value-main">
                      {s.list ? (
                        <span className="mx-list-values">
                          {s.list.map((v, i) => (
                            <span key={i} className="mx-list-value">
                              {s.elementNotes?.[i] ? <small>{s.elementNotes[i]}</small> : null}
                              <b>{v}</b>
                              {editButton(s, i)}
                            </span>
                          ))}
                        </span>
                      ) : s.table ? (
                        <table className="mx-lut">
                          <thead>
                            <tr>
                              <th>{s.tableUnits?.[0] ? `In (${s.tableUnits[0]})` : "In"}</th>
                              {s.table.map(([x]) => (
                                <td key={x}>{x}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <th>{s.tableUnits?.[1] ? `Out (${s.tableUnits[1]})` : "Out"}</th>
                              {s.table.map(([x, y]) => (
                                <td key={x}>{y}</td>
                              ))}
                            </tr>
                          </tbody>
                        </table>
                      ) : (
                        <b>{s.display}</b>
                      )}
                    </div>
                    <footer>
                      {s.subsystem} · {s.file.split("/").pop()}:{s.line}
                      {s.doc ? <span className="mx-value-doc">{s.doc}</span> : null}
                    </footer>
                  </article>
                ))}
          </div>
        </section>
      ))}
    </div>
  );
}
