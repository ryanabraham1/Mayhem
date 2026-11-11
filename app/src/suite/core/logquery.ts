import type { Channel, Recording, Sample } from "./analysis.ts";
import { valueAt } from "./analysis.ts";

/**
 * Exploration helpers for agents: find channels, line several up on one clock,
 * surface abnormal behavior, and see what changed around a moment. Everything
 * is read-only and returns small, ranked results so an agent can iterate
 * (anomalies -> what changed -> table) instead of reading raw dumps.
 */
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const isNumeric = (c: Channel) =>
  c.samples.length > 0 && c.samples.every((s) => typeof s.value === "number");
const toNumber = (v: Sample["value"]) =>
  typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN;
const show = (v: Sample["value"] | undefined) =>
  typeof v === "number" ? round(v) : typeof v === "string" && v.length > 80 ? `${v.slice(0, 77)}...` : v;

function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
interface Baseline { median: number; scale: number }
/** Robust center/spread; falls back to the standard deviation for mostly constant signals. */
function baseline(values: number[]): Baseline {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med))) * 1.4826;
  if (mad > 0) return { median: med, scale: mad };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { median: med, scale: sd };
}

/** Exact name wins; otherwise every case-insensitive substring match. */
export function resolveChannels(recording: Recording, needles: string[] | undefined) {
  const found: Channel[] = [];
  const missing: string[] = [];
  for (const needle of needles ?? []) {
    const exact = recording.channels.find((c) => c.name === needle);
    const hits = exact
      ? [exact]
      : recording.channels.filter((c) => c.name.toLowerCase().includes(needle.toLowerCase()));
    if (!hits.length) missing.push(needle);
    for (const h of hits) if (!found.includes(h)) found.push(h);
  }
  return { found, missing };
}

export function listChannels(
  recording: Recording,
  opts: { filter?: string[]; type?: string; limit?: number; offset?: number } = {},
) {
  let pool = recording.channels;
  if (opts.filter?.length) pool = resolveChannels(recording, opts.filter).found;
  if (opts.type) pool = pool.filter((c) => c.type === opts.type);
  const limit = Math.min(opts.limit ?? 60, 300);
  const offset = opts.offset ?? 0;
  return {
    total: pool.length,
    offset,
    channels: pool.slice(offset, offset + limit).map((c) => {
      const out: Record<string, unknown> = { name: c.name, type: c.type, samples: c.samples.length };
      if (c.samples.length) {
        const first = c.samples[0].time;
        const last = c.samples[c.samples.length - 1].time;
        out.span = [round(first, 3), round(last, 3)];
        if (c.samples.length > 1 && last > first) out.hz = round((c.samples.length - 1) / (last - first), 1);
        if (isNumeric(c)) {
          const v = c.samples.map((s) => s.value as number);
          let min = Infinity, max = -Infinity, sum = 0;
          for (const x of v) { min = Math.min(min, x); max = Math.max(max, x); sum += x; }
          Object.assign(out, { min: round(min), max: round(max), mean: round(sum / v.length) });
        } else out.first = show(c.samples[0].value);
      }
      return out;
    }),
  };
}

function pearson(a: number[], b: number[]): number | undefined {
  const pairs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  if (pairs.length < 3) return undefined;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sab = 0, saa = 0, sbb = 0;
  for (const [x, y] of pairs) { sab += (x - ma) * (y - mb); saa += (x - ma) ** 2; sbb += (y - mb) ** 2; }
  return saa && sbb ? round(sab / Math.sqrt(saa * sbb), 3) : undefined;
}

/** Several channels sampled on one shared clock (last value held), plus pairwise correlation. */
export function logTable(
  recording: Recording,
  opts: { channels: string[]; from?: number; to?: number; step?: number; points?: number },
) {
  const { found, missing } = resolveChannels(recording, opts.channels);
  const channels = found.slice(0, 20);
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(recording.duration, opts.to ?? recording.duration);
  if (!(to > from)) throw new Error("`to` must be greater than `from`.");
  const points = Math.min(Math.max(opts.points ?? 40, 2), 500);
  const step = opts.step && opts.step > 0 ? opts.step : (to - from) / (points - 1);
  const times: number[] = [];
  for (let t = from; t <= to + 1e-9 && times.length < 500; t += step) times.push(t);
  const rows = times.map((t) => [round(t, 3), ...channels.map((c) => show(valueAt(c, t)) ?? null)]);
  const out: Record<string, unknown> = {
    from: round(from, 3),
    to: round(to, 3),
    step: round(step, 4),
    columns: ["time", ...channels.map((c) => c.name)],
    rows,
  };
  if (missing.length) out.unmatched = missing;
  if (found.length > channels.length) out.truncatedChannels = found.length - channels.length;
  if (channels.length > 1 && channels.length <= 8) {
    const cols = channels.map((c) => times.map((t) => toNumber(valueAt(c, t) as Sample["value"])));
    const correlation: { a: string; b: string; r: number }[] = [];
    for (let i = 0; i < channels.length; i++)
      for (let j = i + 1; j < channels.length; j++) {
        const r = pearson(cols[i], cols[j]);
        if (r !== undefined) correlation.push({ a: channels[i].name, b: channels[j].name, r });
      }
    out.correlation = correlation;
  }
  return out;
}

export interface Anomaly {
  channel: string;
  kind: "outlier" | "jump" | "dropout" | "flatline" | "flapping" | "stopped-logging" | "late-start";
  start: number;
  end: number;
  score: number;
  detail: string;
}

/** Rank unusual behavior across channels. Thresholds scale with `sensitivity` (higher = more findings). */
export function findAnomalies(
  recording: Recording,
  opts: { channels?: string[]; from?: number; to?: number; limit?: number; sensitivity?: number } = {},
) {
  const sens = Math.min(Math.max(opts.sensitivity ?? 1, 0.25), 4);
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const pool = opts.channels?.length ? resolveChannels(recording, opts.channels).found : recording.channels;
  const found: Anomaly[] = [];
  const add = (a: Anomaly) => {
    if (a.end >= from && a.start <= to && Number.isFinite(a.score)) found.push({ ...a, score: round(a.score, 2) });
  };
  const zThreshold = 6 / sens;
  for (const c of pool) {
    const n = c.samples.length;
    if (n < 10 || c.name.includes("/.schema/")) continue;
    const first = c.samples[0].time, last = c.samples[n - 1].time;
    const earlyRegular = n > 50 && (() => {
      const d = c.samples.slice(1).map((x, i) => x.time - c.samples[i].time).filter((x) => x > 0).sort((a, b) => a - b);
      return d.length > 0 && d[Math.floor(d.length * 0.9)] <= 3 * d[d.length >> 1];
    })();
    if (earlyRegular && recording.duration - last > Math.max(2, recording.duration * 0.05))
      add({ channel: c.name, kind: "stopped-logging", start: last, end: recording.duration, score: recording.duration - last,
        detail: `Last sample at ${round(last, 2)} s; log runs to ${round(recording.duration, 2)} s.` });
    if (earlyRegular && first > Math.max(2, recording.duration * 0.1))
      add({ channel: c.name, kind: "late-start", start: 0, end: first, score: first,
        detail: `First sample at ${round(first, 2)} s.` });
    const dts = c.samples.slice(1).map((s, i) => s.time - c.samples[i].time).filter((d) => d > 0);
    const dt = median(dts);
    // Channels logged only on change have irregular spacing; gaps/stops/flatlines mean nothing there.
    const sortedDts = [...dts].sort((a, b) => a - b);
    const regular = dt > 0 && sortedDts[Math.floor(sortedDts.length * 0.9)] <= 3 * dt;
    if (dt > 0 && n > 50 && regular)
      c.samples.forEach((s, i) => {
        if (!i) return;
        const gap = s.time - c.samples[i - 1].time;
        if (gap > Math.max(0.25, 20 * dt) / sens)
          add({ channel: c.name, kind: "dropout", start: c.samples[i - 1].time, end: s.time, score: gap / dt / 10,
            detail: `${round(gap, 3)} s without samples (normal spacing ${round(dt, 4)} s).` });
      });
    if (isNumeric(c)) {
      const v = c.samples.map((s) => s.value as number);
      const range = Math.max(...v) - Math.min(...v);
      const raw = baseline(v);
      // A tiny spread must not make ordinary changes look huge: floor it at 2% of the channel's range.
      const base = { median: raw.median, scale: Math.max(raw.scale, range * 0.02) };
      if (base.scale > 0) {
        // Consecutive outlier samples collapse into one event.
        let run: { start: number; end: number; peak: number; peakTime: number } | undefined;
        const flush = () => {
          if (!run) return;
          add({ channel: c.name, kind: "outlier", start: run.start, end: run.end, score: Math.abs(run.peak - base.median) / base.scale,
            detail: `Reached ${round(run.peak)} (typical ${round(base.median)}, spread ${round(base.scale)}) at ${round(run.peakTime, 3)} s.` });
          run = undefined;
        };
        v.forEach((x, i) => {
          const z = Math.abs(x - base.median) / base.scale;
          const t = c.samples[i].time;
          if (z > zThreshold) {
            if (!run) run = { start: t, end: t, peak: x, peakTime: t };
            run.end = t;
            if (Math.abs(x - base.median) > Math.abs(run.peak - base.median)) { run.peak = x; run.peakTime = t; }
          } else flush();
        });
        flush();
        const diffs = v.slice(1).map((x, i) => x - v[i]);
        const diffRaw = baseline(diffs);
        const diffBase = { median: diffRaw.median, scale: Math.max(diffRaw.scale, range * 0.01) };
        if (diffBase.scale > 0)
          diffs.forEach((d, i) => {
            const z = Math.abs(d - diffBase.median) / diffBase.scale;
            // Must be both statistically rare and a large step for this channel (>= 15% of its range).
            if (z > zThreshold * 2 && Math.abs(d) >= range * 0.15 / sens)
              add({ channel: c.name, kind: "jump", start: c.samples[i].time, end: c.samples[i + 1].time, score: z / 2,
                detail: `Changed by ${round(d)} (${round(v[i])} -> ${round(v[i + 1])}) in ${round(c.samples[i + 1].time - c.samples[i].time, 4)} s.` });
          });
        // Stuck sensor: lots of distinct values overall, but one long constant stretch.
        if (regular && new Set(v.map((x) => round(x, 6))).size >= 20) {
          let start = 0;
          for (let i = 1; i <= n; i++)
            if (i === n || v[i] !== v[start]) {
              const len = c.samples[i - 1].time - c.samples[start].time;
              if (i - start >= 10 && len >= Math.max(1, recording.duration * 0.04) * sens ** -1)
                add({ channel: c.name, kind: "flatline", start: c.samples[start].time, end: c.samples[i - 1].time, score: len / 2,
                  detail: `Stayed at ${round(v[start])} for ${round(len, 2)} s (${i - start} samples) although it varies elsewhere.` });
              start = i;
            }
        }
      }
    } else if (c.samples.every((s) => typeof s.value === "boolean")) {
      const changes: number[] = [];
      c.samples.forEach((s, i) => { if (i && s.value !== c.samples[i - 1].value) changes.push(s.time); });
      // Sliding one-second window with many toggles.
      let lo = 0;
      for (let hi = 0; hi < changes.length; hi++) {
        while (changes[hi] - changes[lo] > 1) lo++;
        const count = hi - lo + 1;
        if (count >= Math.ceil(6 / sens))
          add({ channel: c.name, kind: "flapping", start: changes[lo], end: changes[hi], score: count,
            detail: `${count} toggles within ${round(changes[hi] - changes[lo], 2)} s.` });
      }
    }
  }
  // Keep the strongest event per (channel, kind, ~second) so one burst doesn't flood the list.
  const best = new Map<string, Anomaly>();
  for (const a of found) {
    const key = `${a.channel}|${a.kind}|${Math.floor(a.start)}`;
    if (!best.has(key) || best.get(key)!.score < a.score) best.set(key, a);
  }
  const all = [...best.values()].sort((a, b) => b.score - a.score);
  const limit = Math.min(opts.limit ?? 25, 100);
  // Round-robin across kinds so one noisy kind can't hide the others.
  const queues = new Map<string, Anomaly[]>();
  for (const a of all) (queues.get(a.kind) ?? queues.set(a.kind, []).get(a.kind)!).push(a);
  const ranked: Anomaly[] = [];
  for (let i = 0; ranked.length < all.length; i++)
    for (const q of queues.values()) if (q[i]) ranked.push(q[i]);
  const perKind: Record<string, number> = {};
  for (const a of ranked) perKind[a.kind] = (perKind[a.kind] ?? 0) + 1;
  return {
    scanned: pool.length,
    totalFound: ranked.length,
    countsByKind: perKind,
    anomalies: ranked.slice(0, limit).map((a) => ({ ...a, start: round(a.start, 3), end: round(a.end, 3) })),
  };
}

/** What deviated most from its own normal around a moment: the "what just broke?" query. */
export function whatChanged(
  recording: Recording,
  opts: { time: number; window?: number; filter?: string[]; limit?: number },
) {
  const w = opts.window ?? 1;
  const pool = opts.filter?.length ? resolveChannels(recording, opts.filter).found : recording.channels;
  const rows: Record<string, unknown>[] = [];
  for (const c of pool) {
    if (!isNumeric(c) || c.samples.length < 10) continue;
    const base = baseline(c.samples.map((s) => s.value as number));
    if (!(base.scale > 0)) continue;
    const before = c.samples.filter((s) => s.time >= opts.time - w && s.time < opts.time).map((s) => s.value as number);
    const after = c.samples.filter((s) => s.time >= opts.time && s.time <= opts.time + w).map((s) => s.value as number);
    if (!before.length && !after.length) continue;
    const win = [...before, ...after];
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    const deviation = Math.max(...win.map((x) => Math.abs(x - base.median))) / base.scale;
    const shift = before.length && after.length ? Math.abs(mean(after) - mean(before)) / base.scale : 0;
    rows.push({
      channel: c.name,
      score: round(Math.max(deviation, shift), 2),
      before: before.length ? round(mean(before)) : null,
      after: after.length ? round(mean(after)) : null,
      windowMin: round(Math.min(...win)),
      windowMax: round(Math.max(...win)),
      typical: round(base.median),
      spread: round(base.scale),
    });
  }
  rows.sort((a, b) => (b.score as number) - (a.score as number));
  return { time: opts.time, window: w, scanned: pool.length, top: rows.slice(0, Math.min(opts.limit ?? 20, 80)) };
}

/** Chronological state/boolean/string transitions, merged across channels. */
export function logEvents(
  recording: Recording,
  opts: { channels?: string[]; from?: number; to?: number; limit?: number } = {},
) {
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const pool = opts.channels?.length
    ? resolveChannels(recording, opts.channels).found
    : recording.channels.filter((c) => c.samples.length && !isNumeric(c));
  const events: { time: number; channel: string; from: unknown; to: unknown }[] = [];
  for (const c of pool) {
    c.samples.forEach((s, i) => {
      if (s.time < from || s.time > to) return;
      if (i === 0) events.push({ time: s.time, channel: c.name, from: null, to: show(s.value) });
      else if (s.value !== c.samples[i - 1].value)
        events.push({ time: s.time, channel: c.name, from: show(c.samples[i - 1].value), to: show(s.value) });
    });
  }
  events.sort((a, b) => a.time - b.time);
  const limit = Math.min(opts.limit ?? 100, 500);
  return {
    channels: pool.length,
    totalEvents: events.length,
    truncated: events.length > limit,
    events: events.slice(0, limit).map((e) => ({ ...e, time: round(e.time, 3) })),
  };
}
