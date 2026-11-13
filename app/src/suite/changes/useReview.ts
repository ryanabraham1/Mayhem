import { useCallback, useEffect, useMemo, useState } from "react";
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

const REPO_KEY = "mayhem.review.repo";
const remembered = () => {
  try {
    return localStorage.getItem(REPO_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Two revisions of the robot repo, the review between them, and edits to the working copy. */
export function useReview() {
  const [repo, setRepoState] = useState(remembered);
  const [info, setInfo] = useState<RepoInfo>();
  const [before, setBefore] = useState("HEAD");
  const [after, setAfter] = useState(WORKTREE);
  const [snapshots, setSnapshots] = useState<{ before: Snapshot; after: Snapshot }>();
  const [imported, setImported] = useState<ReviewReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [proof, setProof] = useState<SimProof>();
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
    try {
      localStorage.setItem(REPO_KEY, path);
    } catch {
      /* a convenience only */
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
      setProof(await runSimProof(runner, { before: snapshots.before.rev, after: after === WORKTREE ? WORKTREE : snapshots.after.rev }, set.scenarios, machines, (text, done, total) => setSimProgress({ text, done, total })));
    } catch (e) {
      setSimError(String(e));
    } finally {
      setSimProgress(undefined);
    }
  };

  return {
    sim: { proof, progress: simProgress, error: simError, errors: simErrors, start: startSim, set: setProof },
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
