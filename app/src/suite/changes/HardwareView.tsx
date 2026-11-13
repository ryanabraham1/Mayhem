import { useMemo, useState } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { DEVICE_FIELDS, type Device, type DeviceChange } from "../core/review/hardware.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { Badge, EmptyState } from "../ui";
import { Cpu } from "lucide-react";
import type { EditTarget } from "./EditSetting";
import type { Review } from "./useReview";

const MODULES = ["Front left", "Front right", "Back left", "Back right"] as const;
const moduleOf = (d: Device) => MODULES.find((m) => d.subsystem === "Drivetrain" && d.name.startsWith(m));

/** Top-down robot: swerve modules at the corners, every other subsystem as a tile in the middle. */
export function RobotDiagram({
  devices,
  changes,
  selected,
  select,
}: {
  devices: Device[];
  changes: Map<string, DeviceChange>;
  selected: string;
  select: (group: string) => void;
}) {
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    const group = moduleOf(d) ? `Drivetrain · ${moduleOf(d)}` : d.subsystem;
    groups.set(group, [...(groups.get(group) ?? []), d]);
  }
  const tile = (group: string, className = "") => {
    const list = groups.get(group) ?? [];
    const changed = list.filter((d) => changes.has(d.key)).length;
    return (
      <button
        type="button"
        key={group}
        className={`mx-hw-tile ${className} ${changed ? "is-changed" : ""} ${selected === group ? "is-selected" : ""}`}
        onClick={() => select(group)}
        aria-pressed={selected === group}
      >
        <strong>{group.replace("Drivetrain · ", "")}</strong>
        <span className="mx-hw-ids">
          {list.map((d) => (
            <i key={d.key} className={changes.has(d.key) ? "is-changed" : ""} title={`${d.name} (${d.kind})`}>
              {d.kind === "Talon FX" ? "" : d.kind === "CANcoder" ? "enc " : d.kind === "Pigeon 2" ? "gyro " : ""}
              {d.fields["CAN ID"] ?? "?"}
            </i>
          ))}
        </span>
        {changed > 0 && <Badge tone="bad">{changed} changed</Badge>}
      </button>
    );
  };
  const middle = [...groups.keys()].filter((g) => !g.startsWith("Drivetrain · "));
  return (
    <div className="mx-hw-robot" aria-label="Robot hardware map (top view, front at the top)">
      <span className="mx-hw-front">Front</span>
      {[MODULES.slice(0, 2), MODULES.slice(2)].map((row, i) => {
        const modules = (
          <div key={row[0]} className="mx-hw-modules">
            {row.map((m) => (groups.has(`Drivetrain · ${m}`) ? tile(`Drivetrain · ${m}`, "is-module") : <span key={m} />))}
          </div>
        );
        return i === 0 ? modules : [<div key="body" className="mx-hw-body">{middle.map((g) => tile(g))}</div>, modules];
      })}
    </div>
  );
}

export function HardwareView({
  report,
  review,
  editSetting,
}: {
  report: ReviewReport;
  review: Review;
  editSetting: (target: EditTarget) => void;
}) {
  const changes = useMemo(() => new Map(report.devices.map((c) => [c.key, c])), [report.devices]);
  const removed = report.devices.filter((c) => c.kind === "removed").map((c) => c.before!);
  const devices = [...report.hardware.after, ...removed];
  const firstChanged = report.devices[0];
  const [selected, setSelected] = useState(() => {
    const d = firstChanged?.after ?? firstChanged?.before ?? devices[0];
    return d ? (moduleOf(d) ? `Drivetrain · ${moduleOf(d)}` : d.subsystem) : "";
  });
  if (!devices.length)
    return (
      <EmptyState icon={Cpu} title="No devices found">
        No CAN ID constants were found in <code>src/main/include</code>. Device names come from constants such as{" "}
        <code>kLeftMotorId</code>.
      </EmptyState>
    );
  const shown = devices.filter((d) => (moduleOf(d) ? `Drivetrain · ${moduleOf(d)}` : d.subsystem) === selected);
  const fields = DEVICE_FIELDS.filter((f) => shown.some((d) => d.fields[f] !== undefined || changes.get(d.key)?.fields.some((c) => c.field === f)));
  const settingByKey = new Map(review.settingsAfter.map((s) => [s.key, s]));

  return (
    <div className="mx-hw">
      {report.duplicates.length > 0 && (
        <div className="mx-callout is-bad" role="alert">
          <TriangleAlert size={16} />
          <span>
            {report.duplicates.map((d) => `CAN ID ${d.canId} is shared by ${d.devices.join(" and ")}`).join(". ")}. Devices of the same
            type need different IDs on the same CAN bus.
          </span>
        </div>
      )}
      <RobotDiagram devices={devices} changes={changes} selected={selected} select={setSelected} />
      <section className="mx-panel is-flush mx-hw-table" aria-label={`${selected} devices`}>
        <header className="mx-panel-head">
          <h2>{selected}</h2>
          {!review.editable && review.snapshots && <small className="mx-help">To edit, set “After” to This computer.</small>}
        </header>
        <div className="mx-table-scroll">
          <table className="mx-review-table">
            <thead>
              <tr>
                <th>Device</th>
                {fields.map((f) => (
                  <th key={f}>{f}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const change = changes.get(d.key);
                return (
                  <tr key={d.key} className={change ? `is-${change.kind}` : ""}>
                    <th scope="row">
                      {d.name}
                      <small>{d.kind}</small>
                      {change && change.kind !== "changed" && <Badge tone="bad">{change.kind}</Badge>}
                    </th>
                    {fields.map((f) => {
                      const diff = change?.fields.find((c) => c.field === f);
                      const source = d.fieldSources[f];
                      const setting = source && settingByKey.get(source.key);
                      const value = d.fields[f];
                      return (
                        <td key={f} className={diff ? "is-changed" : ""}>
                          {diff ? (
                            <span className="mx-before-after">
                              <s>{diff.before ?? "—"}</s> {diff.after ?? "—"}
                            </span>
                          ) : (
                            value ?? <span className="mx-muted">—</span>
                          )}
                          {review.editable && setting && change?.kind !== "removed" && (
                            <button
                              type="button"
                              className="mx-cell-edit"
                              aria-label={`Edit ${d.name} ${f}`}
                              title="Edit in the robot code"
                              onClick={() => editSetting({ setting, index: source.index, title: `${d.subsystem} · ${d.name} · ${f}` })}
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mx-help mx-hw-note">
          Read from the robot code's constants and motor configurations. A simulated check of what each motor actually receives comes
          with sim proof.
        </p>
      </section>
    </div>
  );
}
