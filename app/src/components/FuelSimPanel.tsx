import { useEffect, useRef, useState } from "react";
import { Atom, Copy, Plus, Trash2, X } from "lucide-react";
import { useStore } from "../store";
import { DEFAULT_FUEL_SIM, intakenBy, newSimRobot } from "../fuelsim";
import { useFuelSim } from "../useFuelSim";
import { flipPoint, uid } from "../model";
import type { SimRobot } from "../types";
import { Card, Check, NumberField, Seg, TextField } from "./ui";

const allianceColor = (a: SimRobot["alliance"]) => (a === "blue" ? "var(--blue-alliance)" : "var(--red-alliance)");

/** Toolstrip popover: turn the fuel sim on, set our intake, and add allies / opponents. */
export function FuelSimPopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const on = useStore((s) => s.fuelSimOn);
  const cfg = useStore((s) => s.project?.fuelSim ?? DEFAULT_FUEL_SIM);
  const selection = useStore((s) => s.selection);
  const t = useStore((s) => s.playback.t);
  const sim = useFuelSim();
  const a = useStore.getState();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const add = (alliance: SimRobot["alliance"]) => {
    const r = newSimRobot(a.project!.field, alliance, cfg.robots);
    a.updateFuelSim((f) => { f.robots.push(r); });
    a.setFuelSimOn(true);
    a.select({ kind: "simRobot", id: r.id });
  };
  const count = (key: string) => (sim ? intakenBy(sim, key, t) : null);

  return (
    <div className="pose-popover-anchor" ref={ref} onKeyDownCapture={(e) => {
      if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
    }}>
      <button className={`tool ${open || on ? "on" : ""}`} onClick={() => setOpen(!open)}
        aria-expanded={open} aria-haspopup="dialog" title="Simulate how fuel moves during playback">
        <Atom size={16} /> Fuel sim
      </button>
      {open && (
        <div className="pose-popover fuel-popover" role="dialog" aria-label="Fuel sim">
          <div className="card-head">
            <div className="card-title">Fuel sim</div>
            <button className="btn ghost icon sm" title="Close" onClick={() => setOpen(false)}><X size={15} /></button>
          </div>
          <div className="pose-popover-content">
            <Check label="Simulate fuel during playback" checked={on} onChange={(v) => a.setFuelSimOn(v)} />
            <div className="note">
              Robots push the fuel around; an extended intake takes it in only as fast as its rate, and the rest gets shoved.
              Our robot uses its <b>Intake extended</b> spans.
            </div>
            <div className="field-row">
              <NumberField label="Our intake rate" unit="/s" value={cfg.intakeRate} min={0} step={1} digits={1}
                onChange={(v) => a.updateFuelSim((f) => { f.intakeRate = v; })} />
              <NumberField label="Our capacity" hint="0 = no limit" value={cfg.capacity} min={0} step={1} digits={0}
                onChange={(v) => a.updateFuelSim((f) => { f.capacity = Math.round(v); })} />
            </div>
            {on && count("us") !== null && <div className="note">We have <b>{count("us")}</b> fuel at {t.toFixed(2)} s.</div>}
            <div className="lbl"><span>Other robots</span></div>
            <div className="sim-robot-list">
              {cfg.robots.map((r) => {
                const n = count(r.id);
                return (
                  <div key={r.id} className={`pose-popover-item ${selection?.kind === "simRobot" && selection.id === r.id ? "on" : ""}`}
                    role="button" tabIndex={0} onClick={() => { a.setFuelSimOn(true); a.select({ kind: "simRobot", id: r.id }); }}>
                    <span className="dot" style={{ background: allianceColor(r.alliance), opacity: r.enabled ? 1 : 0.35 }} />
                    <span style={{ flex: 1 }}>{r.name}</span>
                    {n !== null && r.enabled && <span className="mono muted" style={{ fontSize: 11 }}>{n} fuel</span>}
                    <input type="checkbox" checked={r.enabled} title="Include in the sim" onClick={(e) => e.stopPropagation()}
                      onChange={(e) => a.updateFuelSim((f) => { const x = f.robots.find((q) => q.id === r.id); if (x) x.enabled = e.target.checked; })} />
                  </div>
                );
              })}
              {!cfg.robots.length && <div className="note">None yet. Their autos are smooth curves you drag on the field.</div>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn sm" onClick={() => add("blue")}>
                <Plus size={14} /><span className="dot" style={{ background: "var(--blue-alliance)" }} /> Ally
              </button>
              <button className="btn sm" onClick={() => add("red")}>
                <Plus size={14} /><span className="dot" style={{ background: "var(--red-alliance)" }} /> Opponent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Floating panel for the selected sim robot. */
export function SimRobotEditor({ id }: { id: string }) {
  const r = useStore((s) => s.project?.fuelSim?.robots.find((x) => x.id === id));
  const a = useStore.getState();
  if (!r) return null;
  const set = (fn: (r: SimRobot) => void) => a.updateFuelSim((f) => { const x = f.robots.find((q) => q.id === id); if (x) fn(x); });
  return (
    <Card title={<><span className="dot" style={{ background: allianceColor(r.alliance), marginRight: 6 }} />Sim robot</>} actions={
      <div style={{ display: "flex", gap: 2 }}>
        <button className="btn ghost icon sm" title="Copy to the other alliance (uses field symmetry)" onClick={() => {
          const field = a.project!.field;
          const c: SimRobot = {
            ...structuredClone(r), id: uid("r"), alliance: r.alliance === "blue" ? "red" : "blue",
            name: r.name.includes("Ally") ? r.name.replace("Ally", "Opponent") : r.name.includes("Opponent") ? r.name.replace("Opponent", "Ally") : `${r.name} (other alliance)`,
            points: r.points.map((p) => flipPoint(field, p)),
          };
          a.updateFuelSim((f) => { f.robots.push(c); });
          a.select({ kind: "simRobot", id: c.id });
        }}><Copy size={14} /></button>
        <button className="btn ghost icon sm danger" title="Delete" onClick={() => {
          a.updateFuelSim((f) => { f.robots = f.robots.filter((x) => x.id !== id); });
          a.select(null);
        }}><Trash2 size={14} /></button>
      </div>
    }>
      <div className="form">
        <TextField label="Name" value={r.name} onChange={(v) => set((x) => { x.name = v.trim() || x.name; })} />
        <label className="lbl"><span>Alliance</span>
          <Seg value={r.alliance} onChange={(v) => set((x) => { x.alliance = v; })}
            options={[{ value: "blue", label: "Ally (blue)" }, { value: "red", label: "Opponent (red)" }]} />
        </label>
        <div className="field-row">
          <NumberField label="Max speed" unit="m/s" value={r.maxVelocity} min={0.1} step={0.1} onChange={(v) => set((x) => { x.maxVelocity = v; })} />
          <NumberField label="Max accel" unit="m/s²" value={r.maxAcceleration} min={0.1} step={0.1} onChange={(v) => set((x) => { x.maxAcceleration = v; })} />
        </div>
        <div className="field-row">
          <NumberField label="Start delay" unit="s" value={r.startDelay} min={0} step={0.1} onChange={(v) => set((x) => { x.startDelay = v; })} />
          <NumberField label="Frame size" unit="m" value={r.size} min={0.3} step={0.05} onChange={(v) => set((x) => { x.size = v; })} />
        </div>
        <Check label="Intake out at the front while driving" checked={r.intake} onChange={(v) => set((x) => { x.intake = v; })} />
        <div className="field-row">
          <NumberField label="Intake rate" unit="/s" value={r.intakeRate} min={0} step={1} digits={1} disabled={!r.intake} onChange={(v) => set((x) => { x.intakeRate = v; })} />
          <NumberField label="Capacity" hint="0 = no limit" value={r.capacity} min={0} step={1} digits={0} disabled={!r.intake} onChange={(v) => set((x) => { x.capacity = Math.round(v); })} />
        </div>
        <Check label="Include in the sim" checked={r.enabled} onChange={(v) => set((x) => { x.enabled = v; })} />
        <div className="note">
          Drag its points to reshape its path, or drag the robot to move the whole path. Double-click the field to add a point at the end; ⇧-click a point to remove it.
          It faces along its path.
        </div>
      </div>
    </Card>
  );
}
