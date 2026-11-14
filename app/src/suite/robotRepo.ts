import { useEffect, useMemo, useState } from "react";
import { desktop, invoke } from "./native";

/** The robot code folder (a git repo) the Changes and Tasks pages work on, shared by every page. */
const REPO_KEY = "mayhem.review.repo";
const AUTHOR_KEY = "mayhem.review.author";
const EVENT = "mayhem-robot-repo";

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a convenience only */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
};

function useShared(key: string) {
  const [value, setValue] = useState(() => read(key));
  useEffect(() => {
    const sync = () => setValue(read(key));
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [key]);
  return [value, (next: string) => write(key, next)] as const;
}

export const useRobotRepo = () => useShared(REPO_KEY);
/** The name feedback is signed with on this computer. */
export const useAuthor = () => useShared(AUTHOR_KEY);

/** deploy/mayhem-build.json, written by the robot code's build and read back off the robot. */
export interface BuildStamp {
  sha: string;
  branch: string;
  dirty: string[];
  builtAt: string;
  builtBy: string;
  computer?: string;
}
const STAMP_KEY = "mayhem.robot.stamp";
/**
 * What the robot was running the last time anyone checked (Robot → On the robot now), kept so
 * other pages can say whether a change has reached the robot without a connection.
 */
export function useRobotStamp() {
  const [raw, setRaw] = useShared(STAMP_KEY);
  const known = useMemo(() => {
    try {
      const value = raw ? (JSON.parse(raw) as { stamp: BuildStamp; checkedAt: number }) : undefined;
      return value?.stamp?.sha ? value : undefined;
    } catch {
      return undefined;
    }
  }, [raw]);
  const set = (stamp: BuildStamp) => setRaw(JSON.stringify({ stamp, checkedAt: Date.now() }));
  return [known, set] as const;
}

export async function chooseRepo(set: (path: string) => void) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, title: "Choose the robot code folder (a git repository)" });
  if (typeof picked === "string") set(picked);
}

const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
export const samePath = (a?: string | null, b?: string | null) => !!a && !!b && slashes(a) === slashes(b);

/**
 * The robot repo's own Mayhem project (`robot.mayhem.json`: its autos and state machines), once
 * the desktop app has found it. Undefined while looking and when the repo has none.
 */
export function useRepoProject(repo: string): string | undefined {
  const [found, setFound] = useState<{ repo: string; path?: string }>({ repo: "" });
  useEffect(() => {
    if (!desktop || !repo) return;
    let current = true;
    const path = `${slashes(repo)}/robot.mayhem.json`;
    invoke<unknown>("read_suite_project", { path, allowMissing: true })
      .then((project) => current && setFound({ repo, path: project ? path : undefined }))
      .catch(() => current && setFound({ repo }));
    return () => {
      current = false;
    };
  }, [repo]);
  return found.repo === repo ? found.path : undefined;
}

const COMPARE_KEY = "mayhem.review.compare";
/** Asks the Changes page to compare these two revisions next time it opens. */
export function requestCompare(before: string, after: string) {
  try {
    sessionStorage.setItem(COMPARE_KEY, JSON.stringify({ before, after }));
  } catch {
    /* the Changes page then keeps its own choice */
  }
}
export function takeCompareRequest(): { before: string; after: string } | undefined {
  try {
    const value = sessionStorage.getItem(COMPARE_KEY);
    sessionStorage.removeItem(COMPARE_KEY);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
