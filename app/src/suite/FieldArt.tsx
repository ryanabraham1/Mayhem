import { memo } from "react";
/** An [x, y] point in meters. */
type Vec2 = number[];
/** One painted shape; `style` is a DECO_STYLE key (blueZone, tape, fuel, algae, structure, ...). */
export interface Decoration {
  kind: string; points: Vec2[]; center: Vec2; radius: number; style: string; width: number;
}
/** A season's field drawing (core/rebuilt-2026.json, core/reefscape-2025.json): its size in meters and what's painted on it. */
export interface FieldDrawing { length: number; width: number; decorations?: Decoration[] }
const pts = (p: Vec2[]) => p.map(([x, y]) => `${x},${y}`).join(" ");
const DECO_STYLE: Record<
  string,
  { fill?: string; stroke?: string; op?: number }
> = {
  blueZone: { fill: "var(--blue-alliance)", op: 0.045 },
  redZone: { fill: "var(--red-alliance)", op: 0.045 },
  tape: { stroke: "var(--field-line)" },
  blueTape: { stroke: "var(--blue-alliance)", op: 0.7 },
  redTape: { stroke: "var(--red-alliance)", op: 0.7 },
  fuel: { fill: "#e3b341", op: 0.22 },
  algae: { fill: "#2bb5a0", op: 0.35 },
  structure: { fill: "var(--structure)", stroke: "var(--structure-stroke)" },
  blue: {
    fill: "var(--blue-alliance)",
    stroke: "var(--blue-alliance)",
    op: 0.12,
  },
  red: { fill: "var(--red-alliance)", stroke: "var(--red-alliance)", op: 0.12 },
};

/** Game pieces staged on the field, left out where a replay draws its own. */
const GAME_PIECES = new Set(["fuel", "algae"]);

export const FieldArt = memo(function FieldArt({
  field,
  hideFuel,
}: {
  field: FieldDrawing;
  hideFuel?: boolean;
}) {
  const d = (field.decorations ?? []).filter(
    (x) => !(hideFuel && GAME_PIECES.has(x.style)),
  );
  const draw = (dec: Decoration, i: number) => {
    const st = DECO_STYLE[dec.style] ?? {};
    if (dec.kind === "circle")
      return (
        <circle
          key={i}
          cx={dec.center[0]}
          cy={dec.center[1]}
          r={dec.radius}
          fill={st.fill}
          opacity={st.op}
        />
      );
    if (dec.kind === "line")
      return (
        <polyline
          key={i}
          points={pts(dec.points)}
          stroke={st.stroke ?? st.fill}
          strokeWidth={dec.width}
          opacity={st.op}
          fill="none"
        />
      );
    return (
      <polygon
        key={i}
        points={pts(dec.points)}
        fill={st.fill ?? "none"}
        fillOpacity={st.op ?? 1}
        stroke={st.stroke}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        strokeOpacity={st.stroke ? 0.9 : 0}
      />
    );
  };
  return (
    <g>
      <rect
        x={0}
        y={0}
        width={field.length}
        height={field.width}
        fill="var(--carpet)"
      />
      {d.filter((x) => x.style.endsWith("Zone")).map(draw)}
      {d.filter((x) => !x.style.endsWith("Zone")).map(draw)}
      <rect
        x={0}
        y={0}
        width={field.length}
        height={field.width}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
});
