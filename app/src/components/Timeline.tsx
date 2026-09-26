import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { LineChart, Pause, Play } from "lucide-react";
import { useStore } from "../store";
import { moduleCurrents, sampleAt, totalTime } from "../model";
import type { Trajectory } from "../types";

export function BottomBar() {
  const traj = useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
  const view = useStore((s) => s.view);
  const solving = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj]?.status === "solving" : false));
  const stage = useStore((s) => (s.selectedTraj ? s.solves[s.selectedTraj]?.stage : undefined));
  const showGraphs = useStore((s) => s.showGraphs);
  if (!traj || view !== "paths") return <div className="bottombar" />;
  return (
    <div className="bottombar">
      {solving && <div className="progress"><div /></div>}
      <Timeline traj={traj} solvingStage={solving ? stage : undefined} />
      {showGraphs && traj.output && <Graphs traj={traj} />}
    </div>
  );
}

export function Timeline({ traj, solvingStage }: { traj: Trajectory; solvingStage?: string }) {
  const playback = useStore((s) => s.playback);
  const stale = useStore((s) => s.stale[traj.name]);
  const showGraphs = useStore((s) => s.showGraphs);
  const T = totalTime(traj.output);
  const set = useStore.getState().setPlayback;

  // animation loop
  useEffect(() => {
    if (!playback.playing || T <= 0) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const cur = useStore.getState().playback;
      let t = cur.t + dt * cur.speed;
      if (t > T) t = 0;
      set({ t });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playback.playing, T, set]);

  // space toggles playback
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.code === "Space") {
        e.preventDefault();
        const p = useStore.getState().playback;
        set({ playing: !p.playing });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  const s = traj.output ? sampleAt(traj.output, Math.min(playback.t, T)) : null;
  const pct = (t: number) => `calc(${(t / Math.max(T, 1e-6)) * 100}% )`;
  return (
    <div className="timeline">
      <button className="btn ghost icon" onClick={() => set({ playing: !playback.playing })} disabled={!T} title="Play / pause (space)">
        {playback.playing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <div className="scrub-wrap">
        {traj.output && traj.output.waypointTimes.map((t, i) => <span key={"w" + i} className="tick" style={{ left: pct(t) }} />)}
        {traj.output && traj.output.events.map((e, i) => <span key={"e" + i} className="tick marker" style={{ left: pct(e.t) }} title={e.name} />)}
        <input className="scrub" type="range" min={0} max={Math.max(T, 0.001)} step={0.001} value={Math.min(playback.t, T)} disabled={!T}
          onChange={(e) => set({ t: +e.target.value, playing: false })} />
      </div>
      <div className="time-readout">
        {solvingStage ? <>optimizing · {solvingStage}</> : s
          ? <><b>{Math.min(playback.t, T).toFixed(2)}</b> / {T.toFixed(2)} s · {Math.hypot(s.vx, s.vy).toFixed(2)} m/s{stale ? " · out of date" : ""}</>
          : "not generated"}
      </div>
      <select className="select" style={{ width: 64, height: 28 }} value={playback.speed} onChange={(e) => set({ speed: +e.target.value })} title="Playback speed">
        {[0.25, 0.5, 1, 2].map((v) => <option key={v} value={v}>{v}×</option>)}
      </select>
      <button className={`btn ghost icon ${showGraphs ? "on" : ""}`} disabled={!traj.output} onClick={() => useStore.getState().setShowGraphs(!showGraphs)} title="Graphs">
        <LineChart size={16} />
      </button>
    </div>
  );
}

type GraphKind = "velocity" | "accel" | "current" | "force";

export function Graphs({ traj }: { traj: Trajectory }) {
  const project = useStore((s) => s.project)!;
  const [kind, setKind] = useState<GraphKind>("velocity");
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const tRef = useRef(0);
  const playbackT = useStore((s) => s.playback.t);
  const out = traj.output;

  const data = useMemo(() => {
    if (!out) return null;
    const T = totalTime(out);
    const n = Math.min(600, Math.max(60, Math.round(T / 0.01)));
    const ts: number[] = [];
    const cols: number[][] = [[], [], [], [], []];
    for (let i = 0; i <= n; i++) {
      const t = (T * i) / n;
      const s = sampleAt(out, t);
      ts.push(t);
      if (kind === "velocity") {
        cols[0].push(Math.hypot(s.vx, s.vy));
        cols[1].push(s.omega);
      } else if (kind === "accel") {
        cols[0].push(Math.hypot(s.ax, s.ay));
        cols[1].push(s.alpha);
      } else if (kind === "current") {
        moduleCurrents(project.robot, s).forEach((c, k) => cols[k].push(c));
        cols[4].push(project.robot.motor.currentLimit);
      } else {
        s.fx.forEach((f, k) => cols[k].push(Math.hypot(f, s.fy[k])));
      }
    }
    return [ts, ...cols.filter((c) => c.length)] as uPlot.AlignedData;
  }, [out, kind, project.robot]);

  useEffect(() => {
    tRef.current = playbackT;
    plot.current?.redraw(false);
  }, [playbackT]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !data) return;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#6b3fe6";
    const amber = css.getPropertyValue("--amber").trim() || "#c27806";
    const muted = css.getPropertyValue("--muted").trim() || "#6c6880";
    const grid = css.getPropertyValue("--border").trim() || "#e8e6f0";
    const red = css.getPropertyValue("--red").trim() || "#d13a3a";
    const palette = [accent, "#2bb3a3", amber, "#e0508a"];
    const labels: Record<GraphKind, [string, string][]> = {
      velocity: [["Speed (m/s)", accent], ["ω (rad/s)", amber]],
      accel: [["|a| (m/s²)", accent], ["α (rad/s²)", amber]],
      current: [["FL (A)", palette[0]], ["FR (A)", palette[1]], ["BL (A)", palette[2]], ["BR (A)", palette[3]], ["Limit", red]],
      force: [["FL (N)", palette[0]], ["FR (N)", palette[1]], ["BL (N)", palette[2]], ["BR (N)", palette[3]]],
    };
    const series: uPlot.Series[] = [{ label: "t (s)", value: (_u, v) => (v == null ? "" : v.toFixed(2)) }];
    labels[kind].slice(0, data.length - 1).forEach(([label, stroke], i) =>
      series.push({ label, stroke, width: 2, dash: kind === "current" && i === 4 ? [6, 4] : undefined,
        value: (_u, v) => (v == null ? "" : v.toFixed(2)) }));
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: 150,
      series,
      scales: { x: { time: false } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font: "11px JetBrains Mono" },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font: "11px JetBrains Mono", size: 44 },
      ],
      cursor: { drag: { x: false, y: false } },
      hooks: {
        draw: [(u) => {
          const x = u.valToPos(tRef.current, "x", true);
          const ctx = u.ctx;
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5 * devicePixelRatio;
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.restore();
        }],
      },
    };
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const onClick = () => {
      const idx = u.cursor.idx;
      if (idx != null) useStore.getState().setPlayback({ t: data[0][idx] as number, playing: false });
    };
    u.over.addEventListener("click", onClick);
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: 150 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [data, kind]);

  if (!out) return null;
  return (
    <div>
      <div className="graph-tabs">
        {([["velocity", "Velocity"], ["accel", "Acceleration"], ["current", "Motor current"], ["force", "Module force"]] as [GraphKind, string][]).map(([k, l]) => (
          <button key={k} className={`btn sm ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      <div className="graphs" ref={ref} />
    </div>
  );
}

