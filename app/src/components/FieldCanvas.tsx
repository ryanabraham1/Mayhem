import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  applyWaypointKind, centroid, circlePoints, deleteWaypoint, distToSegment, footprint, intakeFootprint, intakeWaypoints, newConstraint, newObstacle, newWaypoint, resolveWaypoint,
  obstaclePoints, pointInPolygon, sampleAt, totalTime,
} from "../model";
import type { Constraint, Decoration, Field, FuelSimConfig, Obstacle, RobotConfig, SimRobot, Trajectory, TrajectoryOutput, Vec2 } from "../types";
import { blocksFuel, DEFAULT_FUEL_SIM, simRobotPathD, simRobotPose, simRobotTrack, type FuelSim, type SimTrack } from "../fuelsim";
import { useFuelSim } from "../useFuelSim";

type Mode = "path" | "field";

interface View { x: number; y: number; w: number; h: number } // viewBox in screen-oriented meters

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "waypoint"; index: number; dx: number; dy: number }
  | { kind: "heading"; index: number }
  | { kind: "obstacle"; id: string; last: Vec2 }
  | { kind: "vertex"; id: string; vi: number }
  | { kind: "radius"; id: string }
  | { kind: "circle-new"; center: Vec2 }
  | { kind: "pointAt"; id: string }
  | { kind: "region"; id: string; last: Vec2 }
  | { kind: "regionVertex"; id: string; vi: number }
  | { kind: "simPoint"; id: string; vi: number }
  | { kind: "simRobot"; id: string; last: Vec2 };

const speedColor = (u: number) => {
  // Choreo-style: red (slow) -> yellow -> green (fast), interpolated by hue
  const t = Math.max(0, Math.min(1, u));
  return `hsl(${Math.round(t * 120)}, 85%, 45%)`;
};

type RegionKind = "zone" | "in" | "out";

/** The polygon a constraint draws on the field (zone scope, keep-in or keep-out), if any. */
function constraintRegion(c: Constraint): { id: string; poly: Vec2[]; kind: RegionKind } | null {
  if (c.scope.kind === "zone" && c.scope.region.length >= 3) return { id: c.id, poly: c.scope.region, kind: "zone" };
  if (c.data.type === "keepOut") return { id: c.id, poly: c.data.points, kind: "out" };
  if (c.data.type === "keepIn") return { id: c.id, poly: c.data.points, kind: "in" };
  return null;
}

const regionColor = (kind: RegionKind) => (kind === "out" ? "var(--red)" : kind === "in" ? "var(--green)" : "var(--amber)");

const pts = (p: Vec2[]) => p.map(([x, y]) => `${x},${y}`).join(" ");

const DECO_STYLE: Record<string, { fill?: string; stroke?: string; op?: number }> = {
  blueZone: { fill: "var(--blue-alliance)", op: 0.045 },
  redZone: { fill: "var(--red-alliance)", op: 0.045 },
  tape: { stroke: "var(--field-line)" },
  blueTape: { stroke: "var(--blue-alliance)", op: 0.7 },
  redTape: { stroke: "var(--red-alliance)", op: 0.7 },
  fuel: { fill: "#e3b341", op: 0.22 },
  structure: { fill: "var(--structure)", stroke: "var(--structure-stroke)" },
  blue: { fill: "var(--blue-alliance)", stroke: "var(--blue-alliance)", op: 0.12 },
  red: { fill: "var(--red-alliance)", stroke: "var(--red-alliance)", op: 0.12 },
};

const FieldArt = memo(function FieldArt({ field, hideFuel }: { field: Field; hideFuel?: boolean }) {
  const d = (field.decorations ?? []).filter((x) => !(hideFuel && x.style === "fuel"));
  const draw = (dec: Decoration, i: number) => {
    const st = DECO_STYLE[dec.style] ?? {};
    if (dec.kind === "circle")
      return <circle key={i} cx={dec.center[0]} cy={dec.center[1]} r={dec.radius} fill={st.fill} opacity={st.op} />;
    if (dec.kind === "line")
      return <polyline key={i} points={pts(dec.points)} stroke={st.stroke ?? st.fill} strokeWidth={dec.width} opacity={st.op} fill="none" />;
    return (
      <polygon key={i} points={pts(dec.points)} fill={st.fill ?? "none"} fillOpacity={st.op ?? 1} stroke={st.stroke}
        strokeWidth={1} vectorEffect="non-scaling-stroke" strokeOpacity={st.stroke ? 0.9 : 0} />
    );
  };
  return (
    <g>
      <rect x={0} y={0} width={field.length} height={field.width} fill="var(--carpet)" />
      {d.filter((x) => x.style.endsWith("Zone")).map(draw)}
      {d.filter((x) => !x.style.endsWith("Zone")).map(draw)}
      <rect x={0} y={0} width={field.length} height={field.width} fill="none" stroke="var(--border-strong)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </g>
  );
});

function RobotShape({ robot, x, y, h, stroke, fill = "none", dash, width = 1.5, opacity = 1 }: {
  robot: RobotConfig; x: number; y: number; h: number; stroke: string; fill?: string; dash?: string; width?: number; opacity?: number;
}) {
  const fp = footprint(robot, x, y, h);
  const b = robot.bumper;
  const c = Math.cos(h), s = Math.sin(h);
  const front: Vec2 = [x + c * b.front * 0.95, y + s * b.front * 0.95];
  return (
    <g opacity={opacity} pointerEvents="none">
      <polygon points={pts(fp)} fill={fill} stroke={stroke} strokeWidth={width} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
      <line x1={x} y1={y} x2={front[0]} y2={front[1]} stroke={stroke} strokeWidth={width} vectorEffect="non-scaling-stroke" />
      <polyline points={pts([fp[3], front, fp[0]])} fill="none" stroke={stroke} strokeWidth={width * 1.6} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** Playback robot: translucent rounded body, bold front bumper, and a chevron pointing forward. */
function PlaybackRobot({ robot, x, y, h }: { robot: RobotConfig; x: number; y: number; h: number }) {
  const { front: f, back: bk, left: l, right: r } = robot.bumper;
  const k = Math.min(f + bk, l + r);
  const rx = k * 0.14;
  const tip = f - k * 0.22, d = k * 0.13, w = k * 0.19;
  const line = { fill: "none", stroke: "var(--accent)", strokeLinecap: "round", strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" } as const;
  return (
    <g transform={`translate(${x} ${y}) rotate(${(h * 180) / Math.PI})`}>
      <rect x={-bk} y={-r} width={f + bk} height={l + r} rx={rx} fill="var(--accent)" fillOpacity={0.22}
        stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <path d={`M ${f - rx} ${-r} A ${rx} ${rx} 0 0 1 ${f} ${-r + rx} L ${f} ${l - rx} A ${rx} ${rx} 0 0 1 ${f - rx} ${l}`} {...line} strokeWidth={5} />
      <polyline points={`${tip - d},${w} ${tip},0 ${tip - d},${-w}`} {...line} strokeWidth={2.5} />
    </g>
  );
}

/**
 * Simulated fuel, drawn on a canvas between the field art and the interactive SVG: repainting
 * hundreds of moving SVG circles every frame is slow, especially in WebKit. It follows playback
 * through a store subscription, so the field itself doesn't re-render per frame. `frame` is the SVG
 * group the fuel lives in; its screen transform (view, zoom, red flip) maps field meters to pixels.
 */
function FuelCanvas({ sim, frame, viewKey }: { sim: FuelSim; frame: React.RefObject<SVGGElement | null>; viewKey: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const m = frame.current?.getScreenCTM();
      if (!m) return;
      const box = cv.getBoundingClientRect();
      ctx.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * (m.e - box.left), dpr * (m.f - box.top));
      const t = Math.min(useStore.getState().playback.t, sim.duration);
      const f = Math.max(0, Math.min(sim.frames - 1, t / sim.frameDt));
      const a = Math.floor(f), u = f - a;
      const oa = a * sim.n * 2, ob = Math.min(sim.frames - 1, a + 1) * sim.n * 2;
      const P = sim.pos, r = sim.radius;
      ctx.beginPath();
      for (let i = 0; i < sim.n; i++) {
        if (sim.takenAt[i] <= t) continue; // intaken
        const x = P[oa + 2 * i] + (P[ob + 2 * i] - P[oa + 2 * i]) * u;
        const y = P[oa + 2 * i + 1] + (P[ob + 2 * i + 1] - P[oa + 2 * i + 1]) * u;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fillStyle = "rgba(227, 179, 65, 0.85)";
      ctx.fill();
      ctx.lineWidth = 0.012;
      ctx.strokeStyle = "#b8860b";
      ctx.stroke();
    };
    draw();
    const unsub = useStore.subscribe((st, prev) => { if (st.playback.t !== prev.playback.t) draw(); });
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => { unsub(); ro.disconnect(); };
  }, [sim, frame, viewKey]);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}

const allianceColor = (a: SimRobot["alliance"]) => (a === "blue" ? "var(--blue-alliance)" : "var(--red-alliance)");
// In the red preview we're red, so allies are drawn red and opponents blue.
const simColor = (r: SimRobot, red: boolean) => allianceColor(red === (r.alliance === "blue") ? "red" : "blue");

/** Another robot's auto curve. Clicking it selects the robot; drag its body or points to edit. */
function SimRobotPath({ robot: r, selected, interactive, red }: { robot: SimRobot; selected: boolean; interactive: boolean; red: boolean }) {
  const color = simColor(r, red);
  const d = simRobotPathD(r.points);
  return (
    <g opacity={r.enabled ? 1 : 0.35} data-h={interactive ? `sl:${r.id}` : undefined} style={{ cursor: interactive ? "pointer" : undefined }}>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.12} strokeWidth={14} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.4 : 1.6} strokeDasharray="6 4" strokeOpacity={0.85} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** The other robots where they are at the playback time (re-renders per frame on its own). */
function SimRobotBodies({ tracks, selectedId, interactive, red }: { tracks: SimTrack[]; selectedId: string | null; interactive: boolean; red: boolean }) {
  const t = useStore((s) => s.playback.t);
  return (
    <>
      {tracks.map((track) => {
        const r = track.robot;
        const color = simColor(r, red);
        const q = simRobotPose(track, t);
        const h = r.size / 2;
        const selected = r.id === selectedId;
        const driving = t >= r.startDelay && t <= r.startDelay + track.driveTime;
        return (
          <g key={r.id} opacity={r.enabled ? 1 : 0.35} transform={`translate(${q.x} ${q.y}) rotate(${(q.heading * 180) / Math.PI})`}
            data-h={interactive ? `sr:${r.id}` : undefined} style={{ cursor: interactive ? (selected ? "move" : "pointer") : undefined }}>
            {r.intake && driving && (
              <rect x={h} y={-h} width={0.25} height={2 * h} fill="var(--amber)" fillOpacity={0.5} stroke="var(--amber)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            )}
            <rect x={-h} y={-h} width={2 * h} height={2 * h} rx={h * 0.2} fill={color} fillOpacity={0.3} stroke={color}
              strokeWidth={selected ? 2.5 : 1.8} vectorEffect="non-scaling-stroke" />
            <polyline points={`${h * 0.35},${h * 0.4} ${h * 0.75},0 ${h * 0.35},${-h * 0.4}`} fill="none" stroke={color} strokeWidth={2.2}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </>
  );
}

/** Our robot at the playback time; module forces only while paused/scrubbing. */
function PlaybackGhost({ out, robot, pxToM }: { out: TrajectoryOutput; robot: RobotConfig; pxToM: number }) {
  const t = useStore((s) => s.playback.t);
  const playing = useStore((s) => s.playback.playing);
  const T = totalTime(out);
  if (!(T > 0)) return null;
  const ghost = sampleAt(out, Math.min(t, T));
  const intakeOut = out.intake?.some((sp) => ghost.t >= sp.t - 1e-6 && ghost.t <= sp.endT + 1e-6);
  const c = Math.cos(ghost.heading), s = Math.sin(ghost.heading);
  return (
    <g pointerEvents="none">
      {intakeOut && (
        <polygon points={pts(intakeFootprint(robot, ghost.x, ghost.y, ghost.heading))} fill="var(--amber)" fillOpacity={0.55}
          stroke="var(--amber)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      )}
      <PlaybackRobot robot={robot} x={ghost.x} y={ghost.y} h={ghost.heading} />
      {!playing && robot.modules.map(([mx, my], i) => {
        const px = ghost.x + c * mx - s * my, py = ghost.y + s * mx + c * my;
        const k = 0.004;
        return <line key={i} x1={px} y1={py} x2={px + (ghost.fx[i] ?? 0) * k} y2={py + (ghost.fy[i] ?? 0) * k} stroke="var(--accent-ink)" strokeWidth={2 * pxToM} strokeLinecap="round" />;
      })}
    </g>
  );
}

export function FieldCanvas({ mode }: { mode: Mode }) {
  const project = useStore((s) => s.project)!;
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const drawing = useStore((s) => s.drawing);
  const pending = useStore((s) => s.pending);
  const solveState = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj] : undefined));
  const stale = useStore((s) => (s.selectedTraj ? s.stale[s.selectedTraj] : false));
  const showRed = useStore((s) => s.showRed);
  const info = useStore((s) => s.drivetrainInfo);
  const fuelOn = useStore((s) => s.fuelSimOn) && mode === "path";
  const fuelCfg: FuelSimConfig = useStore((s) => s.project?.fuelSim ?? DEFAULT_FUEL_SIM);
  const sim = useFuelSim();
  const st = useStore.getState;

  const field = project.field;
  const robot = project.robot;
  const L = field.length, W = field.width;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const flipRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [view, setView] = useState<View | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const drag = useRef<Drag | null>(null);
  // Sim robot the first click of a double-click deselected; the second click extends its auto.
  // (PointerEvent.detail is 0 in Chromium, so double-clicks are detected by time and distance.)
  const simClick = useRef<{ id: string; at: number; x: number; y: number } | null>(null);

  // fit view to container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback((): View => {
    const pad = 0.4;
    const fw = L + 2 * pad, fh = W + 2 * pad;
    const aspect = size.h / Math.max(size.w, 1);
    if (fh / fw > aspect) {
      const w = fh / aspect;
      return { x: -pad - (w - fw) / 2, y: -pad, w, h: fh };
    }
    const h = fw * aspect;
    return { x: -pad, y: -pad - (h - fh) / 2, w: fw, h };
  }, [L, W, size]);

  // Refit on resize until the user zooms or pans; afterwards keep their view.
  const userMoved = useRef(false);
  useEffect(() => {
    setView((v) => {
      if (!v || !userMoved.current) return fit();
      const aspect = size.h / Math.max(size.w, 1);
      return { ...v, h: v.w * aspect };
    });
  }, [size, fit]);

  const vb = view ?? fit();
  const pxToM = vb.w / Math.max(size.w, 1);
  const hr = 6 * pxToM; // handle radius

  const toField = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!, g = gRef.current!;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const m = g.getScreenCTM();
    if (!m) return [0, 0];
    const q = p.matrixTransform(m.inverse());
    return [q.x, q.y];
  };

  const readOnly = mode === "path" && showRed;
  const flipTransform = showRed && mode === "path"
    ? field.symmetry === "rotational" ? `matrix(-1 0 0 -1 ${L} ${W})` : `matrix(-1 0 0 1 ${L} 0)`
    : undefined;

  // ------------------------------------------------------------ derived
  const out = traj?.output ?? null;
  const vmax = info?.maxSpeed ?? 4.5;

  const pathSegs = useMemo(() => {
    if (!out) return [];
    const s = out.samples;
    const segs: { a: Vec2; b: Vec2; c: string }[] = [];
    for (let i = 0; i + 1 < s.length; i++) {
      const sub = 3;
      for (let k = 0; k < sub; k++) {
        const t0 = s[i].t + ((s[i + 1].t - s[i].t) * k) / sub;
        const t1 = s[i].t + ((s[i + 1].t - s[i].t) * (k + 1)) / sub;
        const p0 = sampleAt(out, t0), p1 = sampleAt(out, t1);
        segs.push({ a: [p0.x, p0.y], b: [p1.x, p1.y], c: speedColor(Math.hypot(p0.vx, p0.vy) / vmax) });
      }
    }
    return segs;
  }, [out, vmax]);

  const simTracks = useMemo(() => (fuelOn ? fuelCfg.robots.filter((r) => r.points.length).map(simRobotTrack) : []), [fuelOn, fuelCfg]);
  const updFuel = (fn: (f: FuelSimConfig) => void, history = false) => st().updateFuelSim(fn, { history });
  const updSimRobot = (id: string, fn: (r: SimRobot) => void, history = false) =>
    updFuel((f) => { const r = f.robots.find((x) => x.id === id); if (r) fn(r); }, history);

  const intakePaths = useMemo(() => (out?.intake ?? []).map((sp) => {
    const line: Vec2[] = [];
    for (let t = sp.t; t < sp.endT; t += 0.03) { const q = sampleAt(out!, t); line.push([q.x, q.y]); }
    const q = sampleAt(out!, sp.endT);
    line.push([q.x, q.y]);
    return line;
  }), [out]);

  // ------------------------------------------------------------ interaction helpers
  const updTraj = (fn: (t: Trajectory) => void, history = false) => {
    const n = st().selectedTraj;
    if (n) st().updateTraj(n, fn, { history });
  };
  const updField = (fn: (f: Field) => void, history = false) => st().updateProject((p) => fn(p.field), { history });

  const hitObstacle = (p: Vec2): Obstacle | undefined =>
    [...field.obstacles].reverse().find((o) =>
      o.kind === "circle" ? Math.hypot(p[0] - o.center[0], p[1] - o.center[1]) <= o.radius : pointInPolygon(p, o.points));

  const finishPolygon = (poly: Vec2[]) => {
    if (poly.length < 3) {
      st().setDrawing([]);
      return;
    }
    if (mode === "field") {
      const o = newObstacle(poly, `Obstacle ${field.obstacles.length + 1}`);
      updField((f) => { f.obstacles.push(o); }, true);
      st().select({ kind: "obstacle", id: o.id });
    } else if (traj) {
      const pend = st().pending;
      if (tool === "region" && pend) {
        const c = newConstraint(pend.type, traj.waypoints.length);
        if (pend.type === "keepOut") c.data = { type: "keepOut", points: poly, margin: 0 };
        else if (pend.type === "keepIn") c.data = { type: "keepIn", points: poly };
        else if (pend.type === "roughTerrain") c.scope = { kind: "zone", from: 0, to: Math.max(0, traj.waypoints.length - 1), region: poly };
        updTraj((t) => { t.constraints.push(c); }, true);
        st().select({ kind: "constraint", id: c.id });
      }
    }
    st().setDrawing([]);
    st().setTool("select");
  };

  /** Second waypoint click of the constraint tool: create it over [a, b] and select it. */
  const placeConstraint = (a: number, b: number) => {
    const pend = st().pending;
    if (!pend || !traj) return;
    const [from, to] = a <= b ? [a, b] : [b, a];
    const hub: Vec2 = [4.63, field.width / 2];
    const c = newConstraint(pend.type, traj.waypoints.length, pend.type === "pointAt" ? hub : undefined, from, to);
    updTraj((t) => { t.constraints.push(c); }, true);
    st().setTool("select");
    st().select({ kind: "constraint", id: c.id });
  };

  // ------------------------------------------------------------ pointer events
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey && tool === "select")) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: vb };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const p = toField(e);
    const target = (e.target as Element).closest("[data-h]") as HTMLElement | null;
    const h = target?.dataset.h;
    svgRef.current?.setPointerCapture(e.pointerId);

    if (!readOnly && h) {
      const [kind, a, b] = h.split(":");
      if (kind === "wp") {
        const i = +a;
        const pend = st().pending;
        if (tool === "constraint" && pend && traj) {
          if (pend.from === null) {
            useStore.setState((s) => { if (s.pending) s.pending.from = i; });
          } else {
            placeConstraint(pend.from, i);
          }
          return;
        }
        st().select({ kind: "waypoint", index: i });
        st().checkpoint();
        const w = resolveWaypoint(project.poses, traj!.waypoints[i]);
        drag.current = { kind: "waypoint", index: i, dx: w.x - p[0], dy: w.y - p[1] };
        return;
      }
      if (kind === "hd") {
        st().select({ kind: "waypoint", index: +a });
        st().checkpoint();
        drag.current = { kind: "heading", index: +a };
        return;
      }
      if (kind === "ob" && mode === "field" && tool === "select") {
        st().select({ kind: "obstacle", id: a });
        st().checkpoint();
        drag.current = { kind: "obstacle", id: a, last: p };
        return;
      }
      if (kind === "vx") {
        if (e.shiftKey || e.metaKey) {
          updField((f) => {
            const o = f.obstacles.find((x) => x.id === a);
            if (o && o.points.length > 3) o.points.splice(+b, 1);
          }, true);
          return;
        }
        st().checkpoint();
        drag.current = { kind: "vertex", id: a, vi: +b };
        return;
      }
      if (kind === "rad") {
        st().checkpoint();
        drag.current = { kind: "radius", id: a };
        return;
      }
      if (kind === "pa") {
        st().select({ kind: "constraint", id: a });
        st().checkpoint();
        drag.current = { kind: "pointAt", id: a };
        return;
      }
      if (kind === "rg" && tool === "select") {
        st().select({ kind: "constraint", id: a });
        st().checkpoint();
        drag.current = { kind: "region", id: a, last: p };
        return;
      }
      if (kind === "rv") {
        st().checkpoint();
        drag.current = { kind: "regionVertex", id: a, vi: +b };
        return;
      }
      if (kind === "mk") {
        st().select({ kind: "marker", id: a });
        return;
      }
      if (kind === "sp") {
        if (e.shiftKey || e.metaKey) {
          updSimRobot(a, (r) => { if (r.points.length > 2) r.points.splice(+b, 1); }, true);
          return;
        }
        st().checkpoint();
        drag.current = { kind: "simPoint", id: a, vi: +b };
        return;
      }
      if (kind === "sl" && tool === "select") {
        st().select({ kind: "simRobot", id: a });
        return;
      }
      if (kind === "sr" && tool === "select") {
        const was = selection?.kind === "simRobot" && selection.id === a;
        st().select({ kind: "simRobot", id: a });
        if (was) {
          st().checkpoint();
          drag.current = { kind: "simRobot", id: a, last: p };
        }
        return;
      }
      if (kind === "is") {
        st().select({ kind: "issue", index: +a });
        return;
      }
    }

    if (readOnly) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: vb };
      return;
    }

    // tools
    if (mode === "path" && (tool === "pose" || tool === "translation" || tool === "guide") && traj) {
      // Like Choreo: new waypoints always go at the end. Reorder from the sidebar.
      const wps = traj.waypoints;
      const prev = wps[wps.length - 1];
      const w = newWaypoint(p[0], p[1], prev?.heading ?? 0);
      applyWaypointKind(w, tool);
      const idx = wps.length;
      updTraj((t) => {
        const n = t.waypoints.length;
        w.stop = true; // the end of the path stops; the old end (unless it's the start) passes through
        if (n > 1) t.waypoints[n - 1].stop = false;
        // constraints and markers that ran to the old end keep running to the new end
        for (const c of t.constraints) {
          if (c.scope.kind === "range" && c.scope.to === n - 1 && n > 1 && c.scope.from !== c.scope.to) c.scope.to = n;
        }
        t.waypoints.push(w);
      }, true);
      st().select({ kind: "waypoint", index: idx });
      return;
    }
    if (tool === "polygon" || tool === "region") {
      const first = drawing[0];
      if (first && drawing.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < hr * 2) {
        finishPolygon(drawing);
      } else {
        st().setDrawing([...drawing, p]);
      }
      return;
    }
    if (tool === "circle" && mode === "field") {
      drag.current = { kind: "circle-new", center: p };
      return;
    }
    if (tool === "constraint") return; // waiting for a waypoint click
    if (mode === "field" && tool === "select") {
      const o = hitObstacle(p);
      if (o) {
        st().select({ kind: "obstacle", id: o.id });
        st().checkpoint();
        drag.current = { kind: "obstacle", id: o.id, last: p };
        return;
      }
    }
    if (fuelOn && tool === "select") {
      const prev = simClick.current;
      if (prev && performance.now() - prev.at < 500 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6) {
        simClick.current = null;
        updSimRobot(prev.id, (r) => { r.points.push(p); }, true);
        st().select({ kind: "simRobot", id: prev.id });
        return;
      }
      simClick.current = selection?.kind === "simRobot" ? { id: selection.id, at: performance.now(), x: e.clientX, y: e.clientY } : null;
    }
    st().select(null);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, view: vb };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toField(e);
    setCursor(p);
    const d = drag.current;
    if (!d) return;
    const snap = (v: number) => (e.shiftKey ? Math.round(v / 0.05) * 0.05 : v);
    switch (d.kind) {
      case "pan": {
        userMoved.current = true;
        const dx = (e.clientX - d.sx) * pxToM, dy = (e.clientY - d.sy) * pxToM;
        setView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy });
        break;
      }
      case "waypoint": {
        const x = snap(p[0] + d.dx), y = snap(p[1] + d.dy);
        const ref = traj?.waypoints[d.index]?.poseRef;
        if (ref && project.poses?.some((v) => v.id === ref)) {
          st().updateProject((pr) => { const v = pr.poses.find((q) => q.id === ref); if (v) { v.x = x; v.y = y; } }, { history: false });
        } else {
          updTraj((t) => { const w = t.waypoints[d.index]; w.x = x; w.y = y; });
        }
        break;
      }
      case "heading": {
        const w0 = traj ? resolveWaypoint(project.poses, traj.waypoints[d.index]) : null;
        if (!w0) break;
        let ang = Math.atan2(p[1] - w0.y, p[0] - w0.x);
        if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        const ref = traj?.waypoints[d.index]?.poseRef;
        if (ref && project.poses?.some((v) => v.id === ref)) {
          st().updateProject((pr) => { const v = pr.poses.find((q) => q.id === ref); if (v) v.heading = ang; }, { history: false });
        } else {
          updTraj((t) => { t.waypoints[d.index].heading = ang; });
        }
        break;
      }
      case "obstacle": {
        const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
        d.last = p;
        updField((f) => {
          const o = f.obstacles.find((x) => x.id === d.id);
          if (!o) return;
          o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
          o.center = [o.center[0] + dx, o.center[1] + dy];
        });
        break;
      }
      case "vertex":
        updField((f) => {
          const o = f.obstacles.find((x) => x.id === d.id);
          if (o) o.points[d.vi] = [snap(p[0]), snap(p[1])];
        });
        break;
      case "radius":
        updField((f) => {
          const o = f.obstacles.find((x) => x.id === d.id);
          if (o) o.radius = Math.max(0.05, Math.hypot(p[0] - o.center[0], p[1] - o.center[1]));
        });
        break;
      case "pointAt":
        updTraj((t) => {
          const c = t.constraints.find((x) => x.id === d.id);
          if (c && c.data.type === "pointAt") {
            c.data.x = snap(p[0]);
            c.data.y = snap(p[1]);
          }
        });
        break;
      case "region": {
        const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
        d.last = p;
        updTraj((t) => {
          const c = t.constraints.find((x) => x.id === d.id);
          if (!c) return;
          if (c.scope.kind === "zone") c.scope.region = c.scope.region.map(([x, y]) => [x + dx, y + dy]);
          else if (c.data.type === "keepOut" || c.data.type === "keepIn") c.data.points = c.data.points.map(([x, y]) => [x + dx, y + dy]);
        });
        break;
      }
      case "regionVertex":
        updTraj((t) => {
          const c = t.constraints.find((x) => x.id === d.id);
          if (!c) return;
          if (c.scope.kind === "zone") c.scope.region[d.vi] = [snap(p[0]), snap(p[1])];
          else if (c.data.type === "keepOut" || c.data.type === "keepIn") c.data.points[d.vi] = [snap(p[0]), snap(p[1])];
        });
        break;
      case "simPoint":
        updSimRobot(d.id, (r) => { if (r.points[d.vi]) r.points[d.vi] = [snap(p[0]), snap(p[1])]; });
        break;
      case "simRobot": {
        const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
        d.last = p;
        updSimRobot(d.id, (r) => { r.points = r.points.map(([x, y]) => [x + dx, y + dy]); });
        break;
      }
      default:
        break;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (d?.kind === "circle-new") {
      const p = toField(e);
      const r = Math.hypot(p[0] - d.center[0], p[1] - d.center[1]);
      if (r > 0.05) {
        const o: Obstacle = { ...newObstacle([], `Circle ${field.obstacles.length + 1}`), kind: "circle", center: d.center, radius: r };
        updField((f) => { f.obstacles.push(o); }, true);
        st().select({ kind: "obstacle", id: o.id });
        st().setTool("select");
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly) return;
    if ((tool === "polygon" || tool === "region") && drawing.length >= 3) {
      finishPolygon(drawing);
      return;
    }
    // insert a vertex on the selected obstacle edge
    if (mode === "field" && selection?.kind === "obstacle") {
      const p = toField(e);
      updField((f) => {
        const o = f.obstacles.find((x) => x.id === selection.id);
        if (!o || o.kind !== "polygon") return;
        let best = -1, bd = Infinity;
        o.points.forEach((a, i) => {
          const b = o.points[(i + 1) % o.points.length];
          const dd = distToSegment(p, a, b);
          if (dd < bd) { bd = dd; best = i; }
        });
        if (bd < 0.3) o.points.splice(best + 1, 0, p);
      }, true);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    userMoved.current = true;
    const p = toField(e);
    const k = Math.exp(e.deltaY * 0.0015);
    const w = Math.min(Math.max(vb.w * k, 1.5), (L + 4) * 3);
    const s = w / vb.w;
    // keep cursor fixed (screen y is flipped relative to field y)
    const sx = p[0], sy = W - p[1];
    setView({ x: sx - (sx - vb.x) * s, y: sy - (sy - vb.y) * s, w, h: vb.h * s });
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const s = st();
      if (e.key === "Escape") {
        if (s.drawing.length) s.setDrawing([]);
        else if (s.tool !== "select") s.setTool("select");
        else s.select(null);
      }
      if (e.key === "Enter" && s.drawing.length >= 3) finishPolygon(s.drawing);
      if (e.key === "Enter" && s.tool === "constraint" && s.pending?.from != null) placeConstraint(s.pending.from, s.pending.from);
      if (readOnly) return;
      const sel = s.selection;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (sel.kind === "waypoint" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => deleteWaypoint(t, sel.index));
        } else if (sel.kind === "constraint" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => { t.constraints = t.constraints.filter((c) => c.id !== sel.id); });
        } else if (sel.kind === "marker" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => { t.markers = t.markers.filter((m) => m.id !== sel.id); });
        } else if (sel.kind === "obstacle") {
          s.updateProject((p) => { p.field.obstacles = p.field.obstacles.filter((o) => o.id !== sel.id); });
        } else if (sel.kind === "simRobot") {
          s.updateFuelSim((f) => { f.robots = f.robots.filter((r) => r.id !== sel.id); });
        }
        s.select(null);
      }
      if (sel?.kind === "waypoint" && e.key.startsWith("Arrow") && s.selectedTraj) {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 0.01;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowDown" ? -step : e.key === "ArrowUp" ? step : 0;
        s.updateTraj(s.selectedTraj, (t) => {
          const w = t.waypoints[sel.index];
          if (w) { w.x += dx; w.y += dy; }
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, mode, tool, traj?.name]);

  // ------------------------------------------------------------ render
  const selWp = selection?.kind === "waypoint" ? selection.index : -1;
  const selId = selection && "id" in selection ? selection.id : null;
  const wps = (traj?.waypoints ?? []).map((w) => resolveWaypoint(project.poses, w));
  const intakeAt = traj ? intakeWaypoints(traj, project.poses) : new Set<number>();
  const selCon = selection?.kind === "constraint" ? traj?.constraints.find((c) => c.id === selection.id) : undefined;
  const issues = solveState?.issues ?? [];
  const selRegion = selCon ? constraintRegion(selCon) : null;

  const cursorClass = readOnly ? "grab" : tool === "select" ? "default" : "crosshair";

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0 }}>
      {/* static field art in its own layer, so the fuel canvas can sit between it and the editor */}
      <svg className="field field-art" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} aria-hidden>
        <g transform={`matrix(1 0 0 -1 0 ${W})`}>
          <FieldArt field={field} hideFuel={!!sim && mode === "path" && !!traj} />
        </g>
      </svg>
      {sim && mode === "path" && traj && (
        <FuelCanvas sim={sim} frame={flipRef} viewKey={`${vb.x} ${vb.y} ${vb.w} ${vb.h} ${flipTransform ?? ""} ${size.w} ${size.h}`} />
      )}
      <svg
        ref={svgRef}
        className="field"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        style={{ cursor: cursorClass }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="hatch" width="0.12" height="0.12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="0.12" stroke="var(--accent)" strokeWidth="0.03" opacity="0.35" />
          </pattern>
          <pattern id="hatch-red" width="0.12" height="0.12" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="0.12" stroke="var(--red)" strokeWidth="0.03" opacity="0.4" />
          </pattern>
        </defs>
        <g ref={gRef} transform={`matrix(1 0 0 -1 0 ${W})`}>

          {/* obstacles */}
          {field.obstacles.map((o) => {
            const p = obstaclePoints(o);
            const sel = selId === o.id;
            const interactive = mode === "field";
            // with the fuel sim on, fuel-only blockers (e.g. bumps) get an amber outline
            const fuelOnly = fuelOn && !o.enabled && blocksFuel(o);
            return (
              <g key={o.id} data-h={interactive ? `ob:${o.id}` : undefined} style={{ cursor: interactive && tool === "select" ? "move" : undefined }}>
                <polygon points={pts(p)} fill={o.enabled ? "url(#hatch)" : "none"}
                  stroke={sel || o.enabled ? "var(--accent)" : fuelOnly ? "var(--amber)" : "var(--faint)"}
                  strokeOpacity={o.enabled || sel || fuelOnly ? 0.9 : 0.6} strokeWidth={sel ? 2.5 : fuelOnly ? 1.6 : 1.2}
                  strokeDasharray={o.enabled ? undefined : "4 4"} vectorEffect="non-scaling-stroke" />
                {mode === "field" && sel && o.kind === "polygon" && o.points.map(([x, y], i) => (
                  <circle key={i} data-h={`vx:${o.id}:${i}`} cx={x} cy={y} r={hr} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ cursor: "grab" }} />
                ))}
                {mode === "field" && sel && o.kind === "circle" && (
                  <circle data-h={`rad:${o.id}`} cx={o.center[0] + o.radius} cy={o.center[1]} r={hr} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ cursor: "ew-resize" }} />
                )}
              </g>
            );
          })}

          {mode === "path" && traj && (
            <g ref={flipRef} transform={flipTransform}>
              {/* regions: zones, keep-in, keep-out */}
              {traj.constraints.map((c) => {
                const region = constraintRegion(c);
                if (!region) return null;
                const { poly, kind } = region;
                const sel = selId === c.id;
                const color = regionColor(kind);
                return (
                  <g key={c.id} opacity={c.enabled ? 1 : 0.4}>
                    <polygon data-h={`rg:${c.id}`} points={pts(poly)} fill={kind === "out" ? "url(#hatch-red)" : color}
                      fillOpacity={kind === "out" ? 1 : 0.07} stroke={color} strokeWidth={sel ? 2.5 : 1.5}
                      strokeDasharray="6 4" vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} />
                  </g>
                );
              })}

              {/* fuel sim: balls and other robots, under our path */}
              {simTracks.map((tr) => (
                <SimRobotPath key={tr.robot.id} robot={tr.robot} red={showRed} interactive={!readOnly && tool === "select"}
                  selected={selection?.kind === "simRobot" && selection.id === tr.robot.id} />
              ))}
              {simTracks.length > 0 && (
                <SimRobotBodies tracks={simTracks} red={showRed} interactive={!readOnly && tool === "select"}
                  selectedId={selection?.kind === "simRobot" ? selection.id : null} />
              )}

              {/* candidate routes while solving */}
              {solveState?.status === "solving" && solveState.candidates?.map((cand, ci) => (
                <g key={ci}>
                  {cand.map((seg, si) => (
                    <polyline key={si} points={pts(seg as Vec2[])} fill="none" stroke="var(--faint)" strokeWidth={1.2} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
                  ))}
                </g>
              ))}

              {/* straight-line constraints */}
              {traj.constraints.map((c) => {
                if (c.data.type !== "straightLine" || c.scope.kind !== "range") return null;
                const a = wps[c.scope.from], b = wps[c.scope.to];
                if (!a || !b) return null;
                const sel = selId === c.id;
                return <line key={c.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--accent-ink)" strokeOpacity={c.enabled ? 0.8 : 0.3}
                  strokeWidth={sel ? 3 : 1.6} strokeDasharray="1 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
              })}

              {/* span of the selected constraint */}
              {selCon && selCon.scope.kind !== "zone" && (() => {
                const from = selCon.scope.from, to = selCon.scope.kind === "range" ? selCon.scope.to : selCon.scope.from;
                let span: Vec2[] = [];
                if (out && !stale && out.waypointTimes[from] !== undefined && out.waypointTimes[to] !== undefined) {
                  for (let t = out.waypointTimes[from]; t <= out.waypointTimes[to] + 1e-9; t += 0.03) {
                    const q = sampleAt(out, t);
                    span.push([q.x, q.y]);
                  }
                } else {
                  span = wps.slice(from, to + 1).map((w) => [w.x, w.y] as Vec2);
                }
                return (
                  <g pointerEvents="none">
                    {span.length > 1 && <polyline points={pts(span)} fill="none" stroke="var(--amber)" strokeWidth={12} strokeOpacity={0.3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
                    {[from, to].map((k, i) => wps[k] && (
                      <circle key={i} cx={wps[k].x} cy={wps[k].y} r={hr * 2.2} fill="none" stroke="var(--amber)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
                    ))}
                  </g>
                );
              })()}

              {/* waypoint guide line */}
              {(!out || stale) && wps.length > 1 && (
                <polyline points={pts(wps.map((w) => [w.x, w.y]))} fill="none" stroke="var(--faint)" strokeWidth={1.2} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
              )}

              {/* intake-extended stretches of the solved path */}
              {!stale && intakePaths.map((line, i) => (
                <polyline key={i} points={pts(line)} fill="none" stroke="var(--amber)" strokeWidth={11} strokeOpacity={0.35}
                  strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pointerEvents="none" />
              ))}

              {/* solved path */}
              <g opacity={stale ? 0.35 : 1}>
                {pathSegs.map((s, i) => (
                  <line key={i} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} stroke={s.c} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                ))}
              </g>

              {/* live preview / failed preview */}
              {solveState?.status === "solving" && solveState.previews && Object.entries(solveState.previews).map(([ci, path]) => (
                <polyline key={ci} points={pts(path.map(([x, y]) => [x, y]))} fill="none" stroke="var(--accent)"
                  strokeOpacity={0.55} strokeWidth={1.6} strokeDasharray={ci === "0" ? "5 3" : "2 4"} vectorEffect="non-scaling-stroke" />
              ))}
              {solveState?.preview && solveState.status === "failed" && (
                <polyline points={pts(solveState.preview.map(([x, y]) => [x, y]))} fill="none"
                  stroke={solveState.status === "failed" ? "var(--red)" : "var(--accent)"} strokeWidth={2.2}
                  strokeDasharray={solveState.status === "failed" ? "6 4" : "5 3"} vectorEffect="non-scaling-stroke" />
              )}

              {/* event markers */}
              {out && !stale && out.events.map((ev, i) => {
                const s = sampleAt(out, ev.t);
                const mk = traj.markers.find((m) => m.name === ev.name);
                const sel = mk && selId === mk.id;
                const r = hr * (sel ? 1.3 : 1);
                return (
                  <g key={i} data-h={mk ? `mk:${mk.id}` : undefined} style={{ cursor: "pointer" }}>
                    {ev.endT !== null && (() => {
                      const zone: Vec2[] = [];
                      for (let t = ev.t; t <= ev.endT! + 1e-9; t += 0.05) { const q = sampleAt(out, t); zone.push([q.x, q.y]); }
                      return <polyline points={pts(zone)} fill="none" stroke="var(--amber)" strokeWidth={9} strokeOpacity={0.28} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
                    })()}
                    <polygon points={pts([[s.x, s.y + r], [s.x + r, s.y], [s.x, s.y - r], [s.x - r, s.y]])}
                      fill={ev.mustHit ? "var(--amber)" : "var(--panel)"} stroke="var(--amber)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}

              {/* waypoints: pose = bumper box + heading knob, translation = dot, guide = hollow dot */}
              {wps.map((w, i) => {
                const sel = i === selWp;
                const guide = w.translationMode === "guide";
                const pose = !guide && w.headingMode === "fixed";
                const linked = !!traj.waypoints[i]?.poseRef;
                const picking = tool === "constraint" && pending?.from === i;
                const color = sel ? "var(--accent)" : i === 0 ? "var(--green)" : "var(--accent-ink)";
                const c = Math.cos(w.heading), s = Math.sin(w.heading);
                const knobD = robot.bumper.front + 0.22;
                const knob: Vec2 = [w.x + c * knobD, w.y + s * knobD];
                return (
                  <g key={w.id}>
                    {pose && (
                      <RobotShape robot={robot} x={w.x} y={w.y} h={w.heading} stroke={color}
                        fill={sel ? "var(--accent)" : "transparent"} opacity={sel ? 1 : 0.85} width={sel ? 2.2 : 1.4} />
                    )}
                    {sel && pose && <polygon points={pts(footprint(robot, w.x, w.y, w.heading))} fill="var(--accent)" fillOpacity={0.08} pointerEvents="none" />}
                    {pose && intakeAt.has(i) && (
                      <polygon points={pts(intakeFootprint(robot, w.x, w.y, w.heading))} fill="var(--amber)" fillOpacity={0.15}
                        stroke="var(--amber)" strokeWidth={1.4} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                    )}
                    {w.tolerance.kind === "circle" && !guide && (
                      <circle cx={w.x} cy={w.y} r={w.tolerance.radius} fill="var(--accent)" fillOpacity={0.06} stroke="var(--accent)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                    )}
                    {w.tolerance.kind === "box" && !guide && (
                      <rect x={w.x - w.tolerance.dx} y={w.y - w.tolerance.dy} width={2 * w.tolerance.dx} height={2 * w.tolerance.dy} fill="var(--accent)" fillOpacity={0.06} stroke="var(--accent)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                    )}
                    {pose && !readOnly && (
                      <>
                        <line x1={w.x + c * robot.bumper.front} y1={w.y + s * robot.bumper.front} x2={knob[0]} y2={knob[1]} stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                        <circle data-h={`hd:${i}`} cx={knob[0]} cy={knob[1]} r={hr * 0.8} fill="var(--panel)" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ cursor: "grab" }} />
                      </>
                    )}
                    {linked && <circle cx={w.x} cy={w.y} r={hr * 1.9} fill="none" stroke="var(--accent-2)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                    {picking && <circle cx={w.x} cy={w.y} r={hr * 2.4} fill="var(--amber)" fillOpacity={0.15} stroke="var(--amber)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                    <circle data-h={`wp:${i}`} cx={w.x} cy={w.y} r={guide ? hr * 0.9 : hr * (sel ? 1.45 : 1.25)}
                      fill={guide ? "var(--panel)" : color} stroke={guide ? color : "var(--panel)"} strokeWidth={2}
                      strokeDasharray={guide ? "2 2" : undefined} vectorEffect="non-scaling-stroke"
                      style={{ cursor: readOnly ? undefined : tool === "constraint" ? "pointer" : "move" }} />
                    {w.stop && !guide && <rect x={w.x - hr * 0.45} y={w.y - hr * 0.45} width={hr * 0.9} height={hr * 0.9} fill="var(--panel)" pointerEvents="none" />}
                    {w.split && <circle cx={w.x} cy={w.y} r={hr * 2} fill="none" stroke="var(--amber)" strokeWidth={2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                  </g>
                );
              })}

              {/* corner handles of the selected region, above the waypoints so a robot box can't cover them */}
              {selRegion && selRegion.poly.map(([x, y], i) => (
                <circle key={i} data-h={`rv:${selRegion.id}:${i}`} cx={x} cy={y} r={hr * 0.85} fill="var(--panel)"
                  stroke={regionColor(selRegion.kind)} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}

              {/* points of the selected sim robot's auto, each with a generous invisible grab area */}
              {fuelOn && !readOnly && selection?.kind === "simRobot" && (() => {
                const sr = fuelCfg.robots.find((r) => r.id === selection.id);
                if (!sr) return null;
                const color = simColor(sr, showRed);
                return sr.points.map(([x, y], i) => (
                  <g key={`sp${i}`} data-h={`sp:${sr.id}:${i}`} style={{ cursor: "grab" }}>
                    <circle cx={x} cy={y} r={hr * 2.2} fill="transparent" />
                    <circle cx={x} cy={y} r={hr * (i === 0 ? 1.1 : 0.85)} fill={i === 0 ? color : "var(--panel)"} stroke={color} strokeWidth={2}
                      vectorEffect="non-scaling-stroke" />
                    <title>{i === 0 ? "Start" : i === sr.points.length - 1 ? "End" : `Point ${i + 1}`}</title>
                  </g>
                ));
              })()}

              {/* point-at targets */}
              {traj.constraints.filter((c) => c.data.type === "pointAt").map((c) => {
                if (c.data.type !== "pointAt") return null;
                const sel = selId === c.id;
                const r = hr * 1.8;
                return (
                  <g key={c.id} data-h={`pa:${c.id}`} style={{ cursor: "move" }} opacity={c.enabled ? 1 : 0.4}>
                    <circle cx={c.data.x} cy={c.data.y} r={r} fill="var(--panel)" fillOpacity={0.6} stroke={sel ? "var(--accent)" : "var(--amber)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    <line x1={c.data.x - r * 1.5} y1={c.data.y} x2={c.data.x + r * 1.5} y2={c.data.y} stroke={sel ? "var(--accent)" : "var(--amber)"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                    <line x1={c.data.x} y1={c.data.y - r * 1.5} x2={c.data.x} y2={c.data.y + r * 1.5} stroke={sel ? "var(--accent)" : "var(--amber)"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}

              {/* playback robot */}
              {out && !stale && <PlaybackGhost out={out} robot={robot} pxToM={pxToM} />}

              {/* issue pins */}
              {issues.map((is, i) => (is.x != null && is.y != null ? (
                <g key={i} data-h={`is:${i}`} style={{ cursor: "pointer" }}>
                  <circle cx={is.x} cy={is.y} r={hr * 1.5} fill="var(--red)" stroke="var(--panel)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <circle cx={is.x} cy={is.y} r={hr * 3} fill="none" stroke="var(--red)" strokeWidth={1.5} strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
                </g>
              ) : null))}
            </g>
          )}

          {/* in-progress drawing */}
          {drawing.length > 0 && (
            <g pointerEvents="none">
              <polyline points={pts(cursor ? [...drawing, cursor] : drawing)} fill="var(--accent)" fillOpacity={0.08}
                stroke="var(--accent)" strokeWidth={2} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
              {drawing.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={hr * (i === 0 ? 1.1 : 0.8)} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {tool === "circle" && drag.current?.kind === "circle-new" && cursor && (() => {
            const c = (drag.current as { center: Vec2 }).center;
            return <polygon points={pts(circlePoints({ center: c, radius: Math.hypot(cursor[0] - c[0], cursor[1] - c[1]) } as Obstacle))} fill="var(--accent)" fillOpacity={0.08} stroke="var(--accent)" strokeDasharray="5 4" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
          })()}
        </g>
      </svg>

      <div className="stage-foot">
        <button className="btn sm" onClick={() => { userMoved.current = false; setView(fit()); }}>Fit</button>
        {cursor && <span className="chip mono">{cursor[0].toFixed(2)}, {cursor[1].toFixed(2)} m</span>}
        {readOnly && <span className="chip red">Red alliance preview · read-only</span>}
      </div>
      {mode === "path" && out && (
        <div className="legend"><span>0</span><div className="legend-bar" /><span>{vmax.toFixed(1)} m/s</span></div>
      )}
    </div>
  );
}

export { centroid };
