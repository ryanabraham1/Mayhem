import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, GitCompare, HeartPulse, RefreshCw, RotateCcw, Rocket, TriangleAlert } from "lucide-react";
import { findAnomalies } from "../core/logquery.ts";
import { tasksInMessage } from "../core/review/tasks.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop, invoke } from "../native";
import { useRobot } from "../robot";
import { requestCompare, useAuthor, useRobotRepo } from "../robotRepo";
import { useTasks } from "../tasks/feedback";
import { Badge, Button, Panel, timeAgo } from "../ui";

/** deploy/mayhem-build.json, written by the robot code's build. */
interface Stamp {
  sha: string;
  branch: string;
  dirty: string[];
  builtAt: string;
  builtBy: string;
  computer?: string;
}
interface Deploy extends Stamp {
  seen: number;
}
interface Good {
  sha: string;
  at: number;
  by: string;
}

const HISTORY_KEY = "mayhem.robot.deploys";
const GOOD_KEY = "mayhem.robot.good";
const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* history is a convenience */
  }
};

/** What's deployed, what changed since the last known-good version, the latest log's health, and rollback. */
export function RobotNow({ openChanges }: { openChanges: () => void }) {
  const robot = useRobot();
  const lib = useLogLibrary();
  const tasks = useTasks();
  const [repo] = useRobotRepo();
  const [author] = useAuthor();
  const [stamp, setStamp] = useState<Stamp>();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [history, setHistory] = useState<Deploy[]>(() => load(HISTORY_KEY, []));
  const [good, setGood] = useState<Good | undefined>(() => load(GOOD_KEY, undefined));
  const [commits, setCommits] = useState<{ sha: string; subject: string; body: string }[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string>();

  const check = useCallback(async () => {
    if (!desktop) return;
    setChecking(true);
    setProblem(undefined);
    try {
      const value = JSON.parse(await invoke<string>("robot_build_info", { host: robot.host })) as Stamp;
      setStamp(value);
      setHistory((h) => {
        if (h[0]?.sha === value.sha && h[0]?.builtAt === value.builtAt) return h;
        const next = [{ ...value, seen: Date.now() }, ...h].slice(0, 20);
        save(HISTORY_KEY, next);
        return next;
      });
    } catch (e) {
      setProblem(String(e));
    } finally {
      setChecking(false);
    }
  }, [robot.host]);
  // Look as soon as the robot is reachable.
  const connected = robot.live.snapshot.status === "connected";
  useEffect(() => {
    if (connected) void check();
  }, [connected, check]);

  const deployed = stamp ?? history[0];
  useEffect(() => {
    if (!desktop || !repo || !deployed?.sha || !good?.sha || good.sha === deployed.sha) return setCommits([]);
    invoke<{ sha: string; subject: string; body: string }[]>("review_commits", { repo, before: good.sha, after: deployed.sha })
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [repo, deployed?.sha, good?.sha]);

  const markGood = () => {
    if (!deployed?.sha) return;
    const value = { sha: deployed.sha, at: Date.now(), by: author || "someone" };
    setGood(value);
    save(GOOD_KEY, value);
  };

  const rollback = async () => {
    if (!good || !repo) return;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      `Build commit ${good.sha.slice(0, 7)} (marked good by ${good.by}, ${timeAgo(good.at)}) and deploy it to team ${robot.config.team}'s robot?\n\nThe robot must be connected and disabled. This replaces the code on the robot; nothing in the repository changes.`,
      { title: "Roll back the robot", kind: "warning", okLabel: "Deploy last good", cancelLabel: "Cancel" },
    ).catch((e) => {
      setDeployLog(`Could not ask for confirmation: ${e}`);
      return false;
    });
    if (!ok) return;
    setDeploying(true);
    setDeployLog(undefined);
    try {
      setDeployLog(await invoke<string>("robot_deploy", { repo, rev: good.sha, team: robot.config.team }));
      await check();
    } catch (e) {
      setDeployLog(String(e));
    } finally {
      setDeploying(false);
    }
  };

  // Health of the newest log in the library (open it to analyze).
  const latest = useMemo(() => [...lib.logs].sort((a, b) => b.added - a.added)[0], [lib.logs]);
  const health = lib.current && latest && lib.current.id === latest.id ? lib.current : undefined;
  const flapping = useMemo(
    () => (health ? findAnomalies(health.recording, { limit: 50 }).anomalies.filter((a) => a.kind === "flapping") : []),
    [health],
  );
  const linked = (sha: string, message: string) =>
    tasks.items.filter((t) => tasksInMessage(message).includes(t.id) || t.changes.some((c) => c.revision === sha));

  return (
    <Panel
      title="On the robot now"
      icon={Rocket}
      className="mx-robot-now"
      actions={
        desktop && (
          <Button size="sm" icon={RefreshCw} disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check robot"}
          </Button>
        )
      }
    >
      {!desktop && <p className="mx-help">Reading the robot needs the desktop app.</p>}
      {problem && !deployed && <p className="mx-help is-bad">{problem}</p>}
      {deployed ? (
        <div className="mx-now-grid">
          <div className="mx-now-version">
            <span className="mx-help">Running</span>
            <strong>
              <code>{deployed.sha ? deployed.sha.slice(0, 7) : "unknown commit"}</code> · {deployed.branch || "no branch"}
            </strong>
            <small>
              Built {new Date(deployed.builtAt).toLocaleString()} by {deployed.builtBy}
              {deployed.computer ? ` on ${deployed.computer}` : ""}
              {!stamp && " · last seen, robot not checked now"}
            </small>
            {good?.sha === deployed.sha ? (
              <Badge tone="good">
                <BadgeCheck size={12} /> known good
              </Badge>
            ) : (
              <Button size="sm" icon={BadgeCheck} onClick={markGood} disabled={!deployed.sha}>
                Mark this version as good
              </Button>
            )}
          </div>
          {deployed.dirty.length > 0 && (
            <div className="mx-callout is-bad">
              <TriangleAlert size={16} />
              <span>
                Deployed with uncommitted changes, so nobody can rebuild exactly this version: {deployed.dirty.slice(0, 6).join(", ")}
                {deployed.dirty.length > 6 ? ` and ${deployed.dirty.length - 6} more` : ""}.
              </span>
            </div>
          )}
          <div>
            <h3>{good ? `Changes since the last good version (${good.sha.slice(0, 7)})` : "Mark a version as good to track what changed since"}</h3>
            {good && good.sha !== deployed.sha && (
              <>
                {commits.length ? (
                  <ul className="mx-change-list">
                    {commits.slice(0, 12).map((c) => (
                      <li key={c.sha}>
                        <code>{c.sha.slice(0, 7)}</code> {c.subject}
                        {linked(c.sha, `${c.subject}\n${c.body}`).map((t) => (
                          <Badge key={t.id} tone="accent">
                            for: {t.title}
                          </Badge>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mx-help">{repo ? "No commits between them in the robot repo (or the deployed commit isn't in it)." : "Choose the robot code folder (Changes or Tasks) to list them."}</p>
                )}
                <div className="mx-now-actions">
                  <Button
                    size="sm"
                    icon={GitCompare}
                    disabled={!repo}
                    onClick={() => {
                      requestCompare(good.sha, deployed.sha);
                      openChanges();
                    }}
                  >
                    Review these changes
                  </Button>
                  <Button size="sm" variant="danger" icon={RotateCcw} disabled={!repo || deploying} onClick={() => void rollback()}>
                    {deploying ? "Deploying…" : `Roll back to ${good.sha.slice(0, 7)}`}
                  </Button>
                </div>
              </>
            )}
            {good?.sha === deployed.sha && <p className="mx-help">The robot runs the last known-good version.</p>}
          </div>
          {deployLog && <pre className="mx-deploy-log">{deployLog}</pre>}
        </div>
      ) : (
        !problem && <p className="mx-help">Connect to the robot and click Check robot.</p>
      )}
      <div className="mx-health">
        <h3>
          <HeartPulse size={15} /> Latest log
        </h3>
        {!latest ? (
          <p className="mx-help">No logs collected yet.</p>
        ) : health ? (
          <>
            <p>
              <strong>{latest.name}</strong>{" "}
              {health.analysis.findings.filter((f) => f.severity === "error").length ? (
                <Badge tone="bad">{health.analysis.findings.filter((f) => f.severity === "error").length} red flags</Badge>
              ) : (
                <Badge tone="good">no red flags</Badge>
              )}{" "}
              <Badge tone={health.analysis.findings.length ? "warn" : "good"}>{health.analysis.findings.length} findings</Badge>
              {health.analysis.power.minVoltage !== undefined && <span className="mx-help"> · lowest battery {health.analysis.power.minVoltage.toFixed(1)} V</span>}
            </p>
            <ul className="mx-change-list">
              {health.analysis.findings
                .filter((f) => f.severity === "error")
                .concat(health.analysis.findings.filter((f) => f.severity !== "error"))
                .slice(0, 4)
                .map((f) => (
                  <li key={f.id}>
                    <Badge tone={f.severity === "error" ? "bad" : "warn"}>{f.severity === "error" ? "red flag" : "warning"}</Badge> {f.title} ({f.start.toFixed(1)} s)
                  </li>
                ))}
              {flapping.slice(0, 2).map((a) => (
                <li key={a.channel + a.start}>
                  <Badge tone="bad">flickering</Badge> {a.channel.split("/").slice(-2).join("/")}: {a.detail} ({a.start.toFixed(1)} s)
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Button size="sm" onClick={() => void lib.open(latest)}>
            Check {latest.name}
          </Button>
        )}
      </div>
    </Panel>
  );
}
