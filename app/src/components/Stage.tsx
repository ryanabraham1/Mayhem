import { AlertTriangle, Info, OctagonAlert, X } from "lucide-react";
import { useStore } from "../store";
import { FieldCanvas } from "./FieldCanvas";
import { ConstraintEditor, MarkerEditor, PoseVariableEditor, WaypointEditor } from "./Inspector";
import { FieldSettingsPanel, ObstacleEditor } from "./FieldPanels";
import { SimRobotEditor } from "./FuelSimPanel";
import type { Issue, Trajectory } from "../types";
import { CONSTRAINT_LABELS } from "../model";

const HINTS: Record<string, string> = {
  pose: "Click to add a pose waypoint at the end of the path · drag the knob to rotate · hold ⇧ to snap",
  translation: "Click to add a translation waypoint at the end of the path",
  guide: "Click to add a guide point at the end of the path",
  region: "Click corners · click the first corner, double-click or press Enter to finish · Esc cancels",
  polygon: "Click corners · click the first corner, double-click or press Enter to finish · Esc cancels",
  circle: "Drag from the center to set the radius",
};

function IssueRow({ issue, onSelect }: { issue: Issue; onSelect: (issue: Issue) => void }) {
  const Icon = issue.severity === "error" ? OctagonAlert : issue.severity === "warning" ? AlertTriangle : Info;
  return <div className="issue" onClick={() => onSelect(issue)}>
    <Icon size={15} style={{ flex: "none", marginTop: 2,
      color: issue.severity === "error" ? "var(--red)" : "var(--amber)" }} />
    <div>{issue.message}{issue.t != null && <span className="mono muted" style={{ fontSize: 11 }}> · t≈{issue.t.toFixed(2)}s</span>}</div>
  </div>;
}

export function Stage() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const field = useStore((s) => s.project!.field);
  const solve = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj] : undefined));
  const pending = useStore((s) => s.pending);
  const a = useStore.getState();
  let hint = HINTS[tool];
  if (tool === "constraint" && pending) {
    hint = pending.from === null
      ? `${CONSTRAINT_LABELS[pending.type]}: click the first waypoint`
      : `${CONSTRAINT_LABELS[pending.type]}: click the last waypoint (Enter = just this one) · Esc cancels`;
  }

  let panel: React.ReactNode = null;
  if (view === "field") {
    const o = selection?.kind === "obstacle" ? field.obstacles.find((x) => x.id === selection.id) : undefined;
    panel = o ? <ObstacleEditor o={o} field={field} /> : <FieldSettingsPanel />;
  } else if (traj) {
    const upd = (fn: (t: Trajectory) => void, history = true) => a.updateTraj(traj.name, fn, { history });
    if (selection?.kind === "pose") panel = <PoseVariableEditor id={selection.id} />;
    else if (selection?.kind === "simRobot") panel = <SimRobotEditor id={selection.id} />;
    else if (selection?.kind === "waypoint" && traj.waypoints[selection.index]) panel = <WaypointEditor traj={traj} index={selection.index} upd={upd} />;
    else if (selection?.kind === "constraint") {
      const c = traj.constraints.find((x) => x.id === selection.id);
      if (c) panel = <ConstraintEditor traj={traj} c={c} upd={upd} />;
    } else if (selection?.kind === "marker") {
      const m = traj.markers.find((x) => x.id === selection.id);
      if (m) panel = <MarkerEditor traj={traj} m={m} upd={upd} />;
    }
  }

  const warning = view === "paths" && solve?.status === "solving" && !!solve.warnings?.length;
  const issues = view === "paths" ? (warning ? solve?.warnings ?? [] : solve?.issues ?? []) : [];
  return (
    <div className="stage">
      {view === "paths" && !traj ? (
        <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
          <div style={{ textAlign: "center" }}>
            <div className="muted" style={{ marginBottom: 10 }}>No path selected.</div>
            <button className="btn primary" onClick={() => a.addTrajectory("New Path")}>New path</button>
          </div>
        </div>
      ) : (
        <FieldCanvas mode={view === "field" ? "field" : "path"} />
      )}
      {hint && <div className="hint-chip"><span className="chip accent">{hint}</span></div>}
      {panel && <div className="float props">{panel}</div>}
      {issues.length > 0 && (
        <div className="float issues">
          <div className="card-head">
            <div className="card-title" style={{ color: warning ? "var(--amber)" : "var(--red)" }}>
              {warning ? <AlertTriangle size={16} /> : <OctagonAlert size={16} />}
              {warning ? "Likely unsolvable" : "Generation failed"}
            </div>
            {!warning && <button className="btn ghost icon sm" onClick={() => useStore.setState((s) => { if (s.selectedTraj && s.solves[s.selectedTraj]) s.solves[s.selectedTraj].issues = []; })}><X size={14} /></button>}
          </div>
          {warning && <div className="muted" style={{ padding: "0 12px 8px" }}>Mayhem is checking the remaining routes.</div>}
          {issues.map((is, i) => <IssueRow key={i} issue={is} onSelect={(issue) => {
            if (issue.waypoint != null) a.select({ kind: "waypoint", index: issue.waypoint });
            if (issue.t != null) a.setPlayback({ t: issue.t, playing: false });
          }} />)}
          {warning && <button className="btn danger sm" style={{ margin: "8px 12px 12px" }}
            onClick={() => { if (a.selectedTraj) a.stopWithWarnings(a.selectedTraj); }}>Stop</button>}
        </div>
      )}
    </div>
  );
}
