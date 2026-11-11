import { memo } from "react";
import type { Decoration, Field, Vec2 } from "../types";
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
  structure: { fill: "var(--structure)", stroke: "var(--structure-stroke)" },
  blue: {
    fill: "var(--blue-alliance)",
    stroke: "var(--blue-alliance)",
    op: 0.12,
  },
  red: { fill: "var(--red-alliance)", stroke: "var(--red-alliance)", op: 0.12 },
};

export const FieldArt = memo(function FieldArt({
  field,
  hideFuel,
}: {
  field: Field;
  hideFuel?: boolean;
}) {
  const d = (field.decorations ?? []).filter(
    (x) => !(hideFuel && x.style === "fuel"),
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
