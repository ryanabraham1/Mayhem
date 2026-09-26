import { useState } from "react";
import { Copy, FlipHorizontal2, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { centroid, flipPoint, uid } from "../model";
import type { Field, Obstacle } from "../types";
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
