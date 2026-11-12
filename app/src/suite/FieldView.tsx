import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  AlertTriangle,
  CircleDot,
  ClipboardCopy,
  Copy,
  Maximize2,
  Minus,
  Navigation,
  Pencil,
  Plus,
  RotateCcw,
  RotateCw,
  Route,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { copyText, openContextMenu, type MenuItem } from "./ContextMenu";
import { routeSegments, routeWarnings } from "./core/routes.ts";
import { FieldArt } from "../components/FieldArt";
import seasonField from "./core/rebuilt-2026.json";
import type { Field } from "../types";
import { PATH_DEFAULTS, type AutoRoutine, type SuiteProject, type Pose } from "./core/model.ts";
import { isIntermediate } from "./core/runtime.ts";
export type FieldTool = "select" | "pose" | "translation" | "handoff";
interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Drag {
  kind: "position" | "heading";
  id: string;
  x: number;
  y: number;
  heading: number;
}
/** Legacy planner / Choreo convention: red (slow) through yellow to green (fast). */
export const speedColor = (fraction: number) =>
  `hsl(${Math.round(Math.max(0, Math.min(1, fraction)) * 120)}, 85%, 45%)`;
const SPEED_BUCKETS = 24;
/** Split a route into polylines of one speed color each (few SVG nodes, smooth joins). */
function speedRunsFor(path: { x: number; y: number; speed: number }[], maxSpeed: number) {
  const runs: { color: string; points: [number, number][] }[] = [];
  let bucket = -1;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 && runs.length) continue;
    const next = Math.round(
      (Math.max(0, Math.min(1, (a.speed + b.speed) / 2 / Math.max(1e-6, maxSpeed)))) * SPEED_BUCKETS,
    );
    if (next !== bucket) {
      bucket = next;
      runs.push({ color: speedColor(next / SPEED_BUCKETS), points: [[a.x, a.y]] });
    }
    runs[runs.length - 1].points.push([b.x, b.y]);
  }
  return runs;
}

export function FieldView({
  project,
  routine,
  pose,
  selected,
  tool,
  select,
  inspect,
  move,
  moveStart,
  rotate,
  place,
  remove,
  duplicate,
  resetStart,
  trail = [],
  speedPath,
  maxSpeed = 1,
}: {
  project: SuiteProject;
  routine: AutoRoutine;
  pose: Pose;
  selected: string;
  tool: FieldTool;
  select: (id: string) => void;
  inspect: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  moveStart: (pose: Pose) => void;
  rotate: (id: string, heading: number) => void;
  /** Add a goal at a field point; `kind` overrides the active tool (used by the context menu). */
  place: (x: number, y: number, kind?: Exclude<FieldTool, "select">) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** Clear the routine's own start so it follows the robot default. Omit when there is none. */
  resetStart?: () => void;
  /** Poses already driven in the preview, drawn behind the robot. */
  trail?: Pose[];
  /** The whole previewed route with speed (m/s); drawn colored by speed instead of the trail. */
  speedPath?: { x: number; y: number; speed: number }[];
  /** Speed drawn fully green. */
  maxSpeed?: number;
}) {
  const speedRuns = useMemo(() => speedRunsFor(speedPath ?? [], maxSpeed), [speedPath, maxSpeed]);
  const svg = useRef<SVGSVGElement>(null);
  const { width, height } = project.field;
  const fit = (): View => ({
    x: -0.7,
    y: -0.7,
    w: width + 1.4,
    h: height + 1.4,
  });
  const [view, setView] = useState(fit),
    [drag, setDrag] = useState<Drag | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const pan = useRef<{ sx: number; sy: number; view: View } | null>(null);
  const [hover, setHover] = useState<Pose | null>(null);
  const segments = useMemo(
    () => routeSegments(project, routine),
    [project, routine],
  );
  const warnings = useMemo(
    () => routeWarnings(project, routine),
    [project, routine],
  );
  const start =
    drag?.id === "@start" ? drag : (routine.start ?? project.robot.start);
  const goals = routine.nodes.filter((n) => n.kind === "pose" && n.goal);
  const positions = goals.map((n) =>
    drag?.id === n.id ? { ...n.goal!, ...drag } : n.goal!,
  );
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
  };
  const fieldPoint = (e: { clientX: number; clientY: number }) => {
    const p = svgPoint(e);
    return (
      p && {
        x: Math.max(0, Math.min(width, p.x)),
        y: Math.max(0, Math.min(height, height - p.y)),
      }
    );
  };
  const startGoalDrag = (
    event: PointerEvent<SVGGElement>,
    id: string,
    kind: Drag["kind"],
    goal: Pose,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY };
    select(id);
    setDrag({ kind, id, ...goal });
  };
  const zoom = (factor: number) =>
    setView((v) => ({
      x: v.x + (v.w * (1 - factor)) / 2,
      y: v.y + (v.h * (1 - factor)) / 2,
      w: v.w * factor,
      h: v.h * factor,
    }));
  return (
    <div className="mx-field-wrap">
      {warnings.length > 0 && (
        <details className="mx-field-warnings">
          <summary>
            <AlertTriangle size={14} />
            {warnings.length} clearance {warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <div>
            {warnings.map((w, i) => (
              <button key={i} onClick={() => inspect(w.nodeId)}>
                {w.message}
              </button>
            ))}
            <p>
              Straight-segment checks against field structures. The preview
              does not simulate contact.
            </p>
          </div>
        </details>
      )}
      <svg
        ref={svg}
        className="mx-field"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        aria-label="Autonomous field editor"
        style={{
          cursor:
            tool === "select"
              ? pan.current
                ? "grabbing"
                : "grab"
              : "crosshair",
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (tool !== "select") {
            const p = fieldPoint(e);
            if (p) place(p.x, p.y);
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          pan.current = { sx: e.clientX, sy: e.clientY, view: { ...view } };
        }}
        onPointerMove={(e) => {
          const p = fieldPoint(e);
          if (p) setHover({ ...p, heading: 0 });
          if (drag && p) {
            if (drag.kind === "position") setDrag({ ...drag, ...p });
            else {
              let heading = Math.atan2(p.y - drag.y, p.x - drag.x);
              if (e.shiftKey)
                heading = (Math.round(heading / (Math.PI / 12)) * Math.PI) / 12;
              setDrag({ ...drag, heading });
            }
          } else if (pan.current) {
            const matrix = svg.current?.getScreenCTM();
            if (!matrix) return;
            setView({
              ...pan.current.view,
              x: pan.current.view.x - (e.clientX - pan.current.sx) / matrix.a,
              y: pan.current.view.y - (e.clientY - pan.current.sy) / matrix.d,
            });
          }
        }}
        onPointerUp={(e) => {
          if (drag) {
            if (
              Math.hypot(
                e.clientX - dragStart.current.x,
                e.clientY - dragStart.current.y,
              ) < 3
            )
              inspect(drag.id);
            else if (drag.id === "@start")
              moveStart({ x: drag.x, y: drag.y, heading: drag.heading });
            else if (drag.kind === "position") move(drag.id, drag.x, drag.y);
            else rotate(drag.id, drag.heading);
            setDrag(null);
          }
          pan.current = null;
        }}
        onPointerCancel={() => {
          setDrag(null);
          pan.current = null;
        }}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => {
          const p = fieldPoint(e);
          if (!p) return;
          const at = `${p.x.toFixed(2)}, ${p.y.toFixed(2)} m`;
          openContextMenu(
            e,
            [
              { label: "Add pose goal here", icon: Navigation, onSelect: () => place(p.x, p.y, "pose") },
              { label: "Add translation here", icon: CircleDot, onSelect: () => place(p.x, p.y, "translation") },
              { label: "Add handoff here", icon: Route, onSelect: () => place(p.x, p.y, "handoff") },
              "separator",
              {
                label: "Move start here",
                icon: Navigation,
                onSelect: () => moveStart({ ...start, x: p.x, y: p.y }),
              },
              {
                label: "Copy coordinates",
                icon: ClipboardCopy,
                onSelect: () => void copyText(`${p.x.toFixed(3)}, ${p.y.toFixed(3)}`),
              },
              "separator",
              {
                label: "Zoom in here",
                icon: ZoomIn,
                onSelect: () =>
                  setView((v) => {
                    const pt = { x: p.x, y: height - p.y };
                    return { x: pt.x - (v.w * 0.6) / 2, y: pt.y - (v.h * 0.6) / 2, w: v.w * 0.6, h: v.h * 0.6 };
                  }),
              },
              { label: "Fit field", icon: Maximize2, onSelect: () => setView(fit()) },
            ],
            at,
          );
        }}
        onDoubleClick={(e) => {
          if (tool === "select") {
            const p = fieldPoint(e);
            if (p) place(p.x, p.y);
          }
        }}
        onWheel={(e) => {
          const p = svgPoint(e);
          if (!p) return;
          const factor = Math.exp(
            Math.max(-0.2, Math.min(0.2, e.deltaY * 0.001)),
          );
          const w = Math.max(2, Math.min(width * 3, view.w * factor));
          const ratio = w / view.w;
          setView({
            x: p.x - (p.x - view.x) * ratio,
            y: p.y - (p.y - view.y) * ratio,
            w,
            h: view.h * ratio,
          });
        }}
      >
        <g
          transform={`translate(0 ${height}) scale(${width / seasonField.length} ${-height / seasonField.width})`}
          aria-label="2026 REBUILT vector field"
          aria-hidden="true"
          style={{ pointerEvents: "none" }}
        >
          <FieldArt field={seasonField as Field} />
        </g>
        {Array.from({ length: Math.floor(width) + 1 }, (_, i) => (
          <text
            key={i}
            x={i}
            y={height + 0.32}
            textAnchor="middle"
            className="mx-field-tick"
          >
            {i}
          </text>
        ))}
        {segments.map((segment) => {
          const from = segment.fromId
            ? (positions[goals.findIndex((n) => n.id === segment.fromId)] ??
              segment.from)
            : start;
          const to =
            positions[goals.findIndex((n) => n.id === segment.toId)] ??
            segment.to;
          const d = `M${from.x},${height - from.y} L${to.x},${height - to.y}`;
          return (
            <g
              key={`${segment.fromId ?? "start"}:${segment.toId}`}
              pointerEvents="none"
            >
              <path
                d={d}
                fill="none"
                stroke="var(--mx-halo)"
                strokeWidth=".11"
              />
              <path
                d={d}
                fill="none"
                stroke="var(--mx-path)"
                strokeWidth=".05"
                strokeLinecap="round"
              />
            </g>
          );
        })}
        <g
          role="button"
          tabIndex={0}
          aria-label="Select starting pose"
          aria-pressed={selected === "@start"}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            select("@start");
            openContextMenu(
              e,
              [
                { label: "Edit starting pose", icon: Pencil, onSelect: () => inspect("@start") },
                { label: "Copy pose", icon: ClipboardCopy, onSelect: () => void copyText(poseText(start)) },
                ...turnItems(start, (heading) => moveStart({ x: start.x, y: start.y, heading })),
                "separator",
                resetStart && {
                  label: "Use robot default start",
                  icon: RotateCcw,
                  onSelect: resetStart,
                },
              ],
              "Starting pose",
            );
          }}
          onPointerDown={(e) => startGoalDrag(e, "@start", "position", start)}
          onKeyDown={(e) => {
            if (e.key === "Enter") inspect("@start");
          }}
          transform={`translate(${start.x},${height - start.y})`}
          style={{ cursor: "grab" }}
        >
          <g transform={`rotate(${(-start.heading * 180) / Math.PI})`}>
            <rect
              x={-project.robot.length / 2}
              y={-project.robot.width / 2}
              width={project.robot.length}
              height={project.robot.width}
              rx=".07"
              fill="var(--mx-start-soft)"
              stroke="var(--mx-start)"
              strokeWidth=".035"
            />
            <path d="M0,0 H.78" stroke="var(--mx-start)" strokeWidth=".03" />
            <circle
              r=".15"
              fill="var(--mx-start)"
              stroke="var(--mx-halo)"
              strokeWidth=".03"
            />
            <g
              role="button"
              tabIndex={0}
              aria-label="Rotate starting pose"
              onPointerDown={(e) =>
                startGoalDrag(e, "@start", "heading", start)
              }
            >
              <circle cx=".78" r=".19" fill="transparent" />
              <circle
                cx=".78"
                r=".085"
                fill="var(--mx-halo)"
                stroke="var(--mx-start)"
                strokeWidth=".035"
              />
            </g>
          </g>
          <text y=".7" textAnchor="middle" className="mx-goal-label">
            Start
          </text>
        </g>
        {goals.map((node, i) => {
          const goal = positions[i],
            active = node.id === selected,
            translationOnly = node.goal?.headingMode === "free",
            // The circle the robot must enter: handoff radius for pass-through
            // points, end tolerance where the path stops.
            ringRadius = isIntermediate(routine, node)
              ? goal.handoffRadius > 0
                ? goal.handoffRadius
                : (node.constraints?.handoffRadius ?? node.generatedConstraints?.handoffRadius ?? routine.constraints?.handoffRadius ?? project.robot.constraints.handoffRadius ?? PATH_DEFAULTS.handoffRadius)
              : goal.translationTolerance;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`Select goal ${node.name}`}
              aria-pressed={active}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(node.id);
                }
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  e.stopPropagation();
                  remove(node.id);
                }
              }}
              onPointerDown={(e) => startGoalDrag(e, node.id, "position", goal)}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                select(node.id);
                openContextMenu(
                  e,
                  [
                    { label: "Edit details", icon: Pencil, onSelect: () => inspect(node.id) },
                    { label: "Duplicate goal", icon: Copy, onSelect: () => duplicate(node.id) },
                    { label: "Copy pose", icon: ClipboardCopy, onSelect: () => void copyText(poseText(goal)) },
                    ...turnItems(goal, (heading) => rotate(node.id, heading)),
                    "separator",
                    { label: "Delete goal", icon: Trash2, danger: true, hint: "Del", onSelect: () => remove(node.id) },
                  ],
                  node.name,
                );
              }}
              className="mx-goal"
            >
              <circle
                cx={goal.x}
                cy={height - goal.y}
                r={Math.max(translationOnly ? 0.18 : 0.24, ringRadius)}
                fill={active ? "var(--mx-path-soft)" : "transparent"}
                stroke="var(--mx-path)"
                strokeWidth=".018"
                strokeDasharray=".05 .05"
              />
              {translationOnly ? (
                <circle
                  cx={goal.x}
                  cy={height - goal.y}
                  r=".13"
                  fill="var(--mx-path)"
                  stroke="var(--mx-halo)"
                  strokeWidth=".035"
                />
              ) : (
              <g
                transform={`translate(${goal.x},${height - goal.y}) rotate(${(-goal.heading * 180) / Math.PI})`}
              >
                <rect
                  x={-project.robot.length / 2}
                  y={-project.robot.width / 2}
                  width={project.robot.length}
                  height={project.robot.width}
                  fill={active ? "var(--mx-path-soft)" : "transparent"}
                  stroke="var(--mx-path)"
                  strokeWidth=".025"
                  rx=".04"
                />
                <path
                  d="M0,0 H.78"
                  stroke="var(--mx-path)"
                  strokeWidth=".035"
                />
                <circle
                  r=".16"
                  fill="var(--mx-path)"
                  stroke="var(--mx-halo)"
                  strokeWidth=".035"
                />
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`Rotate goal ${node.name}`}
                  onPointerDown={(e) =>
                    startGoalDrag(e, node.id, "heading", goal)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      rotate(
                        node.id,
                        goal.heading +
                          ((e.key === "ArrowLeft" ? 1 : -1) * Math.PI) / 36,
                      );
                    }
                  }}
                  style={{ cursor: "crosshair" }}
                >
                  <circle cx=".78" r=".19" fill="transparent" />
                  <circle
                    cx=".78"
                    r=".085"
                    fill="var(--mx-halo)"
                    stroke="var(--mx-path)"
                    strokeWidth=".035"
                  />
                </g>
              </g>
              )}
              <text
                x={goal.x}
                y={height - goal.y - (translationOnly ? 0.36 : 0.63)}
                textAnchor="middle"
                className="mx-goal-label"
              >
                {active
                  ? `${routine.nodes.indexOf(node) + 1}. ${node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}`
                  : routine.nodes.indexOf(node) + 1}
              </text>
            </g>
          );
        })}
        {tool !== "select" && hover && !drag && (
          <g
            transform={`translate(${hover.x},${height - hover.y})`}
            pointerEvents="none"
            opacity=".4"
          >
            <circle r=".16" fill="var(--mx-path)" />
            <rect
              x="-.42"
              y="-.42"
              width=".84"
              height=".84"
              fill="none"
              stroke="var(--mx-path)"
              strokeWidth=".025"
            />
          </g>
        )}
        {speedRuns.map((run, i) => (
          <polyline
            key={i}
            className="mx-speed-path"
            points={run.points.map(([x, y]) => `${x},${height - y}`).join(" ")}
            fill="none"
            stroke={run.color}
            strokeWidth=".09"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        ))}
        {!speedRuns.length && trail.length > 1 && (
          <polyline
            className="mx-trail"
            points={trail.map((p) => `${p.x},${height - p.y}`).join(" ")}
            fill="none"
            stroke="var(--mx-trail)"
            strokeWidth=".09"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}
        <g
          transform={`translate(${pose.x},${height - pose.y}) rotate(${(-pose.heading * 180) / Math.PI})`}
          style={{ pointerEvents: "none" }}
        >
          <rect
            x={-project.robot.length / 2}
            y={-project.robot.width / 2}
            width={project.robot.length}
            height={project.robot.width}
            rx=".1"
            fill="var(--mx-path-soft)"
            stroke="var(--mx-path)"
            strokeWidth=".04"
          />
          <path
            d="M-.12,-.17 L.15,0 L-.12,.17"
            fill="none"
            stroke="var(--mx-path)"
            strokeWidth=".055"
          />
          <path
            d={`M${project.robot.length / 2},${-project.robot.width / 2 + 0.1} V${project.robot.width / 2 - 0.1}`}
            stroke="var(--mx-path)"
            strokeWidth=".08"
          />
        </g>
      </svg>
      <div className="mx-field-zoom">
        <button aria-label="Zoom in" onClick={() => zoom(0.8)}>
          <Plus size={15} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoom(1.2)}>
          <Minus size={15} />
        </button>
        <button aria-label="Fit field" onClick={() => setView(fit())}>
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="mx-field-readout" aria-hidden="true">
        {hover
          ? `${hover.x.toFixed(2)}, ${hover.y.toFixed(2)} m`
          : tool === "select"
            ? "Double-click to add a pose · drag to pan · scroll to zoom"
            : "Click to place · Esc to select"}
      </div>
    </div>
  );
}

const poseText = (p: Pose) =>
  `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${((p.heading * 180) / Math.PI).toFixed(1)}°`;

/** Quick heading tweaks: turn 90° either way, or snap to face an alliance wall. */
function turnItems(p: Pose, set: (heading: number) => void): MenuItem[] {
  const wrap = (h: number) => Math.atan2(Math.sin(h), Math.cos(h));
  return [
    "separator",
    { label: "Turn 90° left", icon: RotateCcw, onSelect: () => set(wrap(p.heading + Math.PI / 2)) },
    { label: "Turn 90° right", icon: RotateCw, onSelect: () => set(wrap(p.heading - Math.PI / 2)) },
    { label: "Face 0° (red wall)", onSelect: () => set(0) },
    { label: "Face 180° (blue wall)", onSelect: () => set(Math.PI) },
  ];
}
