import { useEffect, useMemo, useState } from "react";
import { FieldArt } from "./FieldArt";
import { DEFAULT_SEASON, type Season } from "./core/seasons.ts";
import type { Recording } from "./core/analysis.ts";
import { poseTrail } from "./core/plot.ts";
import { replayValueAt } from "./core/replay";
import { Field } from "./ui";

const numeric = ["double", "float", "int64", "number"];

export function PoseReplay({
  recording,
  time,
  season = DEFAULT_SEASON,
}: {
  recording: Recording;
  time: number;
  /** The game whose field the log is drawn on (the open project's). */
  season?: Season;
}) {
  const field = season.field;
  const [mapping, setMapping] = useState({ x: "", y: "", heading: "" });
  useEffect(() => {
    const x =
      recording.channels.find((c) => /(?:pose|odometry).*\/x$/i.test(c.name))
        ?.name ?? "";
    const prefix = x.slice(0, -1);
    setMapping({
      x,
      y: recording.channels.find((c) => c.name === prefix + "y")?.name ?? "",
      heading:
        recording.channels.find((c) => c.name === prefix + "heading")?.name ??
        "",
    });
  }, [recording]);
  const channel = (name: string) =>
    recording.channels.find((c) => c.name === name);
  const values = Object.fromEntries(
    Object.entries(mapping).map(([key, name]) => [
      key,
      replayValueAt(channel(name), time, key === "heading"),
    ]),
  );
  const pose =
    typeof values.x === "number" &&
    Number.isFinite(values.x) &&
    typeof values.y === "number" &&
    Number.isFinite(values.y)
      ? { x: values.x, y: values.y }
      : undefined;
  const xs = channel(mapping.x), ys = channel(mapping.y);
  const mapped = Boolean(xs?.samples.length && ys?.samples.length);
  const firstPoseTime = mapped
    ? Math.max(xs!.samples[0].time, ys!.samples[0].time)
    : undefined;
  const trail = useMemo(
    () =>
      poseTrail(channel(mapping.x), channel(mapping.y)).map((seg) =>
        seg.map((p) => `${p.x.toFixed(3)},${(field.width - p.y).toFixed(3)}`).join(" "),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recording, mapping.x, mapping.y, field],
  );
  return (
    <div className="mx-replay">
      <div className="mx-mapping">
        {(["x", "y", "heading"] as const).map((key) => (
          <Field key={key} label={key === "heading" ? "Heading (rad)" : `${key.toUpperCase()} position (m)`}>
            <select
              value={mapping[key]}
              onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value }))}
            >
              <option value="">Not mapped</option>
              {recording.channels
                .filter((c) => c.samples.length && numeric.includes(c.type))
                .map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
            </select>
          </Field>
        ))}
      </div>
      {!pose && (
        <p className="mx-help" role="status">
          {mapped
            ? firstPoseTime !== undefined && time < firstPoseTime
              ? `Position signals are mapped. Pose data starts at ${firstPoseTime.toFixed(2)} s; play or seek forward to replay the robot.`
              : "The selected position signals have no valid pose at this time."
            : "Choose recorded X and Y position signals to replay the robot on the field."}
        </p>
      )}
      <svg
        className="mx-replay-field"
        viewBox={`-.3 -.3 ${field.length + 0.6} ${field.width + 0.6}`}
        aria-label="Recorded robot field replay"
      >
        <g aria-hidden="true" transform={`translate(0 ${field.width}) scale(1 -1)`}>
          <FieldArt field={field} />
        </g>
        {trail.map((points, i) => (
          <polyline key={i} points={points} fill="none" stroke="var(--mx-trail)" strokeWidth=".08" strokeLinejoin="round" />
        ))}
        {pose && (
          <g
            transform={`translate(${pose.x},${field.width - pose.y}) rotate(${(-(typeof values.heading === "number" && Number.isFinite(values.heading) ? values.heading : 0) * 180) / Math.PI})`}
          >
            <rect x="-.42" y="-.42" width=".84" height=".84" rx=".06" fill="var(--mx-path-soft)" stroke="var(--mx-path)" strokeWidth=".04" />
            <path d="M-.12,-.17 L.15,0 L-.12,.17" fill="none" stroke="var(--mx-path)" strokeWidth=".055" />
          </g>
        )}
      </svg>
    </div>
  );
}
