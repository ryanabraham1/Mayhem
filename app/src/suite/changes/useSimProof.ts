import { useEffect, useRef, useState } from "react";
import { readProject } from "../core/review/autos.ts";
import { parseMachineSpecs } from "../core/review/machines.ts";
import { MACHINES_FILE, projectFile, SCENARIOS_FILE, type Snapshot } from "../core/review/report.ts";
import { scenarioSet } from "../core/review/scenarios.ts";
import { runSimProof, type SimProof } from "../core/review/simproof.ts";
import { parseWPILog } from "../core/wpilog.ts";
import probe from "../core/review/probe.cpp?raw";
import { invoke, nativeRead } from "../native";

/**
 * Runs every scenario in the robot's own simulation (desktop only): on two versions to compare
 * them (Changes), or on one version alone (Robot → Simulation). `key` names what the proof belongs
 * to; when it changes, a shown proof and a run still going are dropped.
 */
export function useSimProof(repo: string, key: string) {
  const [proof, setProof] = useState<SimProof>();
  // The versions the proof ran on (commits, or WORKTREE), to keep its result on the commit.
  const [revs, setRevs] = useState<{ before?: string; after: string }>();
  const [progress, setProgress] = useState<{ text: string; done: number; total: number }>();
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  // The latest proof started; a run left behind by a newer one (or by switching versions) is dropped.
  const run = useRef(0);
  const busy = useRef(0);
  useEffect(() => {
    run.current++;
    setProof(undefined);
    setError(undefined);
    setProgress(undefined);
  }, [repo, key]);

  /** Builds `after` (and `before`, when given) with the probe and runs every scenario `after`'s files define. */
  const start = async (after: Snapshot, revisions: { before?: string; after: string }) => {
    if (!repo) return;
    // Already running on these versions: a second proof would build into the same folders.
    if (busy.current && busy.current === run.current) return;
    const id = ++run.current;
    busy.current = id;
    const current = () => run.current === id;
    setError(undefined);
    setProof(undefined);
    setProgress({ text: "Starting…", done: 0, total: 1 });
    try {
      const files = after.files;
      const machines = parseMachineSpecs(files[MACHINES_FILE]).machines;
      const project = projectFile(files);
      const set = scenarioSet(project ? readProject(files[project]).project : undefined, files[SCENARIOS_FILE]);
      setErrors(set.errors);
      const runner = {
        prepare: (rev: string) => invoke<{ dir: string; cached: boolean }>("review_sim_prepare", { repo, rev, probe }),
        run: (dir: string, id: string, scenario: string) =>
          invoke<{ log?: string | null; result?: string | null; ok: boolean; output: string }>("review_sim_run", { dir, id, scenario }),
        readLog: async (path: string) => parseWPILog(await nativeRead(path), path.split("/").pop() ?? path),
      };
      const result = await runSimProof(runner, revisions, set.scenarios, machines, (text, done, total) => {
        if (current()) setProgress({ text, done, total });
      });
      if (!current()) return;
      setRevs(revisions);
      setProof(result);
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (busy.current === id) busy.current = 0;
      if (current()) setProgress(undefined);
    }
  };

  return { proof, revs, progress, error, errors, start, set: setProof };
}
export type SimState = ReturnType<typeof useSimProof>;
