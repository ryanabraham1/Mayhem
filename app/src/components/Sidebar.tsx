import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpFromLine, GripVertical, ChevronDown, ChevronRight, Circle, Copy, Crosshair, Flag, Folder, FolderInput, FolderMinus,
  FolderOpen, FolderPlus, Gauge, Link2, Loader2, Minus, Pentagon, Play, Plus, Route, Trash2,
} from "lucide-react";
import { useStore } from "../store";
import { CONSTRAINT_LABELS, folderList, newMarker, reorderWaypoint, totalTime } from "../model";
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
  const selected = useStore((s) => s.selectedTraj);
  const trajectories = useStore((s) => s.trajectories);
  const traj = selected ? trajectories[selected] : undefined;
  return (
    <>
      <PathList />
      {traj && <WaypointSection traj={traj} />}
      {traj && <ConstraintSection traj={traj} />}
      {traj && <MarkerSection traj={traj} />}
    </>
  );
}

/** Where a dragged path would land: into a folder (at its end) or before another path. */
type DropTarget = { folder: string | null; before: string | null } | null;

function PathList() {
  const order = useStore((s) => s.order);
  const trajectories = useStore((s) => s.trajectories);
  const project = useStore((s) => s.project);
  const status = useStore((s) => s.backendStatus);
  const solves = useStore((s) => s.solves);
  const generatingAll = useStore((s) => s.generatingAll);
  const a = useStore.getState();
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);

  const folders = folderList(project, trajectories);
  const loose = order.filter((n) => !trajectories[n].folder);
  const inFolder = (f: string) => order.filter((n) => trajectories[n].folder === f);

  const dropProps = (target: NonNullable<DropTarget>) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      if (drop?.folder !== target.folder || drop?.before !== target.before) setDrop(target);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      a.moveTrajectory(dragging, target.folder, target.before);
      setDragging(null);
      setDrop(null);
    },
  });

  const newFolder = () => setRenamingFolder(a.addFolder());

  const row = (name: string) => (
    <PathRow key={name} name={name} folders={folders} indent={!!trajectories[name].folder}
      dropBefore={!!dragging && drop?.before === name}
      onDragStart={() => setDragging(name)} onDragEnd={() => { setDragging(null); setDrop(null); }}
      onNewFolder={() => { const f = a.addFolder(); a.moveTrajectory(name, f); setRenamingFolder(f); }}
      {...dropProps({ folder: trajectories[name].folder ?? null, before: name })} />
  );

  return (
    <div className="section" {...dropProps({ folder: null, before: null })}>
      <div className="section-head">
        <span>Paths<span className="count">{order.length}</span></span>
        <span style={{ display: "flex", gap: 2 }}>
          <button className="btn ghost icon sm" title="New folder" onClick={newFolder}><FolderPlus size={15} /></button>
          <button className="btn ghost icon sm" title="New path" onClick={() => a.addTrajectory("New Path")}><Plus size={15} /></button>
        </span>
      </div>
      {!order.length && !folders.length && <div className="sidebar-empty">No paths yet. Click + to add one.</div>}
      {folders.map((f) => {
        const names = inFolder(f);
        const open = !collapsed[f];
        const solvable = names.filter((n) => trajectories[n].waypoints.length >= 2);
        return (
          <div key={f}>
            <div className={`item folder ${dragging && drop && drop.folder === f && drop.before === null ? "drop-into" : ""}`}
              onClick={() => setCollapsed({ ...collapsed, [f]: open })} onDoubleClick={() => setRenamingFolder(f)}
              {...dropProps({ folder: f, before: null })}>
              <span className="icon">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              <span className="icon">{open ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
              {renamingFolder === f ? (
                <RenameInput value={f} onDone={(v) => { if (v !== null) a.renameFolder(f, v); setRenamingFolder(null); }} />
              ) : (
                <span className="name">{f}</span>
              )}
              <span className="meta">{names.length}</span>
              <span className="actions">
                <button className="btn ghost icon sm" title="New path in this folder" onClick={(e) => {
                  e.stopPropagation();
                  a.addTrajectory("New Path", f);
                  setCollapsed({ ...collapsed, [f]: false });
                }}><Plus size={13} /></button>
                <button className="btn ghost icon sm" title="Generate every path in this folder"
                  disabled={status !== "ready" || !solvable.length || generatingAll || Object.values(solves).some((s) => s.status === "solving")}
                  onClick={(e) => { e.stopPropagation(); void a.solveAll(solvable); }}><Play size={13} /></button>
                <button className="btn ghost icon sm danger" title="Delete folder (keeps its paths)" onClick={(e) => {
                  e.stopPropagation();
                  if (!names.length || window.confirm(`Delete folder "${f}"? Its ${names.length} path${names.length === 1 ? "" : "s"} move to the top level.`)) a.deleteFolder(f);
                }}><Trash2 size={13} /></button>
              </span>
            </div>
            {open && names.map(row)}
            {open && !names.length && <div className="sidebar-empty indent">Empty. Drag paths here.</div>}
          </div>
        );
      })}
      {loose.map(row)}
      {dragging && trajectories[dragging]?.folder && (
        <div className={`drop-zone ${drop?.folder === null && drop.before === null ? "on" : ""}`}>Drop here to remove from folder</div>
      )}
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input className="input" autoFocus defaultValue={value} style={{ height: 26 }}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") finish(null);
      }} />
  );
}

function PathRow({ name, folders, indent, dropBefore, onDragStart, onDragEnd, onNewFolder, onDragOver, onDrop }: {
  name: string; folders: string[]; indent: boolean; dropBefore: boolean;
  onDragStart: () => void; onDragEnd: () => void; onNewFolder: () => void;
  onDragOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void;
}) {
  const t = useStore((s) => s.trajectories[name]);
  const st = useStore((s) => s.solves[name]);
  const stale = useStore((s) => s.stale[name]);
  const selected = useStore((s) => s.selectedTraj === name);
  const a = useStore.getState();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const T = totalTime(t.output);
  let meta = T ? `${T.toFixed(2)}s` : "";
  if (st?.status === "failed") meta = "failed";
  const move = (f: string | null) => { a.moveTrajectory(name, f); setMenu(false); };
  return (
    <div className={`item ${selected ? "on" : ""} ${indent ? "indent" : ""} ${dropBefore ? "drop-before" : ""}`}
      draggable={!renaming}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", name); onDragStart(); }}
      onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}
      onClick={() => a.selectTraj(name)} onDoubleClick={() => setRenaming(true)}>
      <span className="icon">{st?.status === "solving" ? <Loader2 size={15} className="spin" /> : <Route size={15} />}</span>
      {renaming ? (
        <RenameInput value={name} onDone={(v) => { if (v !== null) void a.renameTrajectory(name, v); setRenaming(false); }} />
      ) : (
        <span className="name">{name}</span>
      )}
      <span className="meta" style={{ color: st?.status === "failed" ? "var(--red)" : stale ? "var(--amber)" : undefined }}
        title={stale ? "Out of date: regenerate" : undefined}>
        {meta}{stale && T ? "*" : ""}
      </span>
      <span className="actions" style={menu ? { display: "flex" } : undefined}>
        <span ref={menuRef} style={{ position: "relative", display: "flex" }}>
          <button className={`btn ghost icon sm ${menu ? "on" : ""}`} title="Move to folder"
            onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><FolderInput size={13} /></button>
          {menu && (
            <div className="menu folder-menu" onClick={(e) => e.stopPropagation()}>
              {t.folder && <button className="menu-item" onClick={() => move(null)}><FolderMinus size={15} /><span className="menu-title">Top level</span></button>}
              {folders.filter((f) => f !== t.folder).map((f) => (
                <button key={f} className="menu-item" onClick={() => move(f)}><Folder size={15} /><span className="menu-title">{f}</span></button>
              ))}
              <button className="menu-item" onClick={() => { setMenu(false); onNewFolder(); }}><FolderPlus size={15} /><span className="menu-title">New folder…</span></button>
            </div>
          )}
        </span>
        <button className="btn ghost icon sm" title="Duplicate" onClick={(e) => { e.stopPropagation(); a.duplicateTrajectory(name); }}><Copy size={13} /></button>
        <button className="btn ghost icon sm danger" title="Delete" onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete "${name}"? This removes its file.`)) a.deleteTrajectory(name);
        }}><Trash2 size={13} /></button>
      </span>
    </div>
  );
}

function WaypointSection({ traj }: { traj: Trajectory }) {
  const selection = useStore((s) => s.selection);
  const a = useStore.getState();
  const n = traj.waypoints.length;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  // Insertion slot while dragging: the dragged waypoint lands before index `slot` (n = at the end).
  const [slot, setSlot] = useState<number | null>(null);

  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    const selected = selection?.kind === "waypoint" && selection.index === from;
    a.updateTraj(traj.name, (t) => reorderWaypoint(t, from, to));
    if (selected || selection?.kind !== "waypoint") a.select({ kind: "waypoint", index: to });
  };
  const endDrag = () => { setDragFrom(null); setSlot(null); };

  return (
    <div className="section">
      <div className="section-head">
        <span>Waypoints<span className="count">{n}</span></span>
        <button className={`btn ghost icon sm`} title="Add waypoints (W)" onClick={() => a.setTool("pose")}><Plus size={15} /></button>
      </div>
      {!n && <div className="sidebar-empty">Press W, then click the field.</div>}
      {traj.waypoints.map((w, i) => (
        <div key={w.id} draggable
          className={`item ${selection?.kind === "waypoint" && selection.index === i ? "on" : ""} ${w.translationMode === "guide" ? "dim" : ""}`
            + `${dragFrom === i ? " dragging" : ""}${slot === i && dragFrom !== null ? " drop-before" : ""}${slot === n && i === n - 1 && dragFrom !== null ? " drop-after" : ""}`}
          onClick={() => a.select({ kind: "waypoint", index: i })}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); setDragFrom(i); }}
          onDragOver={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const next = e.clientY < r.top + r.height / 2 ? i : i + 1;
            if (next !== slot) setSlot(next);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && slot !== null) moveTo(dragFrom, slot > dragFrom ? slot - 1 : slot);
            endDrag();
          }}
          onDragEnd={endDrag}>
          <span className="grip" title="Drag to reorder"><GripVertical size={13} /></span>
          <span className={`num ${i === 0 ? "start" : ""}`}>{i + 1}</span>
          <span className="name">{wpLabel(w, i, n)}{w.split ? " · split" : ""}</span>
          {w.poseRef && <span className="icon" title="Linked to a pose variable" style={{ color: "var(--accent)" }}><Link2 size={13} /></span>}
          <span className="meta">
            {traj.output?.waypointTimes[i] !== undefined ? `${traj.output.waypointTimes[i].toFixed(2)}s` : `${w.x.toFixed(1)}, ${w.y.toFixed(1)}`}
          </span>
          <span className="actions">
            <button className="btn ghost icon sm" title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveTo(i, i - 1); }}><ArrowUp size={13} /></button>
            <button className="btn ghost icon sm" title="Move down" disabled={i === n - 1} onClick={(e) => { e.stopPropagation(); moveTo(i, i + 1); }}><ArrowDown size={13} /></button>
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
    a.startConstraint(type); // then click the waypoint(s) on the field
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
          <span className="icon">{c.data.type === "pointAt" ? <Crosshair size={15} /> : c.data.type === "straightLine" ? <Minus size={15} /> : c.data.type === "intakeExtended" ? <ArrowUpFromLine size={15} /> : c.data.type.startsWith("keep") ? <Pentagon size={15} /> : <Gauge size={15} />}</span>
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
