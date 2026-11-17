/**
 * Sim proof: every scenario run on both revisions, judged against its expectations and compared
 * before/after. The runner (desktop app or CLI) builds and runs; this decides what passed.
 */
import type { Recording } from "../analysis.ts";
import type { MachineManifest } from "../machines.ts";
import { checkExpectations, compareOutcomes, outcomeOf, probeInput, type Check, type Outcome, type Physics, type Scenario } from "./scenarios.ts";
import type { ProofSummary } from "./proofs.ts";

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

/**
 * How many scenario processes to run at once. A run spends most of its time waiting rather than
 * computing (about 5 s of a ~10 s run is Phoenix's start-up wait), so twice the cores keeps the CPU
 * busy: measured on 10 cores, 20 at once ran about twice as many scenarios a second as 9.
 */
export function defaultParallel(cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency) {
  return Math.max(2, Math.min(32, 2 * (cores ?? 4)));
}

/**
 * Runs `scenarios` on `before` (optional) and `after`, `parallel` processes at a time. The first
 * version's scenarios start as soon as it is built, while the second version builds.
 */
export async function runSimProof(
  runner: SimRunner,
  revs: { before?: string; after: string },
  scenarios: Scenario[],
  machines: MachineManifest[],
  progress: (text: string, done: number, total: number) => void = () => {},
  parallel = defaultParallel(),
): Promise<SimProof> {
  const sides = (revs.before ? (["before", "after"] as const) : (["after"] as const)) as readonly ("before" | "after")[];
  const results: ScenarioResult[] = scenarios.map((scenario) => ({ scenario, checks: [], differences: [], failed: false, logs: {} }));
  // One side's jobs after the other's, so workers run the version that is ready.
  const jobs = sides.flatMap((side) => results.map((r) => ({ r, side })));
  let done = 0;
  // Builds one after the other (each already uses every core); a failed build stops the proof.
  const dirs: Partial<Record<"before" | "after", Promise<string>>> = {};
  let built: Promise<unknown> = Promise.resolve();
  for (const side of sides) {
    const dir = built.then(async () => {
      progress(`Building ${side === "before" ? "the before" : "the after"} version with the probe…`, done, jobs.length);
      return (await runner.prepare(side === "before" ? revs.before! : revs.after)).dir;
    });
    dir.catch(() => {}); // reported once, below
    dirs[side] = dir;
    built = dir;
  }
  let buildError: unknown;
  const work = async ({ r, side }: (typeof jobs)[number]) => {
    let dir: string;
    try {
      dir = await dirs[side]!;
    } catch (e) {
      buildError ??= e;
      return;
    }
    try {
      const run = await runner.run(dir, r.scenario.id, JSON.stringify(probeInput(r.scenario)));
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
    for (let job = queue.shift(); job && buildError === undefined; job = queue.shift()) await work(job);
  }));
  await built; // a failed build throws here
  if (buildError !== undefined) throw buildError;
  for (const r of results) {
    if (r.after) r.checks = checkExpectations(r.scenario, r.after, machines);
    if (r.before && r.after) r.differences = compareOutcomes(r.before, r.after).differences;
    r.failed = !r.after || r.checks.some((c) => !c.pass);
  }
  return { results, passed: results.every((r) => !r.failed), changed: results.filter((r) => r.differences.length).length };
}

/** A finished proof, reduced to what is kept on a task's commit. */
export function summarizeProof(proof: SimProof, meta: { by: string; before?: string; partial?: boolean }): Omit<ProofSummary, "at"> {
  return {
    ...(meta.before ? { before: meta.before } : {}),
    by: meta.by,
    ran: proof.results.length,
    failed: proof.results.filter((r) => r.failed).map((r) => r.scenario.name),
    different: proof.results.filter((r) => r.differences.length).map((r) => r.scenario.name),
    ...(meta.partial ? { partial: true } : {}),
  };
}
