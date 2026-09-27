import { useEffect, useRef, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { useStore } from "../store";
import { newPoseVariable, resolveWaypoint } from "../model";
import { PoseVariableEditor } from "./Inspector";

export function PoseVariablesPopover() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const poses = useStore((s) => s.project?.poses ?? []);
  const selectedId = poses.some((p) => p.id === selected) ? selected : poses[0]?.id;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const add = () => {
    const a = useStore.getState();
    const t = a.selectedTraj ? a.trajectories[a.selectedTraj] : undefined;
    const index = a.selection?.kind === "waypoint" ? a.selection.index : null;
    const original = index !== null ? t?.waypoints[index] : undefined;
    const w = original ? resolveWaypoint(a.project?.poses, original) : undefined;
    const field = a.project!.field;
    const v = newPoseVariable(`Pose ${poses.length + 1}`, w?.x ?? field.length / 4,
      w?.y ?? field.width / 2, w?.heading ?? 0);
    a.updateProject((p) => { p.poses.push(v); });
    if (original && !original.poseRef && t && index !== null) {
      a.updateTraj(t.name, (d) => { d.waypoints[index].poseRef = v.id; });
    }
    setSelected(v.id);
  };

  return (
    <div className="pose-popover-anchor" ref={ref} onKeyDownCapture={(e) => {
      if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
    }}>
      <button className={`tool ${open ? "on" : ""}`} onClick={() => setOpen(!open)}
        aria-expanded={open} aria-haspopup="dialog" title="Manage project pose variables">
        <Link2 size={16} /> Pose variables
      </button>
      {open && (
        <div className="pose-popover" role="dialog" aria-label="Pose variables">
          <div className="card-head">
            <div className="card-title">Pose variables</div>
            <button className="btn ghost icon sm" title="Close" onClick={() => setOpen(false)}><X size={15} /></button>
          </div>
          <div className="pose-popover-content">
            <div className="note">Shared positions and headings for paths. Select a waypoint first to link a new variable to it.</div>
            <button className="btn sm" onClick={add}><Plus size={14} /> New pose variable</button>
            {poses.length > 0 ? (
              <div className="pose-popover-layout">
                <div className="pose-popover-list">
                  {poses.map((p) => (
                    <button key={p.id} className={`pose-popover-item ${selectedId === p.id ? "on" : ""}`}
                      aria-pressed={selectedId === p.id} onClick={() => setSelected(p.id)}>
                      <Link2 size={14} /><span>{p.name}</span>
                    </button>
                  ))}
                </div>
                {selectedId && <PoseVariableEditor id={selectedId} />}
              </div>
            ) : <div className="note">No pose variables yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
