/**
 * Sim proof: every scenario run on both revisions, judged against its expectations and compared
 * before/after. The runner (desktop app or CLI) builds and runs; this decides what passed.
 */
import type { Recording } from "../analysis.ts";
import type { MachineManifest } from "../machines.ts";
import { checkExpectations, compareOutcomes, outcomeOf, probeInput, type Check, type Outcome, type Physics, type Scenario } from "./scenarios.ts";

export interface SimRunner {
  /** Build `rev` with the probe; returns the folder runs go in. */
  prepare(rev: string): Promise<{ dir: string; cached: boolean }>;
  run(dir: string, id: string, scenario: string): Promise<{ log?: string | null; result?: string | null; ok: boolean; output: string }>;
  readLog(path: string): Promise<Recording>;
}

export interface ScenarioResult {
  scenario: Scenario;
  before?: Outcome;
  after?: Outcome;
  /** Expectations, judged on the after run. */
  checks: Check[];
  /** What a driver would notice differently (empty: same behavior). */
  differences: string[];
  /** The after run crashed or failed an expectation. */
  failed: boolean;
  error?: string;
  logs: { before?: string; after?: string };
}

export interface SimProof {
  results: ScenarioResult[];
  /** Every expectation passed and every run finished. */
  passed: boolean;
  /** Scenarios that behave differently. */
  changed: number;
}

/** Runs `scenarios` on `before` (optional) and `after`, `parallel` processes at a time. */
export async function runSimProof(
  runner: SimRunner,
  revs: { before?: string; after: string },
  scenarios: Scenario[],
  machines: MachineManifest[],
  progress: (text: string, done: number, total: number) => void = () => {},
  parallel = 4,
): Promise<SimProof> {
  const sides = (revs.before ? (["before", "after"] as const) : (["after"] as const)) as readonly ("before" | "after")[];
  const dirs: Partial<Record<"before" | "after", string>> = {};
  for (const side of sides) {
    progress(`Building ${side === "before" ? "the before" : "the after"} version with the probe…`, 0, 1);
    dirs[side] = (await runner.prepare(side === "before" ? revs.before! : revs.after)).dir;
  }
  const results: ScenarioResult[] = scenarios.map((scenario) => ({ scenario, checks: [], differences: [], failed: false, logs: {} }));
  const jobs = results.flatMap((r) => sides.map((side) => ({ r, side })));
  let done = 0;
  const work = async ({ r, side }: (typeof jobs)[number]) => {
    try {
      const run = await runner.run(dirs[side]!, r.scenario.id, JSON.stringify(probeInput(r.scenario)));
      if (!run.ok || !run.log) throw new Error(`The simulation stopped early.\n${run.output}`);
      const physics = run.result ? (JSON.parse(run.result).physics as Physics | undefined) : undefined;
      r[side] = outcomeOf(await runner.readLog(run.log), machines, physics);
      r.logs[side] = run.log;
    } catch (e) {
      if (side === "after") r.error = (e as Error).message;
      else r.error ??= `Before: ${(e as Error).message}`;
    }
    progress(`Ran ${r.scenario.name} (${side})`, ++done, jobs.length);
  };
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await work(job);
  }));
  for (const r of results) {
    if (r.after) r.checks = checkExpectations(r.scenario, r.after, machines);
    if (r.before && r.after) r.differences = compareOutcomes(r.before, r.after).differences;
    r.failed = !r.after || r.checks.some((c) => !c.pass);
  }
  return { results, passed: results.every((r) => !r.failed), changed: results.filter((r) => r.differences.length).length };
}
