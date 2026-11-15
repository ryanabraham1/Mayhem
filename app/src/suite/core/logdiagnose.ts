import type { Channel, PowerMapping, Recording, Sample } from "./analysis.ts";
import { analyze, valueAt } from "./analysis.ts";
import { findAnomalies, machineStates, meaningful } from "./logquery.ts";

/**
 * One-call triage for the agent loop "read a sim log, find failures, fix, repeat". `diagnoseLog`
 * turns a recording into grouped, ranked findings with stable ids, evidence and the next query to
 * run; `compareLogs` diagnoses two recordings and says which findings were fixed, which persist and
 * which are new, plus the metrics that moved. Everything is inferred from channel names and data
 * (setpoint/measurement pairs, mode, state channels, loop timing, alerts), so it works on any robot
 * without configuration; `ignore` drops findings by id or kind.
 */
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const numeric = (c: Channel) => c.samples.length > 0 && typeof c.samples[0].value === "number";
const show = (v: Sample["value"] | undefined) => (typeof v === "number" ? round(v, 4) : v);
const norm = (name: string) => name.replace(/^NT:/, "").replace(/^\/+/, "").replace(/^(AdvantageKit\/)?RealOutputs\//, "");

export interface Phase { mode: "disabled" | "auto" | "teleop" | "test"; start: number; end: number }
export interface Diagnosis {
  /** Stable across runs: kind plus the channels involved, never times. */
  id: string;
  severity: "error" | "warning" | "info";
  kind: string;
  title: string;
  detail: string;
  /** Times (s) of the first few occurrences; `occurrences` counts all. */
  at: number[];
  occurrences: number;
  phases: Phase["mode"][];
  channels: string[];
  /** A number to compare across runs (larger is worse), e.g. worst tracking error. */
  metric?: number;
  evidence?: Record<string, unknown>;
  /** The query that shows it, ready to run. */
  next?: { tool: string; args: Record<string, unknown> };
}

/** Match phases from the DS channels (WPILib `DS:` or AdvantageKit `/DriverStation/`). */
export function phasesOf(recording: Recording): Phase[] {
  const find = (re: RegExp) => recording.channels.find((c) => re.test(c.name) && c.samples.length && typeof c.samples[0].value === "boolean");
  const enabled = find(/^(DS:enabled|\/?DriverStation\/Enabled)$/i);
  const auto = find(/^(DS:autonomous|\/?DriverStation\/Autonomous)$/i);
  const test = find(/^(DS:test|\/?DriverStation\/Test)$/i);
  if (!enabled) return [{ mode: "teleop", start: 0, end: recording.duration }];
  const times = [...new Set([0, ...[enabled, auto, test].flatMap((c) => c?.samples.map((s) => s.time) ?? [])])].sort((a, b) => a - b);
  const phases: Phase[] = [];
  for (const t of times) {
    const mode: Phase["mode"] = !valueAt(enabled, t) ? "disabled" : valueAt(test, t) ? "test" : valueAt(auto, t) ? "auto" : "teleop";
    const last = phases[phases.length - 1];
    if (last?.mode === mode) continue;
    if (last) last.end = t;
    phases.push({ mode, start: t, end: recording.duration });
  }
  return phases.filter((p) => p.end > p.start).map((p) => ({ ...p, start: round(p.start), end: round(p.end) }));
}
const phaseAt = (phases: Phase[], t: number) => phases.find((p) => t >= p.start && t < p.end)?.mode ?? phases[phases.length - 1]?.mode ?? "teleop";
const enabledAt = (phases: Phase[], t: number) => phaseAt(phases, t) !== "disabled";

// ---- Setpoint tracking -------------------------------------------------------------------------
const SETPOINT_LEAF = /^(req|requested|setpoint|target|goal|desired|commanded|reference|ref)[A-Z_]|^(setpoint|goal|reference)$|(setpoint|goal|desired|requested)$/i;
const SETPOINT_SEGMENT = /^(targets?|setpoints?|desired|goals?|commanded|requested|references?)$/i;
const MEASURED_SEGMENT = /^(states?|measured|actual|current|positions?)$/i;
const quantity = (leaf: string) =>
  /veloc|speed|rpm|rps|omega/i.test(leaf) ? "velocity" : /pos|angle|height|distance|extension|rotation/i.test(leaf) ? "position" : undefined;
const EXCLUDE_MEASURED = /current|volt|temp|accel|jerk|error|tolerance|req|setpoint|target|goal|desired|command|ids?$/i;

export interface TrackingPair { setpoint: Channel; measured: Channel; quantity: string; sign: 1 | -1; absolute: boolean }

/** Pair setpoint channels with the measured channel they control. */
export function trackingPairs(recording: Recording): TrackingPair[] {
  const pool = meaningful(recording).filter((c) => numeric(c) && c.samples.length >= 5);
  const pairs: TrackingPair[] = [];
  const used = new Set<string>();
  // 1. Same path except one segment: .../ModuleTargets/0/speed <-> .../ModuleStates/0/speed.
  const byShape = new Map<string, Channel[]>();
  for (const c of pool) {
    const parts = norm(c.name).split("/");
    parts.forEach((p, i) => {
      if (!SETPOINT_SEGMENT.test(p.replace(/^Module/, "")) && !MEASURED_SEGMENT.test(p.replace(/^Module/, ""))) return;
      const key = [...parts.slice(0, i), "*", ...parts.slice(i + 1)].join("/");
      (byShape.get(key) ?? byShape.set(key, []).get(key)!).push(c);
    });
  }
  for (const [key, group] of byShape) {
    const leaf = key.split("/").pop()!;
    const q = quantity(leaf);
    if (!q) continue;
    const seg = (c: Channel) => norm(c.name).split("/")[key.split("/").indexOf("*")].replace(/^Module/, "");
    const sp = group.find((c) => SETPOINT_SEGMENT.test(seg(c)));
    const me = group.find((c) => MEASURED_SEGMENT.test(seg(c)) && c !== sp);
    if (sp && me && !used.has(sp.name)) {
      // Swerve modules flip speed and turn 180° instead of turning far: compare magnitudes.
      pairs.push({ setpoint: sp, measured: me, quantity: q, sign: 1, absolute: /speed/i.test(leaf) });
      used.add(sp.name);
    }
  }
  // 2. A setpoint leaf in a subsystem, and that subsystem's measured channel of the same quantity.
  const subsystem = (c: Channel) => norm(c.name).split("/")[0].toLowerCase();
  for (const sp of pool) {
    const leaf = sp.name.split("/").pop()!;
    const q = quantity(leaf);
    if (!q || used.has(sp.name) || !SETPOINT_LEAF.test(leaf)) continue;
    const candidates = pool.filter((c) => {
      if (c === sp || subsystem(c) !== subsystem(sp)) return false;
      const parts = norm(c.name).split("/");
      const name = parts.slice(1).join("/");
      return quantity(name) === q && !EXCLUDE_MEASURED.test(parts[parts.length - 1]) && !/\/[1-9]\d*$/.test(c.name);
    });
    let best: { c: Channel; sign: 1 | -1; err: number } | undefined;
    for (const c of candidates)
      for (const sign of [1, -1] as const) {
        const errs: number[] = [];
        for (const s of sp.samples) {
          const m = valueAt(c, s.time + 0.5);
          if (typeof m === "number" && typeof s.value === "number" && s.value !== 0) errs.push(Math.abs(sign * m - s.value) / Math.abs(s.value));
        }
        if (errs.length < 3) continue;
        errs.sort((a, b) => a - b);
        const err = errs[errs.length >> 1];
        if (!best || err < best.err) best = { c, sign, err };
      }
    // Further apart than this, the two are in different units (rotations vs meters): not a pair.
    if (best && best.err < 0.5) {
      pairs.push({ setpoint: sp, measured: best.c, quantity: q, sign: best.sign, absolute: false });
      used.add(sp.name);
    }
  }
  return pairs;
}

interface Hold { start: number; end: number; setpoint: number; reached?: number; peak: number; exits: number; finalError: number; tol: number }
/** Split the setpoint into constant holds while enabled and measure how the mechanism followed each. */
function trackHolds(pair: TrackingPair, phases: Phase[], duration: number): Hold[] {
  const spv = (v: Sample["value"]) => (pair.absolute ? Math.abs(v as number) : (v as number));
  const mv = (v: Sample["value"] | undefined) => (typeof v !== "number" ? undefined : pair.absolute ? Math.abs(v) : pair.sign * v);
  const sps = pair.setpoint.samples.filter((s) => typeof s.value === "number");
  if (!sps.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const s of sps) { lo = Math.min(lo, spv(s.value)); hi = Math.max(hi, spv(s.value)); }
  const holds: Hold[] = [];
  const minHold = pair.absolute ? 0.6 : 0.4;
  for (let i = 0; i < sps.length; ) {
    let j = i + 1;
    // Small changes (a few % of the setpoint range) are the same hold, e.g. distance-scaled shots.
    while (j < sps.length && Math.abs(spv(sps[j].value) - spv(sps[i].value)) <= Math.max(1e-6, (hi - lo) * 0.03)) j++;
    const start = sps[i].time, end = j < sps.length ? sps[j].time : Math.min(duration, pair.measured.samples[pair.measured.samples.length - 1]?.time ?? duration);
    const target = spv(sps[j - 1].value);
    i = j;
    if (end - start < minHold || !enabledAt(phases, start) || !enabledAt(phases, end - 0.01)) continue;
    // A zero velocity setpoint is "off"; coasting down is not a tracking problem.
    if (pair.quantity === "velocity" && Math.abs(target) < 1e-6) continue;
    const tol = Math.max(Math.abs(target) * (pair.quantity === "velocity" ? 0.05 : 0.02), (hi - lo) * 0.02, 1e-3);
    const ms = pair.measured.samples.filter((s) => s.time >= start && s.time <= end);
    if (ms.length < 3) continue;
    const hold: Hold = { start, end, setpoint: target, peak: NaN, exits: 0, finalError: 0, tol };
    let inside = false, peakErr = Infinity;
    const tail: number[] = [];
    for (const s of ms) {
      const m = mv(s.value)!;
      const err = m - target;
      if (Math.abs(err) <= tol) { if (hold.reached === undefined) hold.reached = s.time - start; inside = true; }
      else if (inside && Math.abs(err) > tol * 1.5) { hold.exits++; inside = false; }
      if (Math.abs(err) < peakErr) { peakErr = Math.abs(err); hold.peak = m; }
      if (s.time >= start + (end - start) * 0.7) tail.push(err);
    }
    hold.finalError = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
    holds.push(hold);
  }
  return holds;
}

// ---- Flags: what a flickering boolean follows ----------------------------------------------------
/** Numeric channels (and tracking errors) whose value crossing one threshold reproduces the flag. */
function explainFlag(flag: Channel, start: number, end: number, candidates: { name: string; channels?: string[]; at: (t: number) => number | undefined }[]) {
  const times = flag.samples.filter((s) => s.time >= start - 0.25 && s.time <= end + 0.25);
  if (times.length < 6) return [];
  const results: { channel: string; channels: string[]; when: string; agreement: number }[] = [];
  for (const cand of candidates) {
    const pts: [number, boolean][] = [];
    for (const s of times) {
      // The flag is computed from the value logged just before it in the same loop.
      const v = cand.at(s.time);
      if (v !== undefined && Number.isFinite(v)) pts.push([v, s.value === true]);
    }
    if (pts.length < times.length * 0.8) continue;
    pts.sort((a, b) => a[0] - b[0]);
    const trues = pts.filter((p) => p[1]).length;
    // Sweep thresholds: below -> false/above -> true, or the reverse.
    let belowTrue = 0, bestAcc = 0, bestAt = 0, bestDir = "";
    for (let i = 0; i <= pts.length; i++) {
      const accAbove = (i - belowTrue + (trues - belowTrue)) / pts.length; // false below, true above
      const accBelow = (belowTrue + (pts.length - i - (trues - belowTrue))) / pts.length;
      const thr = i === 0 ? pts[0][0] : i === pts.length ? pts[pts.length - 1][0] : (pts[i - 1][0] + pts[i][0]) / 2;
      if (accAbove > bestAcc) { bestAcc = accAbove; bestAt = thr; bestDir = ">"; }
      if (accBelow > bestAcc) { bestAcc = accBelow; bestAt = thr; bestDir = "<"; }
      if (i < pts.length && pts[i][1]) belowTrue++;
    }
    const spread = pts[pts.length - 1][0] - pts[0][0];
    if (bestAcc >= 0.85 && spread > 0) results.push({ channel: cand.name, channels: cand.channels ?? [cand.name], when: `true when ${bestDir} ${round(bestAt, 4)}`, agreement: round(bestAcc, 2) });
  }
  return results.sort((a, b) => b.agreement - a.agreement).slice(0, 3);
}

// ---- Main ----------------------------------------------------------------------------------------
export interface DiagnoseOptions { from?: number; to?: number; ignore?: string[]; limit?: number; mapping?: PowerMapping }

export function diagnoseLog(recording: Recording, opts: DiagnoseOptions = {}) {
  const from = opts.from ?? 0, to = opts.to ?? recording.duration;
  const inRange = (t: number) => t >= from && t <= to;
  const phases = phasesOf(recording);
  const pool = meaningful(recording);
  const raw: (Omit<Diagnosis, "at" | "occurrences" | "phases"> & { time: number })[] = [];
  const add = (d: Omit<Diagnosis, "at" | "occurrences" | "phases"> & { time: number }) => { if (inRange(d.time)) raw.push(d); };
  const metrics: Record<string, number> = {};

  // Setpoint tracking.
  const pairs = trackingPairs(recording);
  const trackingSummary: Record<string, unknown>[] = [];
  const seenGroups = new Set<string>();
  for (const pair of pairs) {
    const holds = trackHolds(pair, phases, recording.duration).filter((h) => h.end >= from && h.start <= to);
    if (!holds.length) continue;
    // Indexed copies (swerve modules, follower motors) are one finding: ModuleTargets/*/speed.
    const group = pair.setpoint.name.replace(/\/\d+\//, "/*/");
    const measuredName = group === pair.setpoint.name ? pair.measured.name : pair.measured.name.replace(/\/\d+\//, "/*/");
    const firstOfGroup = !seenGroups.has(group);
    seenGroups.add(group);
    const units = pair.absolute ? " (magnitudes)" : pair.sign < 0 ? " (measured sign flipped)" : "";
    const reached = holds.filter((h) => h.reached !== undefined);
    const reachTimes = reached.map((h) => h.reached!).sort((a, b) => a - b);
    const worst = Math.max(...holds.map((h) => Math.abs(h.finalError) / Math.max(Math.abs(h.setpoint), h.tol)));
    if (firstOfGroup) {
      metrics[`tracking ${group} worst steady error (fraction)`] = round(worst, 4);
      trackingSummary.push({
        setpoint: group, measured: measuredName + units, holds: holds.length, reached: reached.length,
        medianTimeToReach: reachTimes.length ? round(reachTimes[reachTimes.length >> 1]) : null,
      });
    }
    const mag = (v: number) => (pair.absolute ? Math.abs(v) : pair.sign * v);
    let maxMeasured = 0, maxSetpoint = 0;
    for (const s of pair.measured.samples) if (typeof s.value === "number") maxMeasured = Math.max(maxMeasured, Math.abs(mag(s.value)));
    for (const s of pair.setpoint.samples) if (typeof s.value === "number") maxSetpoint = Math.max(maxSetpoint, Math.abs(s.value));
    const channels = [pair.setpoint.name, pair.measured.name];
    const next = (h: Hold) => ({ tool: "log_table", args: { channels, from: round(Math.max(0, h.start - 0.2)), to: round(h.end + 0.2), points: 40 } });
    for (const h of holds.filter((h) => h.reached === undefined && h.end - h.start >= 0.8)) {
      // Pinned at the most it ever did while asked for more: the setpoint is out of reach, not mistuned.
      const ceiling = Math.abs(h.setpoint) > maxMeasured && Math.abs(h.peak) >= maxMeasured * 0.95;
      const maxConstant = Math.abs(h.setpoint) >= maxSetpoint * 0.98;
      const evidence = { setpoint: round(h.setpoint, 4), closest: round(h.peak, 4), maxEverMeasured: round(maxMeasured, 4), start: round(h.start), end: round(h.end) };
      if (ceiling)
        add({ id: `tracking-unreachable:${group}`, severity: maxConstant ? "warning" : "error", kind: "tracking-unreachable", time: h.start,
          title: `${measuredName} is asked for more than it can reach`,
          detail: `Setpoint ${round(h.setpoint, 4)} for ${round(h.end - h.start, 2)} s, but it tops out at ${round(maxMeasured, 4)} (${Math.round((maxMeasured / Math.abs(h.setpoint)) * 100)}%)${units}. ${maxConstant ? "This is the largest setpoint it is ever given, so the configured maximum is higher than the mechanism (or its sim model) achieves: lower the max constant or fix the free-speed/gearing." : "Lower the requested value (shot table, preset) or raise what the mechanism can do; anything waiting for \"at setpoint\" waits forever."}`,
          channels, metric: round(Math.abs(h.setpoint) - maxMeasured, 4), next: next(h), evidence });
      else
        add({ id: `tracking-never-reached:${group}`, severity: "error", kind: "tracking-never-reached", time: h.start,
          title: `${measuredName} never reached its setpoint`,
          detail: `Setpoint ${round(h.setpoint, 4)} for ${round(h.end - h.start, 2)} s; closest ${round(h.peak, 4)}, ending ${round(h.finalError, 4)} off (tolerance ±${round(h.tol, 4)})${units}. Check gains/feedforward, current limits, gearing/units, or a mechanism that is blocked.`,
          channels, metric: round(Math.abs(h.finalError), 4), next: next(h), evidence });
    }
    for (const h of holds.filter((h) => h.exits >= 3))
      add({ id: `tracking-oscillates:${group}`, severity: "warning", kind: "tracking-oscillates", time: h.start,
        title: `${measuredName} oscillates around its setpoint`,
        detail: `Left the ±${round(h.tol, 4)} band ${h.exits} times in ${round(h.end - h.start, 2)} s after reaching ${round(h.setpoint, 4)}${units}. Usually too much P/D or too little damping; anything gated on "at setpoint" will flicker.`,
        channels, metric: h.exits, next: next(h),
        evidence: { setpoint: round(h.setpoint, 4), exits: h.exits, start: round(h.start), end: round(h.end) } });
    for (const h of reached)
      if (h.reached! > (pair.quantity === "velocity" ? 1.5 : 1.0))
        add({ id: `tracking-slow:${group}`, severity: "warning", kind: "tracking-slow", time: h.start,
          title: `${measuredName} is slow to reach its setpoint`,
          detail: `Took ${round(h.reached!, 2)} s to get within ±${round(h.tol, 4)} of ${round(h.setpoint, 4)}${units}.`,
          channels, metric: round(h.reached!, 3), next: next(h) });
    for (const h of reached)
      if (Math.abs(h.finalError) > h.tol && h.exits < 3)
        add({ id: `tracking-offset:${group}`, severity: "warning", kind: "tracking-offset", time: h.start,
          title: `${measuredName} settles off its setpoint`,
          detail: `Averaged ${round(h.finalError, 4)} from ${round(h.setpoint, 4)} at the end of the hold (tolerance ±${round(h.tol, 4)})${units}. Steady-state error: missing kS/kG/kV or integral, or a load the feedforward ignores.`,
          channels, metric: round(Math.abs(h.finalError), 4), next: next(h) });
  }
  // Setpoints with nothing measured to compare against (or in other units): tracking is unchecked there.
  const paired = new Set(pairs.map((p) => p.setpoint.name));
  const unpairedSetpoints = pool.filter((c) => numeric(c) && SETPOINT_LEAF.test(c.name.split("/").pop()!) && quantity(c.name.split("/").pop()!) && !paired.has(c.name)).map((c) => c.name);

  // Flickering booleans and state channels while enabled, with what each flag follows.
  const errorSeries = pairs.map((p) => ({
    name: `|${p.measured.name} − ${p.setpoint.name}|`,
    channels: [p.setpoint.name, p.measured.name],
    at: (t: number) => {
      const s = valueAt(p.setpoint, t), m = valueAt(p.measured, t);
      return typeof s === "number" && typeof m === "number" ? Math.abs((p.absolute ? Math.abs(m) : p.sign * m) - (p.absolute ? Math.abs(s) : s)) : undefined;
    },
  }));
  const flaps = findAnomalies(recording, { limit: 100, sensitivity: 1 }).anomalies.filter((a) => a.kind === "flapping" && enabledAt(phases, a.start));
  for (const a of flaps) {
    const ch = recording.channels.find((c) => c.name === a.channel)!;
    const isBool = typeof ch.samples[0]?.value === "boolean";
    const sub = norm(ch.name).split("/")[0].toLowerCase();
    const candidates = isBool
      ? [
          ...errorSeries,
          ...pool.filter((c) => numeric(c) && c !== ch && c.samples.length >= 10 && !/\/\.schema\/|LoggedTracer|Loop(Time|Period)/.test(c.name)
            && (norm(c.name).split("/")[0].toLowerCase() === sub || c.samples.some((s) => s.time >= a.start && s.time <= a.end)))
            .map((c) => ({ name: c.name, at: (t: number) => { const v = valueAt(c, t); return typeof v === "number" ? v : undefined; } })),
        ]
      : [];
    const follows = isBool ? explainFlag(ch, a.start, a.end, candidates) : [];
    const state = !isBool;
    add({ id: `${state ? "state-flicker" : "flag-flicker"}:${ch.name}`, severity: state ? "error" : "warning", kind: state ? "state-flicker" : "flag-flicker", time: a.start,
      title: state ? `${ch.name} switches back and forth` : `${ch.name} flickers`,
      detail: `${a.detail}${follows.length ? ` It follows ${follows[0].channel} (${follows[0].when}, ${Math.round(follows[0].agreement * 100)}% agreement): that signal hovers at the threshold. Add hysteresis or a debounce, or stop the signal from hunting.` : state ? " Two transitions are true at once; make the guards exclusive or add a hold." : ""}`,
      channels: [...new Set([ch.name, ...follows.flatMap((f) => f.channels)])], metric: a.score,
      evidence: follows.length ? { follows: follows.map(({ channels, ...f }) => f) } : undefined,
      next: state
        ? { tool: "log_events", args: { channels: [ch.name], from: round(Math.max(0, a.start - 0.5)), to: round(a.end + 0.5) } }
        : { tool: "log_table", args: { channels: [...new Set([ch.name, ...follows.flatMap((f) => f.channels)])].slice(0, 6), from: round(Math.max(0, a.start - 0.3)), to: round(a.end + 0.3), points: 40 } } });
  }
  const machines = machineStates(recording, { from, to, limit: 200 }).machines;
  for (const m of machines)
    for (const e of m.history as Record<string, unknown>[])
      if (e.flapping)
        add({ id: `machine-flicker:${m.id}`, severity: "error", kind: "machine-flicker", time: e.start as number,
          title: `Machine ${m.id} fights itself`, detail: `${e.changes} changes between ${(e.states as string[]).join(" and ")}: ${(e.transitions as string[]).join(", ")}. ${e.hint}`,
          channels: [m.channel], metric: e.changes as number, evidence: { inputs: e.inputs },
          next: { tool: "log_states", args: { machines: [m.id], from: round(Math.max(0, (e.start as number) - 0.5)), to: round((e.end as number) + 0.5) } } });

  // Loop timing: work time over budget, or a period that skipped whole loops.
  for (const c of pool.filter(numeric)) {
    const leaf = norm(c.name);
    const work = /(LoopTime|FullCycle|CycleTime|UserCode)(MS|Ms|_ms)?$|LoggedRobot\/(FullCycleMS|UserCodeMS)$/i.test(leaf);
    const period = /LoopPeriod(MS|Ms)?$/i.test(leaf);
    if (!work && !period) continue;
    const limit = work ? 20 : 30;
    const over = c.samples.filter((s) => (s.value as number) > limit && enabledAt(phases, s.time) && inRange(s.time));
    const vals = c.samples.map((s) => s.value as number).sort((a, b) => a - b);
    metrics[`${c.name} p99`] = round(vals[Math.floor(vals.length * 0.99)] ?? 0, 3);
    if (over.length)
      add({ id: `loop-overrun:${c.name}`, severity: work ? "error" : "warning", kind: "loop-overrun", time: over[0].time,
        title: work ? "Robot loop over its 20 ms budget" : "Robot loop skipped cycles",
        detail: `${over.length} loops with ${c.name} > ${limit} ms (max ${round(Math.max(...over.map((s) => s.value as number)), 2)} ms). ${work ? "Find the subsystem with the time spike (LoggedTracer/*, profiling) and move blocking work off the main loop." : "Usually a slow loop or GC pause; check loop work time at the same moment."}`,
        channels: [c.name], metric: over.length,
        next: { tool: "log_what_changed", args: { time: round(over[0].time), window: 0.2, filter: ["MS", "Ms", "Time"] } } });
  }

  // Alerts and console output.
  for (const c of pool) {
    const level = /alerts\/errors$/i.test(c.name) ? "error" : /alerts\/warnings$/i.test(c.name) ? "warning" : undefined;
    if (!level || c.type !== "string[]") continue;
    const seen = new Map<string, number>();
    for (const s of c.samples) {
      if (!inRange(s.time)) continue;
      let items: unknown = [];
      try { items = JSON.parse(String(s.value)); } catch { /* not an array */ }
      for (const text of Array.isArray(items) ? items : []) if (!seen.has(String(text))) seen.set(String(text), s.time);
    }
    for (const [text, time] of seen)
      add({ id: `alert:${text}`, severity: level, kind: "alert", time, title: `Alert: ${text}`, detail: `Raised on ${c.name} at ${round(time, 2)} s.`, channels: [c.name],
        next: { tool: "log_events", args: { channels: [c.name] } } });
  }
  for (const c of recording.channels.filter((c) => /^(messages|\/?RealOutputs\/Console|\/?Console)$/i.test(c.name) && c.samples.length)) {
    const seen = new Set<string>();
    for (const s of c.samples) {
      const text = String(s.value).trim();
      if (!inRange(s.time) || !/error|exception|fail|stale|overrun|not received|timed out|unable/i.test(text) || seen.has(text.slice(0, 120))) continue;
      seen.add(text.slice(0, 120));
      add({ id: `console:${text.replace(/\d+(\.\d+)?/g, "#").slice(0, 80)}`, severity: /exception|error/i.test(text) ? "error" : "warning", kind: "console", time: s.time,
        title: `Console: ${text.split("\n")[0].slice(0, 100)}`, detail: text.slice(0, 400), channels: [c.name] });
    }
  }

  // Motors held at a current limit (stalled or jammed) while enabled.
  for (const c of pool.filter((c) => numeric(c) && /statorcurrent/i.test(c.name))) {
    let peak = 0;
    for (const s of c.samples) peak = Math.max(peak, Math.abs(s.value as number));
    if (peak < 20) continue;
    let runStart: number | undefined, last = 0;
    const spans: [number, number][] = [];
    for (const s of c.samples) {
      const pinned = Math.abs(s.value as number) >= peak * 0.97 && enabledAt(phases, s.time);
      if (pinned) runStart ??= s.time;
      else if (runStart !== undefined) { spans.push([runStart, last]); runStart = undefined; }
      last = s.time;
    }
    if (runStart !== undefined) spans.push([runStart, last]);
    for (const [a, b] of spans.filter(([a, b]) => b - a >= 0.5))
      add({ id: `current-limited:${c.name}`, severity: "warning", kind: "current-limited", time: a,
        title: `${c.name} held at its current limit`,
        detail: `${round(b - a, 2)} s at ~${round(peak, 1)} A: the mechanism is stalled, jammed or asked for more than it can do.`,
        channels: [c.name], metric: round(b - a, 2), next: { tool: "log_what_changed", args: { time: round(a), window: 0.5 } } });
  }

  // Pose jumps (odometry resets, bad vision) on robot pose channels while enabled.
  for (const x of pool.filter((c) => numeric(c) && /(^|\/)(Robot)?Pose(Estimate|Estimator)?\/x$/i.test(norm(c.name)) && !/target|lookahead|vision|camera|reference/i.test(c.name))) {
    const y = recording.channels.find((c) => c.name === x.name.replace(/x$/, "y"));
    if (!y) continue;
    for (let i = 1; i < x.samples.length; i++) {
      const a = x.samples[i - 1], b = x.samples[i];
      const dt = b.time - a.time;
      const ya = valueAt(y, a.time), yb = valueAt(y, b.time);
      if (typeof ya !== "number" || typeof yb !== "number" || dt <= 0 || dt > 0.25) continue;
      const d = Math.hypot((b.value as number) - (a.value as number), yb - ya);
      if (d > 0.4 && d / dt > 8 && enabledAt(phases, b.time))
        add({ id: `pose-jump:${x.name}`, severity: "warning", kind: "pose-jump", time: b.time,
          title: "Robot pose jumped", detail: `${round(d, 2)} m in ${round(dt, 3)} s on ${x.name.replace(/\/x$/, "")} (a reset or a bad vision update).`,
          channels: [x.name, y.name], metric: round(d, 3), next: { tool: "log_what_changed", args: { time: round(b.time), window: 0.3, filter: ["pose", "vision", "reset"] } } });
    }
  }

  // Power, from the shared analysis. Estimated (summed motor) current is a hint, not a finding.
  const power = analyze(recording, opts.mapping);
  for (const f of power.findings) {
    const estimated = f.channel === "Estimated total supply current";
    add({ id: `power:${f.title}`, severity: estimated ? "info" : f.severity, kind: "power", time: f.start, title: f.title,
      detail: f.detail + (estimated ? " Summed from motor supply currents; in sim these overstate battery current." : ""),
      channels: [f.channel], next: { tool: "log_what_changed", args: { time: round(f.start), window: 0.5 } } });
  }
  if (power.power.minVoltage !== undefined) metrics["min battery voltage"] = round(power.power.minVoltage, 3);

  // Group by id: one entry per problem, with its occurrence times.
  const ignore = (opts.ignore ?? []).map((s) => s.toLowerCase());
  const grouped = new Map<string, Diagnosis>();
  for (const d of raw.sort((a, b) => a.time - b.time)) {
    if (ignore.some((s) => d.id.toLowerCase().includes(s) || d.kind === s)) continue;
    const { time, ...rest } = d;
    const g = grouped.get(d.id);
    if (!g) { grouped.set(d.id, { ...rest, at: [round(time)], occurrences: 1, phases: [phaseAt(phases, time)] }); continue; }
    g.occurrences++;
    if (g.at.length < 5 && !g.at.includes(round(time))) g.at.push(round(time));
    const p = phaseAt(phases, time);
    if (!g.phases.includes(p)) g.phases.push(p);
    if (d.metric !== undefined && (g.metric === undefined || d.metric > g.metric)) { g.metric = d.metric; g.detail = d.detail; g.evidence = d.evidence; g.next = d.next; }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  const findings = [...grouped.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || b.occurrences - a.occurrences);
  const limit = Math.min(opts.limit ?? 30, 200);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    name: recording.name,
    duration: round(recording.duration),
    counts,
    findings: findings.slice(0, limit),
    truncated: findings.length > limit,
    context: { ...context(recording, phases, pool, machines, trackingSummary), ...(unpairedSetpoints.length ? { unpairedSetpoints } : {}) },
    metrics,
  };
}

/** What happened in the run, for orienting before reading findings. */
function context(recording: Recording, phases: Phase[], pool: Channel[], machines: { id: string; count: number }[], tracking: Record<string, unknown>[]) {
  const stateChannels = pool.filter((c) => c.type === "string" && /(^|\/)(state|mode|status|currentstate|superstate)$/i.test(c.name.split("/").pop()!) && !/\.|prev/i.test(c.name.split("/").pop()!));
  const states = stateChannels.map((c) => {
    const seq: [number, unknown][] = [];
    for (const s of c.samples) if (!seq.length || seq[seq.length - 1][1] !== s.value) seq.push([round(s.time, 2), show(s.value)]);
    return { channel: c.name, changes: seq.length - 1, sequence: seq.slice(0, 40), truncated: seq.length > 40 };
  }).filter((s) => s.changes > 0);
  const text = (re: RegExp) => { const c = recording.channels.find((c) => re.test(c.name) && c.samples.length); return c ? show(c.samples[c.samples.length - 1].value) : undefined; };
  const commands = pool.filter((c) => /CurrentCommand$/i.test(c.name) && c.type === "string")
    .map((c) => ({ channel: c.name, values: [...new Set(c.samples.map((s) => s.value))].slice(0, 8) }));
  const warnings = recording.warnings.filter((w) => !/^structschema:/.test(w));
  return {
    phases,
    build: text(/Mayhem\/Build$/),
    autoSelected: text(/Auto(nomous)? ?Chooser\/(active|selected)$/i),
    states,
    machines: machines.map((m) => ({ id: m.id, transitions: m.count })),
    tracking,
    commands,
    ...(warnings.length ? { parserWarnings: warnings } : {}),
  };
}

// ---- Compare -----------------------------------------------------------------------------------
/** Diagnose both runs and line findings up by id: fixed, still present (better/worse), new. */
export function compareLogs(before: Recording, after: Recording, opts: DiagnoseOptions = {}) {
  const all = { ...opts, limit: 200 };
  const a = diagnoseLog(before, all), b = diagnoseLog(after, all);
  const byId = (d: typeof a) => new Map(d.findings.map((f) => [f.id, f]));
  const A = byId(a), B = byId(b);
  const brief = (f: Diagnosis) => ({ id: f.id, severity: f.severity, title: f.title, occurrences: f.occurrences, at: f.at, ...(f.metric !== undefined ? { metric: f.metric } : {}) });
  const fixed = [...A.values()].filter((f) => !B.has(f.id)).map(brief);
  const added = [...B.values()].filter((f) => !A.has(f.id)).map((f) => ({ ...brief(f), detail: f.detail, next: f.next }));
  const persisting = [...A.values()].filter((f) => B.has(f.id)).map((f) => {
    const g = B.get(f.id)!;
    const trend = g.occurrences < f.occurrences || (g.metric ?? 0) < (f.metric ?? 0) ? "better" : g.occurrences > f.occurrences || (g.metric ?? 0) > (f.metric ?? 0) ? "worse" : "same";
    return { id: f.id, severity: g.severity, title: g.title, trend, before: { occurrences: f.occurrences, metric: f.metric }, after: { occurrences: g.occurrences, metric: g.metric, at: g.at } };
  });
  const metrics = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].map((k) => ({ name: k, before: a.metrics[k] ?? null, after: b.metrics[k] ?? null }))
    .filter((m) => m.before !== m.after);
  // State sequences that differ: the same inputs should give the same behavior unless it was the fix.
  const seq = (d: typeof a) => new Map(d.context.states.map((s) => [s.channel, s.sequence.map((x) => x[1]).join(" → ")]));
  const sa = seq(a), sb = seq(b);
  const states = [...new Set([...sa.keys(), ...sb.keys()])].filter((k) => sa.get(k) !== sb.get(k)).map((k) => ({ channel: k, before: sa.get(k) ?? null, after: sb.get(k) ?? null }));
  const regressed = added.some((f) => f.severity === "error") || persisting.some((p) => p.trend === "worse" && p.severity === "error");
  return {
    before: { name: before.name, counts: a.counts },
    after: { name: after.name, counts: b.counts },
    verdict: regressed ? "regressed" : fixed.length && !added.length ? "improved" : !fixed.length && !added.length && persisting.every((p) => p.trend === "same") ? "unchanged" : "mixed",
    fixed,
    new: added,
    persisting,
    metrics,
    states,
  };
}
