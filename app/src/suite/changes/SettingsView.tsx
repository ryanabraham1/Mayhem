import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ReviewReport } from "../core/review/report.ts";
import type { SettingChange } from "../core/review/settings.ts";
import { EmptyState, Segmented } from "../ui";
import type { EditTarget } from "./EditSetting";
import type { Review } from "./useReview";
import { sections, shortLabel, SpecSection, ValuesBrowser, where } from "./ValuesBrowser";

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
  const [showSim, setShowSim] = useState(false);
  const changes = report.settings.filter((c) => showSim || c.category !== "simulation");
  const which = (
    <Segmented
      label="Which values"
      value={mode}
      onChange={setMode}
      options={[
        { value: "changes", label: `Changed (${changes.length})` },
        { value: "all", label: "All values" },
      ]}
    />
  );
  if (mode === "all")
    return (
      <div className="mx-settings-view">
        <div className="mx-toolbar">{which}</div>
        <ValuesBrowser settings={review.settingsAfter} editable={review.editable} editSetting={editSetting} />
      </div>
    );
  const list = sections(changes);
  return (
    <div className="mx-settings-view">
      <div className="mx-toolbar">
        {which}
        <label className="mx-check">
          <input type="checkbox" checked={showSim} onChange={(e) => setShowSim(e.target.checked)} /> Simulation-only values
        </label>
      </div>
      {!changes.length && (
        <EmptyState icon={SlidersHorizontal} title="No values changed">
          Constants and motor settings are the same in both versions.
        </EmptyState>
      )}
      {list.map(({ category, parts }) => (
        <SpecSection key={category} category={category}>
          {parts.map(({ subsystem, rows }) => (
            <article key={subsystem} className="mx-spec-card">
              <h3>{subsystem}</h3>
              {(rows as SettingChange[]).map((c) => {
                const s = (c.after ?? c.before)!;
                return (
                  <div key={c.key} className={`mx-spec-row is-${c.kind}`} title={where(s)}>
                    <span>{shortLabel(c.label, c.subsystem, c.category)}</span>
                    <ChangeValue c={c} />
                  </div>
                );
              })}
            </article>
          ))}
        </SpecSection>
      ))}
      {list.length > 0 && <p className="mx-help">Hover a value to see where it's written in the robot code.</p>}
    </div>
  );
}
