import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert, TriangleAlert, X } from "lucide-react";
import { checkValue, editInfo } from "../core/review/edit.ts";
import { duplicateIds, readDevices } from "../core/review/hardware.ts";
import { settingsOf } from "../core/review/report.ts";
import { CATEGORY_NAMES, SAFETY_CATEGORIES, type Setting } from "../core/review/settings.ts";
import { Button } from "../ui";
import type { Review } from "./useReview";

/** One value to edit: a setting, and the list entry when the setting is a list (CAN IDs). */
export interface EditTarget {
  setting: Setting;
  index?: number;
  /** What a person called it where they clicked (`Shooter · Motor 3 · CAN ID`). */
  title?: string;
}

export function EditSetting({ review, target, close }: { review: Review; target: EditTarget; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { setting, index } = target;
  const info = editInfo(setting, index);
  const [value, setValue] = useState("reason" in info ? "" : info.current);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);

  // Everything this one source value also controls: other configurations that inherit it, and devices.
  const sameSource = (s: Setting) =>
    s.origin.file === setting.origin.file && s.origin.line === setting.origin.line && s.origin.name === setting.origin.name && s.origin.path === setting.origin.path;
  const shared = useMemo(() => {
    const keys = new Set(review.settingsAfter.filter(sameSource).map((s) => s.key));
    return readDevices(review.settingsAfter)
      .filter((d) => Object.values(d.fieldSources).some((f) => keys.has(f.key) && (index === undefined || f.index === undefined || f.index === index)))
      .map((d) => `${d.subsystem} · ${d.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.settingsAfter, setting, index]);

  const problem = "reason" in info ? info.reason : checkValue(info, value);
  const result = useMemo(() => (problem || "reason" in info ? undefined : review.preview(setting, value, index)), [problem, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const conflicts = useMemo(() => {
    if (!result || "error" in result) return [];
    const was = new Set(duplicateIds(readDevices(review.settingsAfter)).map((d) => `${d.kind}${d.canId}`));
    return duplicateIds(readDevices(settingsOf({ rev: "", label: "", files: result.files }))).filter((d) => !was.has(`${d.kind}${d.canId}`));
  }, [result, review.settingsAfter]);
  const safety = SAFETY_CATEGORIES.has(setting.category);
  const unchanged = !("reason" in info) && value.trim() === info.current;

  const save = async () => {
    setSaving(true);
    setFailure(undefined);
    try {
      await review.edit(setting, value.trim(), index);
      close();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="mx-dialog mx-edit-setting" aria-label="Edit value" onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>{target.title ?? `${setting.subsystem} · ${setting.label}`}</h2>
          <p>
            {CATEGORY_NAMES[setting.category]} · written in <code>{setting.origin.file.split("/").pop()}</code> line {setting.origin.line}
          </p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {"reason" in info ? (
        <p className="mx-help">{info.reason}</p>
      ) : (
        <>
          <label className="mx-edit-value">
            <span>New value</span>
            {info.kind === "enum" ? (
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                {info.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : info.kind === "bool" ? (
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="true">{setting.category === "inversion" ? "Yes / inverted" : "On"}</option>
                <option value="false">{setting.category === "inversion" ? "No / normal" : "Off"}</option>
              </select>
            ) : (
              <span className="mx-edit-number">
                <input
                  autoFocus
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !problem && !unchanged && void save()}
                  aria-label="New value"
                />
                {info.unit && <small>{info.unit}</small>}
              </span>
            )}
            <small className="mx-help">Now: {setting.list && index !== undefined ? setting.list[index] : setting.display}</small>
          </label>
          {problem && <p className="mx-help is-bad">{problem}</p>}
          {result && "error" in result && <p className="mx-help is-bad">{result.error}</p>}
          {shared.length > 1 && (
            <div className="mx-callout is-warn">
              <TriangleAlert size={16} />
              <span>
                This one value is shared. Changing it changes all of: {shared.join(", ")}.
              </span>
            </div>
          )}
          {setting.origin.inheritedFrom && (
            <p className="mx-help">
              Inherited from <code>{setting.origin.inheritedFrom.split("::").pop()}</code>; the edit is made there.
            </p>
          )}
          {conflicts.map((d) => (
            <div key={`${d.kind}${d.canId}`} className="mx-callout is-bad" role="alert">
              <TriangleAlert size={16} />
              <span>
                CAN ID {d.canId} would be used by {d.devices.length} {d.kind} devices: {d.devices.join(", ")}.
              </span>
            </div>
          ))}
          {safety && (
            <div className="mx-callout is-bad">
              <ShieldAlert size={16} />
              <span>
                Safety setting: the change is marked red on the Changes page.
              </span>
            </div>
          )}
          {failure && <p className="mx-help is-bad">{failure}</p>}
        </>
      )}
      <div className="mx-dialog-actions">
        <Button onClick={close}>Cancel</Button>
        {!("reason" in info) && (
          <Button variant="primary" disabled={!!problem || unchanged || saving || (!!result && "error" in result)} onClick={() => void save()}>
            {saving ? "Saving…" : "Save to robot code"}
          </Button>
        )}
      </div>
    </dialog>
  );
}
