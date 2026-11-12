import { useMemo } from "react";
import type { Frame } from "../core/runtime.ts";
import type { HeadingLint } from "../core/headingLint.ts";
import "./routeFootprints.css";

/**
 * Robot outlines along the previewed route, with the front (intake side, +x) drawn as a
 * bold bar, so you can see where the robot faces as it passes game pieces. Pickup events
 * that fire with the front far off the direction of travel are drawn in red.
 * Field coordinates; rendered inside FieldView's <svg> (y is flipped there).
 */
export function RouteFootprints({
  frames,
  length,
  width,
  fieldHeight,
  lints = [],
  spacing = 0.6,
}: {
  frames: Frame[];
  length: number;
  width: number;
  fieldHeight: number;
  lints?: HeadingLint[];
  /** Meters of travel between outlines. */
  spacing?: number;
}) {
  const poses = useMemo(() => {
    const out: Frame["pose"][] = [];
    let travelled = spacing;
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) travelled += Math.hypot(frames[i].pose.x - frames[i - 1].pose.x, frames[i].pose.y - frames[i - 1].pose.y);
      if (travelled >= spacing) {
        out.push(frames[i].pose);
        travelled = 0;
      }
    }
    return out;
  }, [frames, spacing]);
  const outline = (key: string, p: Frame["pose"], className: string, title?: string) => (
    <g
      key={key}
      className={className}
      transform={`translate(${p.x},${fieldHeight - p.y}) rotate(${(-p.heading * 180) / Math.PI})`}
    >
      {title && <title>{title}</title>}
      <rect x={-length / 2} y={-width / 2} width={length} height={width} rx=".08" />
      <path className="mx-footprint-front" d={`M${length / 2},${-width / 2 + 0.06} V${width / 2 - 0.06}`} />
    </g>
  );
  return (
    <g className="mx-footprints" aria-label="Robot heading along the route">
      {poses.map((p, i) => outline(String(i), p, "mx-footprint"))}
      {lints.map((l, i) => (
        <g key={`lint-${i}`} className="mx-footprint-lint" role="img" aria-label={l.message}>
          {outline(`lint-outline-${i}`, l, "mx-footprint is-warning", l.message)}
          <circle cx={l.x} cy={fieldHeight - l.y} r=".16" />
          <text x={l.x} y={fieldHeight - l.y + 0.07} textAnchor="middle">!</text>
        </g>
      ))}
    </g>
  );
}
