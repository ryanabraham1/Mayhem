import { useEffect, useRef, useState } from "react";
import { Check, Circle, Code2, Flag, Navigation, Zap } from "lucide-react";
import {
  conditionLabel,
  evaluate,
  type AutoRoutine,
  type Signals,
} from "./core/model.ts";
export function StateView({
  routine,
  signals,
  selected,
  active,
  select,
}: {
  routine: AutoRoutine;
  signals: Signals;
  selected: string;
  active: string;
  select: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(900);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setAvailable(element.clientWidth),
    );
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(
      1,
      Math.min(3, routine.nodes.length, Math.floor((available - 20) / 260)),
    ),
    rows = Math.ceil(routine.nodes.length / columns);
  const position = (id: string) => {
    const i = routine.nodes.findIndex((n) => n.id === id);
    return {
      x: 36 + (i % columns) * 260,
      y: 40 + Math.floor(i / columns) * 174,
    };
  };
  return (
    <div className="ms-state-scroll" ref={container}>
      <div
        className="ms-state-canvas"
        style={{ width: columns * 260 + 25, height: rows * 174 + 70 }}
      >
        <svg
          className="ms-state-wires"
          width="100%"
          height="100%"
          aria-label="State transitions"
        >
          <defs>
            <marker
              id="ms-state-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L7,3.5 L0,7" fill="var(--ms-wire,#9bacc0)" />
            </marker>
          </defs>
          {routine.transitions.map((t) => {
            const a = position(t.from),
              b = position(t.to),
              sameRow = a.y === b.y;
            const d = sameRow
              ? `M${a.x + 214},${a.y + 47} C${a.x + 243},${a.y + 47} ${b.x - 22},${b.y + 47} ${b.x},${b.y + 47}`
              : `M${a.x + 107},${a.y + 94} C${a.x + 107},${a.y + 140} ${b.x + 107},${b.y - 35} ${b.x + 107},${b.y}`;
            return (
              <path
                key={t.id}
                d={d}
                fill="none"
                stroke={
                  t.from === active && evaluate(t.condition, signals)
                    ? "var(--ms-blue,#2469e8)"
                    : "var(--ms-wire,#b5c3d3)"
                }
                strokeWidth="2"
                markerEnd="url(#ms-state-arrow)"
              >
                <title>{conditionLabel(t.condition)}</title>
              </path>
            );
          })}
        </svg>
        {routine.nodes.map((node) => {
          const p = position(node.id),
            Icon =
              node.kind === "pose"
                ? Navigation
                : node.kind === "finish"
                  ? Flag
                  : node.kind === "custom"
                    ? Code2
                    : Zap;
          return (
            <button
              key={node.id}
              aria-current={active === node.id ? "step" : undefined}
              className={`ms-state-node ${selected === node.id ? "selected" : ""} ${active === node.id ? "active" : ""}`}
              style={{ left: p.x, top: p.y }}
              onClick={() => select(node.id)}
            >
              <span className="ms-node-kind">
                <Icon size={13} />
                {node.kind === "pose"
                  ? "Pose goal"
                  : node.kind === "finish"
                    ? "Finish"
                    : node.kind === "custom"
                      ? "Custom C++"
                      : "Robot action"}
                {node.id === active && <i className="ms-dot blue" />}
              </span>
              <strong>{node.name}</strong>
              <small>
                {node.kind === "pose"
                  ? "Measured arrival"
                  : node.action || "Routine succeeded"}
              </small>
            </button>
          );
        })}
      </div>
      <div className="ms-guard-panel">
        <div className="ms-panel-heading">
          Outgoing conditions <span>Declared order sets priority</span>
        </div>
        {routine.transitions
          .filter((t) => t.from === selected)
          .map((t) => (
            <div className="ms-guard" key={t.id}>
              {evaluate(t.condition, signals) ? (
                <Check size={15} className="ms-good" />
              ) : (
                <Circle size={15} />
              )}
              <code>{conditionLabel(t.condition)}</code>
              <span>→ {routine.nodes.find((n) => n.id === t.to)?.name}</span>
            </div>
          ))}
        {!routine.transitions.some((t) => t.from === selected) && (
          <p className="ms-muted">This is a terminal state.</p>
        )}
      </div>
    </div>
  );
}
