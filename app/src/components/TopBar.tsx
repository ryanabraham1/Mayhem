import { FolderOpen, Loader2, Play, Redo2, Rocket, Settings2, Undo2 } from "lucide-react";
import { useStore } from "../store";
import { Seg } from "./ui";

export function TopBar() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const selected = useStore((s) => s.selectedTraj);
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const solving = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj]?.status === "solving" : false));
  const anySolving = useStore((s) => Object.values(s.solves).some((x) => x.status === "solving"));
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const status = useStore((s) => s.backendStatus);
  const a = useStore.getState();

  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M8.2 18H14a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h5.8" />
          </svg>
        </div>
        Mayhem
      </div>
      {project && (
        <>
          <span className="divider-v" />
          <span className="project-name" title={useStore.getState().dir ?? ""}>{project.name}</span>
          <button className="btn ghost icon sm" title="Open another project" onClick={a.closeProject}><FolderOpen size={15} /></button>
          <span className="divider-v" />
          <Seg value={view} onChange={(v) => a.setView(v)} options={[{ value: "paths", label: "Paths" }, { value: "field", label: "Field" }]} />
        </>
      )}
      <div className="spacer" />
      {project && (
        <>
          <button className="btn ghost icon" onClick={a.undo} disabled={!canUndo} title="Undo (⌘Z)"><Undo2 size={16} /></button>
          <button className="btn ghost icon" onClick={a.redo} disabled={!canRedo} title="Redo (⇧⌘Z)"><Redo2 size={16} /></button>
          <span className="divider-v" />
          <button className="btn" onClick={() => void a.solveAll()} disabled={status !== "ready" || anySolving} title="Generate every path">Generate all</button>
          <button className="btn primary" disabled={status !== "ready" || !selected || (traj?.waypoints.length ?? 0) < 2 || solving}
            onClick={() => selected && void a.solve(selected)} title="Generate the selected path (⌘↵)">
            {solving ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Generate
          </button>
          <button className="btn" onClick={() => void a.deploy()} title="Copy generated paths into the robot project"><Rocket size={15} /> Deploy</button>
          <button className="btn ghost icon" onClick={() => a.openSettings("robot")} title="Settings"><Settings2 size={17} /></button>
        </>
      )}
    </header>
  );
}
