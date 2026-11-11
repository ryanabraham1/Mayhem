import { useMemo, useRef, useState } from "react";
import { plotSeries } from "../core/plot.ts";
import { valueAt, type Channel, type Finding } from "../core/analysis.ts";

const VW = 1000,
  VH = 220,
  L = 44,
  R = 12,
  T = 12,
  B = 26;

export function SignalChart({
  channel,
  overlay,
  duration,
  cursor,
  seek,
  findings = [],
  threshold,
  unit,
  label = "Recorded signal graph",
}: {
  channel?: Channel;
  overlay?: Channel;
  duration: number;
  cursor: number;
  seek: (time: number) => void;
  findings?: Finding[];
  threshold?: { value: number; label: string };
  unit?: string;
  label?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => plotSeries(channel), [channel]);
  const overlaySeries = useMemo(() => plotSeries(overlay), [overlay]);
  const span = Math.max(duration, 0.001);
  const x = (t: number) => L + (t / span) * (VW - L - R);
  const range = (s: typeof series) => {
    let min = s.min,
      max = s.max;
    if (threshold && s === series) {
      min = Math.min(min, threshold.value);
      max = Math.max(max, threshold.value);
    }
    if (max - min < 1e-9) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  };
  const main = range(series);
  const y = (v: number, r = main) => T + (1 - (v - r.min) / (r.max - r.min)) * (VH - T - B);
  const path = (s: typeof series, r: typeof main) =>
    s.samples.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(Number(p.value), r).toFixed(1)}`).join("");
  const overlayRange = range(overlaySeries);
  const timeAt = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return 0;
    const px = ((clientX - box.left) / box.width) * VW;
    return Math.max(0, Math.min(span, ((px - L) / (VW - L - R)) * span));
  };
  if (!series.samples.length)
    return (
      <div className="mx-chart-empty">
        {channel?.samples.length ? "This signal isn't numeric, so it can't be graphed." : "No samples recorded for this signal."}
      </div>
    );
  const ticks = [main.min, (main.min + main.max) / 2, main.max];
  const shown = hover ?? cursor;
  const value = valueAt(channel, shown);
  return (
    <div className="mx-chart">
      <div className="mx-chart-readout">
        <code>
          {typeof value === "number" ? value.toFixed(2) : String(value ?? "—")}
          {unit && <small>{unit}</small>}
        </code>
        <span>at {shown.toFixed(2)} s</span>
        {overlay && (
          <span className="mx-chart-overlay-key">
            <i /> {overlay.name}: {String(valueAt(overlay, shown) ?? "—")}
          </span>
        )}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="none"
        aria-label={label}
        role="img"
        onPointerMove={(e) => setHover(timeAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => seek(timeAt(e.clientX))}
      >
        {findings.map((f) => (
          <rect
            key={f.id}
            className={`mx-chart-span is-${f.severity}`}
            x={x(f.start)}
            y={T}
            width={Math.max(2, x(f.end) - x(f.start))}
            height={VH - T - B}
          />
        ))}
        {ticks.map((t, i) => (
          <g key={i}>
            <line className="mx-chart-grid" x1={L} x2={VW - R} y1={y(t)} y2={y(t)} />
            <text className="mx-chart-tick" x={L - 6} y={y(t) + 4} textAnchor="end">
              {Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(1)}
            </text>
          </g>
        ))}
        {threshold && (
          <g>
            <line className="mx-chart-threshold" x1={L} x2={VW - R} y1={y(threshold.value)} y2={y(threshold.value)} />
            <text className="mx-chart-tick is-threshold" x={VW - R - 4} y={y(threshold.value) - 5} textAnchor="end">
              {threshold.label}
            </text>
          </g>
        )}
        {overlay && overlaySeries.samples.length > 0 && (
          <path className="mx-chart-overlay" d={path(overlaySeries, overlayRange)} vectorEffect="non-scaling-stroke" />
        )}
        <path className="mx-chart-line" d={path(series, main)} vectorEffect="non-scaling-stroke" />
        <line className="mx-chart-cursor" x1={x(cursor)} x2={x(cursor)} y1={T} y2={VH - B} vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <line className="mx-chart-hover" x1={x(hover)} x2={x(hover)} y1={T} y2={VH - B} vectorEffect="non-scaling-stroke" />
        )}
        <text className="mx-chart-tick" x={L} y={VH - 6}>
          0 s
        </text>
        <text className="mx-chart-tick" x={VW - R} y={VH - 6} textAnchor="end">
          {duration.toFixed(1)} s
        </text>
      </svg>
    </div>
  );
}

/** A compact strip showing where each finding happens across the recording. */
export function FindingTimeline({
  findings,
  duration,
  cursor,
  seek,
}: {
  findings: Finding[];
  duration: number;
  cursor: number;
  seek: (time: number, finding?: Finding) => void;
}) {
  const span = Math.max(duration, 0.001);
  const pct = (t: number) => `${(t / span) * 100}%`;
  return (
    <div
      className="mx-timeline"
      role="slider"
      aria-label="Recording time"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={cursor}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") seek(Math.min(duration, cursor + 1));
        if (e.key === "ArrowLeft") seek(Math.max(0, cursor - 1));
      }}
      onPointerDown={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        seek(((e.clientX - box.left) / box.width) * span);
      }}
    >
      {findings.map((f) => (
        <button
          key={f.id}
          className={`mx-timeline-mark is-${f.severity}`}
          style={{ left: pct(f.start), width: `max(6px, ${pct(f.end - f.start)})` }}
          title={`${f.title} · ${f.start.toFixed(1)} s`}
          aria-label={`${f.title} at ${f.start.toFixed(1)} seconds`}
          onPointerDown={(e) => {
            e.stopPropagation();
            seek(f.start, f);
          }}
        />
      ))}
      <span className="mx-timeline-cursor" style={{ left: pct(cursor) }} />
    </div>
  );
}
