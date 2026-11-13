import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, GitCompare, HeartPulse, RefreshCw, RotateCcw, Rocket, TriangleAlert } from "lucide-react";
import { findAnomalies } from "../core/logquery.ts";
import { tasksInMessage } from "../core/review/tasks.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop, invoke } from "../native";
import { useRobot } from "../robot";
import { requestCompare, useRobotRepo } from "../robotRepo";
import { useTasks } from "../tasks/feedback";
import { Badge, Button, Panel } from "../ui";

/** deploy/mayhem-build.json, written by the robot code's build. */
interface Stamp {
  sha: string;
  branch: string;
  dirty: string[];
  builtAt: string;
  builtBy: string;
  computer?: string;
}
interface Commit {
  sha: string;
  subject: string;
  body: string;
}

/** What's deployed, how it differs from main, the latest log's health, and putting main back. */
export function RobotNow({ openChanges }: { openChanges: () => void }) {
  const robot = useRobot();
  const lib = useLogLibrary();
  const tasks = useTasks();
  const [repo] = useRobotRepo();
  const [stamp, setStamp] = useState<Stamp>();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  // main is the known-good version: what the robot runs is compared with it.
  const [main, setMain] = useState<{ rev: string; sha: string }>();
  const [ahead, setAhead] = useState<Commit[]>([]);
  const [behind, setBehind] = useState<Commit[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string>();

  const check = useCallback(async () => {
    if (!desktop) return;
    setChecking(true);
    setProblem(undefined);
    try {
      setStamp(JSON.parse(await invoke<string>("robot_build_info", { host: robot.host })) as Stamp);
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

  useEffect(() => {
    if (!desktop || !repo) return setMain(undefined);
    invoke<{ revisions: { rev: string; sha: string; kind: string }[] }>("review_repo", { repo })
      .then((info) => {
        const ref = info.revisions.find((r) => r.kind === "remote" && r.rev === "origin/main") ?? info.revisions.find((r) => r.kind === "branch" && r.rev === "main");
        setMain(ref && { rev: ref.rev, sha: ref.sha });
      })
      .catch(() => setMain(undefined));
  }, [repo, stamp]);

  useEffect(() => {
    if (!desktop || !repo || !stamp?.sha || !main || main.sha === stamp.sha) {
      setAhead([]);
      setBehind([]);
      return;
    }
    invoke<Commit[]>("review_commits", { repo, before: main.sha, after: stamp.sha }).then(setAhead).catch(() => setAhead([]));
    invoke<Commit[]>("review_commits", { repo, before: stamp.sha, after: main.sha }).then(setBehind).catch(() => setBehind([]));
  }, [repo, stamp?.sha, main]);

  const deployMain = async () => {
    if (!main || !repo) return;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      `Build ${main.rev} (${main.sha.slice(0, 7)}) and deploy it to team ${robot.config.team}'s robot?\n\nThe robot must be connected and disabled. This replaces the code on the robot; nothing in the repository changes.`,
      { title: "Put main back on the robot", kind: "warning", okLabel: "Deploy main", cancelLabel: "Cancel" },
    ).catch((e) => {
      setDeployLog(`Could not ask for confirmation: ${e}`);
      return false;
    });
    if (!ok) return;
    setDeploying(true);
    setDeployLog(undefined);
    try {
      setDeployLog(await invoke<string>("robot_deploy", { repo, rev: main.sha, team: robot.config.team }));
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
      {stamp ? (
        <div className="mx-now-grid">
          <div className="mx-now-version">
            <span className="mx-help">Running</span>
            <strong>
              <code>{stamp.sha ? stamp.sha.slice(0, 7) : "unknown commit"}</code> · {stamp.branch || "no branch"}
            </strong>
            <small>
              Built {new Date(stamp.builtAt).toLocaleString()} by {stamp.builtBy}
              {stamp.computer ? ` on ${stamp.computer}` : ""}
            </small>
            {main && main.sha === stamp.sha && !stamp.dirty.length && (
              <Badge tone="good">
                <BadgeCheck size={12} /> same as {main.rev}
              </Badge>
            )}
          </div>
          {stamp.dirty.length > 0 && (
            <div className="mx-callout is-bad">
              <TriangleAlert size={16} />
              <span>
                Deployed with uncommitted changes, so nobody can rebuild exactly this version: {stamp.dirty.slice(0, 6).join(", ")}
                {stamp.dirty.length > 6 ? ` and ${stamp.dirty.length - 6} more` : ""}.
              </span>
            </div>
          )}
          {!repo ? (
            <p className="mx-help">Choose the robot code folder (Changes or Tasks) to compare it with main.</p>
          ) : !main ? (
            <p className="mx-help">The robot repo has no main branch to compare with.</p>
          ) : main.sha !== stamp.sha ? (
            <div>
              <h3>Different from {main.rev}</h3>
              {ahead.length > 0 && (
                <>
                  <p className="mx-help">On the robot but not on {main.rev}:</p>
                  <ul className="mx-change-list">
                    {ahead.slice(0, 12).map((c) => (
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
                </>
              )}
              {behind.length > 0 && <p className="mx-help">{behind.length} newer commit{behind.length === 1 ? " is" : "s are"} on {main.rev} but not on the robot.</p>}
              <div className="mx-now-actions">
                <Button
                  size="sm"
                  icon={GitCompare}
                  onClick={() => {
                    requestCompare(main.sha, stamp.sha);
                    openChanges();
                  }}
                >
                  What's different from {main.rev}
                </Button>
                <Button size="sm" variant="danger" icon={RotateCcw} disabled={deploying} onClick={() => void deployMain()}>
                  {deploying ? "Deploying…" : `Put ${main.rev} back on the robot`}
                </Button>
              </div>
            </div>
          ) : null}
          {deployLog && <pre className="mx-deploy-log">{deployLog}</pre>}
        </div>
      ) : (
        <p className={`mx-help ${problem ? "is-bad" : ""}`}>{problem ?? "Connect to the robot and click Check robot."}</p>
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
