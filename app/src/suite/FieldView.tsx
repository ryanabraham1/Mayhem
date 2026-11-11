import { useMemo, useRef, useState, type PointerEvent } from "react";
import { Crosshair, Maximize2, Minus, Plus } from "lucide-react";
import { routeSegments, routeWarnings } from "./core/routes.ts";
import { FieldArt } from "../components/FieldArt";
import seasonField from "./core/rebuilt-2026.json";
import type { Field } from "../types";
import type { AutoRoutine, SuiteProject, Pose } from "./core/model.ts";
import {autoStepLabel} from './core/model.ts';
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
  place: (x: number, y: number) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
}) {
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
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
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
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY };
    select(id);
    setMenu(null);
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
    <div className="ms-field-wrap" onContextMenu={(e) => e.preventDefault()}>
      <div className="ms-canvas-caption">
        <span>
          <Crosshair size={14} />
          {project.field.name === "Practice field"
            ? "2026 REBUILT"
            : project.field.name}
        </span>
        <span>
          {tool === "select"
            ? "Drag to pan · scroll to zoom · double-click to add a pose"
            : "Click the field to place a goal · Esc to select"}
        </span>
      </div>
      {warnings.length > 0 && (
        <details className="ms-route-warnings">
          <summary>{warnings.length} route clearance warnings</summary>
          {warnings.map((w, i) => (
            <button key={i} onClick={() => inspect(w.nodeId)}>
              {w.message}
            </button>
          ))}
          <p>
            Conservative straight-segment checks. Playback does not simulate
            contact or guarantee collision-free motion.
          </p>
        </details>
      )}
      <svg
        ref={svg}
        className="ms-field"
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
          setMenu(null);
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
          if (tool !== "select" && p) setHover({ ...p, heading: 0 });
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
            className="ms-field-tick"
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
                stroke="var(--ms-path-halo,#fff)"
                strokeWidth=".11"
              />
              <path
                d={d}
                fill="none"
                stroke="var(--ms-blue)"
                strokeWidth=".055"
                strokeDasharray=".15 .09"
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
              fill="#15917c18"
              stroke="#15917c"
              strokeWidth=".035"
            />
            <path d="M0,0 H.78" stroke="#15917c" strokeWidth=".03" />
            <circle
              r=".15"
              fill="#15917c"
              stroke="var(--ms-path-halo,white)"
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
                fill="white"
                stroke="#15917c"
                strokeWidth=".035"
              />
            </g>
          </g>
          <text y=".7" textAnchor="middle" className="ms-field-label">
            Start
          </text>
        </g>
        {goals.map((node, i) => {
          const goal = positions[i],
            active = node.id === selected;
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
                e.preventDefault();
                e.stopPropagation();
                select(node.id);
                setMenu({ id: node.id, x: e.clientX, y: e.clientY });
              }}
              className="ms-goal"
            >
              <circle
                cx={goal.x}
                cy={height - goal.y}
                r={Math.max(
                  0.24,
                  goal.handoffRadius || goal.translationTolerance,
                )}
                fill={active ? "#6b3fe612" : "transparent"}
                stroke="var(--ms-blue)"
                strokeWidth=".018"
                strokeDasharray=".05 .05"
              />
              <g
                transform={`translate(${goal.x},${height - goal.y}) rotate(${(-goal.heading * 180) / Math.PI})`}
              >
                <rect
                  x={-project.robot.length / 2}
                  y={-project.robot.width / 2}
                  width={project.robot.length}
                  height={project.robot.width}
                  fill={active ? "#6b3fe61a" : "transparent"}
                  stroke="var(--ms-blue)"
                  strokeWidth=".025"
                  rx=".04"
                />
                <path
                  d="M0,0 H.78"
                  stroke="var(--ms-blue)"
                  strokeWidth=".035"
                />
                <circle
                  r=".16"
                  fill="var(--ms-blue)"
                  stroke="var(--ms-path-halo,#fff)"
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
                    fill="#fff"
                    stroke="var(--ms-blue)"
                    strokeWidth=".035"
                  />
                </g>
              </g>
              <text
                x={goal.x}
                y={height - goal.y - 0.63}
                textAnchor="middle"
                className="ms-field-label"
              >
                {routine.nodes.indexOf(node)+1} {autoStepLabel(node)}
              </text>
            </g>
          );
        })}
        {tool !== "select" && hover && (
          <g
            transform={`translate(${hover.x},${height - hover.y})`}
            pointerEvents="none"
            opacity=".4"
          >
            <circle r=".16" fill="var(--ms-blue)" />
            <rect
              x="-.42"
              y="-.42"
              width=".84"
              height=".84"
              fill="none"
              stroke="var(--ms-blue)"
              strokeWidth=".025"
            />
          </g>
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
            fill="#6b3fe630"
            stroke="var(--ms-blue)"
            strokeWidth=".04"
          />
          <path
            d="M-.12,-.17 L.15,0 L-.12,.17"
            fill="none"
            stroke="var(--ms-blue)"
            strokeWidth=".055"
          />
          <path
            d={`M${project.robot.length / 2},${-project.robot.width / 2 + 0.1} V${project.robot.width / 2 - 0.1}`}
            stroke="var(--ms-blue)"
            strokeWidth=".08"
          />
        </g>
      </svg>
      <div className="ms-field-foot">
        <button className="ms-button" onClick={() => setView(fit())}>
          <Maximize2 size={13} />
          Fit
        </button>
        <button
          className="ms-icon-button"
          aria-label="Zoom out"
          onClick={() => zoom(1.2)}
        >
          <Minus size={14} />
        </button>
        <button
          className="ms-icon-button"
          aria-label="Zoom in"
          onClick={() => zoom(0.8)}
        >
          <Plus size={14} />
        </button>
        <span className="ms-field-hint">
          {tool === "select"
            ? "Double-click to add · drag heading knob to rotate"
            : "Click to place · V to select"}{" "}
          · SI units
        </span>
      </div>
      {menu && (
        <div
          className="ms-field-context"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 110),
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              duplicate(menu.id);
              setMenu(null);
            }}
          >
            Duplicate goal
          </button>
          <button
            role="menuitem"
            onClick={() => {
              remove(menu.id);
              setMenu(null);
            }}
          >
            Delete goal
          </button>
          <button role="menuitem" onClick={() => setMenu(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
