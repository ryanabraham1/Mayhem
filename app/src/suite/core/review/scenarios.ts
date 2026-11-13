/**
 * Sim proof scenarios: scripted driver inputs and autos run through the robot's own simulation
 * (probe.cpp), and what to check in the recorded log. Written in plain lines so drive team members
 * and agents can both read them:
 *
 *   tools/mayhem/scenarios.json
 *   { "scenarios": [ {
 *       "name": "Hold A shoots",
 *       "steps": ["teleop", "wait 0.5", "hold A 2", "press RT", "wait 1"],
 *       "expect": ["Shooter mode is SHOOTING by 1.5 s", "Intake mode never OUTTAKING"]
 *   } ] }
 *
 * Steps: `teleop` | `auto` | `disabled`, `select auto <name>`, `wait <s>`, `press <button>` (tap),
 * `hold <button> <s>`, `down <button>` / `up <button>`, `stick left|right <x> <y>` (forward is +y).
 * Buttons: A B X Y LB RB LT RT Back Start LS RS Up Down Left Right (D-pad).
 * Expectations: `<machine> is <STATE> by <t> s`, `<machine> is <STATE> at <t> s`,
 * `<machine> reaches <STATE>`, `<machine> never <STATE>`, `auto completes`, `no tip-over`,
 * `no collisions`, `battery stays above <v> V`. Times are seconds from the scenario's start.
 */
import { valueAt, type Recording } from "../analysis.ts";
import type { MachineManifest } from "../machines.ts";
import type { SuiteProject } from "../model.ts";

export const BUTTONS = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right"] as const;
export type Button = (typeof BUTTONS)[number];

export type ProbeStep =
  | { kind: "mode"; mode: "teleop" | "auto" | "disabled" }
  | { kind: "auto"; name: string }
  | { kind: "button"; button: Button; down: boolean }
  | { kind: "axis"; axis: "leftX" | "leftY" | "rightX" | "rightY"; value: number }
  | { kind: "wait"; seconds: number };

export interface Scenario {
  id: string;
  name: string;
  /** `button`: generated per controller button; `auto`: every routine; `custom`: scenarios.json. */
  group: "button" | "auto" | "custom";
  alliance: "blue" | "red";
  field: boolean;
  steps: string[];
  expect: string[];
  /** The auto this runs, for path replays. */
  routine?: string;
}

const button = (text: string): Button => {
  const b = BUTTONS.find((x) => x.toLowerCase() === text.toLowerCase());
  if (!b) throw new Error(`Unknown button "${text}" (use ${BUTTONS.join(", ")}).`);
  return b;
};
const seconds = (text: string | undefined, line: string) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 180) throw new Error(`Expected seconds in "${line}".`);
  return n;
};

/** Plain step lines to the probe's step list. */
export function compileSteps(lines: string[]): ProbeStep[] {
  const out: ProbeStep[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const [verb, ...rest] = line.split(/\s+/);
    const v = verb?.toLowerCase();
    if (v === "teleop" || v === "auto" || v === "disabled") {
      if (rest.length) throw new Error(`"${line}": use "select auto <name>" to choose an auto.`);
      out.push({ kind: "mode", mode: v });
    } else if (v === "select" && rest[0]?.toLowerCase() === "auto" && rest.length > 1) out.push({ kind: "auto", name: rest.slice(1).join(" ") });
    else if (v === "wait") out.push({ kind: "wait", seconds: seconds(rest[0], line) });
    else if (v === "press") out.push({ kind: "button", button: button(rest[0] ?? ""), down: true }, { kind: "wait", seconds: 0.06 }, { kind: "button", button: button(rest[0] ?? ""), down: false });
    else if (v === "hold") out.push({ kind: "button", button: button(rest[0] ?? ""), down: true }, { kind: "wait", seconds: seconds(rest[1], line) }, { kind: "button", button: button(rest[0] ?? ""), down: false });
    else if (v === "down" || v === "up") out.push({ kind: "button", button: button(rest[0] ?? ""), down: v === "down" });
    else if (v === "stick" && (rest[0] === "left" || rest[0] === "right") && rest.length === 3) {
      const [x, y] = [Number(rest[1]), Number(rest[2])];
      if (![x, y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1)) throw new Error(`Stick values must be -1..1 in "${line}".`);
      // Xbox: pushing a stick forward reads negative Y.
      out.push({ kind: "axis", axis: rest[0] === "left" ? "leftX" : "rightX", value: x }, { kind: "axis", axis: rest[0] === "left" ? "leftY" : "rightY", value: -y });
    } else throw new Error(`Unknown step "${line}".`);
  }
  return out;
}

/** Every button tapped and held from teleop idle, every auto, and the team's own scenarios. */
export function scenarioSet(project: SuiteProject | undefined, scenariosJson: string | undefined): { scenarios: Scenario[]; errors: string[] } {
  const scenarios: Scenario[] = [];
  const errors: string[] = [];
  for (const b of BUTTONS) {
    scenarios.push({ id: `tap-${b}`, name: `Tap ${b}`, group: "button", alliance: "blue", field: false, steps: ["teleop", "wait 1", `press ${b}`, "wait 2.5"], expect: [] });
    scenarios.push({ id: `hold-${b}`, name: `Hold ${b} for 2 s`, group: "button", alliance: "blue", field: false, steps: ["teleop", "wait 1", `hold ${b} 2`, "wait 1.5"], expect: [] });
  }
  for (const r of project?.routines ?? [])
    scenarios.push({
      id: `auto-${r.id}`,
      name: `Auto: ${r.name}`,
      group: "auto",
      alliance: "blue",
      field: true,
      steps: ["disabled", "wait 0.1", `select auto ${r.name}`, "wait 0.5", "auto", "wait 20", "disabled", "wait 0.2"],
      expect: ["auto completes", "no tip-over"],
      routine: r.id,
    });
  if (scenariosJson !== undefined) {
    try {
      const value = JSON.parse(scenariosJson);
      const list = Array.isArray(value) ? value : value?.scenarios;
      if (!Array.isArray(list)) throw new Error('Expected { "scenarios": [...] }.');
      list.forEach((s: Partial<Scenario>, i: number) => {
        try {
          if (typeof s?.name !== "string" || !s.name.trim()) throw new Error("needs a name");
          if (!Array.isArray(s.steps) || !s.steps.every((x) => typeof x === "string")) throw new Error("steps must be a list of lines");
          compileSteps(s.steps);
          const expect = Array.isArray(s.expect) ? s.expect.filter((x): x is string => typeof x === "string") : [];
          expect.forEach((e) => parseExpectation(e));
          scenarios.push({
            id: `custom-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            name: s.name,
            group: "custom",
            alliance: s.alliance === "red" ? "red" : "blue",
            field: s.field === true,
            steps: s.steps,
            expect,
          });
        } catch (e) {
          errors.push(`scenarios.json #${i + 1}: ${(e as Error).message}`);
        }
      });
    } catch (e) {
      errors.push(`scenarios.json: ${(e as Error).message}`);
    }
  }
  return { scenarios, errors };
}

/** The probe's input for one scenario. */
export const probeInput = (s: Scenario) => ({ alliance: s.alliance, field: s.field, steps: compileSteps(s.steps) });

export type Expectation =
  | { kind: "state"; machine: string; state: string; by?: number; at?: number; never?: boolean }
  | { kind: "auto-completes" }
  | { kind: "no-tip" }
  | { kind: "no-collisions" }
  | { kind: "battery"; volts: number };

export function parseExpectation(text: string): Expectation {
  const t = text.trim();
  if (/^auto completes$/i.test(t)) return { kind: "auto-completes" };
  if (/^no tip-?over$/i.test(t)) return { kind: "no-tip" };
  if (/^no collisions$/i.test(t)) return { kind: "no-collisions" };
  let m = /^battery stays above ([\d.]+)\s*V$/i.exec(t);
  if (m) return { kind: "battery", volts: Number(m[1]) };
  m = /^(.+?) is (\S+) (by|at) ([\d.]+)\s*s$/i.exec(t);
  if (m) return { kind: "state", machine: m[1], state: m[2], [m[3].toLowerCase()]: Number(m[4]) };
  m = /^(.+?) reaches (\S+)$/i.exec(t);
  if (m) return { kind: "state", machine: m[1], state: m[2] };
  m = /^(.+?) never (\S+)$/i.exec(t);
  if (m) return { kind: "state", machine: m[1], state: m[2], never: true };
  throw new Error(`Can't read expectation "${t}".`);
}

export interface Physics {
  tippedOver?: boolean;
  brownedOut?: boolean;
  hits?: string[];
  minBatteryVolts?: number;
  maxTotalCurrent?: number;
  end?: [number, number, number];
}

/** A channel the scenario outcome is judged and compared on. */
export interface Track {
  name: string;
  channel: string;
  /** Value changes, seconds from the scenario's start. */
  changes: { time: number; value: string }[];
}

export interface Outcome {
  tracks: Track[];
  poses: { time: number; x: number; y: number; heading: number }[];
  autoStatus?: string;
  physics?: Physics;
  /** Scenario seconds since the log started (the robot program's boot). */
  offset: number;
  duration: number;
}

const STATUS_CHANNEL = /Mayhem\/Auto\/Status$/;
const plainId = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
/** Every machine's state (Mayhem's `Mayhem/States/<id>/state`, or a manifest's state channel), the drive mode and the auto status: what a driver would notice. */
function trackChannels(recording: Recording, machines: MachineManifest[]): { name: string; channel: string }[] {
  const out: { name: string; channel: string }[] = [];
  const seen = new Set<string>();
  for (const c of recording.channels) {
    const m = /^\/?(?:RealOutputs\/)?Mayhem\/States\/([^/]+)\/state$/.exec(c.name);
    if (!m || !c.samples.length || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: machines.find((x) => x.id === m[1])?.name ?? plainId(m[1]), channel: c.name });
  }
  for (const m of machines) {
    if (seen.has(m.id) || !m.stateChannel) continue;
    const c = recording.channels.find((x) => x.name === m.stateChannel || x.name.endsWith(m.stateChannel!));
    if (c) out.push({ name: m.name, channel: c.name });
  }
  for (const c of recording.channels)
    if (!c.name.startsWith("NT:") && (/RealOutputs\/Drive\/?Mode$/.test(c.name) || STATUS_CHANNEL.test(c.name)))
      out.push({ name: STATUS_CHANNEL.test(c.name) ? "Auto status" : "Drive mode", channel: c.name });
  return out.filter((t, i) => out.findIndex((o) => o.channel === t.channel) === i);
}

/** The robot's position: the simulated true pose when logged, else the logged robot pose. */
function poseChannels(recording: Recording) {
  const named = (re: RegExp) => recording.channels.find((c) => !c.name.startsWith("NT:") && re.test(c.name) && c.samples.length);
  const x = named(/Sim\/RobotPose\/x$/) ?? named(/RealOutputs\/.*Robot\/?Pose\/x$/i) ?? named(/RealOutputs\/(?!Vision|ShotCalculator).*Pose\/x$/i);
  if (!x) return undefined;
  const prefix = x.name.slice(0, -1);
  const get = (n: string) => recording.channels.find((c) => c.name === prefix + n);
  return { x, y: get("y"), heading: get("heading") ?? get("rotation"), qw: get("qw"), qz: get("qz") };
}

/** The scenario's outcome from its log: state timelines, path and auto status. */
export function outcomeOf(recording: Recording, machines: MachineManifest[], physics?: Physics, durationHint?: number): Outcome {
  // The harness's clock starts with the robot program, at the scenario's start.
  const offset = Math.min(...recording.channels.flatMap((c) => (c.samples.length ? [c.samples[0].time] : [])).concat([0]));
  const tracks: Track[] = trackChannels(recording, machines).map(({ name, channel }) => {
    const c = recording.channels.find((x) => x.name === channel)!;
    const changes: Track["changes"] = [];
    for (const s of c.samples) {
      const value = String(s.value);
      if (changes[changes.length - 1]?.value !== value) changes.push({ time: s.time - offset, value });
    }
    return { name, channel, changes };
  });
  const p = poseChannels(recording);
  const poses: Outcome["poses"] = [];
  if (p?.y) {
    let last = -Infinity;
    for (const s of p.x.samples) {
      if (s.time - last < 0.1 || typeof s.value !== "number") continue;
      const y = valueAt(p.y, s.time);
      if (typeof y !== "number") continue;
      const h = p.heading && valueAt(p.heading, s.time);
      const qw = p.qw && valueAt(p.qw, s.time),
        qz = p.qz && valueAt(p.qz, s.time);
      const heading = typeof h === "number" ? h : typeof qw === "number" && typeof qz === "number" ? 2 * Math.atan2(qz, qw) : 0;
      poses.push({ time: s.time - offset, x: s.value, y, heading });
      last = s.time;
    }
  }
  const status = recording.channels.find((c) => !c.name.startsWith("NT:") && STATUS_CHANNEL.test(c.name));
  const end = Math.max(...recording.channels.flatMap((c) => (c.samples.length ? [c.samples[c.samples.length - 1].time] : [])).concat([0]));
  return {
    tracks,
    poses,
    ...(status?.samples.length ? { autoStatus: String(status.samples[status.samples.length - 1].value) } : {}),
    ...(physics ? { physics } : {}),
    offset,
    duration: durationHint ?? end - offset,
  };
}

/** State of a track at a scenario time. */
const stateAt = (t: Track, time: number) => [...t.changes].reverse().find((c) => c.time <= time + 1e-6)?.value;

export interface Check {
  text: string;
  pass: boolean;
  detail: string;
}

export function checkExpectations(s: Scenario, o: Outcome, machines: MachineManifest[]): Check[] {
  const stutter: Check[] = o.tracks.flatMap((t) => {
    const f = flapping(t);
    return f ? [{ text: `${t.name} doesn't flicker`, pass: false, detail: `Flips between ${f.values.join(" and ")} ${f.count} times (${f.from.toFixed(1)}–${f.to.toFixed(1)} s)` }] : [];
  });
  return [...stutter, ...s.expect.map((text) => {
    let e: Expectation;
    try {
      e = parseExpectation(text);
    } catch (err) {
      return { text, pass: false, detail: (err as Error).message };
    }
    if (e.kind === "auto-completes")
      return { text, pass: /complet/i.test(o.autoStatus ?? ""), detail: `Auto status: ${o.autoStatus ?? "not logged"}` };
    if (e.kind === "no-tip") return { text, pass: o.physics ? !o.physics.tippedOver : true, detail: o.physics ? (o.physics.tippedOver ? "Tipped over" : "Stayed upright") : "No physics data" };
    if (e.kind === "no-collisions") {
      const hits = o.physics?.hits ?? [];
      return { text, pass: hits.length === 0, detail: hits.length ? hits.slice(0, 3).join("; ") : "No hits" };
    }
    if (e.kind === "battery") {
      const v = o.physics?.minBatteryVolts;
      return { text, pass: v === undefined || v >= e.volts, detail: v === undefined ? "No battery data" : `Lowest ${v.toFixed(2)} V` };
    }
    const machine = machines.find((m) => m.name.toLowerCase() === e.machine.toLowerCase() || m.id.toLowerCase() === e.machine.toLowerCase());
    const track = o.tracks.find((t) => t.name === machine?.name);
    if (!machine || !track) return { text, pass: false, detail: `No recorded state for "${e.machine}"` };
    const state = machine.states.find((x) => x.id.toLowerCase() === e.state.toLowerCase() || x.name.toLowerCase() === e.state.toLowerCase())?.id ?? e.state;
    const hits = track.changes.filter((c) => c.value === state);
    if (e.never) return { text, pass: hits.length === 0, detail: hits.length ? `Entered ${state} at ${hits[0].time.toFixed(2)} s` : `Never ${state}` };
    if (e.at !== undefined) {
      const now = stateAt(track, e.at);
      return { text, pass: now === state, detail: `At ${e.at} s: ${now ?? "nothing logged"}` };
    }
    const first = hits[0];
    const pass = !!first && (e.by === undefined || first.time <= e.by + 1e-6);
    return { text, pass, detail: first ? `Reached ${state} at ${first.time.toFixed(2)} s` : `Never reached ${state}` };
  })];
}

/** Rapid back-and-forth (a state flipping every few loops), which a driver sees as stutter. */
export function flapping(t: Track): { values: string[]; count: number; from: number; to: number } | undefined {
  let best: { values: string[]; count: number; from: number; to: number } | undefined;
  let start = 0;
  for (let i = 1; i <= t.changes.length; i++) {
    const quick = i < t.changes.length && t.changes[i].time - t.changes[i - 1].time <= 0.1;
    if (quick) continue;
    const run = t.changes.slice(start, i);
    if (run.length >= 6 && (!best || run.length > best.count))
      best = { values: [...new Set(run.map((c) => c.value))], count: run.length, from: run[0].time, to: run[run.length - 1].time };
    start = i;
  }
  return best;
}

/** A track's changes in words, with long flapping runs collapsed. */
export function describeTrack(t: Track, limit = 10): string {
  const parts: string[] = [];
  for (let i = 0; i < t.changes.length; ) {
    let j = i + 1;
    while (j < t.changes.length && t.changes[j].time - t.changes[j - 1].time <= 0.1) j++;
    const run = t.changes.slice(i, j);
    if (run.length >= 6) parts.push(`flips between ${[...new Set(run.map((c) => c.value))].join(" and ")} ${run.length} times (${run[0].time.toFixed(1)}–${run[run.length - 1].time.toFixed(1)} s)`);
    else parts.push(...run.map((c) => `${c.value} (${c.time.toFixed(1)} s)`));
    i = j;
  }
  return parts.length > limit ? [...parts.slice(0, limit - 2), `… ${parts.length - limit + 1} more`, parts[parts.length - 1]].join(" → ") : parts.join(" → ");
}

/** Same steps at different times: "same steps, up to 1.2 s later". */
function shiftText(shifts: number[]) {
  const worst = shifts.reduce((w, d) => (Math.abs(d) > Math.abs(w) ? d : w), 0);
  return `same steps, up to ${Math.abs(worst).toFixed(1)} s ${worst > 0 ? "later" : "earlier"}`;
}

/** Different steps, in a few words: what is new, what is gone, flickering. */
function stepsText(before: Track, after: Track) {
  const was = new Set(before.changes.map((c) => c.value)),
    now = new Set(after.changes.map((c) => c.value));
  const parts: string[] = [];
  const flap = flapping(after);
  if (flap && !flapping(before)) parts.push(`now flickers between ${flap.values.join(" and ")} (${flap.from.toFixed(1)} s)`);
  const added = [...now].filter((v) => !was.has(v)),
    gone = [...was].filter((v) => !now.has(v));
  if (added.length) parts.push(`now also ${added.slice(0, 4).join(", ")}${added.length > 4 ? "…" : ""}`);
  if (gone.length) parts.push(`no longer ${gone.slice(0, 4).join(", ")}${gone.length > 4 ? "…" : ""}`);
  if (!parts.length) parts.push(`different steps (${before.changes.length} before, ${after.changes.length} now)`);
  return parts.join("; ");
}

/** Two runs of the same scenario behave the same when every track goes through the same values at about the same times. */
export function compareOutcomes(before: Outcome, after: Outcome, tolerance = 0.15): { same: boolean; differences: string[] } {
  const differences: string[] = [];
  const names = [...new Set([...before.tracks, ...after.tracks].map((t) => t.name))];
  for (const name of names) {
    const a = before.tracks.find((t) => t.name === name),
      b = after.tracks.find((t) => t.name === name);
    const text = (t?: Track) => (t ? describeTrack(t, 6) : "not logged");
    if (!a || !b) {
      differences.push(`${name}: ${text(a)} ⇒ ${text(b)}`);
      continue;
    }
    const sameValues = a.changes.length === b.changes.length && a.changes.every((c, i) => c.value === b.changes[i].value);
    const shifts = sameValues ? a.changes.map((c, i) => b.changes[i].time - c.time) : [];
    if (sameValues && shifts.every((d) => Math.abs(d) <= tolerance)) continue;
    differences.push(`${name}: ${sameValues ? shiftText(shifts) : stepsText(a, b)}`);
  }
  if ((before.autoStatus ?? "") !== (after.autoStatus ?? "")) differences.push(`Auto result: ${before.autoStatus ?? "—"} ⇒ ${after.autoStatus ?? "—"}`);
  // Where the robot drove: the largest gap between the two paths at the same moment.
  let worst = { gap: 0, time: 0 };
  for (const p of after.poses) {
    const q = before.poses.reduce<(typeof before.poses)[number] | undefined>((best, x) => (!best || Math.abs(x.time - p.time) < Math.abs(best.time - p.time) ? x : best), undefined);
    if (!q || Math.abs(q.time - p.time) > 0.15) continue;
    const gap = Math.hypot(p.x - q.x, p.y - q.y);
    if (gap > worst.gap) worst = { gap, time: p.time };
  }
  if (worst.gap > 0.25) differences.push(`Path: up to ${worst.gap.toFixed(2)} m from the old path (at ${worst.time.toFixed(1)} s)`);
  return { same: differences.length === 0, differences };
}
