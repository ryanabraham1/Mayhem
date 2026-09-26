import { AlertTriangle, Info, OctagonAlert, X } from "lucide-react";
import { useStore } from "../store";
import { FieldCanvas } from "./FieldCanvas";
import { ConstraintEditor, MarkerEditor, WaypointEditor } from "./Inspector";
import { FieldSettingsPanel, ObstacleEditor } from "./FieldPanels";
import type { Trajectory } from "../types";

const HINTS: Record<string, string> = {
  waypoint: "Click to add a waypoint · drag the round knob to rotate · hold ⇧ to snap",
  guide: "Click to add a guide point (shapes the route only)",
  pointAt: "Click the target the robot should face",
  zone: "Click corners · click the first corner, double-click or press Enter to finish · Esc cancels",
  keepOut: "Click corners · click the first corner, double-click or press Enter to finish · Esc cancels",
  polygon: "Click corners · click the first corner, double-click or press Enter to finish · Esc cancels",
  circle: "Drag from the center to set the radius",
};

export function Stage() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const field = useStore((s) => s.project!.field);
  const solve = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj] : undefined));
  const a = useStore.getState();

  let panel: React.ReactNode = null;
  if (view === "field") {
    const o = selection?.kind === "obstacle" ? field.obstacles.find((x) => x.id === selection.id) : undefined;
    panel = o ? <ObstacleEditor o={o} field={field} /> : <FieldSettingsPanel />;
  } else if (traj) {
    const upd = (fn: (t: Trajectory) => void, history = true) => a.updateTraj(traj.name, fn, { history });
    if (selection?.kind === "waypoint" && traj.waypoints[selection.index]) panel = <WaypointEditor traj={traj} index={selection.index} upd={upd} />;
    else if (selection?.kind === "constraint") {
      const c = traj.constraints.find((x) => x.id === selection.id);
      if (c) panel = <ConstraintEditor traj={traj} c={c} upd={upd} />;
    } else if (selection?.kind === "marker") {
      const m = traj.markers.find((x) => x.id === selection.id);
      if (m) panel = <MarkerEditor traj={traj} m={m} upd={upd} />;
    }
  }

  const issues = view === "paths" ? solve?.issues ?? [] : [];
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
      {HINTS[tool] && <div className="hint-chip"><span className="chip accent">{HINTS[tool]}</span></div>}
      {panel && <div className="float props">{panel}</div>}
      {issues.length > 0 && (
        <div className="float issues">
          <div className="card-head">
            <div className="card-title" style={{ color: "var(--red)" }}><OctagonAlert size={16} /> Generation failed</div>
            <button className="btn ghost icon sm" onClick={() => useStore.setState((s) => { if (s.selectedTraj && s.solves[s.selectedTraj]) s.solves[s.selectedTraj].issues = []; })}><X size={14} /></button>
          </div>
          {issues.map((is, i) => {
            const Icon = is.severity === "error" ? OctagonAlert : is.severity === "warning" ? AlertTriangle : Info;
            return (
              <div key={i} className="issue" onClick={() => {
                if (is.waypoint != null) a.select({ kind: "waypoint", index: is.waypoint });
                if (is.t != null) a.setPlayback({ t: is.t, playing: false });
              }}>
                <Icon size={15} style={{ flex: "none", marginTop: 2, color: is.severity === "error" ? "var(--red)" : "var(--amber)" }} />
                <div>{is.message}{is.t != null && <span className="mono muted" style={{ fontSize: 11 }}> · t≈{is.t.toFixed(2)}s</span>}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
