import { Ban, Circle, CircleDot, Crosshair, MapPin, MousePointer2, Pentagon, Sparkles, SquareDashed } from "lucide-react";
import { useStore, type Tool } from "../store";

const PATH_TOOLS: { tool: Tool; icon: typeof MapPin; label: string; key: string; tip: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V", tip: "Select and drag. Drag empty space to pan, scroll to zoom." },
  { tool: "waypoint", icon: MapPin, label: "Waypoint", key: "W", tip: "Click the field to add a waypoint (near the path it is inserted between neighbors)." },
  { tool: "guide", icon: CircleDot, label: "Guide point", key: "G", tip: "A point that only shapes the route, it is not a constraint." },
  { tool: "pointAt", icon: Crosshair, label: "Point at", key: "P", tip: "Keep the robot facing a target (e.g. the hub)." },
  { tool: "zone", icon: SquareDashed, label: "Speed zone", key: "Z", tip: "Draw a region with a speed limit." },
  { tool: "keepOut", icon: Ban, label: "Keep out", key: "K", tip: "Draw a region only this path must avoid." },
];

const FIELD_TOOLS: typeof PATH_TOOLS = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V", tip: "Select, move and reshape obstacles." },
  { tool: "polygon", icon: Pentagon, label: "Polygon", key: "P", tip: "Click corners; click the first corner or press Enter to finish." },
  { tool: "circle", icon: Circle, label: "Circle", key: "C", tip: "Drag from the center to set the radius." },
];

export function Toolstrip() {
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const showRed = useStore((s) => s.showRed);
  const autoSolve = useStore((s) => s.autoSolve);
  const a = useStore.getState();
  const tools = view === "paths" ? PATH_TOOLS : FIELD_TOOLS;
  return (
    <div className="toolstrip">
      {tools.map(({ tool: t, icon: Icon, label, key, tip }) => (
        <button key={t} className={`tool ${tool === t ? "on" : ""}`} onClick={() => a.setTool(t)}
          title={`${label} (${key}): ${tip}`} disabled={view === "paths" && showRed && t !== "select"}>
          <Icon size={16} /> {label}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {view === "paths" && (
        <>
          <button className={`tool ${autoSolve ? "on" : ""}`} onClick={() => a.setAutoSolve(!autoSolve)} title="Regenerate automatically after each edit">
            <Sparkles size={16} /> Auto-generate
          </button>
          <div className="seg" title="Preview the path for each alliance">
            <button className={!showRed ? "on" : ""} onClick={() => a.setShowRed(false)}>
              <span className="dot" style={{ background: "var(--blue-alliance)", marginRight: 6 }} />Blue
            </button>
            <button className={showRed ? "on" : ""} onClick={() => a.setShowRed(true)}>
              <span className="dot" style={{ background: "var(--red-alliance)", marginRight: 6 }} />Red
            </button>
          </div>
        </>
      )}
    </div>
  );
}
