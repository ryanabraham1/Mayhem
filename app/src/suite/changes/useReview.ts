import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyEdit } from "../core/review/edit.ts";
import { readProject } from "../core/review/autos.ts";
import { parseMachineSpecs } from "../core/review/machines.ts";
import { buildReport, MACHINES_FILE, projectFile, SCENARIOS_FILE, settingsOf, WORKTREE, type ReviewReport, type Snapshot } from "../core/review/report.ts";
import { scenarioSet } from "../core/review/scenarios.ts";
import { runSimProof, type SimProof } from "../core/review/simproof.ts";
import { parseWPILog } from "../core/wpilog.ts";
import probe from "../core/review/probe.cpp?raw";
import type { Setting } from "../core/review/settings.ts";
import { desktop, invoke, nativeRead } from "../native";
import { takeCompareRequest, useRobotRepo } from "../robotRepo";

export interface Revision {
  rev: string;
  sha: string;
  label: string;
  kind: "branch" | "tag" | "remote" | "commit";
  date: string;
}
export interface RepoInfo {
  root: string;
  branch: string;
  head: string;
  dirty: string[];
  revisions: Revision[];
}


/** The versions last compared, so leaving the page and coming back shows the same review. */
let remembered: { repo: string; before: string; after: string } | undefined;

/**
 * What to compare when nobody chose: with nothing edited on this computer, "last commit → this
 * computer" is always empty, so show what the current branch changes against main (the known-good
 * version) instead.
 */
export function defaultCompare(info: RepoInfo): { before: string; after: string } | undefined {
  if (info.dirty.length) return undefined;
  const main = info.revisions.find((r) => r.kind === "remote" && r.rev === "origin/main") ?? info.revisions.find((r) => r.kind === "branch" && r.rev === "main");
  return main && main.sha !== info.head ? { before: main.rev, after: "HEAD" } : undefined;
}

/** Two revisions of the robot repo, the review between them, and edits to the working copy. */
export function useReview() {
  const [repo, setRepoState] = useRobotRepo();
  const [info, setInfo] = useState<RepoInfo>();
  const [request] = useState(takeCompareRequest);
  const [start] = useState(() => request ?? (remembered?.repo === repo ? remembered : undefined));
  const [before, setBeforeState] = useState(start?.before ?? "HEAD");
  const [after, setAfterState] = useState(start?.after ?? WORKTREE);
  // Once a person (or a link from another page) picks versions, the default no longer applies.
  const chosen = useRef(!!start);
  const setBefore = (rev: string) => {
    chosen.current = true;
    setBeforeState(rev);
  };
  const setAfter = (rev: string) => {
    chosen.current = true;
    setAfterState(rev);
  };
  useEffect(() => {
    if (repo) remembered = { repo, before, after };
  }, [repo, before, after]);
  useEffect(() => {
    if (!info || chosen.current) return;
    chosen.current = true;
    const pick = defaultCompare(info);
    if (pick) {
      setBeforeState(pick.before);
      setAfterState(pick.after);
    }
  }, [info]);
  const [snapshots, setSnapshots] = useState<{ before: Snapshot; after: Snapshot }>();
  const [imported, setImported] = useState<ReviewReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [proof, setProof] = useState<SimProof>();
  // The two versions the proof ran on (commits, or WORKTREE), to keep its result on the commit.
  const [proofRevs, setProofRevs] = useState<{ before: string; after: string }>();
  const [simProgress, setSimProgress] = useState<{ text: string; done: number; total: number }>();
  const [simError, setSimError] = useState<string>();
  const [simErrors, setSimErrors] = useState<string[]>([]);
  // A sim proof belongs to the two versions it ran on.
  useEffect(() => {
    setProof(undefined);
    setSimError(undefined);
  }, [repo, before, after]);

  const setRepo = (path: string) => {
    setRepoState(path);
    setImported(undefined);
    if (path !== repo) {
      // Another repo: its own default comparison.
      chosen.current = false;
      setBeforeState("HEAD");
      setAfterState(WORKTREE);
    }
  };

  const load = useCallback(async () => {
    if (!desktop || !repo) return;
    setLoading(true);
    setError(undefined);
    try {
      const [repoInfo, b, a] = await Promise.all([
        invoke<RepoInfo>("review_repo", { repo }),
        invoke<Snapshot>("review_snapshot", { repo, rev: before }),
        invoke<Snapshot>("review_snapshot", { repo, rev: after }),
      ]);
      setInfo(repoInfo);
      setSnapshots({ before: b, after: a });
    } catch (e) {
      setError(String(e));
      setSnapshots(undefined);
    } finally {
      setLoading(false);
    }
  }, [repo, before, after]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = useMemo(() => imported ?? (snapshots ? buildReport(snapshots.before, snapshots.after) : undefined), [imported, snapshots]);
  const settingsAfter = useMemo<Setting[]>(() => (snapshots ? settingsOf(snapshots.after) : []), [snapshots]);
  const editable = desktop && !imported && after === WORKTREE && !!snapshots;

  /** The working copy's files with one edit applied (for previews), or an error. */
  const preview = (setting: Setting, value: string, index?: number): { files: Record<string, string> } | { error: string } => {
    if (!snapshots) return { error: "Nothing loaded." };
    const file = setting.origin.file;
    try {
      return { files: { ...snapshots.after.files, [file]: applyEdit(snapshots.after.files[file], setting, value, index) } };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  /** Writes one setting to the robot repo's working copy, then reloads. */
  const edit = async (setting: Setting, value: string, index?: number) => {
    if (!editable || !snapshots) throw new Error("Switch “After” to This computer to edit.");
    const file = setting.origin.file;
    const expected = snapshots.after.files[file];
    const text = applyEdit(expected, setting, value, index);
    await invoke("review_write_file", { repo, path: file, expected, text });
    await load();
  };

  /** Builds both versions with the probe and runs every scenario (desktop only). */
  const startSim = async () => {
    if (!snapshots || !repo) return;
    setSimError(undefined);
    setProof(undefined);
    setSimProgress({ text: "Starting…", done: 0, total: 1 });
    try {
      const files = snapshots.after.files;
      const machines = parseMachineSpecs(files[MACHINES_FILE]).machines;
      const project = projectFile(files);
      const set = scenarioSet(project ? readProject(files[project]).project : undefined, files[SCENARIOS_FILE]);
      setSimErrors(set.errors);
      const runner = {
        prepare: (rev: string) => invoke<{ dir: string; cached: boolean }>("review_sim_prepare", { repo, rev, probe }),
        run: (dir: string, id: string, scenario: string) =>
          invoke<{ log?: string | null; result?: string | null; ok: boolean; output: string }>("review_sim_run", { dir, id, scenario }),
        readLog: async (path: string) => parseWPILog(await nativeRead(path), path.split("/").pop() ?? path),
      };
      const revs = { before: snapshots.before.rev, after: after === WORKTREE ? WORKTREE : snapshots.after.rev };
      const result = await runSimProof(runner, revs, set.scenarios, machines, (text, done, total) => setSimProgress({ text, done, total }));
      setProofRevs(revs);
      setProof(result);
    } catch (e) {
      setSimError(String(e));
    } finally {
      setSimProgress(undefined);
    }
  };

  return {
    sim: { proof, revs: proofRevs, progress: simProgress, error: simError, errors: simErrors, start: startSim, set: setProof },
    repo,
    setRepo,
    info,
    before,
    setBefore,
    after,
    setAfter,
    report,
    snapshots,
    settingsAfter,
    loading,
    error,
    reload: load,
    imported,
    setImported,
    editable,
    preview,
    edit,
  };
}
export type Review = ReturnType<typeof useReview>;
