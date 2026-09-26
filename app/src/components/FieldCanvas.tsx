import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  centroid, circlePoints, distToSegment, footprint, insertionIndex, newConstraint, newObstacle, newWaypoint,
  obstaclePoints, pointInPolygon, sampleAt, totalTime,
} from "../model";
import type { Decoration, Field, Obstacle, RobotConfig, Trajectory, Vec2 } from "../types";

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
  | { kind: "regionVertex"; id: string; vi: number };

const speedColor = (u: number) => {
  // light lavender -> accent purple -> deep violet
  const stops = [[205, 189, 255], [143, 99, 255], [74, 31, 194]];
  const t = Math.max(0, Math.min(1, u)) * 2;
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
};

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

const FieldArt = memo(function FieldArt({ field }: { field: Field }) {
  const d = field.decorations ?? [];
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
    <g opacity={opacity}>
      <polygon points={pts(fp)} fill={fill} stroke={stroke} strokeWidth={width} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
      <line x1={x} y1={y} x2={front[0]} y2={front[1]} stroke={stroke} strokeWidth={width} vectorEffect="non-scaling-stroke" />
      <polyline points={pts([fp[3], front, fp[0]])} fill="none" stroke={stroke} strokeWidth={width * 1.6} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

export function FieldCanvas({ mode }: { mode: Mode }) {
  const project = useStore((s) => s.project)!;
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const drawing = useStore((s) => s.drawing);
  const solveState = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj] : undefined));
  const stale = useStore((s) => (s.selectedTraj ? s.stale[s.selectedTraj] : false));
  const playbackT = useStore((s) => s.playback.t);
  const showRed = useStore((s) => s.showRed);
  const info = useStore((s) => s.drivetrainInfo);
  const st = useStore.getState;

  const field = project.field;
  const robot = project.robot;
  const L = field.length, W = field.width;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [view, setView] = useState<View | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const drag = useRef<Drag | null>(null);

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
  const T = totalTime(out);
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

  const ghost = out && T > 0 ? sampleAt(out, Math.min(playbackT, T)) : null;

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
      if (tool === "zone") {
        const c = newConstraint("maxVelocity", traj.waypoints.length);
        c.scope = { kind: "zone", from: 0, to: 0, region: poly };
        updTraj((t) => { t.constraints.push(c); }, true);
        st().select({ kind: "constraint", id: c.id });
      } else if (tool === "keepOut") {
        const c = newConstraint("keepOut", traj.waypoints.length);
        c.data = { type: "keepOut", points: poly, margin: 0.03 };
        updTraj((t) => { t.constraints.push(c); }, true);
        st().select({ kind: "constraint", id: c.id });
      }
    }
    st().setDrawing([]);
    st().setTool("select");
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
        st().select({ kind: "waypoint", index: i });
        st().checkpoint();
        const w = traj!.waypoints[i];
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
    if (mode === "path" && (tool === "waypoint" || tool === "guide") && traj) {
      const wps = traj.waypoints;
      const idx = insertionIndex(wps, p);
      const ref = wps[Math.min(idx, wps.length - 1)] ?? wps[idx - 1];
      const w = newWaypoint(p[0], p[1], ref?.heading ?? 0,
        tool === "guide" ? { translationMode: "guide", headingMode: "free" } : {});
      updTraj((t) => {
        const n = t.waypoints.length;
        const appending = idx >= n;
        if (appending) {
          // the new point becomes the end: it stops, the old end (unless it's the start) passes through
          w.stop = true;
          if (n > 1) t.waypoints[n - 1].stop = false;
        } else if (n === 0) {
          w.stop = true;
        }
        t.waypoints.splice(idx, 0, w);
        // keep constraint/marker waypoint references pointing at the same waypoints
        for (const c of t.constraints) {
          if (c.scope.kind === "zone") continue;
          const spannedToEnd = c.scope.kind === "range" && c.scope.to === n - 1;
          if (c.scope.from >= idx) c.scope.from += 1;
          if (c.scope.to >= idx || (appending && spannedToEnd)) c.scope.to += 1;
        }
        for (const m of t.markers) {
          if (m.waypoint >= idx) m.waypoint += 1;
          if (m.endWaypoint !== null && m.endWaypoint >= idx) m.endWaypoint += 1;
        }
      }, true);
      st().select({ kind: "waypoint", index: idx });
      return;
    }
    if (tool === "polygon" || tool === "zone" || tool === "keepOut") {
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
    if (tool === "pointAt" && traj) {
      const c = newConstraint("pointAt", traj.waypoints.length, p);
      updTraj((t) => { t.constraints.push(c); }, true);
      st().select({ kind: "constraint", id: c.id });
      st().setTool("select");
      return;
    }
    if (mode === "field" && tool === "select") {
      const o = hitObstacle(p);
      if (o) {
        st().select({ kind: "obstacle", id: o.id });
        st().checkpoint();
        drag.current = { kind: "obstacle", id: o.id, last: p };
        return;
      }
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
      case "waypoint":
        updTraj((t) => {
          const w = t.waypoints[d.index];
          w.x = snap(p[0] + d.dx);
          w.y = snap(p[1] + d.dy);
        });
        break;
      case "heading":
        updTraj((t) => {
          const w = t.waypoints[d.index];
          let a = Math.atan2(p[1] - w.y, p[0] - w.x);
          if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
          w.heading = a;
          w.headingMode = "fixed";
        });
        break;
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
    if ((tool === "polygon" || tool === "zone" || tool === "keepOut") && drawing.length >= 3) {
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
      if (readOnly) return;
      const sel = s.selection;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (sel.kind === "waypoint" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => {
            t.waypoints.splice(sel.index, 1);
            for (const c of t.constraints) {
              if (c.scope.from > sel.index) c.scope.from -= 1;
              if (c.scope.to >= sel.index) c.scope.to = Math.max(0, c.scope.to - 1);
            }
            t.markers = t.markers.filter((m) => m.waypoint !== sel.index);
            for (const m of t.markers) {
              if (m.waypoint > sel.index) m.waypoint -= 1;
              if (m.endWaypoint !== null && m.endWaypoint >= sel.index) m.endWaypoint = Math.max(0, m.endWaypoint - 1);
            }
          });
        } else if (sel.kind === "constraint" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => { t.constraints = t.constraints.filter((c) => c.id !== sel.id); });
        } else if (sel.kind === "marker" && s.selectedTraj) {
          s.updateTraj(s.selectedTraj, (t) => { t.markers = t.markers.filter((m) => m.id !== sel.id); });
        } else if (sel.kind === "obstacle") {
          s.updateProject((p) => { p.field.obstacles = p.field.obstacles.filter((o) => o.id !== sel.id); });
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
  const wps = traj?.waypoints ?? [];
  const issues = solveState?.issues ?? [];

  const cursorClass = readOnly ? "grab" : tool === "select" ? "default" : "crosshair";

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0 }}>
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
          <FieldArt field={field} />

          {/* obstacles */}
          {field.obstacles.map((o) => {
            const p = obstaclePoints(o);
            const sel = selId === o.id;
            const interactive = mode === "field";
            return (
              <g key={o.id} data-h={interactive ? `ob:${o.id}` : undefined} style={{ cursor: interactive && tool === "select" ? "move" : undefined }}>
                <polygon points={pts(p)} fill={o.enabled ? "url(#hatch)" : "none"}
                  stroke={sel ? "var(--accent)" : o.enabled ? "var(--accent)" : "var(--faint)"}
                  strokeOpacity={o.enabled || sel ? 0.9 : 0.6} strokeWidth={sel ? 2.5 : 1.2}
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
            <g transform={flipTransform}>
              {/* regions: zones, keep-in, keep-out */}
              {traj.constraints.map((c) => {
                let poly: Vec2[] | null = null;
                let kind: "zone" | "in" | "out" = "zone";
                if (c.scope.kind === "zone" && c.scope.region.length >= 3) poly = c.scope.region;
                else if (c.data.type === "keepOut") { poly = c.data.points; kind = "out"; }
                else if (c.data.type === "keepIn") { poly = c.data.points; kind = "in"; }
                if (!poly) return null;
                const sel = selId === c.id;
                const color = kind === "out" ? "var(--red)" : kind === "in" ? "var(--green)" : "var(--amber)";
                return (
                  <g key={c.id} opacity={c.enabled ? 1 : 0.4}>
                    <polygon data-h={`rg:${c.id}`} points={pts(poly)} fill={kind === "out" ? "url(#hatch-red)" : color}
                      fillOpacity={kind === "out" ? 1 : 0.07} stroke={color} strokeWidth={sel ? 2.5 : 1.5}
                      strokeDasharray="6 4" vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} />
                    {sel && poly.map(([x, y], i) => (
                      <circle key={i} data-h={`rv:${c.id}:${i}`} cx={x} cy={y} r={hr * 0.85} fill="var(--panel)" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    ))}
                  </g>
                );
              })}

              {/* candidate routes while solving */}
              {solveState?.status === "solving" && solveState.candidates?.map((cand, ci) => (
                <g key={ci}>
                  {cand.map((seg, si) => (
                    <polyline key={si} points={pts(seg as Vec2[])} fill="none" stroke="var(--faint)" strokeWidth={1.2} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
                  ))}
                </g>
              ))}

              {/* waypoint guide line */}
              {(!out || stale) && wps.length > 1 && (
                <polyline points={pts(wps.map((w) => [w.x, w.y]))} fill="none" stroke="var(--faint)" strokeWidth={1.2} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
              )}

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

              {/* waypoints */}
              {wps.map((w, i) => {
                const sel = i === selWp;
                const guide = w.translationMode === "guide";
                const color = sel ? "var(--accent)" : i === 0 ? "var(--green)" : "var(--accent-ink)";
                const c = Math.cos(w.heading), s = Math.sin(w.heading);
                const knobD = robot.bumper.front + 0.22;
                const knob: Vec2 = [w.x + c * knobD, w.y + s * knobD];
                return (
                  <g key={w.id}>
                    {!guide && (
                      <RobotShape robot={robot} x={w.x} y={w.y} h={w.heading} stroke={color}
                        fill={sel ? "var(--accent)" : "transparent"} opacity={sel ? 1 : 0.85}
                        dash={w.headingMode === "free" ? "5 4" : undefined} width={sel ? 2.2 : 1.4} />
                    )}
                    {sel && !guide && <polygon points={pts(footprint(robot, w.x, w.y, w.heading))} fill="var(--accent)" fillOpacity={0.08} />}
                    {w.tolerance.kind === "circle" && !guide && (
                      <circle cx={w.x} cy={w.y} r={w.tolerance.radius} fill="var(--accent)" fillOpacity={0.06} stroke="var(--accent)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    )}
                    {w.tolerance.kind === "box" && !guide && (
                      <rect x={w.x - w.tolerance.dx} y={w.y - w.tolerance.dy} width={2 * w.tolerance.dx} height={2 * w.tolerance.dy} fill="var(--accent)" fillOpacity={0.06} stroke="var(--accent)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    )}
                    {!guide && !readOnly && (
                      <>
                        <line x1={w.x + c * robot.bumper.front} y1={w.y + s * robot.bumper.front} x2={knob[0]} y2={knob[1]} stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                        <circle data-h={`hd:${i}`} cx={knob[0]} cy={knob[1]} r={hr * 0.8} fill="var(--panel)" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ cursor: "grab" }} />
                      </>
                    )}
                    <circle data-h={`wp:${i}`} cx={w.x} cy={w.y} r={guide ? hr * 0.9 : hr * 1.25}
                      fill={guide ? "var(--panel)" : color} stroke={guide ? color : "var(--panel)"} strokeWidth={2}
                      strokeDasharray={guide ? "2 2" : undefined} vectorEffect="non-scaling-stroke" style={{ cursor: readOnly ? undefined : "move" }} />
                    {w.stop && !guide && <rect x={w.x - hr * 0.45} y={w.y - hr * 0.45} width={hr * 0.9} height={hr * 0.9} fill="var(--panel)" pointerEvents="none" />}
                    {w.split && <circle cx={w.x} cy={w.y} r={hr * 2} fill="none" stroke="var(--amber)" strokeWidth={2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                  </g>
                );
              })}

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

              {/* playback robot with module forces */}
              {ghost && !stale && (
                <g pointerEvents="none">
                  <RobotShape robot={robot} x={ghost.x} y={ghost.y} h={ghost.heading} stroke="var(--accent)" fill="var(--accent)" width={2.2} opacity={0.9} />
                  {robot.modules.map(([mx, my], i) => {
                    const c = Math.cos(ghost.heading), s = Math.sin(ghost.heading);
                    const px = ghost.x + c * mx - s * my, py = ghost.y + s * mx + c * my;
                    const k = 0.004;
                    return <line key={i} x1={px} y1={py} x2={px + (ghost.fx[i] ?? 0) * k} y2={py + (ghost.fy[i] ?? 0) * k} stroke="var(--panel)" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
                  })}
                </g>
              )}

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
