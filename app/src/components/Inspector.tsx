import { Flag, Trash2, Waypoints as WaypointsIcon } from "lucide-react";
import { useStore } from "../store";
import { CONSTRAINT_LABELS, applyWaypointKind, defaultConstraintData, newPoseVariable, resolveWaypoint, waypointKind } from "../model";
import type { Constraint, ConstraintType, Marker, Trajectory, Waypoint } from "../types";
import { AngleField, Card, Check, NumberField, Seg, SelectField, TextField } from "./ui";

export type Upd = (fn: (t: Trajectory) => void, history?: boolean) => void;

// ---------------------------------------------------------------- waypoints

export function wpLabel(w: Waypoint, i: number, n: number) {
  const kind = waypointKind(w);
  if (kind === "guide") return "Guide";
  const k = kind === "pose" ? "Pose" : "Translation";
  if (i === 0) return `${k} · start`;
  if (i === n - 1) return `${k} · end`;
  return w.stop ? `${k} · stop` : k;
}

export function WaypointEditor({ traj, index, upd }: { traj: Trajectory; index: number; upd: Upd }) {
  const poses = useStore((s) => s.project?.poses ?? []);
  const raw = traj.waypoints[index];
  const w = resolveWaypoint(poses, raw);
  const linked = raw.poseRef ? poses.find((p) => p.id === raw.poseRef) : undefined;
  const n = traj.waypoints.length;
  const kind = waypointKind(raw);
  const a = useStore.getState();
  const set = (fn: (w: Waypoint) => void) => upd((t) => fn(t.waypoints[index]));
  // Position/heading edits go to the linked pose variable (shared by every path using it).
  const setPose = (fn: (p: { x: number; y: number; heading: number }) => void) => {
    if (linked) a.updateProject((pr) => { const v = pr.poses.find((q) => q.id === linked.id); if (v) fn(v); });
    else set((x) => fn(x));
  };
  return (
    <Card title={<span style={{ display: "flex", gap: 8, alignItems: "center" }}><WaypointsIcon size={16} /> Waypoint {index + 1}</span>}
      actions={
        <button className="btn ghost sm icon danger" title="Delete waypoint (⌫)" onClick={() => {
          upd((t) => {
            t.waypoints.splice(index, 1);
            t.markers = t.markers.filter((m) => m.waypoint !== index);
            for (const m of t.markers) if (m.waypoint > index) m.waypoint -= 1;
            for (const c of t.constraints) {
              if (c.scope.from > index) c.scope.from -= 1;
              if (c.scope.to >= index) c.scope.to = Math.max(0, c.scope.to - 1);
            }
          });
          a.select(null);
        }}><Trash2 size={14} /></button>
      }>
      <div className="form">
        <Seg value={kind} onChange={(k) => set((x) => applyWaypointKind(x, k))}
          options={[{ value: "pose", label: "Pose" }, { value: "translation", label: "Translation" }, { value: "guide", label: "Guide" }]} />
        <div className="field-row">
          <NumberField label="X" unit="m" value={w.x} onChange={(v) => setPose((p) => { p.x = v; })} />
          <NumberField label="Y" unit="m" value={w.y} onChange={(v) => setPose((p) => { p.y = v; })} />
        </div>
        {kind === "pose" && (
          <div className="field-row">
            <AngleField label="Heading" value={w.heading} onChange={(v) => setPose((p) => { p.heading = v; })} />
            <AngleField label="Heading tolerance" value={w.headingTolerance} onChange={(v) => set((x) => { x.headingTolerance = Math.max(0, v); })} />
          </div>
        )}
        {kind !== "guide" && (
          <>
            <div className="lbl"><span>Pose variable</span>
              <div style={{ display: "flex", gap: 6 }}>
                <SelectField value={raw.poseRef ?? ""} onChange={(v) => set((x) => { x.poseRef = v || null; })}
                  options={[{ value: "", label: "Not linked" }, ...poses.map((p) => ({ value: p.id, label: p.name }))]} />
                {!linked && (
                  <button className="btn" title="Save this position as a variable other paths can use" onClick={() => {
                    const v = newPoseVariable(`Pose ${poses.length + 1}`, w.x, w.y, w.heading);
                    a.updateProject((pr) => { pr.poses = [...(pr.poses ?? []), v]; });
                    set((x) => { x.poseRef = v.id; });
                  }}>Save as</button>
                )}
              </div>
            </div>
            {linked && <div className="note">Moving this waypoint moves <b>{linked.name}</b> in every path that uses it.</div>}
            <label className="lbl"><span>Position tolerance</span>
              <Seg value={w.tolerance.kind} onChange={(v) => set((x) => { x.tolerance.kind = v; })}
                options={[{ value: "none", label: "Exact" }, { value: "circle", label: "Circle" }, { value: "box", label: "Box" }]} />
            </label>
            {w.tolerance.kind === "circle" && (
              <NumberField label="Radius" unit="m" value={w.tolerance.radius} min={0} onChange={(v) => set((x) => { x.tolerance.radius = v; })} />
            )}
            {w.tolerance.kind === "box" && (
              <div className="field-row">
                <NumberField label="± X" unit="m" value={w.tolerance.dx} min={0} onChange={(v) => set((x) => { x.tolerance.dx = v; })} />
                <NumberField label="± Y" unit="m" value={w.tolerance.dy} min={0} onChange={(v) => set((x) => { x.tolerance.dy = v; })} />
              </div>
            )}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Check label="Stop here" checked={w.stop || index === 0} disabled={index === 0}
                onChange={(v) => set((x) => { x.stop = v; })} />
              <Check label="Split here" checked={w.split} disabled={index === 0 || index === n - 1}
                onChange={(v) => set((x) => { x.split = v; })} />
            </div>
          </>
        )}
        {kind === "guide" && <div className="note">A guide point only shapes the route (e.g. which side of the hub to pass). The path doesn't have to hit it exactly.</div>}
      </div>
    </Card>
  );
}

export function PoseVariableEditor({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const trajectories = useStore((s) => s.trajectories);
  const v = project.poses?.find((p) => p.id === id);
  const a = useStore.getState();
  if (!v) return null;
  const set = (fn: (p: { name: string; x: number; y: number; heading: number }) => void) =>
    a.updateProject((pr) => { const q = pr.poses.find((x) => x.id === id); if (q) fn(q); });
  const users = Object.values(trajectories).filter((t) => t.waypoints.some((w) => w.poseRef === id)).map((t) => t.name);
  return (
    <Card title="Pose variable" actions={
      <button className="btn ghost sm icon danger" title="Delete variable" onClick={() => {
        a.updateProject((pr) => { pr.poses = pr.poses.filter((x) => x.id !== id); });
        // waypoints that used it keep their last position
        for (const t of Object.values(trajectories)) {
          if (t.waypoints.some((w) => w.poseRef === id)) {
            a.updateTraj(t.name, (d) => { for (const w of d.waypoints) if (w.poseRef === id) { w.x = v.x; w.y = v.y; w.heading = v.heading; w.poseRef = null; } });
          }
        }
        a.select(null);
      }}><Trash2 size={14} /></button>
    }>
      <div className="form">
        <TextField label="Name" value={v.name} onChange={(val) => set((p) => { p.name = val || p.name; })} />
        <div className="field-row">
          <NumberField label="X" unit="m" value={v.x} onChange={(val) => set((p) => { p.x = val; })} />
          <NumberField label="Y" unit="m" value={v.y} onChange={(val) => set((p) => { p.y = val; })} />
        </div>
        <AngleField label="Heading" value={v.heading} onChange={(val) => set((p) => { p.heading = val; })} />
        <div className="note">{users.length ? <>Used by: {users.join(", ")}</> : "Not used yet. Link it from a waypoint's panel."}</div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- constraints

export function scopeText(c: Constraint) {
  if (c.scope.kind === "zone") return "inside zone";
  if (c.scope.kind === "waypoint") return `at waypoint ${c.scope.from + 1}`;
  return `waypoints ${c.scope.from + 1}–${c.scope.to + 1}`;
}

export function constraintValue(c: Constraint) {
  const d = c.data;
  if (d.type === "maxVelocity") return `${d.value} m/s`;
  if (d.type === "maxAcceleration") return `${d.value} m/s²`;
  if (d.type === "maxAngularVelocity") return `${d.value} rad/s`;
  if (d.type === "pointAt") return `(${d.x.toFixed(2)}, ${d.y.toFixed(2)})`;
  if (d.type === "straightLine") return `±${(d.tolerance * 100).toFixed(0)} cm`;
  if (d.type === "roughTerrain") return "bump zone";
  return `${d.points.length} pts`;
}

export function ConstraintEditor({ traj, c, upd }: { traj: Trajectory; c: Constraint; upd: Upd }) {
  const set = (fn: (c: Constraint) => void) => upd((t) => { const x = t.constraints.find((y) => y.id === c.id); if (x) fn(x); });
  const n = traj.waypoints.length;
  const wpOpts = traj.waypoints.map((_, i) => ({ value: i, label: `Waypoint ${i + 1}` }));
  const d = c.data;
  const regionOnly = d.type === "keepOut" || d.type === "keepIn" || d.type === "roughTerrain";
  const rangeOnly = d.type === "straightLine";
  return (
    <Card title={CONSTRAINT_LABELS[d.type]}
      actions={
        <button className="btn sm icon danger" title="Delete constraint" onClick={() => {
          upd((t) => { t.constraints = t.constraints.filter((x) => x.id !== c.id); });
          useStore.getState().select(null);
        }}><Trash2 size={14} /></button>
      }>
      <div className="form">
        <SelectField label="Type" value={d.type}
          onChange={(v) => set((x) => {
            x.data = defaultConstraintData(v, d.type === "pointAt" ? [d.x, d.y] : undefined);
            if (v === "roughTerrain" && x.scope.kind !== "zone") {
              const w = traj.waypoints[Math.min(x.scope.from, n - 1)] ?? { x: 8, y: 4 };
              x.scope.kind = "zone";
              x.scope.region = d.type === "keepIn" || d.type === "keepOut" ? d.points.map(([a, b]) => [a, b])
                : [[w.x - 1, w.y - 1], [w.x + 1, w.y - 1], [w.x + 1, w.y + 1], [w.x - 1, w.y + 1]];
            } else if ((v === "keepIn" || v === "keepOut") && x.scope.kind === "zone") {
              if (x.data.type === "keepIn" || x.data.type === "keepOut") {
                x.data.points = x.scope.region.map(([a, b]) => [a, b]);
              }
              x.scope.kind = "range";
            }
          })}
          options={(Object.keys(CONSTRAINT_LABELS) as ConstraintType[]).map((k) => ({ value: k, label: CONSTRAINT_LABELS[k] }))} />
        {(d.type === "maxVelocity" || d.type === "maxAcceleration" || d.type === "maxAngularVelocity") && (
          <NumberField label="Limit" value={d.value} min={0.01}
            unit={d.type === "maxVelocity" ? "m/s" : d.type === "maxAcceleration" ? "m/s²" : "rad/s"}
            onChange={(v) => set((x) => { if ("value" in x.data) x.data.value = v; })} />
        )}
        {d.type === "pointAt" && (
          <>
            <div className="field-row">
              <NumberField label="Target X" unit="m" value={d.x} onChange={(v) => set((x) => { if (x.data.type === "pointAt") x.data.x = v; })} />
              <NumberField label="Target Y" unit="m" value={d.y} onChange={(v) => set((x) => { if (x.data.type === "pointAt") x.data.y = v; })} />
            </div>
            <AngleField label="Tolerance" value={d.tolerance} onChange={(v) => set((x) => { if (x.data.type === "pointAt") x.data.tolerance = Math.max(0.001, v); })} />
            <Check label="Face away (shoot backward)" checked={d.flip} onChange={(v) => set((x) => { if (x.data.type === "pointAt") x.data.flip = v; })} />
          </>
        )}
        {d.type === "straightLine" && (
          <NumberField label="Allowed distance from the line" unit="m" value={d.tolerance} min={0.001} step={0.005}
            onChange={(v) => set((x) => { if (x.data.type === "straightLine") x.data.tolerance = v; })} />
        )}
        {d.type === "roughTerrain" && (
          <>
            <div className="note">The solver keeps its planned speed. On the robot, collision recovery pauses, the path clock follows progress, and correction softens. Vision trust rises just after the zone.</div>
            <NumberField label="Expected speed fraction" value={d.expectedSpeed} min={0.01} max={1} step={0.05}
              hint="For estimated delay only; does not cap planned speed."
              onChange={(v) => set((x) => { if (x.data.type === "roughTerrain") x.data.expectedSpeed = v; })} />
            <NumberField label="Correction strength" value={d.feedbackScale} min={0} max={1} step={0.05}
              hint="0 = no correction in the zone; 1 = normal correction."
              onChange={(v) => set((x) => { if (x.data.type === "roughTerrain") x.data.feedbackScale = v; })} />
            <div className="note">Drag the amber region or its corners on the field.</div>
          </>
        )}
        {d.type === "keepOut" && (
          <NumberField label="Margin" unit="m" value={d.margin} min={0} onChange={(v) => set((x) => { if (x.data.type === "keepOut") x.data.margin = v; })} />
        )}
        {(d.type === "keepOut" || d.type === "keepIn") && <div className="muted" style={{ fontSize: 12 }}>Drag the region or its corners on the field.</div>}
        {!regionOnly && (
          <>
            {!rangeOnly && <label className="lbl"><span>Applies</span>
              <Seg value={c.scope.kind} onChange={(v) => set((x) => {
                x.scope.kind = v;
                if (v === "zone" && x.scope.region.length < 3) {
                  const w = traj.waypoints[Math.min(x.scope.from, n - 1)] ?? { x: 8, y: 4 };
                  x.scope.region = [[w.x - 1, w.y - 1], [w.x + 1, w.y - 1], [w.x + 1, w.y + 1], [w.x - 1, w.y + 1]];
                }
              })}
                options={[{ value: "waypoint", label: "At waypoint" }, { value: "range", label: "Between" }, { value: "zone", label: "In zone" }]} />
            </label>}
            {c.scope.kind !== "zone" && n > 0 && (
              <div className={c.scope.kind === "range" ? "field-row" : ""}>
                <SelectField label={c.scope.kind === "range" ? "From" : "Waypoint"} value={Math.min(c.scope.from, n - 1)} options={wpOpts}
                  onChange={(v) => set((x) => { x.scope.from = v; if (x.scope.to < v) x.scope.to = v; })} />
                {c.scope.kind === "range" && (
                  <SelectField label="To" value={Math.min(c.scope.to, n - 1)} options={wpOpts}
                    onChange={(v) => set((x) => { x.scope.to = v; if (x.scope.from > v) x.scope.from = v; })} />
                )}
              </div>
            )}
            {c.scope.kind === "zone" && <div className="muted" style={{ fontSize: 12 }}>Drag the amber zone or its corners on the field.</div>}
          </>
        )}
        <Check label="Enabled" checked={c.enabled} onChange={(v) => set((x) => { x.enabled = v; })} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- markers

export function MarkerEditor({ traj, m, upd }: { traj: Trajectory; m: Marker; upd: Upd }) {
  const commands = useStore((s) => s.project?.commands ?? []);
  const set = (fn: (m: Marker) => void) => upd((t) => { const x = t.markers.find((y) => y.id === m.id); if (x) fn(x); });
  const wpOpts = traj.waypoints.map((_, i) => ({ value: i, label: `Waypoint ${i + 1}` }));
  return (
    <Card title={<span style={{ display: "flex", gap: 8, alignItems: "center" }}><Flag size={16} /> Event marker</span>}
      actions={
        <button className="btn sm icon danger" title="Delete marker" onClick={() => {
          upd((t) => { t.markers = t.markers.filter((x) => x.id !== m.id); });
          useStore.getState().select(null);
        }}><Trash2 size={14} /></button>
      }>
      <div className="form">
        <TextField label="Name" value={m.name} onChange={(v) => set((x) => { x.name = v || "event"; })} />
        <label className="lbl"><span>Command (bound in robot code)</span>
          <input className="input" list="mayhem-commands" value={m.command} placeholder={m.name}
            onChange={(e) => set((x) => { x.command = e.target.value; })} onKeyDown={(e) => e.stopPropagation()} />
          <datalist id="mayhem-commands">{commands.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <div className="field-row">
          <SelectField label="At" value={m.waypoint} options={wpOpts} onChange={(v) => set((x) => { x.waypoint = v; })} />
          <NumberField label="Offset" unit="s" value={m.offset} step={0.05} onChange={(v) => set((x) => { x.offset = v; })} />
        </div>
        <Check label="Zone (active until an end point)" checked={m.endWaypoint !== null}
          onChange={(v) => set((x) => { x.endWaypoint = v ? Math.min(x.waypoint + 1, traj.waypoints.length - 1) : null; })} />
        {m.endWaypoint !== null && (
          <div className="field-row">
            <SelectField label="Until" value={m.endWaypoint} options={wpOpts} onChange={(v) => set((x) => { x.endWaypoint = v; })} />
            <NumberField label="Offset" unit="s" value={m.endOffset} step={0.05} onChange={(v) => set((x) => { x.endOffset = v; })} />
          </div>
        )}
        <SelectField label="If bump recovery skips it" value={m.recoveryPolicy}
          onChange={(v) => set((x) => { x.recoveryPolicy = v; })}
          options={[
            { value: "fireAtJoin", label: "Fire when rejoining" },
            { value: "fireImmediately", label: "Fire immediately" },
            { value: "skip", label: "Skip it" },
          ]} />
        <Check label="Must hit (recovery can't jump past it)" checked={m.mustHit} onChange={(v) => set((x) => { x.mustHit = v; })} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- settings

export function SolverSettingsEditor({ traj, upd }: { traj: Trajectory; upd: Upd }) {
  const s = traj.settings;
  const set = (fn: (t: Trajectory) => void) => upd(fn);
  return (
    <div className="form">
      <NumberField label="Target sample spacing" unit="s" value={s.targetDt} min={0.02} max={0.3} step={0.01}
        onChange={(v) => set((t) => { t.settings.targetDt = v; })} />
      <NumberField label="Smoothing" value={s.smoothing} min={0} max={1} step={0.01}
        hint={<span className="mono">0 = raw time-optimal</span>}
        onChange={(v) => set((t) => { t.settings.smoothing = v; })} />
      <NumberField label="Route candidates" value={s.candidates} min={1} max={6} step={1} digits={0}
        hint={<span className="mono">tried in parallel</span>}
        onChange={(v) => set((t) => { t.settings.candidates = Math.round(v); })} />
      <div className="field-row">
        <NumberField label="Time limit" unit="s" value={s.timeLimit} min={5} max={600} step={5} digits={0}
          onChange={(v) => set((t) => { t.settings.timeLimit = v; })} />
        <NumberField label="Max iterations" value={s.maxIterations} min={100} step={100} digits={0}
          onChange={(v) => set((t) => { t.settings.maxIterations = Math.round(v); })} />
      </div>
    </div>
  );
}
