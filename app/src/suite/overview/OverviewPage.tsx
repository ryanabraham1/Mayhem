import { useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileChartColumn,
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
import { Explainer } from "./Explainer";

export type Destination = "autos" | "states" | "logs" | "robot" | "tasks" | "changes";

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

        <Panel title="Get to match-ready" icon={CheckCircle2}>
          <div className="mx-checklist-progress">
            <span>{done} of 4 done</span>
            <progress value={done} max={4} aria-label="Match readiness" />
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
