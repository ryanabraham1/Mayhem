import type { Frame } from "./runtime.ts";
import { wrap } from "./runtime.ts";

/** Display interpolation only; control steps and recorded/exported frames stay fixed. */
export function interpolatePreviewFrame(
  a: Frame,
  b: Frame | undefined,
  time: number,
): Frame {
  if (!b || b.time <= a.time || time <= a.time) return a;
  const t = Math.min(1, (time - a.time) / (b.time - a.time));
  return {
    ...a,
    time: a.time + t * (b.time - a.time),
    pose: {
      x: a.pose.x + (b.pose.x - a.pose.x) * t,
      y: a.pose.y + (b.pose.y - a.pose.y) * t,
      heading: wrap(a.pose.heading + wrap(b.pose.heading - a.pose.heading) * t),
    },
  };
}
