import { useState } from "react";
import { Calculator, FolderOpen, Keyboard, Palette, Route, Settings2, Trash2, Truck, X } from "lucide-react";
import { useStore, type SettingsTab } from "../store";
import { footprint, MOTOR_LABELS } from "../model";
import type { MotorType, RobotConfig } from "../types";
import { NumberField, Seg, SelectField, TextField } from "./ui";
import { SolverSettingsEditor } from "./Inspector";
import { pickFolder } from "./Welcome";

const TABS: { tab: SettingsTab; label: string; icon: typeof Truck }[] = [
  { tab: "robot", label: "Robot", icon: Truck },
  { tab: "path", label: "Path solver", icon: Route },
  { tab: "project", label: "Project", icon: Settings2 },
  { tab: "appearance", label: "Appearance", icon: Palette },
  { tab: "shortcuts", label: "Shortcuts", icon: Keyboard },
];

export function SettingsModal() {
  const tab = useStore((s) => s.settings);
  const a = useStore.getState();
  if (!tab) return null;
  return (
    <div className="modal-back" onMouseDown={() => a.openSettings(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">Settings</div>
          <button className="btn ghost icon sm" onClick={() => a.openSettings(null)}><X size={15} /></button>
        </div>
        <div className="modal-body">
          <nav className="modal-nav">
            {TABS.map(({ tab: t, label, icon: Icon }) => (
              <div key={t} className={`item ${tab === t ? "on" : ""}`} onClick={() => a.openSettings(t)}>
                <span className="icon"><Icon size={15} /></span><span className="name">{label}</span>
              </div>
            ))}
          </nav>
          <div className="modal-content">
            {tab === "robot" && <RobotSettings />}
            {tab === "path" && <PathSettings />}
            {tab === "project" && <ProjectSettings />}
            {tab === "appearance" && <AppearanceSettings />}
            {tab === "shortcuts" && <Shortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

function RobotSettings() {
  const robot = useStore((s) => s.project!.robot);
  const info = useStore((s) => s.drivetrainInfo);
  const a = useStore.getState();
  const set = (fn: (r: RobotConfig) => void) => a.updateProject((p) => fn(p.robot));
  const mods = robot.modules;
  const wheelbase = Math.abs(mods[0][0] - mods[2][0]);
  const track = Math.abs(mods[0][1] - mods[1][1]);
  const L = robot.bumper.front + robot.bumper.back;
  const W = robot.bumper.left + robot.bumper.right;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 20 }}>
      <div className="form">
        <h3>Mass</h3>
        <div className="field-row">
          <NumberField label="Mass (with bumpers & battery)" unit="kg" value={robot.mass} min={5} step={0.5} onChange={(v) => set((r) => { r.mass = v; })} />
          <NumberField label="Moment of inertia" unit="kg·m²" value={robot.moi} min={0.1} step={0.1} onChange={(v) => set((r) => { r.moi = v; })} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn sm" onClick={() => set((r) => { r.moi = +(r.mass * (L * L + W * W) / 12).toFixed(3); })}><Calculator size={13} /> Estimate MOI</button>
          <span className="note">Treats the robot as a uniform box the size of the bumpers.</span>
        </div>
        <NumberField label="Center of gravity height (0 = ignore weight transfer)" unit="m" value={robot.cogHeight} min={0} onChange={(v) => set((r) => { r.cogHeight = v; })} />
        <h3>Bumper (from robot center)</h3>
        <div className="field-row">
          <NumberField label="Front" unit="m" value={robot.bumper.front} min={0.1} onChange={(v) => set((r) => { r.bumper.front = v; })} />
          <NumberField label="Back" unit="m" value={robot.bumper.back} min={0.1} onChange={(v) => set((r) => { r.bumper.back = v; })} />
          <NumberField label="Left" unit="m" value={robot.bumper.left} min={0.1} onChange={(v) => set((r) => { r.bumper.left = v; })} />
          <NumberField label="Right" unit="m" value={robot.bumper.right} min={0.1} onChange={(v) => set((r) => { r.bumper.right = v; })} />
        </div>
        <h3>Modules</h3>
        <div className="field-row">
          <NumberField label="Wheelbase (front–back)" unit="m" value={wheelbase} min={0.1} onChange={(v) => set((r) => { r.modules = r.modules.map(([x, y]) => [Math.sign(x) * v / 2, y]); })} />
          <NumberField label="Track width (left–right)" unit="m" value={track} min={0.1} onChange={(v) => set((r) => { r.modules = r.modules.map(([x, y]) => [x, Math.sign(y) * v / 2]); })} />
          <NumberField label="Wheel radius" unit="m" value={robot.wheelRadius} min={0.01} step={0.001} digits={4} onChange={(v) => set((r) => { r.wheelRadius = v; })} />
          <NumberField label="Wheel friction (μ)" value={robot.wheelCof} min={0.1} step={0.05} onChange={(v) => set((r) => { r.wheelCof = v; })} />
        </div>
        <h3>Drive motors</h3>
        <div className="field-row">
          <SelectField label="Motor" value={robot.motor.type} onChange={(v) => set((r) => { r.motor.type = v as MotorType; })}
            options={Object.entries(MOTOR_LABELS).map(([value, label]) => ({ value: value as MotorType, label }))} />
          <NumberField label="Gear ratio" unit=":1" value={robot.motor.gearing} min={1} step={0.05} onChange={(v) => set((r) => { r.motor.gearing = v; })} />
          <NumberField label="Stator current limit" unit="A" value={robot.motor.currentLimit} min={10} step={5} digits={0} onChange={(v) => set((r) => { r.motor.currentLimit = v; })} />
          <NumberField label="Efficiency" value={robot.motor.efficiency} min={0.3} max={1} step={0.01} onChange={(v) => set((r) => { r.motor.efficiency = v; })} />
          <NumberField label="Planning voltage" unit="V" value={robot.batteryVoltage} min={6} max={13} step={0.1} onChange={(v) => set((r) => { r.batteryVoltage = v; })} />
        </div>
        <div className="note">Module order is FL, FR, BL, BR (the CTRE Tuner X default). Planning below 12 V leaves headroom for feedback.</div>
      </div>
      <div>
        <RobotPreview robot={robot} />
        {info && (
          <div style={{ marginTop: 12 }}>
            {[
              ["Free speed", `${info.maxSpeed.toFixed(2)} m/s`],
              ["Max accel", `${info.maxAcceleration.toFixed(2)} m/s²`],
              ["Max ω", `${info.maxAngularVelocity.toFixed(2)} rad/s`],
              ["Limited by", info.limitingForce],
            ].map(([k, v]) => <div key={k} className="kv"><span className="muted">{k}</span><b>{v}</b></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function RobotPreview({ robot }: { robot: RobotConfig }) {
  const fp = footprint(robot, 0, 0, Math.PI / 2);
  const ext = Math.max(...fp.flat().map(Math.abs)) + 0.1;
  return (
    <svg viewBox={`${-ext} ${-ext} ${2 * ext} ${2 * ext}`} style={{ width: "100%", display: "block", background: "var(--canvas)", borderRadius: 10 }}>
      <polygon points={fp.map(([x, y]) => `${x},${-y}`).join(" ")} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={0.012} />
      {robot.modules.map(([mx, my], i) => (
        <g key={i}>
          <rect x={-my - 0.03} y={-mx - 0.045} width={0.06} height={0.09} rx={0.012} fill="var(--accent)" />
          <text x={-my} y={-mx + 0.09} textAnchor="middle" fontSize={0.045} fill="var(--muted)" fontFamily="var(--mono)">{["FL", "FR", "BL", "BR"][i]}</text>
        </g>
      ))}
      <path d={`M 0 ${-robot.bumper.front + 0.04} l -0.045 0.07 h 0.09 z`} fill="var(--accent)" />
    </svg>
  );
}

function PathSettings() {
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  if (!traj) return <div className="muted">Select a path first.</div>;
  return (
    <div className="form" style={{ maxWidth: 420 }}>
      <h3>{traj.name}</h3>
      <SolverSettingsEditor traj={traj} upd={(fn, history = true) => useStore.getState().updateTraj(traj.name, fn, { history })} />
    </div>
  );
}

function ProjectSettings() {
  const project = useStore((s) => s.project)!;
  const dir = useStore((s) => s.dir);
  const a = useStore.getState();
  const [cmd, setCmd] = useState("");
  const addCmd = () => {
    const c = cmd.trim();
    if (c) a.updateProject((p) => { if (!p.commands.includes(c)) p.commands.push(c); });
    setCmd("");
  };
  return (
    <div className="form" style={{ maxWidth: 480 }}>
      <h3>Project</h3>
      <TextField label="Name" value={project.name} onChange={(v) => a.updateProject((p) => { p.name = v; })} />
      <div className="note mono">{dir}</div>
      <label className="lbl"><span>Deploy folder (the robot project's src/main/deploy/mayhem)</span>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input mono" value={project.deployDir} placeholder="same as the project folder"
            onChange={(e) => a.updateProject((p) => { p.deployDir = e.target.value; }, { history: false })} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn icon" title="Browse" onClick={async () => {
            const d = await pickFolder("Choose the robot project's deploy/mayhem folder");
            if (d) a.updateProject((p) => { p.deployDir = d; });
          }}><FolderOpen size={15} /></button>
        </div>
      </label>
      <div className="note">If the project already lives in the robot's deploy folder, leave this blank: saving is deploying.</div>
      <h3>Named commands</h3>
      <div className="note">Names bound in robot code with <span className="mono">auto.bind("name", command)</span>; they autocomplete in event markers.</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="input" placeholder="e.g. intake" value={cmd} onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") addCmd(); }} />
        <button className="btn" onClick={addCmd}>Add</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {project.commands.map((c) => (
          <span key={c} className="chip accent">{c}
            <button className="link-btn" style={{ color: "inherit" }} onClick={() => a.updateProject((p) => { p.commands = p.commands.filter((x) => x !== c); })}><Trash2 size={11} /></button>
          </span>
        ))}
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("mayhem.theme") ?? "light"; } catch { return "light"; } });
  const apply = (t: string) => {
    setTheme(t);
    try { localStorage.setItem("mayhem.theme", t); } catch { /* ignore */ }
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  };
  return (
    <div className="form">
      <h3>Theme</h3>
      <Seg value={theme} onChange={apply} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
    </div>
  );
}

function Shortcuts() {
  const rows = [
    ["Generate selected path", "⌘ ↵"], ["Undo / redo", "⌘Z / ⇧⌘Z"], ["Play / pause", "Space"],
    ["Select · pose · translation · guide", "V · W · T · G"], ["Constraint (from the toolbar menu)", "click first, then last waypoint"],
    ["Single-waypoint constraint", "click it, then ↵"], ["Field mode: polygon · circle", "P · C"], ["Delete selection", "⌫"],
    ["Nudge waypoint", "Arrows (⇧ 10 cm)"], ["Snap while dragging", "hold ⇧"], ["Finish / cancel drawing", "↵ / Esc"],
    ["Pan · zoom", "drag empty space · scroll"],
  ];
  return <div>{rows.map(([k, v]) => <div key={k} className="kv"><span>{k}</span><kbd>{v}</kbd></div>)}</div>;
}
