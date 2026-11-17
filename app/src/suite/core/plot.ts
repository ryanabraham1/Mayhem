import { valueAt, type Channel, type Sample } from "./analysis.ts";
/** Preserve spikes and the full time span while bounding SVG work. Raw data stays intact. */
export function plotSeries(channel: Channel | undefined, buckets = 600) {
  const numeric =
    channel?.samples.filter(
      (s): s is Sample & { value: number } =>
        typeof s.value === "number" && Number.isFinite(s.value),
    ) ?? [];
  if (!numeric.length) return { samples: [] as Sample[], min: 0, max: 0 };
  const size = Math.max(
    1,
    Math.ceil(numeric.length / Math.max(1, Math.floor(buckets))),
  );
  let min = Infinity,
    max = -Infinity;
  const samples: Sample[] = [numeric[0]];
  for (let start = 0; start < numeric.length; start += size) {
    const end = Math.min(numeric.length, start + size);
    let low = start,
      high = start;
    for (let i = start; i < end; i++) {
      if (numeric[i].value < numeric[low].value) low = i;
      if (numeric[i].value > numeric[high].value) high = i;
    }
    min = Math.min(min, numeric[low].value);
    max = Math.max(max, numeric[high].value);
    for (const index of low < high
      ? [low, high]
      : low === high
        ? [low]
        : [high, low])
      if (samples.at(-1) !== numeric[index]) samples.push(numeric[index]);
  }
  if (samples.at(-1) !== numeric.at(-1)) samples.push(numeric.at(-1)!);
  return { samples, min, max };
}

/**
 * Split a recorded X/Y pose into drawable trail segments. Odometry resets (the
 * auto's start pose being set) and telemetry gaps are breaks, not motion, so the
 * trail never draws a line across the field to where the pose was reset.
 */
export function poseTrail(
  xs: Channel | undefined,
  ys: Channel | undefined,
  maxPoints = 800,
): { x: number; y: number }[][] {
  if (!xs || !ys) return [];
  const segments: { x: number; y: number; t: number }[][] = [];
  let current: { x: number; y: number; t: number }[] = [];
  for (const s of xs.samples) {
    const y = valueAt(ys, s.time);
    if (typeof s.value !== "number" || !Number.isFinite(s.value) ||
        typeof y !== "number" || !Number.isFinite(y)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    const last = current[current.length - 1];
    if (last) {
      const d = Math.hypot(s.value - last.x, y - last.y);
      const dt = s.time - last.t;
      // Faster than a robot drives, or across a gap in the data: a reset.
      if (d > 0.4 && (dt <= 0 || dt > 0.25 || d / dt > 8)) {
        segments.push(current);
        current = [];
      }
    }
    current.push({ x: s.value, y, t: s.time });
  }
  if (current.length) segments.push(current);
  const total = segments.reduce((n, seg) => n + seg.length, 0);
  const step = Math.max(1, Math.floor(total / Math.max(1, maxPoints)));
  return segments
    .filter((seg) => seg.length > 1)
    .map((seg) =>
      seg
        .filter((_, i) => i % step === 0 || i === seg.length - 1)
        .map(({ x, y }) => ({ x, y })),
    );
}
