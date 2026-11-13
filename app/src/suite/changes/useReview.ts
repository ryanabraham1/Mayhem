import { useCallback, useEffect, useMemo, useState } from "react";
import { applyEdit } from "../core/review/edit.ts";
import { buildReport, settingsOf, WORKTREE, type ReviewReport, type Snapshot } from "../core/review/report.ts";
import type { Setting } from "../core/review/settings.ts";
import { desktop, invoke } from "../native";

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

  return {
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
