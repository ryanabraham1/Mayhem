/**
 * Scenario coverage: which state machine states the sim proof's runs reach and which of those any
 * scenario checks. A state no scenario expects can change without the proof noticing, so each
 * gap comes with what an agent needs to close it: a draft scenario built from the run that reached
 * the state (steps and time copied from it), or, for a state no run reached, the transitions into
 * it and the inputs they wait on.
 */
import type { MachineManifest } from "../machines.ts";
import type { Condition } from "../model.ts";
import { parseExpectation, type Outcome, type Scenario } from "./scenarios.ts";

export interface CoverageGap {
  machine: string;
  state: string;
  /** `unchecked`: a run reaches it but no scenario expects it. `unreached`: no run reaches it. */
  kind: "unchecked" | "unreached";
  /** Unchecked: the runs that reach it, earliest first, with when. */
  reachedBy?: { scenario: string; time: number }[];
  /**
   * Unchecked: a scenario that pins this state down, from the first run that reached it. It
   * records what the robot does now: confirm that this is intended before adding it to
   * tools/mayhem/scenarios.json, or it locks a bug in.
   */
  draft?: { name: string; steps: string[]; expect: string[] };
  /** Unreached: the transitions into it, with the inputs their conditions read. */
  enteredBy?: { transition: string; from: string; inputs: { key: string; name: string; category?: string }[] }[];
}

/**
 * One row of the feature map: what exists (a machine state), how a driver reaches it (the first
 * run that got there), and what proves it works (the scenarios that expect it).
 */
export interface FeatureRow {
  machine: string;
  state: string;
  name: string;
  status: "proven" | "unchecked" | "unreached";
  reachedBy?: { scenario: string; steps: string[]; time: number };
  provenBy: string[];
}

export interface Coverage {
  /** Non-initial states across every machine. */
  states: number;
  /** States some run entered. */
  reached: number;
  /** States some scenario expects (`is X by|at`, `reaches X`). */
  checked: number;
  gaps: CoverageGap[];
  /** Every state (but initial and boot states), in machine order. */
  map: FeatureRow[];
}

const signalKeys = (c: Condition | undefined, out = new Set<string>()): Set<string> => {
  if (!c) return out;
  if (c.kind === "signal") out.add(c.key);
  else if (c.kind === "all" || c.kind === "any") c.conditions.forEach((x) => signalKeys(x, out));
  else if (c.kind === "not") signalKeys(c.condition, out);
  return out;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Rounded up to the next tenth, with room for the sim's timing to wander. */
const deadline = (time: number) => Math.ceil((time + 0.3) * 10) / 10;

export function scenarioCoverage(machines: MachineManifest[], results: { scenario: Scenario; after?: Outcome }[]): Coverage {
  // Every positive state expectation, by machine id and state id.
  const checked = new Map<string, string[]>();
  for (const { scenario } of results)
    for (const line of scenario.expect) {
      let e;
      try {
        e = parseExpectation(line);
      } catch {
        continue;
      }
      if (e.kind !== "state" || e.never) continue;
      const m = machines.find((x) => same(x.name, e.machine) || same(x.id, e.machine));
      const s = m?.states.find((x) => same(x.id, e.state) || same(x.name, e.state));
      if (m && s) {
        const key = `${m.id}\u0000${s.id}`;
        const list = checked.get(key) ?? [];
        if (!list.includes(scenario.name)) checked.set(key, [...list, scenario.name]);
      }
    }
  const coverage: Coverage = { states: 0, reached: 0, checked: 0, gaps: [], map: [] };
  // Prefer the team's own scenarios as a draft's base (they read like what drivers do), then
  // generated button presses, then autos.
  const order = { custom: 0, button: 1, auto: 2 } as const;
  for (const m of machines) {
    const reached = new Map<string, { scenario: Scenario; time: number }[]>();
    // What the machine logs first is the state it boots in (often not `initial`, e.g. homing):
    // nothing a scenario does gets it there, so it is not a gap.
    const boot = new Set<string>();
    for (const r of results) {
      const track = r.after?.tracks.find((t) => t.name === m.name);
      if (track?.changes.length) boot.add(track.changes[0].value);
      for (const c of track?.changes.slice(1) ?? []) {
        const list = reached.get(c.value) ?? [];
        if (!list.some((x) => x.scenario === r.scenario)) list.push({ scenario: r.scenario, time: c.time });
        reached.set(c.value, list);
      }
    }
    for (const s of m.states) {
      if (s.id === m.initial || (boot.has(s.id) && !reached.has(s.id))) continue;
      coverage.states++;
      const runs = (reached.get(s.id) ?? []).sort((a, b) => order[a.scenario.group] - order[b.scenario.group] || a.time - b.time);
      if (runs.length) coverage.reached++;
      const provenBy = checked.get(`${m.id}\u0000${s.id}`) ?? [];
      coverage.map.push({
        machine: m.name,
        state: s.id,
        name: s.name,
        status: provenBy.length ? "proven" : runs.length ? "unchecked" : "unreached",
        ...(runs.length ? { reachedBy: { scenario: runs[0].scenario.name, steps: runs[0].scenario.steps, time: Math.round(runs[0].time * 100) / 100 } } : {}),
        provenBy,
      });
      if (provenBy.length) {
        coverage.checked++;
        continue;
      }
      if (runs.length) {
        const first = runs[0];
        coverage.gaps.push({
          machine: m.name,
          state: s.id,
          kind: "unchecked",
          reachedBy: runs.slice(0, 3).map((x) => ({ scenario: x.scenario.name, time: Math.round(x.time * 100) / 100 })),
          draft: {
            name: `${first.scenario.name}: ${m.name} reaches ${s.name}`,
            steps: first.scenario.steps,
            expect: [`${m.name} is ${s.id} by ${deadline(first.time)} s`],
          },
        });
        continue;
      }
      const inputs = new Map(m.inputs.map((i) => [i.key, i]));
      coverage.gaps.push({
        machine: m.name,
        state: s.id,
        kind: "unreached",
        enteredBy: m.transitions
          .filter((t) => t.to === s.id)
          .map((t) => ({
            transition: t.name ?? t.id,
            from: t.from,
            inputs: [...signalKeys(t.condition)].map((key) => {
              const i = inputs.get(key);
              return { key, name: i?.name ?? key, ...(i?.category ? { category: i.category } : key === "stateTime" ? { category: "timer" } : {}) };
            }),
          })),
      });
    }
  }
  // Unreached first: nothing exercises them at all.
  coverage.gaps.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "unreached" ? -1 : 1));
  return coverage;
}
