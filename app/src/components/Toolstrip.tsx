import { useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine, Ban, ChevronDown, Circle, CircleDot, Crosshair, Gauge, Minus, MousePointer2, Pentagon, RotateCw,
  SlidersHorizontal, SquareDashed, Waypoints,
} from "lucide-react";
import { useStore, type Tool } from "../store";
import { CONSTRAINT_LABELS } from "../model";
import type { ConstraintType } from "../types";
import { PoseVariablesPopover } from "./PoseVariablesPopover";

// Pose waypoint icon: a small robot square with a heading tick.
function PoseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="12" cy="12" r="2" fill="currentColor" /><path d="M12 12h8" />
    </svg>
  );
}

function TranslationIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}

const PATH_TOOLS: { tool: Tool; icon: React.FC<{ size?: number }>; label: string; key: string; tip: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V", tip: "Select and drag. Drag empty space to pan, scroll to zoom." },
  { tool: "pose", icon: PoseIcon, label: "Pose", key: "W", tip: "Waypoint with a position and a heading." },
  { tool: "translation", icon: TranslationIcon, label: "Translation", key: "T", tip: "Waypoint with a position only; the robot can face any direction." },
  { tool: "guide", icon: CircleDot, label: "Guide", key: "G", tip: "Only shapes the route (e.g. which side of the hub); not a constraint." },
];

const CONSTRAINT_MENU: { type: ConstraintType; icon: typeof Gauge; hint: string }[] = [
  { type: "maxVelocity", icon: Gauge, hint: "Speed limit between two waypoints" },
  { type: "maxAcceleration", icon: SlidersHorizontal, hint: "Acceleration limit between two waypoints" },
  { type: "maxAngularVelocity", icon: RotateCw, hint: "Rotation speed limit between two waypoints" },
  { type: "straightLine", icon: Minus, hint: "Drive in a straight line between two waypoints" },
  { type: "pointAt", icon: Crosshair, hint: "Face a target (e.g. the hub) between two waypoints" },
  { type: "keepIn", icon: SquareDashed, hint: "Draw a region the robot must stay inside" },
  { type: "keepOut", icon: Ban, hint: "Draw a region only this path avoids" },
  { type: "roughTerrain", icon: SquareDashed, hint: "Draw a bump zone; the robot adjusts its clock and correction there" },
  { type: "intakeExtended", icon: ArrowUpFromLine, hint: "Intake is out between two waypoints; it avoids obstacles too" },
];

const FIELD_TOOLS: typeof PATH_TOOLS = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V", tip: "Select, move and reshape obstacles." },
  { tool: "polygon", icon: Pentagon, label: "Polygon", key: "P", tip: "Click corners; click the first corner or press Enter to finish." },
  { tool: "circle", icon: Circle, label: "Circle", key: "C", tip: "Drag from the center to set the radius." },
];

function ConstraintMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const pending = useStore((s) => s.pending);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className={`tool ${pending ? "on" : ""}`} disabled={disabled} onClick={() => setOpen(!open)}
        title="Add a constraint (C)">
        <Waypoints size={16} /> {pending ? CONSTRAINT_LABELS[pending.type] : "Constraint"} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu">
          {CONSTRAINT_MENU.map(({ type, icon: Icon, hint }) => (
            <button key={type} className="menu-item" onClick={() => { useStore.getState().startConstraint(type); setOpen(false); }}>
              <Icon size={16} />
              <span><span className="menu-title">{CONSTRAINT_LABELS[type]}</span><span className="menu-hint">{hint}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toolstrip() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const showRed = useStore((s) => s.showRed);
  const hasTraj = useStore((s) => !!s.selectedTraj);
  const a = useStore.getState();
  const tools = view === "paths" ? PATH_TOOLS : FIELD_TOOLS;
  const locked = view === "paths" && (showRed || !hasTraj);
  return (
    <div className="toolstrip">
      {tools.map(({ tool: t, icon: Icon, label, key, tip }) => (
        <button key={t} className={`tool ${tool === t ? "on" : ""}`} onClick={() => a.setTool(t)}
          title={`${label} (${key}): ${tip}`} disabled={locked && t !== "select"}>
          <Icon size={16} /> {label}
        </button>
      ))}
      {view === "paths" && <><span className="divider-v" style={{ margin: "0 4px" }} /><ConstraintMenu disabled={locked} /><PoseVariablesPopover /></>}
      <div style={{ flex: 1 }} />
      {view === "paths" && (
        <div className="seg" title="Preview the path for each alliance">
          <button className={!showRed ? "on" : ""} onClick={() => a.setShowRed(false)}>
            <span className="dot" style={{ background: "var(--blue-alliance)", marginRight: 6 }} />Blue
          </button>
          <button className={showRed ? "on" : ""} onClick={() => a.setShowRed(true)}>
            <span className="dot" style={{ background: "var(--red-alliance)", marginRight: 6 }} />Red
          </button>
        </div>
      )}
    </div>
  );
}
