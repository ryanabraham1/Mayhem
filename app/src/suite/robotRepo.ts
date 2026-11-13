import { useEffect, useState } from "react";

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

export async function chooseRepo(set: (path: string) => void) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, title: "Choose the robot code folder (a git repository)" });
  if (typeof picked === "string") set(picked);
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
