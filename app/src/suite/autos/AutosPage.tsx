import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CircleDot,
  MousePointer2,
  Navigation,
  PanelRight,
  Pause,
  Play,
  Redo2,
  Route,
  Undo2,
} from "lucide-react";
import { FieldView } from "../FieldView";
import { download } from "../storage";
import type { PlaceTool, SuiteState } from "../useSuiteProject";
import { Badge, Button, IconButton, PageHeader, Segmented } from "../ui";
import { AutoInspector } from "./AutoInspector";
import { PreviewBar } from "./PreviewBar";
import { RoutineRail } from "./RoutineRail";

const tools = [
  { value: "select", label: "Select", icon: MousePointer2, title: "Select and move (V)" },
  { value: "pose", label: "Pose", icon: Navigation, title: "Place a pose goal (W)" },
  { value: "translation", label: "Translation", icon: CircleDot, title: "Place a goal with any heading (T)" },
  { value: "handoff", label: "Handoff", icon: Route, title: "Place a moving handoff (G)" },
] as const;

export function AutosPage({ s }: { s: SuiteState }) {
  const [tool, setTool] = useState<PlaceTool>("select");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const inspect = (id: string) => {
    s.setSelected(id);
    setInspectorOpen(true);
  };
  const shortcuts = useRef({ s });
  shortcuts.current = { s };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      const { s } = shortcuts.current;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" || key === "v") setTool("select");
      else if (key === "w") setTool("pose");
      else if (key === "t") setTool("translation");
      else if (key === "g") setTool("handoff");
      else if (key === " " && (event.target as HTMLElement)?.tagName !== "BUTTON") {
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
  const steps = s.routine.nodes.filter((n) => n.kind !== "finish").length;
  const errors = s.issues.filter((i) => i.severity === "error").length;

  return (
    <div className="mx-autos">
      <PageHeader
        title={s.routine.name}
        subtitle={
          <>
            {steps} {steps === 1 ? "step" : "steps"} · pose-to-pose controller
            {s.latest.status === "completed" && ` · runs in ${s.latest.time.toFixed(1)} s`}
          </>
        }
        actions={
          <>
            <button
              className={`mx-chip-toggle ${inspectorOpen ? "is-on" : ""}`}
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen((v) => !v)}
            >
              <PanelRight size={15} />
              Inspector
            </button>
            <IconButton label="Undo last change" title="Undo (⌘Z)" icon={Undo2} disabled={!s.canUndo} onClick={s.undo} />
            <IconButton label="Redo last change" title="Redo (⇧⌘Z)" icon={Redo2} disabled={!s.canRedo} onClick={s.redo} />
            <Button
              icon={ArrowDownToLine}
              onClick={() =>
                download(`${s.project.id}.mayhem.json`, JSON.stringify(s.project, null, 2))
              }
            >
              Export project
            </Button>
            <Button variant="primary" icon={s.playing ? Pause : Play} onClick={s.togglePlay}>
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
            <Segmented label="Placement tool" value={tool} options={[...tools]} onChange={setTool} />
            <span className="mx-stage-spacer" />
            {errors > 0 ? (
              <Badge tone="bad">{errors} project {errors === 1 ? "error" : "errors"}</Badge>
            ) : (
              <Badge tone="good">Valid · revision {s.project.revision}</Badge>
            )}
          </div>
          <FieldView
            project={s.project}
            routine={s.routine}
            pose={s.frame.pose}
            trail={trail}
            selected={s.selected}
            tool={tool}
            select={s.setSelected}
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
            <AutoInspector s={s} close={() => setInspectorOpen(false)} />
          </aside>
        )}
      </div>
    </div>
  );
}
