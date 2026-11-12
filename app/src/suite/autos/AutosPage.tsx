import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  Keyboard,
  MousePointer2,
  Navigation,
  PanelRight,
  Pause,
  Play,
  Redo2,
  Route,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { FieldView } from "../FieldView";
import { routineLegs } from "../core/legs.ts";
import { resolveConstraints } from "../core/model.ts";
import { AUTO_PERIOD_SECONDS, type PlaceTool, type SuiteState } from "../useSuiteProject";
import { Badge, Button, IconButton, PageHeader, Segmented } from "../ui";
import { AutoInspector } from "./AutoInspector";
import { LegStrip } from "./LegStrip";
import { PreviewBar } from "./PreviewBar";
import { PathConstraints } from "./PathConstraints";
import { RoutineRail } from "./RoutineRail";
import { ShortcutSheet } from "./ShortcutSheet";
import { RouteFootprints } from "./RouteFootprints";
import { headingLints } from "../core/headingLint.ts";

const tools = [
  {
    value: "select",
    label: "Select",
    icon: MousePointer2,
    title: "Select and move (V)",
  },
  {
    value: "pose",
    label: "Pose",
    icon: Navigation,
    title: "Place a pose goal (W)",
  },
  {
    value: "translation",
    label: "Any heading",
    icon: CircleDot,
    title: "Place a goal the robot reaches at any heading (T)",
  },
  {
    value: "handoff",
    label: "Pass through",
    icon: Route,
    title: "Place a point the robot drives through without stopping (G)",
  },
] as const;

const toolHints: Record<PlaceTool, string> = {
  select: "Click a goal to edit it · double-click the field to add one",
  pose: "Click the field to place a pose · Esc when done",
  translation: "Click to place a goal with any heading · Esc when done",
  handoff: "Click to place a pass-through point · Esc when done",
};

export function AutosPage({ s }: { s: SuiteState }) {
  const [tool, setTool] = useState<PlaceTool>("select");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<"step" | "path">("step");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const inspect = (id: string) => {
    s.setSelected(id);
    setInspectorOpen(true);
    setInspectorTab("step");
  };
  const legs = useMemo(
    () => routineLegs(s.project, s.routine),
    [s.project, s.routine],
  );
  const [focusLeg, setFocusLeg] = useState<string | null>(null);
  const leg = legs.find((l) => l.id === focusLeg);
  useEffect(() => setFocusLeg(null), [s.routine.id]);
  // Selecting a goal elsewhere (rail, inspector, keys) brings its leg into focus.
  useEffect(() => {
    if (!leg || leg.nodeIds.includes(s.selected)) return;
    const owner = legs.find((l) => l.nodeIds.includes(s.selected));
    if (owner) setFocusLeg(owner.id);
  }, [s.selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortcuts = useRef({ s, legs, focusLeg, inspect });
  shortcuts.current = { s, legs, focusLeg, inspect };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      const { s, legs, focusLeg, inspect } = shortcuts.current;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "?") setShortcutsOpen((open) => !open);
      else if (event.key === "Escape" || key === "v") setTool("select");
      else if (key === "w") setTool("pose");
      else if (key === "t") setTool("translation");
      else if (key === "g") setTool("handoff");
      else if ((key === "[" || key === "]") && legs.length) {
        // Cycle All -> leg 1 -> ... -> leg n -> All.
        const i = legs.findIndex((l) => l.id === focusLeg),
          next = key === "]" ? (i + 2) % (legs.length + 1) : (i + legs.length + 1) % (legs.length + 1);
        setFocusLeg(next === 0 ? null : legs[next - 1].id);
      } else if ((key === "," || key === ".") && legs.length) {
        const order = legs.flatMap((l) => l.nodeIds),
          i = order.indexOf(s.selected);
        inspect(
          order[
            i < 0
              ? 0
              : Math.max(0, Math.min(order.length - 1, i + (key === "." ? 1 : -1)))
          ],
        );
      }
      else if (
        key === " " &&
        (event.target as HTMLElement)?.tagName !== "BUTTON"
      ) {
        event.preventDefault();
        s.togglePlay();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        s.removeNode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const trail = useMemo(
    () => s.frames.slice(0, s.cursor + 1).map((f) => f.pose),
    [s.frames, s.cursor],
  );
  // The whole forecast route, colored by speed on the field.
  const speedPath = useMemo(
    () =>
      s.forecast.frames.map((f) => ({
        x: f.pose.x,
        y: f.pose.y,
        speed: Math.hypot(f.velocity.vx, f.velocity.vy),
        node: f.node,
      })),
    [s.forecast],
  );
  // Pickup events (event markers) that fire with the front > 45° off the direction of travel.
  const pickupLints = useMemo(
    () => headingLints(s.forecast.frames, undefined, (id) => s.routine.nodes.find((n) => n.id === id)?.name ?? id),
    [s.forecast, s.routine],
  );
  const maxSpeed = Math.max(
    ...s.forecast.frames.map((f) => Math.hypot(f.velocity.vx, f.velocity.vy)),
    resolveConstraints(s.project.robot.constraints, s.routine.constraints)
      .maxVelocity,
  );
  const legSpeeds = useMemo(() => {
    const byNode = new Map<string, number[]>();
    for (const p of speedPath)
      byNode.set(p.node, [...(byNode.get(p.node) ?? []), p.speed]);
    return new Map(
      legs.flatMap((l) => {
        const v = l.nodeIds.flatMap((id) => byNode.get(id) ?? []);
        return v.length
          ? [[l.id, v.reduce((a, b) => a + b, 0) / v.length / maxSpeed] as const]
          : [];
      }),
    );
  }, [legs, speedPath, maxSpeed]);
  const steps = s.routine.nodes.filter((n) => n.kind !== "finish").length;
  const errors = s.issues.filter((i) => i.severity === "error").length;
  const runTime = s.forecast.status === "completed" ? s.forecast.frame.time : undefined;
  const fits = runTime !== undefined && runTime <= AUTO_PERIOD_SECONDS;

  return (
    <div className="mx-autos">
      {shortcutsOpen && <ShortcutSheet close={() => setShortcutsOpen(false)} />}
      <PageHeader
        title={s.routine.name}
        subtitle={
          <>
            {steps} {steps === 1 ? "step" : "steps"}
            {runTime !== undefined ? (
              <>
                {" · "}
                <b className="mx-runtime">{runTime.toFixed(1)} s</b> of the {AUTO_PERIOD_SECONDS} s auto period
              </>
            ) : (
              " · doesn't finish with the current inputs"
            )}
          </>
        }
        actions={
          <>
            {!inspectorOpen && (
              <IconButton
                label="Show inspector"
                icon={PanelRight}
                onClick={() => setInspectorOpen(true)}
              />
            )}
            <IconButton
              label="Undo last change"
              title="Undo (⌘Z)"
              icon={Undo2}
              disabled={!s.canUndo}
              onClick={s.undo}
            />
            <IconButton
              label="Redo last change"
              title="Redo (⇧⌘Z)"
              icon={Redo2}
              disabled={!s.canRedo}
              onClick={s.redo}
            />
            <Button
              variant="primary"
              icon={s.playing ? Pause : Play}
              onClick={s.togglePlay}
            >
              {s.playing ? "Pause" : "Preview"}
            </Button>
          </>
        }
      />
      <div className={`mx-autos-grid ${inspectorOpen ? "" : "is-collapsed"}`}>
        <RoutineRail
          s={s}
          inspect={inspect}
          create={() => {
            if (s.createRoutine()) setTool("pose");
          }}
        />
        <section className="mx-stage" aria-label="Field">
          <div className="mx-stage-bar">
            <Segmented
              label="Placement tool"
              value={tool}
              options={[...tools]}
              onChange={setTool}
            />
            <span className="mx-stage-hint">{toolHints[tool]}</span>
            <span className="mx-stage-spacer" />
            {errors > 0 ? (
              <Badge tone="bad">
                <TriangleAlert size={13} />
                {errors} {errors === 1 ? "error" : "errors"}
              </Badge>
            ) : runTime === undefined ? (
              <Badge tone="warn">Doesn't finish</Badge>
            ) : fits ? (
              <Badge tone="good">
                <CircleCheck size={13} />
                Fits in auto
              </Badge>
            ) : (
              <Badge tone="warn">
                {(runTime - AUTO_PERIOD_SECONDS).toFixed(1)} s over auto
              </Badge>
            )}
            <IconButton
              label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              icon={Keyboard}
              onClick={() => setShortcutsOpen(true)}
            />
          </div>
          {legs.length > 1 && (
            <LegStrip
              legs={legs}
              focused={leg ? leg.id : null}
              focus={setFocusLeg}
              speeds={legSpeeds}
            />
          )}
          <FieldView
            project={s.project}
            routine={s.routine}
            pose={s.frame.pose}
            trail={trail}
            speedPath={speedPath}
            maxSpeed={maxSpeed}
            focus={leg?.nodeIds}
            overlay={
              <RouteFootprints
                frames={s.forecast.frames}
                length={s.project.robot.length}
                width={s.project.robot.width}
                fieldHeight={s.project.field.height}
                lints={pickupLints}
                focus={leg?.nodeIds}
              />
            }
            selected={s.selected}
            tool={tool}
            select={inspect}
            inspect={inspect}
            place={(x, y, kind) => s.addGoal(kind ?? tool, { x, y })}
            resetStart={
              s.routine.start
                ? () =>
                    s.editRoutine((r) => {
                      delete r.start;
                    })
                : undefined
            }
            remove={s.removeNode}
            duplicate={(id) => s.addGoal(tool, undefined, id)}
            moveStart={(pose) =>
              s.editRoutine((r) => {
                r.start = pose;
              })
            }
            rotate={(id, heading) =>
              s.editNode((n) => {
                n.goal!.heading = heading;
              }, id)
            }
            move={(id, x, y) =>
              s.editNode((n) => {
                n.goal = { ...n.goal!, x, y };
              }, id)
            }
          />
          <PreviewBar s={s} />
        </section>
        {inspectorOpen && (
          <aside className="mx-inspector" aria-label="Inspector">
            <div className="mx-insp-tabs">
              <Segmented
                label="Inspector section"
                value={inspectorTab}
                onChange={setInspectorTab}
                options={[
                  { value: "step", label: "Selected step" },
                  { value: "path", label: "Whole path" },
                ]}
              />
            </div>
            {inspectorTab === "path" ? (
              <PathConstraints
                key={s.routine.id}
                s={s}
                close={() => setInspectorTab("step")}
              />
            ) : (
              <AutoInspector
                key={s.selected}
                s={s}
                close={() => setInspectorOpen(false)}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
