import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileChartColumn,
  Link2,
  Plus,
} from "lucide-react";
import { FieldArt } from "../../components/FieldArt";
import type { Field } from "../../types";
import seasonField from "../core/rebuilt-2026.json";
import { routeSegments } from "../core/routes.ts";
import type { AutoRoutine, SuiteProject } from "../core/model.ts";
import { useLogLibrary } from "../logLibrary";
import { useRobot } from "../robot";
import type { SuiteState } from "../useSuiteProject";
import { Badge, Button, Dot, Panel, timeAgo } from "../ui";

export type Destination = "autos" | "states" | "logs" | "robot" | "agents";

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
  const sync = lib.sync;
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
        <div className="mx-hello-status">
          <button className="mx-status-chip" onClick={() => go("robot")}>
            <Dot tone={status === "connected" ? "good" : status === "disconnected" ? "neutral" : "warn"} />
            {status === "connected" ? `Robot connected · ${robot.host}` : "Robot not connected"}
          </button>
          <button className="mx-status-chip" onClick={() => go("robot")}>
            <Dot tone={sync.config.autoPull ? (sync.reach === "reachable" ? "good" : "warn") : "neutral"} />
            {sync.config.autoPull ? "Auto-collecting logs" : "Log collection off"}
          </button>
        </div>
      </header>

      <section className="mx-gallery" aria-label="Autonomous routines">
        {project.routines.map((r) => {
          const steps = r.nodes.filter((n) => n.kind !== "finish").length;
          const routineIssues = s.issues.filter(
            (i) => i.severity === "error" && i.path.startsWith(`routines.${project.routines.indexOf(r)}`),
          );
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
                  {steps} {steps === 1 ? "step" : "steps"}
                  {routineIssues.length ? (
                    <Badge tone="bad">{routineIssues.length} errors</Badge>
                  ) : null}
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

        <Panel title="Project checks" icon={errors.length ? AlertOctagon : CheckCircle2}>
          {errors.length || warnings.length ? (
            <ul className="mx-issues">
              {[...errors, ...warnings].slice(0, 6).map((i, n) => (
                <li key={n} className={`is-${i.severity}`}>
                  {i.severity === "error" ? <AlertOctagon size={14} /> : <AlertTriangle size={14} />}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mx-summary-line is-good">
              <CheckCircle2 size={16} /> Every routine is valid and reaches a finish.
            </p>
          )}
          <div className="mx-kv">
            <span>Revision</span>
            <code>{project.revision}</code>
            <span>Inputs</span>
            <code>{project.signals.length}</code>
            <span>Agent file</span>
            <code>{s.projectPath ? "linked" : "not linked"}</code>
          </div>
          <Button size="sm" icon={Link2} onClick={() => go("agents")}>
            Work with an agent
          </Button>
        </Panel>
      </div>
    </div>
  );
}
