import { useState } from "react";
import {
  ArrowDown, ArrowUp, Circle, Copy, Crosshair, Flag, Gauge, Loader2, Pentagon, Plus, Route, Trash2,
} from "lucide-react";
import { useStore } from "../store";
import { CONSTRAINT_LABELS, newConstraint, newMarker, totalTime } from "../model";
import type { ConstraintType, Trajectory } from "../types";
import { constraintValue, scopeText, wpLabel } from "./Inspector";

export function Sidebar() {
  const view = useStore((s) => s.view);
  const status = useStore((s) => s.backendStatus);
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        {view === "paths" ? <PathsSections /> : <ObstacleSection />}
      </div>
      <div className="sidebar-foot">
        <span className={`dot ${status === "ready" ? "ok" : status === "down" ? "bad" : "warn"}`} />
        {status === "ready" ? "Solver ready" : status === "down" ? "Solver offline, retrying…" : "Starting solver…"}
      </div>
    </aside>
  );
}

function PathsSections() {
  const order = useStore((s) => s.order);
  const trajectories = useStore((s) => s.trajectories);
  const selected = useStore((s) => s.selectedTraj);
  const solves = useStore((s) => s.solves);
  const stale = useStore((s) => s.stale);
  const a = useStore.getState();
  const [renaming, setRenaming] = useState<string | null>(null);
  const traj = selected ? trajectories[selected] : undefined;

  return (
    <>
      <div className="section">
        <div className="section-head">
          <span>Paths<span className="count">{order.length}</span></span>
          <button className="btn ghost icon sm" title="New path" onClick={() => a.addTrajectory("New Path")}><Plus size={15} /></button>
        </div>
        {!order.length && <div className="sidebar-empty">No paths yet. Click + to add one.</div>}
        {order.map((name) => {
          const t = trajectories[name];
          const st = solves[name];
          const T = totalTime(t.output);
          let meta = T ? `${T.toFixed(2)}s` : "";
          if (st?.status === "failed") meta = "failed";
          return (
            <div key={name} className={`item ${selected === name ? "on" : ""}`} onClick={() => a.selectTraj(name)}
              onDoubleClick={() => setRenaming(name)}>
              <span className="icon">{st?.status === "solving" ? <Loader2 size={15} className="spin" /> : <Route size={15} />}</span>
              {renaming === name ? (
                <input className="input" autoFocus defaultValue={name} style={{ height: 26 }}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { void a.renameTrajectory(name, e.target.value); setRenaming(null); }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }} />
              ) : (
                <span className="name">{name}</span>
              )}
              <span className="meta" style={{ color: st?.status === "failed" ? "var(--red)" : stale[name] ? "var(--amber)" : undefined }}
                title={stale[name] ? "Out of date: regenerate" : undefined}>
                {meta}{stale[name] && T ? "*" : ""}
              </span>
              <span className="actions">
                <button className="btn ghost icon sm" title="Duplicate" onClick={(e) => { e.stopPropagation(); a.duplicateTrajectory(name); }}><Copy size={13} /></button>
                <button className="btn ghost icon sm danger" title="Delete" onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${name}"? This removes its file.`)) a.deleteTrajectory(name);
                }}><Trash2 size={13} /></button>
              </span>
            </div>
          );
        })}
      </div>
      {traj && <WaypointSection traj={traj} />}
      {traj && <ConstraintSection traj={traj} />}
      {traj && <MarkerSection traj={traj} />}
    </>
  );
}

function WaypointSection({ traj }: { traj: Trajectory }) {
  const selection = useStore((s) => s.selection);
  const a = useStore.getState();
  const n = traj.waypoints.length;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= n) return;
    a.updateTraj(traj.name, (t) => {
      [t.waypoints[i], t.waypoints[j]] = [t.waypoints[j], t.waypoints[i]];
    });
    a.select({ kind: "waypoint", index: j });
  };
  return (
    <div className="section">
      <div className="section-head">
        <span>Waypoints<span className="count">{n}</span></span>
        <button className={`btn ghost icon sm`} title="Add waypoints (W)" onClick={() => a.setTool("waypoint")}><Plus size={15} /></button>
      </div>
      {!n && <div className="sidebar-empty">Press W, then click the field.</div>}
      {traj.waypoints.map((w, i) => (
        <div key={w.id} className={`item ${selection?.kind === "waypoint" && selection.index === i ? "on" : ""} ${w.translationMode === "guide" ? "dim" : ""}`}
          onClick={() => a.select({ kind: "waypoint", index: i })}>
          <span className={`num ${i === 0 ? "start" : ""}`}>{i + 1}</span>
          <span className="name">{wpLabel(w, i, n)}{w.split ? " · split" : ""}</span>
          <span className="meta">
            {traj.output?.waypointTimes[i] !== undefined ? `${traj.output.waypointTimes[i].toFixed(2)}s` : `${w.x.toFixed(1)}, ${w.y.toFixed(1)}`}
          </span>
          <span className="actions">
            <button className="btn ghost icon sm" title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(i, -1); }}><ArrowUp size={13} /></button>
            <button className="btn ghost icon sm" title="Move down" disabled={i === n - 1} onClick={(e) => { e.stopPropagation(); move(i, 1); }}><ArrowDown size={13} /></button>
          </span>
        </div>
      ))}
    </div>
  );
}

function ConstraintSection({ traj }: { traj: Trajectory }) {
  const selection = useStore((s) => s.selection);
  const a = useStore.getState();
  const [adding, setAdding] = useState(false);
  const add = (type: ConstraintType) => {
    const c = newConstraint(type, traj.waypoints.length);
    a.updateTraj(traj.name, (t) => { t.constraints.push(c); });
    a.select({ kind: "constraint", id: c.id });
    setAdding(false);
  };
  return (
    <div className="section">
      <div className="section-head">
        <span>Constraints<span className="count">{traj.constraints.length}</span></span>
        <button className={`btn ghost icon sm ${adding ? "on" : ""}`} title="Add constraint" onClick={() => setAdding(!adding)}><Plus size={15} /></button>
      </div>
      {adding && (
        <div style={{ padding: "0 10px 8px", display: "flex", flexWrap: "wrap", gap: 4 }}>
          {(Object.keys(CONSTRAINT_LABELS) as ConstraintType[]).map((k) => (
            <button key={k} className="btn sm" onClick={() => add(k)}>{CONSTRAINT_LABELS[k]}</button>
          ))}
        </div>
      )}
      {!traj.constraints.length && !adding && <div className="sidebar-empty">None. Paths use the robot's full limits.</div>}
      {traj.constraints.map((c) => (
        <div key={c.id} className={`item ${selection?.kind === "constraint" && selection.id === c.id ? "on" : ""} ${c.enabled ? "" : "dim"}`}
          onClick={() => a.select({ kind: "constraint", id: c.id })}>
          <span className="icon">{c.data.type === "pointAt" ? <Crosshair size={15} /> : c.data.type.startsWith("keep") ? <Pentagon size={15} /> : <Gauge size={15} />}</span>
          <span className="name">{CONSTRAINT_LABELS[c.data.type]}</span>
          <span className="meta" title={scopeText(c)}>{constraintValue(c)}</span>
        </div>
      ))}
    </div>
  );
}

function MarkerSection({ traj }: { traj: Trajectory }) {
  const selection = useStore((s) => s.selection);
  const a = useStore.getState();
  const add = () => {
    const sel = a.selection;
    const m = newMarker(sel?.kind === "waypoint" ? sel.index : 0);
    a.updateTraj(traj.name, (t) => { t.markers.push(m); });
    a.select({ kind: "marker", id: m.id });
  };
  return (
    <div className="section">
      <div className="section-head">
        <span>Event markers<span className="count">{traj.markers.length}</span></span>
        <button className="btn ghost icon sm" title="Add marker at the selected waypoint" disabled={!traj.waypoints.length} onClick={add}><Plus size={15} /></button>
      </div>
      {!traj.markers.length && <div className="sidebar-empty">Run named commands at points along the path.</div>}
      {traj.markers.map((m) => {
        const ev = traj.output?.events.find((e) => e.name === m.name);
        return (
          <div key={m.id} className={`item ${selection?.kind === "marker" && selection.id === m.id ? "on" : ""}`}
            onClick={() => a.select({ kind: "marker", id: m.id })}>
            <span className="icon" style={{ color: "var(--amber)" }}><Flag size={15} /></span>
            <span className="name">{m.name}{m.endWaypoint !== null ? " (zone)" : ""}</span>
            <span className="meta">{ev ? `${ev.t.toFixed(2)}s` : `wp ${m.waypoint + 1}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function ObstacleSection() {
  const field = useStore((s) => s.project!.field);
  const selection = useStore((s) => s.selection);
  const a = useStore.getState();
  return (
    <div className="section" style={{ borderBottom: 0 }}>
      <div className="section-head">
        <span>Obstacles<span className="count">{field.obstacles.filter((o) => o.enabled).length}/{field.obstacles.length}</span></span>
        <span style={{ display: "flex", gap: 2 }}>
          <button className="btn ghost icon sm" title="Draw polygon (P)" onClick={() => a.setTool("polygon")}><Pentagon size={15} /></button>
          <button className="btn ghost icon sm" title="Draw circle (C)" onClick={() => a.setTool("circle")}><Circle size={15} /></button>
        </span>
      </div>
      {!field.obstacles.length && <div className="sidebar-empty">Draw polygons or circles every path must avoid.</div>}
      {field.obstacles.map((o) => (
        <div key={o.id} className={`item ${selection?.kind === "obstacle" && selection.id === o.id ? "on" : ""} ${o.enabled ? "" : "dim"}`}
          onClick={() => a.select({ kind: "obstacle", id: o.id })}>
          <input type="checkbox" checked={o.enabled} style={{ accentColor: "var(--accent)", margin: 0 }} title="Enabled"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => a.updateProject((p) => { const x = p.field.obstacles.find((y) => y.id === o.id); if (x) x.enabled = e.target.checked; })} />
          <span className="name">{o.name}</span>
          <span className="meta">{o.kind === "circle" ? "circle" : `${o.points.length} pts`}</span>
        </div>
      ))}
    </div>
  );
}
