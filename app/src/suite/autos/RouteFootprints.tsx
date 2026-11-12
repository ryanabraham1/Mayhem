import { useMemo } from "react";
import type { Frame } from "../core/runtime.ts";
import "./routeFootprints.css";

type Pose = Frame["pose"];

/**
 * Where the robot's front (intake side, +x) points along the previewed route: a small chevron
 * every `spacing` meters, on the route line. Nothing else is drawn, so the only boxes on the
 * field stay the waypoints. Field coordinates; rendered inside FieldView's <svg> (y is flipped).
 */
export function RouteFootprints({
  frames,
  fieldHeight,
  focus,
  spacing = 0.5,
}: {
  frames: Frame[];
  fieldHeight: number;
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
  const at = (p: Pose) => `translate(${p.x},${fieldHeight - p.y}) rotate(${(-p.heading * 180) / Math.PI})`;
  return (
    <g className="mx-footprints" aria-label="Robot heading along the route">
      {chevrons.map((p, i) => (
        <g key={i} className="mx-heading-chevron" transform={at(p)}>
          <path className="mx-heading-chevron-halo" d="M-.07,-.09 L.08,0 L-.07,.09" />
          <path d="M-.07,-.09 L.08,0 L-.07,.09" />
        </g>
      ))}
    </g>
  );
}
