import { useMemo } from "react";
import type { Frame } from "../core/runtime.ts";
import type { HeadingLint } from "../core/headingLint.ts";
import "./routeFootprints.css";

type Pose = Frame["pose"];

/**
 * Where the robot's front (intake side, +x) points along the previewed route: a small chevron
 * every `spacing` meters, plus the robot outline wherever an event marker (a pickup) fires.
 * Pickups that fire with the front far off the direction of travel are drawn in red with a
 * "!" beside them. Field coordinates; rendered inside FieldView's <svg> (y is flipped there).
 */
export function RouteFootprints({
  frames,
  length,
  width,
  fieldHeight,
  lints = [],
  focus,
  spacing = 0.5,
}: {
  frames: Frame[];
  length: number;
  width: number;
  fieldHeight: number;
  lints?: HeadingLint[];
  /** Only mark these steps (the focused leg); everything else is left alone. */
  focus?: string[];
  /** Meters of travel between heading chevrons. */
  spacing?: number;
}) {
  const shown = useMemo(() => {
    const live = focus ? new Set(focus) : undefined;
    return frames.filter((f) => !live || live.has(f.node));
  }, [frames, focus]);
  const chevrons = useMemo(() => {
    const out: Pose[] = [];
    let travelled = 0;
    for (let i = 1; i < shown.length; i++) {
      travelled += Math.hypot(shown[i].pose.x - shown[i - 1].pose.x, shown[i].pose.y - shown[i - 1].pose.y);
      if (travelled >= spacing) {
        out.push(shown[i].pose);
        travelled = 0;
      }
    }
    return out;
  }, [shown, spacing]);
  // Every event marker that fired, with its lint when the front was far off travel.
  const pickups = useMemo(() => {
    const bad = new Map(lints.map((l) => [l.time, l]));
    return shown.flatMap((f) =>
      f.events
        .filter((e) => e.kind === "event" && e.time === f.time)
        .map((e) => ({ pose: f.pose, key: e.message.replace(/^Event trigger /, ""), lint: bad.get(f.time) })),
    );
  }, [shown, lints]);
  const at = (p: Pose) => `translate(${p.x},${fieldHeight - p.y}) rotate(${(-p.heading * 180) / Math.PI})`;
  return (
    <g className="mx-footprints" aria-label="Robot heading along the route">
      {chevrons.map((p, i) => (
        <g key={i} className="mx-heading-chevron" transform={at(p)}>
          <path className="mx-heading-chevron-halo" d="M-.07,-.09 L.08,0 L-.07,.09" />
          <path d="M-.07,-.09 L.08,0 L-.07,.09" />
        </g>
      ))}
      {pickups.map(({ pose, key, lint }, i) => (
        <g key={`pickup-${i}`} className={`mx-footprint ${lint ? "is-warning" : ""}`}>
          <title>{lint ? lint.message : `Event "${key}": front leads (within 45° of travel).`}</title>
          <g transform={at(pose)}>
            <rect x={-length / 2} y={-width / 2} width={length} height={width} rx=".08" />
            <path className="mx-footprint-front" d={`M${length / 2 - 0.04},${-width / 2 + 0.1} V${width / 2 - 0.1}`} />
          </g>
          {lint && (
            <g className="mx-footprint-flag" transform={`translate(${pose.x + length / 2 + 0.18},${fieldHeight - pose.y - width / 2 - 0.1})`}>
              <circle r=".14" />
              <text y=".06" textAnchor="middle">!</text>
            </g>
          )}
        </g>
      ))}
    </g>
  );
}
