import type { Channel, Sample } from "./analysis.ts";
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
