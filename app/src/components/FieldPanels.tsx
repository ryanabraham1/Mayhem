import { useState } from "react";
import { Copy, FlipHorizontal2, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { centroid, flipPoint, uid } from "../model";
import type { Field, FuelCollision, Obstacle } from "../types";
import { Card, Check, NumberField, Seg, SelectField, TextField } from "./ui";

export function ObstacleEditor({ o, field }: { o: Obstacle; field: Field }) {
  const a = useStore.getState();
  const set = (fn: (o: Obstacle) => void) => a.updateProject((p) => { const x = p.field.obstacles.find((y) => y.id === o.id); if (x) fn(x); });
  const flipName = (n: string) => n.includes("Blue") ? n.replace("Blue", "Red") : n.includes("Red") ? n.replace("Red", "Blue") : `${n} (other alliance)`;
  return (
    <Card title="Obstacle" actions={
      <div style={{ display: "flex", gap: 2 }}>
        <button className="btn ghost icon sm" title="Duplicate" onClick={() => {
          const c = { ...structuredClone(o), id: uid("o"), name: `${o.name} copy` };
          c.points = c.points.map(([x, y]) => [x + 0.3, y - 0.3]);
          c.center = [c.center[0] + 0.3, c.center[1] - 0.3];
          a.updateProject((p) => { p.field.obstacles.push(c); });
          a.select({ kind: "obstacle", id: c.id });
        }}><Copy size={14} /></button>
        <button className="btn ghost icon sm" title="Copy to the other alliance (uses field symmetry)" onClick={() => {
          const c: Obstacle = { ...structuredClone(o), id: uid("o"), name: flipName(o.name) };
          c.points = o.points.map((p) => flipPoint(field, p));
          c.center = flipPoint(field, o.center);
          a.updateProject((p) => { p.field.obstacles.push(c); });
          a.select({ kind: "obstacle", id: c.id });
        }}><FlipHorizontal2 size={14} /></button>
        <button className="btn ghost icon sm danger" title="Delete" onClick={() => {
          a.updateProject((p) => { p.field.obstacles = p.field.obstacles.filter((x) => x.id !== o.id); });
          a.select(null);
        }}><Trash2 size={14} /></button>
      </div>
    }>
      <div className="form">
        <TextField label="Name" value={o.name} onChange={(v) => set((x) => { x.name = v; })} />
        <NumberField label="Clearance margin" unit="m" value={o.margin} min={0} onChange={(v) => set((x) => { x.margin = v; })} />
        {o.kind === "circle" ? (
          <>
            <div className="field-row">
              <NumberField label="Center X" unit="m" value={o.center[0]} onChange={(v) => set((x) => { x.center = [v, x.center[1]]; })} />
              <NumberField label="Center Y" unit="m" value={o.center[1]} onChange={(v) => set((x) => { x.center = [x.center[0], v]; })} />
            </div>
            <NumberField label="Radius" unit="m" value={o.radius} min={0.02} onChange={(v) => set((x) => { x.radius = v; })} />
          </>
        ) : (
          <div className="note">
            {o.points.length} corners, centered at <span className="mono">{centroid(o.points).map((v) => v.toFixed(2)).join(", ")}</span>.
            Drag corners on the field; double-click an edge to add one; ⇧-click a corner to remove it.
          </div>
        )}
        <Check label="Enabled (paths must avoid it)" checked={o.enabled} onChange={(v) => set((x) => { x.enabled = v; })} />
        <Check label="Rough terrain on every path" checked={!!o.terrain}
          onChange={(v) => set((x) => {
            if (v) { x.terrain = { expectedSpeed: 0.7, feedbackScale: 0.3 }; x.enabled = false; } // terrain is driven over
            else delete x.terrain;
          })} />
        {o.terrain && (
          <>
            <div className="note">
              Every path gets a rough-terrain span wherever the robot center crosses this shape, so you don't draw a zone per path.
              The solver keeps its planned speed; on the robot, collision recovery pauses, the path clock follows progress, and correction softens.
              {o.enabled && <> <b>Enabled</b> is on, so paths avoid this shape and never cross it; turn it off to drive over it.</>}
            </div>
            <NumberField label="Expected speed fraction" value={o.terrain.expectedSpeed} min={0.01} max={1} step={0.05}
              hint="For estimated delay only; does not cap planned speed."
              onChange={(v) => set((x) => { if (x.terrain) x.terrain.expectedSpeed = v; })} />
            <NumberField label="Correction strength" value={o.terrain.feedbackScale} min={0} max={1} step={0.05}
              hint="0 = no correction on the terrain; 1 = normal correction."
              onChange={(v) => set((x) => { if (x.terrain) x.terrain.feedbackScale = v; })} />
          </>
        )}
        <SelectField<FuelCollision> label="Fuel sim" value={o.fuelCollision ?? "paths"}
          onChange={(v) => a.updateProject((p) => { const x = p.field.obstacles.find((y) => y.id === o.id); if (x) x.fuelCollision = v; }, { affectsSolve: false })}
          options={[
            { value: "paths", label: o.enabled ? "Same as paths (blocks fuel)" : "Same as paths (fuel passes)" },
            { value: "block", label: "Blocks fuel" },
            { value: "pass", label: "Fuel passes through" },
          ]} />
        <div className="note">Only affects the fuel sim. E.g. a bump robots drive over but fuel can't roll across: leave it disabled and pick <b>Blocks fuel</b>.</div>
      </div>
    </Card>
  );
}

export function FieldSettingsPanel() {
  const field = useStore((s) => s.project!.field);
  const fields = useStore((s) => s.fields);
  const a = useStore.getState();
  const [preset, setPreset] = useState(fields[0]?.id ?? "");
  const upd = (fn: (f: Field) => void) => a.updateProject((p) => fn(p.field));
  return (
    <Card title="Field">
      <div className="form">
        <TextField label="Name" value={field.name} onChange={(v) => upd((f) => { f.name = v; })} />
        <div className="field-row">
          <NumberField label="Length" unit="m" value={field.length} min={1} onChange={(v) => upd((f) => { f.length = v; })} />
          <NumberField label="Width" unit="m" value={field.width} min={1} onChange={(v) => upd((f) => { f.width = v; })} />
        </div>
        <label className="lbl"><span>Red alliance flip</span>
          <Seg value={field.symmetry} onChange={(v) => upd((f) => { f.symmetry = v; })}
            options={[{ value: "rotational", label: "Rotate 180°" }, { value: "mirror", label: "Mirror" }]} />
        </label>
        <NumberField label="Wall clearance" unit="m" value={field.wallMargin} min={0} onChange={(v) => upd((f) => { f.wallMargin = v; })} />
        {field.notes && <div className="note">{field.notes}</div>}
        <div className="lbl"><span>Replace with a preset</span>
          <div style={{ display: "flex", gap: 6 }}>
            <SelectField value={preset} onChange={setPreset} options={fields.map((f) => ({ value: f.id, label: f.name }))} />
            <button className="btn" onClick={() => {
              const f = fields.find((x) => x.id === preset);
              if (f && window.confirm(`Replace this project's field with "${f.name}"? (Undo is available.)`)) {
                a.updateProject((p) => { p.field = structuredClone(f); });
              }
            }}>Load</button>
          </div>
        </div>
      </div>
    </Card>
  );
}
