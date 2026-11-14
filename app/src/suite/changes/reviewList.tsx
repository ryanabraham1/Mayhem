import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseProofNote, proofFor, withProof, type ProofSummary } from "../core/review/proofs.ts";
import { buildReport, type Level, type Snapshot } from "../core/review/report.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop, invoke } from "../native";
import { useRobotRepo, useRobotStamp } from "../robotRepo";
import type { StoredLog } from "../storage";

/** A branch of the robot repo as the desktop shell lists it (review.rs `Branch`). */
export interface Branch {
  name: string;
  /** What to hand git: the local name, or `origin/<name>` when only GitHub has it. */
  rev: string;
  sha: string;
  /** The commit it left main at: the change is `base..sha`. */
  base: string;
  ahead: number;
  subject: string;
  author: string;
  date: string;
  /** Main already has it (merged, rebased or squashed). */
  merged: boolean;
}

/**
 * A branch with everything a person needs before opening it. All of it is read from the code,
 * git, the robot and the logs; nothing is an agent's account of its own work.
 */
export interface BranchReview extends Branch {
  /** Risk of the change, once its two versions have been read. */
  level?: Level;
  findings?: number;
  /** The sim proof recorded on its newest commit (against its base when there is one). */
  proof?: ProofSummary;
  /** Merged changes: whether the robot runs it (as of the last check) and the logs recorded on it. */
  onRobot?: boolean;
  robotCheckedAt?: number;
  log?: StoredLog;
  logs: number;
  /** Set aside by a person until it gets a new commit. */
  hidden: boolean;
  /** Touched lately enough to be worth showing without being asked. */
  recent: boolean;
}

/** Branches untouched for longer than this are folded away as old. */
const RECENT_DAYS = 21;
/** How many changes get their risk and their reach worked out (the newest ones). */
const DETAILED = 8;
/** Newest logs looked at for "has this change run". */
const LOGS_CHECKED = 8;

const HIDDEN_KEY = "mayhem.review.hidden";
const readHidden = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

// Commits never change, so what is read from a pair of them is read once.
const levels = new Map<string, Promise<{ level: Level; findings: number } | undefined>>();
const reach = new Map<string, Promise<(boolean | null)[] | undefined>>();

function useReviewList() {
  const [repo] = useRobotRepo();
  const [robot] = useRobotStamp();
  const { logs } = useLogLibrary();
  const [listed, setListed] = useState<{ repo: string; main?: { rev: string; sha: string }; branches: Branch[] }>({ repo: "", branches: [] });
  const [notes, setNotes] = useState<Map<string, ProofSummary[]>>(new Map());
  const [risk, setRisk] = useState<Map<string, { level: Level; findings: number }>>(new Map());
  const [reached, setReached] = useState<Map<string, (boolean | null)[]>>(new Map());
  const [hidden, setHidden] = useState(readHidden);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  /** Bumped whenever proofs may have changed, so pages reading other commits' proofs look again. */
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    if (!desktop || !repo) return setListed({ repo: "", branches: [] });
    setLoading(true);
    try {
      const found = await invoke<{ main: { rev: string; sha: string } | null; branches: Branch[] }>("review_branches", { repo });
      const texts = await invoke<(string | null)[]>("review_proofs", { repo, commits: found.branches.map((b) => b.sha) });
      setNotes(new Map(found.branches.map((b, i) => [b.sha, parseProofNote(texts[i])])));
      // Looked at again every minute: keep the same list when nothing moved, so pages don't redraw.
      setListed((previous) => {
        const next = { repo, ...(found.main ? { main: found.main } : {}), branches: found.branches };
        return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
      });
      setVersion((n) => n + 1);
      setError(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repo]);
  // Agents commit, record proofs and get merged outside the app: look when the window comes back
  // to the front and now and then while it stays there.
  useEffect(() => {
    void load();
    if (!desktop || !repo) return;
    const again = () => void load();
    window.addEventListener("focus", again);
    const timer = setInterval(again, 60_000);
    return () => {
      window.removeEventListener("focus", again);
      clearInterval(timer);
    };
  }, [load, repo]);

  const branches = listed.repo === repo ? listed.branches : [];
  const isHidden = useCallback((b: Branch) => hidden[b.name] === b.sha, [hidden]);
  const isRecent = (b: Branch) => Date.now() - Date.parse(b.date) < RECENT_DAYS * 86_400_000;
  const open = useMemo(() => branches.filter((b) => !b.merged && !isHidden(b) && isRecent(b)).slice(0, DETAILED), [branches, isHidden]);
  const landed = useMemo(() => branches.filter((b) => b.merged && isRecent(b)).slice(0, DETAILED), [branches]);

  // Risk of each change waiting for review, from the same report the Changes page shows.
  useEffect(() => {
    if (!desktop || !repo || !open.length) return;
    let current = true;
    void (async () => {
      for (const b of open) {
        const key = `${repo}\n${b.base}\n${b.sha}`;
        let found = levels.get(key);
        if (!found) {
          found = Promise.all([invoke<Snapshot>("review_snapshot", { repo, rev: b.base }), invoke<Snapshot>("review_snapshot", { repo, rev: b.sha })])
            .then(([before, after]) => {
              const report = buildReport(before, after);
              return { level: report.level, findings: report.findings.length };
            })
            .catch(() => undefined);
          levels.set(key, found);
        }
        const value = await found;
        if (!current) return;
        if (value) setRisk((previous) => (previous.get(b.sha)?.level === value.level && previous.get(b.sha)?.findings === value.findings ? previous : new Map(previous).set(b.sha, value)));
      }
    })();
    return () => {
      current = false;
    };
  }, [repo, open]);

  // Where each merged change has got to: on the robot (as of the last check), in which logs.
  const recentLogs = useMemo(
    () =>
      [...logs]
        .filter((l) => !l.archived && l.summary?.revision)
        .sort((a, b) => b.added - a.added)
        .slice(0, LOGS_CHECKED),
    [logs],
  );
  const targets = useMemo(() => [...(robot ? [robot.stamp.sha] : []), ...new Set(recentLogs.map((l) => l.summary!.revision!))], [robot, recentLogs]);
  useEffect(() => {
    if (!desktop || !repo || !landed.length || !targets.length) return;
    let current = true;
    void (async () => {
      for (const b of landed) {
        const key = `${repo}\n${b.base}\n${b.sha}\n${targets.join(",")}`;
        let found = reach.get(key);
        if (!found) {
          found = invoke<(boolean | null)[]>("review_reaches", { repo, base: b.base, tip: b.sha, targets }).catch(() => undefined);
          reach.set(key, found);
        }
        const value = await found;
        if (!current) return;
        if (value) setReached((previous) => (previous.get(key) ? previous : new Map(previous).set(key, value)));
      }
    })();
    return () => {
      current = false;
    };
  }, [repo, landed, targets]);

  const reviews = useMemo<BranchReview[]>(
    () =>
      branches.map((b) => {
        const there = reached.get(`${repo}\n${b.base}\n${b.sha}\n${targets.join(",")}`);
        const includes = (sha: string) => there?.[targets.indexOf(sha)] === true;
        const ran = there ? recentLogs.filter((l) => includes(l.summary!.revision!)) : [];
        return {
          ...b,
          ...(risk.get(b.sha) ?? {}),
          ...(proofFor(notes.get(b.sha) ?? [], b.base) ? { proof: proofFor(notes.get(b.sha) ?? [], b.base) } : {}),
          ...(b.merged && robot && there ? { onRobot: includes(robot.stamp.sha), robotCheckedAt: robot.checkedAt } : {}),
          ...(ran[0] ? { log: ran[0] } : {}),
          logs: ran.length,
          hidden: isHidden(b),
          recent: isRecent(b),
        };
      }),
    [branches, risk, notes, reached, targets, recentLogs, robot, repo, isHidden],
  );

  const setAside = (branch: Branch, aside: boolean) => {
    const next = { ...readHidden() };
    if (aside) next[branch.name] = branch.sha;
    else delete next[branch.name];
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      /* then it stays set aside only until the app restarts */
    }
    setHidden(next);
  };

  /** The sim proofs recorded on any commit, newest first. */
  const proofsOf = useCallback(
    async (commit: string) => (desktop && repo ? parseProofNote((await invoke<(string | null)[]>("review_proofs", { repo, commits: [commit] }).catch(() => [null]))[0]) : []),
    [repo],
  );
  /** Keeps a proof the app just ran on the commit it ran on. */
  const saveProof = async (commit: string, proof: ProofSummary) => {
    const [current] = await invoke<(string | null)[]>("review_proofs", { repo, commits: [commit] });
    await invoke("review_proof_save", { repo, commitId: commit, text: withProof(current, proof) });
    await load();
  };

  return {
    repo,
    main: listed.repo === repo ? listed.main : undefined,
    /** Not in main, touched lately, not set aside: what waits for a person. */
    toReview: reviews.filter((b) => !b.merged && !b.hidden && b.recent),
    /** In main, lately: followed to the robot and the logs. */
    merged: reviews.filter((b) => b.merged && b.recent),
    /** Not in main, but old or set aside. */
    others: reviews.filter((b) => !b.merged && (b.hidden || !b.recent)),
    error,
    loading,
    version,
    reload: load,
    setAside,
    proofsOf,
    saveProof,
  };
}

export type ReviewList = ReturnType<typeof useReviewList>;
const Context = createContext<ReviewList | null>(null);

/** The robot repo's branches as changes to review, for every page. */
export function ReviewProvider({ children }: { children: ReactNode }) {
  const value = useReviewList();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReviews() {
  const value = useContext(Context);
  if (!value) throw new Error("useReviews outside ReviewProvider");
  return value;
}

/** The proof to show for `commit` reviewed against `base` (any commit, not only a branch's newest). */
export function useCommitProof(commit: string | undefined, base: string | undefined): ProofSummary | undefined {
  const { proofsOf, version } = useReviews();
  const [found, setFound] = useState<{ commit: string; proofs: ProofSummary[] }>();
  const asked = useRef("");
  useEffect(() => {
    if (!commit) return setFound(undefined);
    let current = true;
    asked.current = commit;
    void proofsOf(commit).then((proofs) => current && setFound({ commit, proofs }));
    return () => {
      current = false;
    };
  }, [commit, proofsOf, version]);
  return found && found.commit === commit ? proofFor(found.proofs, base) : undefined;
}
