import type { Channel } from "./analysis";

/** Interpolate display poses only, preserving gaps and the original log samples. */
export function replayValueAt(channel: Channel | undefined, time: number, angle = false): number | undefined {
  const samples = channel?.samples;
  if (!samples?.length || time < samples[0].time) return;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (samples[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  const current = samples[lo], next = samples[lo + 1];
  if (typeof current.value !== "number" || !Number.isFinite(current.value)) return;
  // Long gaps can contain resets or missing telemetry. Do not invent motion there.
  if (!next || next.time - current.time > 0.1 ||
      typeof next.value !== "number" || !Number.isFinite(next.value)) return current.value;
  const fraction = (time - current.time) / (next.time - current.time);
  const delta = next.value - current.value;
  return current.value + fraction * (angle ? Math.atan2(Math.sin(delta), Math.cos(delta)) : delta);
}
