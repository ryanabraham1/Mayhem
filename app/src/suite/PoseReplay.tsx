import { useEffect, useState } from "react";
import { FieldArt } from "../components/FieldArt";
import type { Field } from "../types";
import field from "./core/rebuilt-2026.json";
import { valueAt, type Recording } from "./core/analysis.ts";
export function PoseReplay({
  recording,
  time,
}: {
  recording: Recording;
  time: number;
}) {
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
  const values = Object.fromEntries(
    Object.entries(mapping).map(([key, name]) => [
      key,
      valueAt(
        recording.channels.find((c) => c.name === name),
        time,
      ),
    ]),
  );
  return (
    <details className="ms-log-pose">
      <summary>Field replay</summary>
      <div className="ms-pose-mapping">
        {(["x", "y", "heading"] as const).map((key) => (
          <label key={key}>
            {key === "heading" ? "Heading (rad)" : `${key.toUpperCase()} (m)`}
            <select
              value={mapping[key]}
              onChange={(e) =>
                setMapping((m) => ({ ...m, [key]: e.target.value }))
              }
            >
              <option value="">Not mapped</option>
              {recording.channels
                .filter(
                  (c) =>
                    c.samples.length &&
                    ["double", "float", "int64", "number"].includes(c.type),
                )
                .map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
            </select>
          </label>
        ))}
      </div>
      {typeof values.x === "number" && typeof values.y === "number" ? (
        <svg
          className="ms-replay-field"
          viewBox={`-.3 -.3 ${field.length + 0.6} ${field.width + 0.6}`}
          aria-label="Recorded robot field replay"
        >
          <g aria-hidden="true" transform={`translate(0 ${field.width}) scale(1 -1)`}>
            <FieldArt field={field as Field} />
          </g>
          <g
            transform={`translate(${values.x},${field.width - values.y}) rotate(${(-(typeof values.heading === "number" ? values.heading : 0) * 180) / Math.PI})`}
          >
            <rect
              x="-.42"
              y="-.42"
              width=".84"
              height=".84"
              rx=".06"
              fill="#6b3fe630"
              stroke="#6b3fe6"
              strokeWidth=".04"
            />
            <path
              d="M-.12,-.17 L.15,0 L-.12,.17"
              fill="none"
              stroke="#6b3fe6"
              strokeWidth=".055"
            />
          </g>
        </svg>
      ) : (
        <p className="ms-help">
          Choose recorded X and Y position signals to replay the robot on the
          field.
        </p>
      )}
    </details>
  );
}
