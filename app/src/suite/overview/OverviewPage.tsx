import { useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileChartColumn,
  FolderGit2,
  GitCompare,
  Plus,
} from "lucide-react";
import { FieldArt } from "../../components/FieldArt";
import type { Field } from "../../types";
import seasonField from "../core/rebuilt-2026.json";
import { routeSegments } from "../core/routes.ts";
import type { AutoRoutine, SuiteProject } from "../core/model.ts";
import { simulate } from "../core/runtime";
import { desktop } from "../native";
import { cppExportState, downloadCpp } from "../cppExport";
import { setRobotTab } from "../robot/RobotPage";
import { AUTO_PERIOD_SECONDS } from "../useSuiteProject";
import { useLogLibrary } from "../logLibrary";
import { useRobot } from "../robot";
import type { SuiteState } from "../useSuiteProject";
import { Badge, Button, Panel, timeAgo } from "../ui";
import { BranchRow } from "../changes/ReviewParts";
import { useReviews } from "../changes/reviewList";
import { chooseRepo, requestCompare, samePath, useRepoProject, useRobotRepo } from "../robotRepo";
import { Explainer } from "./Explainer";

export type Destination = "autos" | "states" | "logs" | "robot" | "changes";

function MiniField({ project, routine }: { project: SuiteProject; routine: AutoRoutine }) {
  const { width, height } = project.field;
  const start = routine.start ?? project.robot.start;
  const segments = routeSegments(project, routine);
  const goals = routine.nodes.filter((n) => n.kind === "pose" && n.goal).map((n) => n.goal!);
  return (
    <svg className="mx-mini-field" viewBox={`-0.2 -0.2 ${width + 0.4} ${height + 0.4}`} aria-hidden="true">
      <g transform={`translate(0 ${height}) scale(${width / seasonField.length} ${-height / seasonField.width})`}>
        <FieldArt field={seasonField as Field} />
      </g>
      {segments.map((s, i) => (
        <path
          key={i}
          d={`M${s.from.x},${height - s.from.y} L${s.to.x},${height - s.to.y}`}
          stroke="var(--mx-path)"
          strokeWidth=".12"
          strokeLinecap="round"
          fill="none"
        />
      ))}
      {goals.map((g, i) => (
        <circle key={i} cx={g.x} cy={height - g.y} r=".2" fill="var(--mx-halo)" stroke="var(--mx-path)" strokeWidth=".08" />
      ))}
      <circle cx={start.x} cy={height - start.y} r=".26" fill="var(--mx-start)" />
    </svg>
  );
}

/** What agents (or anyone) changed and is waiting for a person, and what was merged but isn't on the robot. */
function ChangesToReview({ go }: { go: (d: Destination) => void }) {
  const reviews = useReviews();
  const [repo, setRepo] = useRobotRepo();
  const main = "main";
  const open = (b: { base: string; sha: string }) => {
    requestCompare(b.base, b.sha);
    go("changes");
  };
  const waiting = reviews.merged.filter((b) => b.onRobot === false && !b.log);
  return (
    <Panel
      title="Changes to review"
      icon={GitCompare}
      actions={
        repo ? (
          <Button size="sm" variant="ghost" onClick={() => go("changes")}>
            All changes <ArrowRight size={14} />
          </Button>
        ) : undefined
      }
    >
      {!desktop ? (
        <div className="mx-panel-empty">
          <p>Reviewing a branch of the robot code needs the desktop app. In the browser, Changes opens saved review files.</p>
        </div>
      ) : !repo ? (
        <div className="mx-panel-empty">
          <p>Choose the robot code folder. Branches that aren't in main yet show up here, with what they change on the robot.</p>
          <Button size="sm" variant="primary" icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>
            Choose robot code folder
          </Button>
        </div>
      ) : reviews.toReview.length ? (
        <div className="mx-work-list">
          {reviews.toReview.slice(0, 4).map((b) => (
            <BranchRow key={b.name} branch={b} main={main} open={() => open(b)} />
          ))}
          {reviews.toReview.length > 4 && (
            <button type="button" className="mx-link" onClick={() => go("changes")}>
              and {reviews.toReview.length - 4} more
            </button>
          )}
        </div>
      ) : (
        <p className="mx-summary-line is-good">
          <CheckCircle2 size={16} />
          {reviews.main ? "Nothing is waiting for review" : "This folder has no main branch to review against"}
        </p>
      )}
      {waiting.length > 0 && (
        <button type="button" className="mx-link mx-work-pending" onClick={() => open(waiting[0])}>
          {waiting.length} merged change{waiting.length === 1 ? " is" : "s are"} not on the robot
        </button>
      )}
    </Panel>
  );
}

export function OverviewPage({ s, go }: { s: SuiteState; go: (d: Destination) => void }) {
  const { project } = s;
  const robot = useRobot();
  const lib = useLogLibrary();
  const errors = s.issues.filter((i) => i.severity === "error");
  const warnings = s.issues.filter((i) => i.severity === "warning");
  const recent = lib.logs.filter((l) => !l.archived).slice(0, 5);
  const flagged = recent.filter((l) => l.summary?.errors).length;
  const status = robot.live.snapshot.status;
  const [, refreshExport] = useState(0);
  const exportState = cppExportState(project);
  const [repo, setRepo] = useRobotRepo();
  // The robot repo has its own project file and this window shows a different project.
  const repoProject = useRepoProject(repo);
  const unlinked = repoProject && !samePath(s.projectPath, repoProject) ? repoProject : undefined;
  const routines = useMemo(() => {
    const signals = Object.fromEntries(project.signals.map((signal) => [signal.key, signal.initial]));
    return project.routines.map((routine, index) => {
      const errors = s.issues.filter((issue) => issue.severity === "error" &&
        (issue.path === `routines.${index}` || issue.path.startsWith(`routines.${index}.`)));
      const run = simulate(project, routine, signals, { mode: "path", maxSeconds: 30 });
      return { routine, errors, seconds: run.status === "completed" ? run.frame.time : undefined };
    });
  }, [project, s.issues]);
  const checklist = [
    ...(desktop
      ? [
          { title: "Choose the robot code folder", detail: repo ? repo.split(/[\\/]/).pop()! : "The code agents change, and what Mayhem reviews.",
            done: !!repo, action: "Choose", run: () => void chooseRepo(setRepo) },
        ]
      : []),
    { title: "Plan an autonomous routine", detail: "Create a valid routine that reaches a finish.",
      done: routines.some((r) => !r.errors.length), action: "Open Autos", run: () => go("autos") },
    { title: "Connect to the robot", detail: status === "connected" ? `Connected to ${robot.host}` : "Connect over your robot network.",
      done: status === "connected", action: "Connect", run: () => { setRobotTab("connection"); go("robot"); } },
    { title: "Turn on log collection", detail: desktop ? "Collect logs whenever the robot is plugged in." : "Log collection needs the desktop app.",
      done: lib.sync.config.autoPull, action: "Set up", run: () => { setRobotTab("logs"); go("robot"); } },
    { title: "Export autos to robot code", detail: exportState === "stale" ? "Routines changed since the last export" :
      exportState === "current" ? "Exported C++ matches this project." : "Download C++ for your robot project.",
      done: exportState === "current", action: "Export C++", run: () => { downloadCpp(project); refreshExport((n) => n + 1); } },
  ];
  const done = checklist.filter((item) => item.done).length;
  return (
    <div className="mx-page-scroll mx-overview">
      <header className="mx-hello">
        <div>
          <h1>{project.name}</h1>
          <p>
            Team {robot.config.team} · {project.robot.name} · {project.routines.length}{" "}
            {project.routines.length === 1 ? "autonomous routine" : "autonomous routines"}
          </p>
        </div>
      </header>

      {unlinked && (
        <p className="mx-repo-project" role="status">
          <FolderGit2 size={15} />
          <span>
            This robot's autos and state machines are in <code>robot.mayhem.json</code> in the robot code folder; this window shows a different project.
          </span>
          <Button size="sm" onClick={() => void s.openProjectFile(unlinked)}>
            Open it
          </Button>
        </p>
      )}
      <section className="mx-gallery" aria-label="Autonomous routines">
        {routines.map(({ routine: r, errors: routineIssues, seconds }) => {
          const steps = r.nodes.filter((n) => n.kind !== "finish").length;
          return (
            <button
              key={r.id}
              className="mx-auto-card"
              onClick={() => {
                s.selectRoutine(r.id);
                go("autos");
              }}
            >
              <MiniField project={project} routine={r} />
              <span className="mx-auto-card-text">
                <strong>{r.name}</strong>
                <small>
                  <span>{steps} steps{seconds !== undefined ? ` · ${seconds.toFixed(1)} s` : ""}</span>
                  {routineIssues.length ? (
                    <Badge tone="bad">{routineIssues.length} errors</Badge>
                  ) : seconds !== undefined && seconds <= AUTO_PERIOD_SECONDS ? (
                    <Badge tone="good">Ready</Badge>
                  ) : seconds !== undefined ? (
                    <Badge tone="warn">Over by {(seconds - AUTO_PERIOD_SECONDS).toFixed(1)} s</Badge>
                  ) : <Badge tone="warn">Doesn't finish</Badge>}
                </small>
              </span>
            </button>
          );
        })}
        <button
          className="mx-auto-card is-new"
          onClick={() => {
            if (s.createRoutine()) go("autos");
          }}
        >
          <Plus size={20} />
          New routine
        </button>
      </section>

      <div className="mx-overview-grid">
        <div className="mx-col">
          <ChangesToReview go={go} />
          <Panel
            title="Latest logs"
            icon={FileChartColumn}
            actions={
              <Button size="sm" variant="ghost" onClick={() => go("logs")}>
                All logs <ArrowRight size={14} />
              </Button>
            }
          >
            {recent.length ? (
              <>
                <p className={`mx-summary-line is-${flagged ? "bad" : "good"}`}>
                  {flagged ? <AlertOctagon size={16} /> : <CheckCircle2 size={16} />}
                  {flagged
                    ? `${flagged} of the last ${recent.length} logs have red flags`
                    : `No red flags in the last ${recent.length} logs`}
                </p>
                <div className="mx-mini-logs">
                  {recent.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => {
                        void lib.open(l);
                        go("logs");
                      }}
                    >
                      <span>
                        <strong>{l.name.replace(/\.wpilog$/i, "")}</strong>
                        <small>
                          {timeAgo(l.added)}
                          {l.summary?.minVoltage !== undefined && ` · min ${l.summary.minVoltage.toFixed(1)} V`}
                        </small>
                      </span>
                      {l.summary ? (
                        l.summary.errors ? (
                          <Badge tone="bad">{l.summary.errors} red</Badge>
                        ) : l.summary.warnings ? (
                          <Badge tone="warn">{l.summary.warnings} warn</Badge>
                        ) : (
                          <Badge tone="good">clean</Badge>
                        )
                      ) : (
                        <Badge>not analyzed</Badge>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="mx-panel-empty">
                <p>No logs yet. Turn on collection and plug into the robot, or import a .wpilog.</p>
                <Button size="sm" onClick={() => go("logs")}>
                  Open Logs
                </Button>
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Get to match-ready" icon={CheckCircle2}>
          <div className="mx-checklist-progress">
            <span>{done} of {checklist.length} done</span>
            <progress value={done} max={checklist.length} aria-label="Match readiness" />
          </div>
          <div className="mx-checklist">
            {checklist.map((item) => (
              <div className={item.done ? "is-done" : ""} key={item.title}>
                <CheckCircle2 size={20} aria-label={item.done ? "Done" : "To do"} />
                <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                {!item.done && <Button size="sm" onClick={item.run}>{item.action}</Button>}
              </div>
            ))}
          </div>
          {errors.length || warnings.length ? (
            <ul className="mx-issues">
              {[...errors, ...warnings].slice(0, 6).map((i, n) => (
                <li key={n} className={`is-${i.severity}`}>
                  {i.severity === "error" ? <AlertOctagon size={14} /> : <AlertTriangle size={14} />}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>
      <Explainer />
    </div>
  );
}
