import { useEffect, useMemo, useState } from "react";
import { includesTask, taskBase, type ReviewItem } from "../core/review/tasks.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop, invoke } from "../native";
import { useRobotRepo, useRobotStamp } from "../robotRepo";
import type { StoredLog } from "../storage";

/**
 * Where an accepted change has got to, read from git, the robot's build stamp and the logs:
 * nothing here is reported by an agent. `undefined` means it can't be told (no main branch, the
 * robot never checked, a commit this folder doesn't have yet).
 */
export interface Delivery {
  /** The main branch it was looked for in (`origin/main` or `main`). */
  main?: string;
  inMain?: boolean;
  onRobot?: boolean;
  /** When the robot's version was last read. */
  robotCheckedAt?: number;
  /** The newest log recorded on code that includes the change, and how many there are. */
  log?: StoredLog;
  logs: number;
}

interface Commit {
  sha: string;
  subject: string;
  body: string;
}

// Commits are immutable, so what lies between two of them never changes: asked once per pair.
const between = new Map<string, Promise<Commit[] | undefined>>();
function commitsBetween(repo: string, before: string, after: string) {
  const key = `${repo}\n${before}\n${after}`;
  let found = between.get(key);
  if (!found) {
    // A commit this folder doesn't have (deployed from another computer, not pulled) can't be judged.
    found = invoke<Commit[]>("review_commits", { repo, before, after }).catch(() => undefined);
    between.set(key, found);
  }
  return found;
}

const sameDelivery = (a: Map<string, Delivery>, b: Map<string, Delivery>) =>
  a.size === b.size &&
  [...b].every(([id, d]) => {
    const o = a.get(id);
    return !!o && o.main === d.main && o.inMain === d.inMain && o.onRobot === d.onRobot && o.robotCheckedAt === d.robotCheckedAt && o.log?.id === d.log?.id && o.logs === d.logs;
  });

/** Newest logs looked at for "has this change run on the robot". */
const LOGS_CHECKED = 12;

/** Delivery of every accepted task that has commits, by task id. */
export function useDelivery(items: ReviewItem[]): Map<string, Delivery> {
  const [repo] = useRobotRepo();
  const [robot] = useRobotStamp();
  const { logs } = useLogLibrary();
  const [found, setFound] = useState<Map<string, Delivery>>(new Map());
  // A merge happens outside the app (a pull request, a pull): look again when the window comes
  // back to the front, and every so often while it stays there.
  const [looked, setLooked] = useState(0);
  useEffect(() => {
    const again = () => setLooked((n) => n + 1);
    window.addEventListener("focus", again);
    const timer = setInterval(again, 30_000);
    return () => {
      window.removeEventListener("focus", again);
      clearInterval(timer);
    };
  }, []);
  const accepted = useMemo(() => items.filter((t) => t.status === "done" && t.changes.length > 0), [items]);
  const recent = useMemo(
    () =>
      [...logs]
        .filter((l) => !l.archived && l.summary?.revision)
        .sort((a, b) => b.added - a.added)
        .slice(0, LOGS_CHECKED),
    [logs],
  );
  useEffect(() => {
    if (!desktop || !repo || !accepted.length) return setFound((previous) => (previous.size ? new Map() : previous));
    let current = true;
    void (async () => {
      const info = await invoke<{ revisions: { rev: string; sha: string; kind: string }[] }>("review_repo", { repo }).catch(() => undefined);
      // A change merged here but not pushed is in `main` before it is in `origin/main`.
      const mains = (info?.revisions ?? []).filter((r) => (r.kind === "remote" && r.rev === "origin/main") || (r.kind === "branch" && r.rev === "main"));
      const next = new Map<string, Delivery>();
      for (const task of accepted) {
        const base = taskBase(task);
        if (!base) continue;
        const reaches = async (sha: string) => {
          const commits = await commitsBetween(repo, base, sha);
          return commits && includesTask(task, commits);
        };
        const delivery: Delivery = { logs: 0 };
        for (const main of mains) {
          const inMain = await reaches(main.sha);
          if (inMain === undefined) continue;
          delivery.main ??= main.rev;
          delivery.inMain = delivery.inMain || inMain;
          if (inMain) delivery.main = main.rev;
        }
        if (robot) {
          delivery.onRobot = await reaches(robot.stamp.sha);
          delivery.robotCheckedAt = robot.checkedAt;
        }
        for (const log of recent)
          if (await reaches(log.summary!.revision!)) {
            delivery.log ??= log;
            delivery.logs++;
          }
        next.set(task.id, delivery);
      }
      if (current) setFound((previous) => (sameDelivery(previous, next) ? previous : next));
    })();
    return () => {
      current = false;
    };
  }, [repo, accepted, robot, recent, looked]);
  return found;
}

/** The furthest point a change has reached, for a chip. */
export function deliveryStage(d: Delivery | undefined): { text: string; tone: "good" | "accent" | "neutral" } | undefined {
  if (!d) return undefined;
  if (d.log) return { text: "in a log", tone: "good" };
  if (d.onRobot) return { text: "on the robot", tone: "good" };
  if (d.inMain) return { text: `in ${d.main}`, tone: "accent" };
  if (d.inMain === false) return { text: `not in ${d.main} yet`, tone: "neutral" };
  return undefined;
}
