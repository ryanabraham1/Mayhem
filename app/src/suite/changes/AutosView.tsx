import { useState } from "react";
import { Navigation } from "lucide-react";
import { FieldArt } from "../../components/FieldArt";
import type { Field as FieldModel } from "../../types";
import field from "../core/rebuilt-2026.json";
import type { DrivenPath, RoutineDiff } from "../core/review/autos.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { Badge, EmptyState, Segmented, Stat, type Tone } from "../ui";
import { useTasks } from "../tasks/feedback";
import { fieldPoint } from "../tasks/anchors";
import { speedColor, speedRunsFor } from "../FieldView";

type Show = "both" | "before" | "after";
const TONE: Record<string, Tone> = { added: "good", removed: "bad", changed: "warn", same: "neutral" };
const points = (p: DrivenPath) => p.poses.map((q) => `${q.x.toFixed(3)},${(field.width - q.y).toFixed(3)}`).join(" ");

function Robot({ pose, className }: { pose: { x: number; y: number; heading: number }; className: string }) {
  return (
    <g className={className} transform={`translate(${pose.x},${field.width - pose.y}) rotate(${(-pose.heading * 180) / Math.PI})`}>
      <rect x="-.42" y="-.42" width=".84" height=".84" rx=".06" />
      <path d="M-.12,-.17 L.15,0 L-.12,.17" fill="none" />
    </g>
  );
}

/** The path colored by speed, red (slow) to green (fast), like the Autonomous editor; plain when the review has no speeds. */
function SpeedPath({ path, max, className }: { path: DrivenPath; max: number; className: string }) {
  if (!path.speeds) return <polyline className={className} points={points(path)} />;
  const runs = speedRunsFor(path.poses.map((p, i) => ({ x: p.x, y: p.y, speed: path.speeds![i] ?? 0 })), max);
  return (
    <g className={`${className} is-speed`}>
      {runs.map((run, i) => (
        <polyline key={i} points={run.points.map(([x, y]) => `${x.toFixed(3)},${(field.width - y).toFixed(3)}`).join(" ")} stroke={run.color} />
      ))}
    </g>
  );
}

const topSpeed = (r: RoutineDiff) => Math.max(0.5, ...(r.before?.speeds ?? []), ...(r.after?.speeds ?? []));

function Overlay({ r, revision, show }: { r: RoutineDiff; revision: string; show: Show }) {
  const { openFeedback } = useTasks();
  const max = topSpeed(r);
  return (
    <svg
      className="mx-replay-field mx-auto-overlay is-clickable"
      viewBox={`-.3 -.3 ${field.length + 0.6} ${field.width + 0.6}`}
      aria-label={`${r.name}: old and new paths (click to comment on a spot)`}
      onClick={(e) =>
        openFeedback({
          kind: "field-point",
          title: `${r.name}: `,
          context: "Pinned to this spot on the field for this auto.",
          anchor: { routine: r.name, revision, pose: fieldPoint(e.currentTarget, e.clientX, e.clientY, field.width) },
        })
      }
    >
      <g aria-hidden="true" transform={`translate(0 ${field.width}) scale(1 -1)`}>
        <FieldArt field={field as FieldModel} hideFuel />
      </g>
      {r.before && show !== "after" && <SpeedPath path={r.before} max={max} className={`is-before${show === "before" ? " is-alone" : ""}`} />}
      {r.after && show !== "before" && <SpeedPath path={r.after} max={max} className="is-after" />}
      {r.before && show !== "after" && <Robot pose={r.before.end} className="mx-overlay-robot is-before" />}
      {r.after && show !== "before" && <Robot pose={r.after.end} className="mx-overlay-robot is-after" />}
    </svg>
  );
}

const stat = (b?: number, a?: number, unit = "") =>
  b === undefined ? `${a?.toFixed(1)}${unit}` : a === undefined ? `${b.toFixed(1)}${unit} → removed` : Math.abs(a - b) < 0.05 ? `${a.toFixed(1)}${unit}` : `${b.toFixed(1)} → ${a.toFixed(1)}${unit}`;

export function AutosView({ report }: { report: ReviewReport }) {
  const routines = [...report.routines].sort((a, b) => Number(a.kind === "same") - Number(b.kind === "same"));
  const [picked, setPicked] = useState(routines[0]?.id);
  const [show, setShow] = useState<Show>("both");
  const r = routines.find((x) => x.id === picked);
  if (!routines.length)
    return (
      <EmptyState icon={Navigation} title="No autonomous routines">
        Autos are read from the Mayhem project file at the root of the robot repo (<code>robot.mayhem.json</code>).
      </EmptyState>
    );
  return (
    <div className="mx-autos-diff">
      <nav className="mx-rail" aria-label="Routines">
        {routines.map((x) => (
          <button key={x.id} type="button" className={x.id === picked ? "is-active" : ""} onClick={() => setPicked(x.id)}>
            <span>{x.name}</span>
            {x.kind !== "same" && <Badge tone={TONE[x.kind]}>{x.kind}</Badge>}
          </button>
        ))}
      </nav>
      {r && (
        <div className="mx-autos-main">
          <div className="mx-autos-legend">
            <Segmented
              label="Which path"
              value={show}
              onChange={setShow}
              options={[
                { value: "both", label: "Before & after" },
                { value: "before", label: "Before" },
                { value: "after", label: "After" },
              ]}
            />
            <div className="mx-legend" aria-label="Legend">
              {show !== "after" && <span className="is-before">Before</span>}
              {show !== "before" && <span className="is-after">After</span>}
              {(r.before?.speeds || r.after?.speeds) && (
                <span className="mx-speed-scale" style={{ background: `linear-gradient(90deg, ${speedColor(0)}, ${speedColor(0.5)}, ${speedColor(1)})` }}>
                  <small>0</small>
                  <small>{topSpeed(r).toFixed(1)} m/s</small>
                </span>
              )}
            </div>
          </div>
          <Overlay r={r} revision={report.after.rev} show={show} />
          <div className="mx-stats">
            <Stat label="Time" value={stat(r.before?.time, r.after?.time, " s")} />
            <Stat label="Distance" value={stat(r.before?.distance, r.after?.distance, " m")} />
            <Stat
              label="Path preview"
              value={r.after ? (r.after.status === "completed" ? "Finishes" : r.after.status === "failed" ? "Fails" : "Doesn't finish") : "—"}
              tone={r.after?.status === "completed" ? "good" : "bad"}
            />
            {r.startMoved !== undefined && <Stat label="Start moved" value={r.startMoved.toFixed(2)} unit="m" tone="warn" />}
          </div>
          {r.steps.length > 0 ? (
            <ul className="mx-change-list">
              {r.steps.map((s) => (
                <li key={s.id} className={`is-${s.kind}`}>
                  <Badge tone={TONE[s.kind]}>{s.kind}</Badge> <strong>{s.name}</strong>
                  {s.details.length > 0 && <span className="mx-before-after"> · {s.details.join(" · ")}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mx-help">{r.kind === "same" ? "No changes to this routine." : "No step changes: robot or path limits changed."}</p>
          )}
          <p className="mx-help">Paths are driven by Mayhem's path preview, the same follower the robot runs. Before/after replays in the robot's physics sim come with sim proof.</p>
        </div>
      )}
    </div>
  );
}
