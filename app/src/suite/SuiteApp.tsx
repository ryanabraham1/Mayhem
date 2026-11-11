import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  MousePointer2,
  CircleDot,
  ArrowUp,
  ArrowDown,
  Trash2,
  Command,
  Flag,
  GitBranch,
  Layers3,
  Navigation,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Square,
  Terminal,
  Undo2,
  Upload,
  X,
  Moon,
  Sun,
} from "lucide-react";
import {
  DEFAULT_GOAL,
  autoStepLabel,
  conditionLabel,
  evaluate,
  parseProject,
  validateProject,
  type AutoNode,
  type SignalValue,
  type Pose,
  type SuiteProject,
} from "./core/model.ts";
import { exportCpp } from "./core/export-cpp.ts";
import { initialFrame, step, type Frame } from "./core/runtime.ts";
import { ConditionEditor } from "./ConditionEditor";
import { SignalsEditor } from "./SignalsEditor";
import { MachinesView } from "./MachinesView";
import { FieldView, type FieldTool } from "./FieldView";
import { LogsView } from "./LogsView";
import {
  download,
  loadProject,
  saveProject,
  recoverySnapshot,
} from "./storage";
import { desktop, invoke } from "./native";
import "./suite.css";
import appPackage from "../../package.json";
const LegacyApp = lazy(() => import("../App"));
type Workspace = "autos" | "states" | "logs" | "agents" | "robot";
const navigation = [
  { id: "autos", name: "Autonomous", icon: Navigation },
  { id: "states", name: "State machines", icon: GitBranch },
  { id: "logs", name: "Logs & power", icon: Activity },
  { id: "robot", name: "Robot setup", icon: Settings2 },
  { id: "agents", name: "Agent tools", icon: Terminal },
] as const;
function NumberField({
  label,
  value,
  unit,
  change,
  min = 0,
  step: increment = 0.05,
}: {
  label: string;
  value: number;
  unit?: string;
  change: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Number(value.toFixed(4)))), [value]);
  return (
    <label className="ms-number-field">
      <span>{label}</span>
      <span className="ms-number-input">
        <input
          aria-label={label}
          type="number"
          min={min}
          step={increment}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const number = Number(draft);
            if (draft.trim() && Number.isFinite(number) && number >= min)
              change(number);
            else setDraft(String(value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </label>
  );
}
function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("mayhem.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
function StartInspector({
  pose,
  change,
  inherit,
  close,
}: {
  pose: Pose;
  change: (p: Pose) => void;
  inherit: () => void;
  close: () => void;
}) {
  return (
    <>
      <div className="ms-inspector-title">
        <span className="ms-eyebrow">Starting pose</span>
        <button
          className="ms-icon-button"
          aria-label="Close inspector"
          onClick={close}
        >
          <X size={14} />
        </button>
      </div>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "12px 0 20px" }}>
        Autonomous start
      </h2>
      <div className="ms-field-pair">
        <NumberField
          label="Starting X"
          value={pose.x}
          unit="m"
          change={(x) => change({ ...pose, x })}
        />
        <NumberField
          label="Starting Y"
          value={pose.y}
          unit="m"
          change={(y) => change({ ...pose, y })}
        />
      </div>
      <NumberField
        label="Starting heading"
        value={(pose.heading * 180) / Math.PI}
        min={-3600}
        unit="deg"
        change={(v) => change({ ...pose, heading: (v * Math.PI) / 180 })}
      />
      <p className="ms-help">
        Drag the green robot or its heading knob on the field. Each autonomous
        routine can have its own starting pose.
      </p>
      <button className="ms-button" onClick={inherit}>
        Use robot default
      </button>
      <p className="ms-help">
        Robot code decides when to reset odometry. Preview starts here.
      </p>
    </>
  );
}
export default function SuiteApp() {
  const [theme, setTheme] = useState(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mayhem.theme", theme);
    } catch {}
  }, [theme]);
  const [loaded] = useState(loadProject);
  const [project, setProject] = useState(loaded.project),
    [workspace, setWorkspace] = useState<Workspace>("autos");
  const [routineId, setRoutineId] = useState(project.routines[0].id),
    [selected, setSelected] = useState(project.routines[0].initial);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [renamingRoutine, setRenamingRoutine] = useState<string | null>(null);
  const [tool, setTool] = useState<FieldTool>("select");
  const [notice, setNotice] = useState(loaded.error ?? ""),
    [legacy, setLegacy] = useState(false),
    [playing, setPlaying] = useState(false),
    [freezeDrive, setFreezeDrive] = useState(false);
  const [signals, setSignals] = useState(() =>
    Object.fromEntries(project.signals.map((s) => [s.key, s.initial])),
  );
  const routine =
    project.routines.find((r) => r.id === routineId) ?? project.routines[0];
  const node = routine.nodes.find((n) => n.id === selected) ?? routine.nodes[0];
  const [frames, setFrames] = useState<Frame[]>(() => [
      initialFrame(project, routine),
    ]),
    [cursor, setCursor] = useState(0);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const pendingWrites = useRef(0),
    writeChain = useRef(Promise.resolve());
  const [diskConflict, setDiskConflict] = useState(false);
  const past = useRef<SuiteProject[]>([]),
    future = useRef<SuiteProject[]>([]);
  const [json, setJson] = useState(() => JSON.stringify(project, null, 2));
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    document.title = `${project.name} · Mayhem`;
  }, [project.name]);
  const issues = useMemo(() => validateProject(project), [project]);
  const frame = frames[Math.min(cursor, frames.length - 1)],
    latest = frames[frames.length - 1];
  const reset = (p = project, id = routine.id) => {
    const r = p.routines.find((r) => r.id === id) ?? p.routines[0];
    setPlaying(false);
    setFrames([initialFrame(p, r)]);
    setCursor(0);
  };
  const conflictRef = useRef(false);
  const persist = (next: SuiteProject) => {
    saveProject(next, project);
    if (projectPath && !diskConflict) {
      pendingWrites.current++;
      const path = projectPath;
      writeChain.current = writeChain.current
        .then(async () => {
          if (!conflictRef.current)
            await invoke("write_suite_project", {
              path,
              project: next,
              expectedRevision: next.revision - 1,
            });
        })
        .catch((e) => {
          conflictRef.current = true;
          setDiskConflict(true);
          notify(String(e));
        })
        .finally(() => {
          pendingWrites.current--;
        });
    }
  };
  const commit = (edit: (draft: SuiteProject) => void) => {
    try {
      const next = structuredClone(project);
      edit(next);
      next.revision = project.revision + 1;
      const errors = validateProject(next).filter(
        (i) => i.severity === "error",
      );
      if (errors.length)
        throw new Error(errors.map((i) => i.message).join(" "));
      persist(next);
      past.current = [...past.current.slice(-49), project];
      future.current = [];
      setProject(next);
      reset(next);
      setNotice("");
      return next;
    } catch (e) {
      notify(
        `Changes were not saved: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const editNode = (edit: (n: AutoNode) => void) =>
    commit((p) => {
      const n = p.routines
        .find((r) => r.id === routine.id)!
        .nodes.find((n) => n.id === node.id)!;
      edit(n);
    });
  const restoreHistory = (next: SuiteProject) => {
    const r =
      next.routines.find((r) => r.id === routine.id) ?? next.routines[0];
    setProject(next);
    setRoutineId(r.id);
    setSelected(
      selected === "@start" || r.nodes.some((n) => n.id === selected)
        ? selected
        : r.initial,
    );
    reset(next, r.id);
  };
  const undo = () => {
    const previous = past.current.at(-1);
    if (!previous) return;
    const next = { ...previous, revision: project.revision + 1 };
    try {
      persist(next);
      future.current.push(project);
      past.current.pop();
      restoreHistory(next);
    } catch (e) {
      notify(String(e));
    }
  };
  const redo = () => {
    const next = future.current.at(-1);
    if (!next) return;
    try {
      const revised = { ...next, revision: project.revision + 1 };
      persist(revised);
      past.current.push(project);
      future.current.pop();
      restoreHistory(revised);
    } catch (e) {
      notify(String(e));
    }
  };
  useEffect(() => {
    setJson(JSON.stringify(project, null, 2));
  }, [project]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setFrames((previous) => {
          const additions: Frame[] = [];
          let current = previous[previous.length - 1];
          for (let i = 0; i < 2 && current.status === "running"; i++) {
            current = step(
              project,
              routine,
              current,
              signals,
              0.02,
              freezeDrive,
            );
            additions.push(current);
          }
          return additions.length ? [...previous, ...additions] : previous;
        }),
      40,
    );
    return () => clearInterval(timer);
  }, [playing, project, routine, signals, freezeDrive]);
  useEffect(() => {
    if (playing) setCursor(frames.length - 1);
    if (latest.status !== "running" || frames.length >= 30000)
      setPlaying(false);
  }, [frames.length, latest.status, playing]);
  useEffect(() => {
    if (!projectPath || !desktop || diskConflict) return;
    let cancelled = false,
      inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight || pendingWrites.current) return;
      inFlight = true;
      try {
        const value = await invoke<unknown>("read_suite_project", {
          path: projectPath,
        });
        const next = parseProject(JSON.stringify(value));
        if (
          !cancelled &&
          !pendingWrites.current &&
          next.revision !== project.revision
        ) {
          saveProject(next);
          setProject(next);
          setRoutineId(next.routines[0].id);
          setSelected(next.routines[0].initial);
          setFrames([initialFrame(next, next.routines[0])]);
          setCursor(0);
          setPlaying(false);
          setSignals(
            Object.fromEntries(next.signals.map((s) => [s.key, s.initial])),
          );
          past.current = [];
          future.current = [];
          notify("Project updated from disk.");
        }
      } catch (e) {
        if (!cancelled) notify(String(e));
      } finally {
        inFlight = false;
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath, project.revision, diskConflict, notify]);
  const openNativeProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Mayhem suite project", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await writeChain.current;
      const value = await invoke<unknown>("read_suite_project", { path });
      const next = parseProject(JSON.stringify(value));
      saveProject(next);
      setProject(next);
      setProjectPath(path);
      conflictRef.current = false;
      setDiskConflict(false);
      setRoutineId(next.routines[0].id);
      setSelected(next.routines[0].initial);
      setSignals(
        Object.fromEntries(next.signals.map((s) => [s.key, s.initial])),
      );
      reset(next, next.routines[0].id);
      past.current = [];
      future.current = [];
      notify(
        "Project opened. Agent edits on disk will appear here automatically.",
      );
    } catch (e) {
      notify(String(e));
    }
  };
  const saveNativeProject = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `${project.id}.mayhem.json`,
        filters: [{ name: "Mayhem suite project", extensions: ["json"] }],
      });
      if (!path) return;
      await writeChain.current;
      const existing = await invoke<unknown>("read_suite_project", {
        path,
        allowMissing: true,
      });
      const expectedRevision =
        existing === null
          ? null
          : parseProject(JSON.stringify(existing)).revision;
      const next = {
        ...project,
        revision: expectedRevision === null ? 0 : expectedRevision + 1,
      };
      await invoke("write_suite_project", {
        path,
        project: next,
        expectedRevision,
      });
      saveProject(next);
      setProject(next);
      setProjectPath(path);
      conflictRef.current = false;
      setDiskConflict(false);
      notify("Project file saved. Subsequent edits save automatically.");
    } catch (e) {
      notify(String(e));
    }
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const next = parseProject(await file.text());
      saveProject(next);
      setProjectPath(null);
      conflictRef.current = false;
      setDiskConflict(false);
      past.current = [];
      future.current = [];
      setProject(next);
      setRoutineId(next.routines[0].id);
      setSelected(next.routines[0].initial);
      setSignals(
        Object.fromEntries(next.signals.map((s) => [s.key, s.initial])),
      );
      reset(next, next.routines[0].id);
      notify(`Opened ${next.name}`);
    } catch (e) {
      notify(String(e));
    }
  };
  const addGoal = (at?: { x: number; y: number }, copyId?: string) => {
    const id = `pose-${crypto.randomUUID().slice(0, 8)}`;
    const anchorNode = copyId
      ? routine.nodes.find((n) => n.id === copyId)!
      : node;
    const atStart = !copyId && selected === "@start";
    const startPose = routine.start ?? project.robot.start;
    const anchor = atStart
      ? undefined
      : anchorNode.kind === "finish"
        ? routine.transitions.find((t) => t.to === anchorNode.id)
        : routine.transitions.find((t) => t.from === anchorNode.id);
    const previousGoal = atStart
      ? startPose
      : (anchorNode.goal ??
        routine.nodes.filter((n) => n.goal).at(-1)?.goal ??
        startPose);
    const goal = {
      ...DEFAULT_GOAL,
      x: at?.x ?? Math.min(project.field.width, previousGoal.x + 0.5),
      y: at?.y ?? previousGoal.y,
      heading: previousGoal.heading,
    };
    if (tool === "translation") goal.headingMode = "free";
    if (tool === "handoff") goal.handoffRadius = 0.3;
    const next = commit((p) => {
      const r = p.routines.find((r) => r.id === routine.id)!;
      const nextNode: AutoNode = copyId
        ? {
            ...structuredClone(anchorNode),
            id,
            name: `${anchorNode.name} copy`,
            goal,
          }
        : {
            id,
            name:
              tool === "handoff"
                ? "Handoff"
                : tool === "translation"
                  ? "Translation"
                  : `Pose ${r.nodes.filter((n) => n.kind === "pose").length + 1}`,
            kind: "pose",
            goal,
            timeout: 8,
          };
      if (atStart) {
        const initial = r.initial;
        r.nodes.unshift(nextNode);
        r.initial = id;
        r.transitions.push({
          id: `arrived-${id}`,
          from: id,
          to: initial,
          condition: { kind: "always" },
        });
      } else if (anchor) {
        const edge = r.transitions.find((t) => t.id === anchor.id)!;
        const oldTarget = edge.to;
        edge.to = id;
        r.nodes.splice(
          r.nodes.findIndex((n) => n.id === anchor.from) + 1,
          0,
          nextNode,
        );
        r.transitions.push({
          id: `to-${oldTarget}-${id}`,
          from: id,
          to: oldTarget,
          condition: { kind: "always" },
        });
      } else if (r.nodes.length === 1 && r.nodes[0].kind === "finish") {
        r.nodes.unshift(nextNode);
        r.initial = id;
        r.transitions.push({
          id: `arrived-${id}`,
          from: id,
          to: r.nodes[1].id,
          condition: { kind: "always" },
        });
      } else
        throw new Error(
          "Select a state with an outgoing transition to insert a goal.",
        );
    });
    if (next) setSelected(id);
  };
  const removeNode = (id = selected) => {
    if (workspace !== "autos" || id === "@start") return;
    const target = routine.nodes.find((n) => n.id === id);
    if (!target || target.kind === "finish") {
      notify("Keep a finish state for this routine.");
      return;
    }
    const next = commit((p) => {
      const r = p.routines.find((r) => r.id === routine.id)!;
      const incoming = r.transitions.filter(
          (t) => t.to === id && t.from !== id,
        ),
        outgoing = r.transitions.filter((t) => t.from === id && t.to !== id);
      if (outgoing.length !== 1)
        throw new Error("Reconnect this branching state before deleting it.");
      r.transitions = r.transitions.filter((t) => t.from !== id && t.to !== id);
      for (const edge of incoming)
        r.transitions.push({
          ...edge,
          to: outgoing[0].to,
          condition:
            outgoing[0].condition.kind === "always"
              ? edge.condition
              : {
                  kind: "all",
                  conditions: [edge.condition, outgoing[0].condition],
                },
        });
      r.nodes = r.nodes.filter((n) => n.id !== id);
      if (r.initial === id) r.initial = outgoing[0].to;
    });
    if (next)
      setSelected(next.routines.find((r) => r.id === routine.id)!.initial);
  };
  const reorder = (id: string, destination: number) => {
    const index = routine.nodes.findIndex((n) => n.id === id);
    if (
      index < 0 ||
      destination < 0 ||
      destination >= routine.nodes.length - 1 ||
      routine.nodes[index].kind === "finish"
    )
      return;
    commit((p) => {
      const r = p.routines.find((r) => r.id === routine.id)!;
      if (
        r.transitions.length !== r.nodes.length - 1 ||
        r.nodes.some(
          (n, i) =>
            i < r.nodes.length - 1 &&
            !r.transitions.some(
              (t) => t.from === n.id && t.to === r.nodes[i + 1].id,
            ),
        )
      )
        throw new Error(
          "This routine branches. Reconnect transitions in the state graph to change its execution order.",
        );
      const [moved] = r.nodes.splice(index, 1);
      r.nodes.splice(destination, 0, moved);
      r.initial = r.nodes[0].id;
      r.nodes.slice(0, -1).forEach((n, i) => {
        r.transitions.find((t) => t.from === n.id)!.to = r.nodes[i + 1].id;
      });
    });
  };
  const createRoutine = () => {
    const id = `auto-${crypto.randomUUID().slice(0, 8)}`;
    const next = commit((p) =>
      p.routines.push({
        id,
        name: `Auto ${p.routines.length + 1}`,
        initial: "done",
        nodes: [{ id: "done", name: "Complete", kind: "finish", timeout: 1 }],
        transitions: [],
      }),
    );
    if (next) {
      setRoutineId(id);
      setSelected("done");
      setTool("pose");
      setWorkspace("autos");
      reset(next, id);
    }
  };
  const shortcuts = useRef({ undo, redo, removeNode });
  shortcuts.current = { undo, redo, removeNode };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) shortcuts.current.redo();
        else shortcuts.current.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" || event.key.toLowerCase() === "v")
        setTool("select");
      if (event.key.toLowerCase() === "w") {
        setWorkspace("autos");
        setTool("pose");
      }
      if (event.key.toLowerCase() === "t") {
        setWorkspace("autos");
        setTool("translation");
      }
      if (event.key.toLowerCase() === "g") {
        setWorkspace("autos");
        setTool("handoff");
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        shortcuts.current.removeNode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const legacyView = legacy ? (
    <Suspense
      fallback={<div className="ms-loading">Opening legacy planner…</div>}
    >
      <div className="ms-legacy-return">
        <button
          onClick={() => {
            setTheme(initialTheme());
            setLegacy(false);
          }}
        >
          ← Return to Mayhem suite
        </button>
      </div>
      <LegacyApp />
    </Suspense>
  ) : null;
  return (
    <>
      {legacyView}
      <div
        className="ms-app"
        data-workspace={workspace}
        data-theme={theme}
        hidden={legacy}
      >
        <header className="ms-topbar">
          <div className="ms-brand">
            <span className="ms-brand-mark">
              <Layers3 size={20} />
            </span>
            Mayhem
          </div>
          <span className="ms-top-divider" />
          <span className="ms-project-name">
            {project.name}
            <ChevronDown size={13} />
          </span>
          <nav className="ms-suite-tabs" aria-label="Suite tools">
            {navigation.map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                title={name}
                aria-label={name}
                className={workspace === id ? "active" : ""}
                onClick={() => setWorkspace(id)}
              >
                <Icon size={15} />
                <span>
                  {id === "autos"
                    ? "Autos"
                    : id === "states"
                      ? "States"
                      : id === "logs"
                        ? "Logs"
                        : id === "robot"
                          ? "Robot"
                          : "Agents"}
                </span>
              </button>
            ))}
          </nav>
          <div className="ms-top-actions">
            <button
              className="ms-icon-button ms-theme-toggle"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              className="ms-icon-button"
              aria-label="Undo last change"
              title="Undo (⌘Z)"
              disabled={!past.current.length}
              onClick={undo}
            >
              <Undo2 size={16} />
            </button>
            <button
              className="ms-icon-button"
              aria-label="Redo last change"
              title="Redo (⇧⌘Z)"
              disabled={!future.current.length}
              onClick={redo}
            >
              <Undo2 size={16} style={{ transform: "scaleX(-1)" }} />
            </button>
            {desktop ? (
              <>
                <button
                  className="ms-button ms-quiet"
                  onClick={() => {
                    void openNativeProject();
                  }}
                >
                  Open
                </button>
                {!projectPath && (
                  <button
                    className="ms-button"
                    onClick={() => {
                      void saveNativeProject();
                    }}
                  >
                    Save file
                  </button>
                )}
              </>
            ) : (
              <label className="ms-button ms-quiet">
                <Upload size={14} />
                Open
                <input
                  type="file"
                  accept=".json"
                  onChange={(e) => {
                    void importProject(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
            <button
              className="ms-button"
              onClick={() =>
                download(
                  `${project.id}.mayhem.json`,
                  JSON.stringify(project, null, 2),
                )
              }
            >
              <ArrowDownToLine size={14} />
              Export project
            </button>
            {workspace === "autos" && (
              <button
                className="ms-button ms-primary"
                onClick={() => {
                  if (latest.status !== "running") reset();
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}{" "}
                {playing ? "Pause" : "Preview"}
              </button>
            )}
          </div>
        </header>
        <div className="ms-body">
          <aside className="ms-navigation">
            <div className="ms-project-tree">
              <div className="ms-workspace-label">
                AUTONOMOUS ROUTINES
                <button
                  title="Create routine"
                  aria-label="Create routine"
                  onClick={createRoutine}
                >
                  <Plus size={14} />
                </button>
              </div>
              {project.routines.map((r) => (
                <div key={r.id} className="ms-routine-row">
                  {renamingRoutine === r.id ? (
                    <input
                      autoFocus
                      aria-label="Routine name"
                      defaultValue={r.name}
                      onBlur={(e) => {
                        if (e.target.value.trim() && e.target.value !== r.name)
                          commit((p) => {
                            p.routines.find((old) => old.id === r.id)!.name =
                              e.target.value.trim();
                          });
                        setRenamingRoutine(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenamingRoutine(null);
                      }}
                    />
                  ) : (
                    <button
                      className={`ms-tree-routine ${r.id === routine.id ? "selected" : ""}`}
                      onDoubleClick={() => setRenamingRoutine(r.id)}
                      onClick={() => {
                        setRoutineId(r.id);
                        setSelected(r.initial);
                        reset(project, r.id);
                        setWorkspace("autos");
                      }}
                    >
                      <ChevronDown size={13} />
                      <GitBranch size={14} />
                      {r.name}
                    </button>
                  )}
                  <div className="ms-routine-actions">
                    <button
                      aria-label={`Duplicate routine ${r.name}`}
                      onClick={() => {
                        const copy = structuredClone(r);
                        copy.id = `auto-${crypto.randomUUID().slice(0, 8)}`;
                        copy.name = `${r.name} copy`;
                        const next = commit((p) => p.routines.push(copy));
                        if (next) {
                          setRoutineId(copy.id);
                          setSelected(copy.initial);
                          reset(next, copy.id);
                        }
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      aria-label={`Delete routine ${r.name}`}
                      disabled={project.routines.length <= 1}
                      onClick={() => {
                        const next = commit((p) => {
                          p.routines = p.routines.filter(
                            (old) => old.id !== r.id,
                          );
                        });
                        if (next && r.id === routine.id) {
                          setRoutineId(next.routines[0].id);
                          setSelected(next.routines[0].initial);
                          reset(next, next.routines[0].id);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <button
                aria-label="Starting pose"
                className={`ms-tree-node ${selected === "@start" ? "selected" : ""}`}
                onClick={() => {
                  setSelected("@start");
                  setInspectorOpen(true);
                  setWorkspace("autos");
                }}
              >
                <span
                  className="ms-step-index"
                  style={{ background: "#e6f6ee", color: "#15917c" }}
                >
                  ↗
                </span>
                Starting pose
              </button>
              {routine.nodes.map((n, i) => (
                <div
                  className="ms-tree-step-row"
                  key={n.id}
                  draggable={n.kind !== "finish"}
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", n.id)
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    reorder(e.dataTransfer.getData("text/plain"), i);
                  }}
                >
                  <button
                    aria-label={`${i + 1} ${autoStepLabel(n)}`}
                    className={`ms-tree-node ${n.id === selected ? "selected" : ""}`}
                    onClick={() => {
                      setSelected(n.id);
                      setInspectorOpen(true);
                      if (workspace !== "autos" && workspace !== "states")
                        setWorkspace("autos");
                    }}
                  >
                    <span
                      className={`ms-step-index ${frame.node === n.id ? "active" : ""}`}
                    >
                      {n.kind === "finish" ? <Flag size={11} /> : i + 1}
                    </span>
                    <span>{autoStepLabel(n)}</span>{n.goal&&n.goal.handoffRadius>0&&<small className="ms-step-handoff">Handoff</small>}
                  </button>
                  {n.kind !== "finish" && (
                    <div className="ms-step-actions">
                      <button
                        aria-label={`Move ${n.name} up`}
                        disabled={i === 0}
                        onClick={() => reorder(n.id, i - 1)}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        aria-label={`Move ${n.name} down`}
                        disabled={i >= routine.nodes.length - 2}
                        onClick={() => reorder(n.id, i + 1)}
                      >
                        <ArrowDown size={12} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="ms-sidebar-bottom">
              <div className="ms-offline-note">
                <CheckCircle2 size={15} />
                <span>
                  Works offline<small>Projects stay on this computer</small>
                </span>
              </div>
              <button onClick={() => setLegacy(true)}>
                <CircleHelp size={14} />
                Legacy trajectory planner
                <ArrowRight size={13} />
              </button>
            </div>
          </aside>
          <main className="ms-main">
            <div className="ms-page-heading">
              <div>
                <div className="ms-breadcrumb">
                  {project.robot.name}
                  <ChevronRight size={12} />
                  {navigation.find((n) => n.id === workspace)?.name}
                </div>
                <h1>
                  {workspace === "autos"
                    ? routine.name
                    : workspace === "states"
                      ? "Behavior, made visible."
                      : workspace === "logs"
                        ? "Understand every run."
                        : workspace === "agents"
                          ? "Your code. Your approach."
                          : "One model of your robot."}
                </h1>
              </div>
              <div className="ms-heading-actions">
                {(workspace === "autos" || workspace === "states") && (
                  <>
                    <button
                      className="ms-icon-button"
                      title="Undo edit"
                      aria-label="Undo edit"
                      disabled={!past.current.length}
                      onClick={undo}
                    >
                      <Undo2 size={16} />
                    </button>
                    <button
                      className="ms-icon-button"
                      title="Redo edit"
                      aria-label="Redo edit"
                      disabled={!future.current.length}
                      onClick={redo}
                    >
                      <Undo2 size={16} style={{ transform: "scaleX(-1)" }} />
                    </button>
                    <button
                      className="ms-button"
                      onClick={() => {
                        setWorkspace("autos");
                        setTool("pose");
                      }}
                    >
                      <Plus size={15} />
                      Pose goal
                    </button>
                    <button
                      className="ms-button ms-primary"
                      onClick={() => {
                        if (latest.status !== "running") reset();
                        setPlaying((p) => !p);
                      }}
                    >
                      <Play size={14} />
                      {playing ? "Pause preview" : "Run preview"}
                    </button>
                  </>
                )}
                {workspace === "agents" && (
                  <span className="ms-tag">
                    <Command size={12} />
                    CLI + MCP
                  </span>
                )}
              </div>
            </div>
            {notice && (
              <div className="ms-notice" role="status">
                <ShieldAlert size={16} />
                <span>{notice}</span>
                <button
                  aria-label="Dismiss message"
                  onClick={() => setNotice("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {workspace === "autos" ? (
              <>
                <div
                  className="ms-editor"
                  data-inspector={inspectorOpen ? "open" : "closed"}
                >
                  <section className="ms-visual">
                    <div className="ms-visual-toolbar">
                      <div className="ms-view-tabs">
                        <button
                          className={workspace === "autos" ? "active" : ""}
                          onClick={() => setWorkspace("autos")}
                        >
                          <Navigation size={14} />
                          Paths
                        </button>
                        <button
                          className=""
                          onClick={() => setWorkspace("states")}
                        >
                          <GitBranch size={14} />
                          States
                        </button>
                      </div>
                      {workspace === "autos" && (
                        <div className="ms-field-tools">
                          {(
                            [
                              {
                                id: "select",
                                name: "Select",
                                key: "V",
                                icon: MousePointer2,
                              },
                              {
                                id: "pose",
                                name: "Pose",
                                key: "W",
                                icon: Navigation,
                              },
                              {
                                id: "translation",
                                name: "Translation",
                                key: "T",
                                icon: CircleDot,
                              },
                              {
                                id: "handoff",
                                name: "Handoff",
                                key: "G",
                                icon: ArrowRight,
                              },
                            ] as const
                          ).map(({ id, name, key, icon: Icon }) => (
                            <button
                              key={id}
                              className={tool === id ? "active" : ""}
                              title={`${name} (${key})`}
                              onClick={() => setTool(id)}
                            >
                              <Icon size={15} />
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        className="ms-inspector-toggle ms-button ms-quiet"
                        aria-pressed={inspectorOpen}
                        onClick={() => setInspectorOpen((v) => !v)}
                      >
                        <Settings2 size={14} />
                        Inspector
                      </button>
                    </div>
                    {
                      <FieldView
                        project={project}
                        routine={routine}
                        pose={frame.pose}
                        selected={selected}
                        tool={tool}
                        select={setSelected}
                        inspect={(id) => {
                          setSelected(id);
                          setInspectorOpen(true);
                        }}
                        place={(x, y) => addGoal({ x, y })}
                        remove={removeNode}
                        duplicate={(id) => addGoal(undefined, id)}
                        moveStart={(pose) =>
                          commit((p) => {
                            p.routines.find((r) => r.id === routine.id)!.start =
                              pose;
                          })
                        }
                        rotate={(id, heading) =>
                          commit((p) => {
                            p.routines
                              .find((r) => r.id === routine.id)!
                              .nodes.find((n) => n.id === id)!.goal!.heading =
                              heading;
                          })
                        }
                        move={(id, x, y) =>
                          commit((p) => {
                            const n = p.routines
                              .find((r) => r.id === routine.id)!
                              .nodes.find((n) => n.id === id)!;
                            n.goal = { ...n.goal!, x, y };
                          })
                        }
                      />
                    }
                    <div className="ms-live-strip">
                      <span>
                        <i
                          className={`ms-dot ${frame.status === "failed" ? "orange" : "teal"}`}
                        />
                        {frame.status === "running"
                          ? playing
                            ? "Preview running"
                            : "Preview paused"
                          : frame.status === "failed"
                            ? "Watchdog failed"
                            : "Routine completed"}
                      </span>
                      <code>
                        x {frame.pose.x.toFixed(2)}
                        <b>m</b>
                      </code>
                      <code>
                        y {frame.pose.y.toFixed(2)}
                        <b>m</b>
                      </code>
                      <code>
                        θ {((frame.pose.heading * 180) / Math.PI).toFixed(1)}
                        <b>°</b>
                      </code>
                    </div>
                  </section>
                  <aside className="ms-inspector">
                    {selected === "@start" ? (
                      <StartInspector
                        pose={routine.start ?? project.robot.start}
                        close={() => setInspectorOpen(false)}
                        change={(pose) =>
                          commit((p) => {
                            p.routines.find((r) => r.id === routine.id)!.start =
                              pose;
                          })
                        }
                        inherit={() =>
                          commit((p) => {
                            delete p.routines.find((r) => r.id === routine.id)!
                              .start;
                          })
                        }
                      />
                    ) : (
                      <>
                        <div className="ms-inspector-title">
                          <span className="ms-eyebrow">
                            {node.kind === "pose"
                              ? "Pose goal"
                              : node.kind === "finish"
                                ? "Terminal state"
                                : "Robot code"}
                          </span>
                          <div className="ms-inspector-actions">
                            <button
                              className="ms-icon-button"
                              aria-label="Close inspector"
                              onClick={() => setInspectorOpen(false)}
                            >
                              <X size={14} />
                            </button>
                            {node.kind === "pose" && (
                              <button
                                className="ms-icon-button"
                                aria-label="Duplicate selected goal"
                                onClick={() => addGoal(undefined, node.id)}
                              >
                                <Copy size={14} />
                              </button>
                            )}
                            {node.kind !== "finish" && (
                              <button
                                className="ms-icon-button"
                                aria-label="Delete selected state"
                                onClick={() => removeNode()}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                        <input
                          className="ms-node-name"
                          aria-label="State name"
                          key={node.id + node.name}
                          defaultValue={node.name}
                          onBlur={(e) => {
                            if (
                              e.target.value.trim() &&
                              e.target.value !== node.name
                            )
                              editNode((n) => {
                                n.name = e.target.value;
                              });
                          }}
                        />
                        {node.kind !== "finish" && (
                          <label className="ms-label">
                            Behavior
                            <select
                              aria-label="Behavior type"
                              value={node.kind}
                              onChange={(e) =>
                                editNode((n) => {
                                  n.kind = e.target.value as AutoNode["kind"];
                                  if (n.kind === "pose")
                                    n.goal ??= { ...DEFAULT_GOAL };
                                  else n.action ||= "robot.customAction";
                                })
                              }
                            >
                              <option value="pose">Reach a pose</option>
                              <option value="action">
                                Registered robot action
                              </option>
                              <option value="custom">
                                Custom C++ callback
                              </option>
                            </select>
                          </label>
                        )}
                        {node.kind === "pose" && node.goal && (
                          <>
                            <div className="ms-inspector-section">
                              <h3>Target pose</h3>
                              <label className="ms-label">
                                Heading policy
                                <select
                                  value={node.goal.headingMode ?? "fixed"}
                                  onChange={(e) =>
                                    editNode((n) => {
                                      n.goal!.headingMode = e.target.value as
                                        | "fixed"
                                        | "pointAt"
                                        | "motion"
                                        | "free";
                                      if (e.target.value === "pointAt") {
                                        n.goal!.aimX ??= 4.6;
                                        n.goal!.aimY ??= 4;
                                      }
                                    })
                                  }
                                >
                                  <option value="fixed">Fixed heading</option>
                                  <option value="free">
                                    No heading target
                                  </option>
                                  <option value="pointAt">
                                    Aim at a field point
                                  </option>
                                  <option value="motion">
                                    Face movement direction
                                  </option>
                                </select>
                              </label>
                              {node.goal.headingMode === "pointAt" && (
                                <div className="ms-field-pair">
                                  <NumberField
                                    label="Aim X"
                                    value={node.goal.aimX ?? 0}
                                    unit="m"
                                    change={(v) =>
                                      editNode((n) => {
                                        n.goal!.aimX = v;
                                      })
                                    }
                                  />
                                  <NumberField
                                    label="Aim Y"
                                    value={node.goal.aimY ?? 0}
                                    unit="m"
                                    change={(v) =>
                                      editNode((n) => {
                                        n.goal!.aimY = v;
                                      })
                                    }
                                  />
                                </div>
                              )}
                              <div className="ms-field-pair">
                                <NumberField
                                  label="X position"
                                  value={node.goal.x}
                                  unit="m"
                                  change={(v) =>
                                    editNode((n) => {
                                      n.goal!.x = v;
                                    })
                                  }
                                />
                                <NumberField
                                  label="Y position"
                                  value={node.goal.y}
                                  unit="m"
                                  change={(v) =>
                                    editNode((n) => {
                                      n.goal!.y = v;
                                    })
                                  }
                                />
                              </div>
                              <NumberField
                                label="Heading"
                                value={(node.goal.heading * 180) / Math.PI}
                                min={-3600}
                                unit="deg"
                                step={5}
                                change={(v) =>
                                  editNode((n) => {
                                    n.goal!.heading = (v * Math.PI) / 180;
                                  })
                                }
                              />
                            </div>
                            <div className="ms-inspector-section">
                              <h3>Step constraints</h3>
                              <NumberField
                                label="Maximum speed"
                                value={
                                  node.constraints?.maxVelocity ??
                                  project.robot.constraints.maxVelocity
                                }
                                min={0.01}
                                unit="m/s"
                                change={(v) =>
                                  editNode((n) => {
                                    n.constraints = {
                                      ...n.constraints,
                                      maxVelocity: v,
                                    };
                                  })
                                }
                              />
                              <h3>Arrival conditions</h3>
                              <NumberField
                                label="Position tolerance"
                                value={node.goal.translationTolerance}
                                min={0.001}
                                unit="m"
                                step={0.01}
                                change={(v) =>
                                  editNode((n) => {
                                    n.goal!.translationTolerance = v;
                                  })
                                }
                              />
                              <NumberField
                                label="Heading tolerance"
                                value={
                                  (node.goal.rotationTolerance * 180) / Math.PI
                                }
                                min={0.01}
                                unit="deg"
                                step={0.5}
                                change={(v) =>
                                  editNode((n) => {
                                    n.goal!.rotationTolerance =
                                      (v * Math.PI) / 180;
                                  })
                                }
                              />
                              <NumberField
                                label="Settling time"
                                value={node.goal.settleTime}
                                unit="s"
                                change={(v) =>
                                  editNode((n) => {
                                    n.goal!.settleTime = v;
                                  })
                                }
                              />
                              <NumberField
                                label="Handoff radius"
                                value={node.goal.handoffRadius}
                                unit="m"
                                change={(v) =>
                                  editNode((n) => {
                                    n.goal!.handoffRadius = v;
                                  })
                                }
                              />
                              <p className="ms-help">
                                {node.goal.handoffRadius
                                  ? "Hands off while moving once position and heading satisfy the goal."
                                  : "Waits for position, heading, low measured speed, and settling."}
                              </p>
                            </div>
                          </>
                        )}
                        {(node.kind === "action" || node.kind === "custom") && (
                          <div className="ms-inspector-section">
                            <h3>Robot implementation</h3>
                            <label className="ms-label">
                              Callback ID
                              <input
                                key={node.id + node.action}
                                defaultValue={node.action}
                                onBlur={(e) => {
                                  if (e.target.value !== node.action)
                                    editNode((n) => {
                                      n.action = e.target.value;
                                    });
                                }}
                              />
                            </label>
                            <p className="ms-help">
                              Implemented by your robot code. The preview only
                              observes its signals; it does not simulate the
                              mechanism.
                            </p>
                          </div>
                        )}
                        {node.kind !== "finish" && (
                          <div className="ms-inspector-section">
                            <NumberField
                              label="Failure watchdog"
                              value={node.timeout}
                              min={0.02}
                              unit="s"
                              step={1}
                              change={(v) =>
                                editNode((n) => {
                                  n.timeout = v;
                                })
                              }
                            />
                            <p className="ms-help">
                              Expiry reports failure. It never marks this step
                              complete.
                            </p>
                          </div>
                        )}
                        <div className="ms-inspector-section">
                          <h3>While active</h3>
                          <label className="ms-label">
                            Concurrent callback IDs
                            <input
                              key={node.id + (node.during ?? []).join(",")}
                              defaultValue={(node.during ?? []).join(", ")}
                              placeholder="intake.run, shooter.spinUp"
                              onBlur={(e) => {
                                const during = e.target.value
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                if (
                                  JSON.stringify(during) !==
                                  JSON.stringify(node.during ?? [])
                                )
                                  editNode((n) => {
                                    n.during = during;
                                  });
                              }}
                            />
                          </label>
                          <p className="ms-help">
                            Robot code owns these concurrent behaviors. Preview
                            does not execute C++ callbacks.
                          </p>
                        </div>
                        <div className="ms-inspector-section">
                          <h3>Continue when</h3>
                          {node.kind === "pose" && (
                            <p className="ms-help">
                              Pose arrival must be satisfied before outgoing
                              conditions are evaluated.
                            </p>
                          )}
                          {routine.transitions
                            .filter((t) => t.from === node.id)
                            .map((t) => (
                              <div className="ms-condition" key={t.id}>
                                <span>
                                  {evaluate(t.condition, frame.signals) ? (
                                    <Check size={14} />
                                  ) : (
                                    <Square size={13} />
                                  )}
                                  {conditionLabel(t.condition)}
                                </span>
                                <small>
                                  →{" "}
                                  {
                                    routine.nodes.find((n) => n.id === t.to)
                                      ?.name
                                  }
                                </small>
                                <details>
                                  <summary>Edit transition</summary>
                                  <label className="ms-label">
                                    Next state
                                    <select
                                      aria-label="Transition destination"
                                      value={t.to}
                                      onChange={(e) =>
                                        commit((p) => {
                                          p.routines
                                            .find((r) => r.id === routine.id)!
                                            .transitions.find(
                                              (edge) => edge.id === t.id,
                                            )!.to = e.target.value;
                                        })
                                      }
                                    >
                                      {routine.nodes.map((n) => (
                                        <option key={n.id} value={n.id}>
                                          {n.name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <ConditionEditor
                                    condition={t.condition}
                                    signals={project.signals}
                                    change={(condition) =>
                                      commit((p) => {
                                        p.routines
                                          .find((r) => r.id === routine.id)!
                                          .transitions.find(
                                            (edge) => edge.id === t.id,
                                          )!.condition = condition;
                                      })
                                    }
                                  />
                                </details>
                              </div>
                            ))}
                          {node.kind === "finish" && (
                            <p className="ms-help">
                              Reaching this state completes the routine.
                            </p>
                          )}
                          {node.kind !== "finish" && (
                            <button
                              className="ms-button"
                              onClick={() =>
                                commit((p) => {
                                  const r = p.routines.find(
                                    (r) => r.id === routine.id,
                                  )!;
                                  r.transitions.push({
                                    id: `branch-${crypto.randomUUID().slice(0, 8)}`,
                                    from: node.id,
                                    to: r.nodes.find((n) => n.id !== node.id)!
                                      .id,
                                    condition: project.signals.length
                                      ? {
                                          kind: "signal",
                                          key: project.signals[0].key,
                                          op: "eq",
                                          value: project.signals[0].initial,
                                        }
                                      : { kind: "always" },
                                  });
                                })
                              }
                            >
                              <Plus size={12} />
                              Branch
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </aside>
                </div>
                <section className="ms-playback">
                  <div className="ms-playback-toolbar">
                    <div className="ms-playback-controls">
                      <button
                        aria-label="Reset preview"
                        title="Reset preview"
                        onClick={() => reset()}
                      >
                        <RotateCcw size={15} />
                      </button>
                      <button
                        className="ms-play-button"
                        aria-label={
                          playing ? "Pause simulation" : "Play simulation"
                        }
                        onClick={() => {
                          if (latest.status !== "running") reset();
                          setPlaying((p) => !p);
                        }}
                      >
                        {playing ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <code>
                        {frame.time.toFixed(2)} <span>s</span>
                      </code>
                    </div>
                    <input
                      aria-label="Preview time"
                      type="range"
                      min="0"
                      max={Math.max(1, frames.length - 1)}
                      value={cursor}
                      onChange={(e) => {
                        setPlaying(false);
                        setCursor(
                          Math.min(Number(e.target.value), frames.length - 1),
                        );
                      }}
                    />
                    <button
                      className="ms-button ms-quiet"
                      onClick={() =>
                        download(
                          `${routine.id}.trace.json`,
                          JSON.stringify(
                            {
                              routine: routine.id,
                              projectRevision: project.revision,
                              signals,
                              events: latest.events,
                              frames: frames.map(
                                ({
                                  events: _events,
                                  controller: _controller,
                                  ...f
                                }) => f,
                              ),
                            },
                            null,
                            2,
                          ),
                        )
                      }
                    >
                      <ArrowDownToLine size={13} />
                      Trace
                    </button>
                  </div>
                  <details className="ms-preview-details">
                    <summary>Inputs & execution events</summary>
                    <div className="ms-playback-details">
                      <div className="ms-signals">
                        <div className="ms-panel-heading">
                          Preview inputs <span>Set sensor values</span>
                        </div>
                        {project.signals.map((signal) => (
                          <label key={signal.key} className="ms-signal">
                            <span>
                              <i
                                className={`ms-dot ${signals[signal.key] ? "teal" : ""}`}
                              />
                              {signal.name}
                            </span>
                            {signal.type === "boolean" ? (
                              <input
                                type="checkbox"
                                checked={signals[signal.key] === true}
                                onChange={(e) =>
                                  setSignals((s) => ({
                                    ...s,
                                    [signal.key]: e.target.checked,
                                  }))
                                }
                              />
                            ) : (
                              <input
                                aria-label={signal.name}
                                type={
                                  signal.type === "number" ? "number" : "text"
                                }
                                value={String(
                                  signals[signal.key] ?? signal.initial,
                                )}
                                onChange={(e) => {
                                  const value: SignalValue =
                                    signal.type === "number"
                                      ? Number(e.target.value)
                                      : e.target.value;
                                  if (
                                    typeof value !== "number" ||
                                    Number.isFinite(value)
                                  )
                                    setSignals((s) => ({
                                      ...s,
                                      [signal.key]: value,
                                    }));
                                }}
                              />
                            )}
                          </label>
                        ))}
                      </div>
                      <div className="ms-event-list">
                        <div className="ms-panel-heading">
                          Execution events <span>Click to replay</span>
                        </div>
                        {frame.events.slice(-30).map((event, i) => (
                          <button
                            key={i}
                            onClick={() => {
                              setPlaying(false);
                              const index = frames.findIndex(
                                (f) => f.time >= event.time,
                              );
                              setCursor(Math.max(0, index));
                              setSelected(event.node);
                            }}
                          >
                            <code>{event.time.toFixed(2)}</code>
                            <i
                              className={`ms-dot ${event.kind === "failure" ? "orange" : "blue"}`}
                            />
                            <span>{event.message}</span>
                          </button>
                        ))}
                      </div>
                      <div className="ms-scenario">
                        <div className="ms-panel-heading">Scenario</div>
                        <label>
                          <input
                            type="checkbox"
                            checked={freezeDrive}
                            onChange={(e) => setFreezeDrive(e.target.checked)}
                          />
                          Freeze drivetrain
                        </label>
                        <p>
                          The pose stays fixed. A goal must fail its watchdog.
                        </p>
                        <span>
                          Ideal kinematics preview · no collision or mechanism
                          simulation
                        </span>
                      </div>
                    </div>
                  </details>
                </section>
              </>
            ) : workspace === "states" ? (
              <MachinesView
                project={project}
                frame={frame}
                commit={commit}
                notify={notify}
                selectAuto={(id) => {
                  setRoutineId(id);
                  reset(project, id);
                }}
              />
            ) : workspace === "logs" ? null : workspace === "agents" ? (
              <div className="ms-settings-page">
                <div className="ms-agent-intro">
                  <span className="ms-agent-icon">
                    <Terminal size={27} />
                  </span>
                  <div>
                    <h2>Build freely. Inspect everything.</h2>
                    <p>
                      Use pose-based auto tools, compose your own strategies, or
                      write custom C++. Mayhem provides context and observation
                      without owning your architecture.
                    </p>
                  </div>
                </div>
                <div className="ms-agent-grid">
                  <div className="ms-settings-card">
                    <h3>
                      <Terminal size={17} />
                      Use from an agent
                    </h3>
                    <p>Start the local MCP server from this repository:</p>
                    <pre>node scripts/mayhem.mjs mcp</pre>
                    <p>Or use the same core directly:</p>
                    <pre>
                      {
                        "node scripts/mayhem.mjs inspect <project>\nnode scripts/mayhem.mjs validate <project>\nnode scripts/mayhem.mjs simulate <project>\nnode scripts/mayhem.mjs analyze <recording>"
                      }
                    </pre>
                    <span className="ms-help">
                      Requires Node 22.18 or later. Full setup:
                      docs/SUITE_AGENTS.md
                    </span>
                  </div>
                  <div className="ms-settings-card">
                    <h3>
                      <Code2 size={17} />
                      Tools, not limits
                    </h3>
                    <button
                      className="ms-button"
                      onClick={() =>
                        download(
                          `${project.id}.hpp`,
                          exportCpp(project),
                          "text/plain",
                        )
                      }
                    >
                      <ArrowDownToLine size={13} />
                      Export C++ routines
                    </button>
                    <ul>
                      <li>Pose goals and moving handoffs</li>
                      <li>Measured-condition transitions</li>
                      <li>Arbitrary named C++ callbacks</li>
                      <li>Optional observation of existing robot code</li>
                      <li>Preserved project extensions</li>
                      <li>Revision-checked, atomic file changes</li>
                    </ul>
                    <p>
                      The visual routine is an optional authoring format. Custom
                      robot logic can use the C++ controller and observer
                      independently.
                    </p>
                  </div>
                </div>
                <div className="ms-json-header">
                  <h3>
                    <Braces size={17} />
                    Project document
                  </h3>
                  <button
                    className="ms-button ms-primary"
                    onClick={() => {
                      try {
                        const next = parseProject(json);
                        const saved = commit((p) => Object.assign(p, next));
                        if (saved)
                          setSignals(
                            Object.fromEntries(
                              next.signals.map((s) => [s.key, s.initial]),
                            ),
                          );
                      } catch (e) {
                        notify(String(e));
                      }
                    }}
                  >
                    Validate & apply
                  </button>
                </div>
                <textarea
                  className="ms-json-editor"
                  aria-label="Project JSON"
                  spellCheck={false}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                />
              </div>
            ) : (
              <div className="ms-settings-page">
                <SignalsEditor project={project} commit={commit} />
                <div className="ms-settings-card">
                  <h3>Project recovery</h3>
                  <p>
                    Mayhem keeps the previous valid save and preserves damaged
                    data before replacing it.
                  </p>
                  <button
                    className="ms-button"
                    onClick={() => {
                      try {
                        const raw = recoverySnapshot();
                        if (raw) download("mayhem-recovery.json", raw);
                        else notify("No recovery snapshot is available yet.");
                      } catch (e) {
                        notify(String(e));
                      }
                    }}
                  >
                    Export recovery snapshot
                  </button>
                </div>
                <div className="ms-settings-card">
                  <h2>Robot & control constraints</h2>
                  <p>
                    These values drive the pose preview and describe the
                    configuration expected by the C++ controller.
                  </p>
                  <div className="ms-robot-fields">
                    {Object.entries(project.robot.constraints).map(
                      ([key, value]) => (
                        <NumberField
                          key={key}
                          label={key.replace(/([A-Z])/g, " $1")}
                          value={value}
                          min={0.001}
                          change={(v) =>
                            commit((p) => {
                              p.robot.constraints[
                                key as keyof typeof p.robot.constraints
                              ] = v;
                            })
                          }
                        />
                      ),
                    )}
                    <NumberField
                      label="Robot length"
                      value={project.robot.length}
                      min={0.01}
                      unit="m"
                      change={(v) =>
                        commit((p) => {
                          p.robot.length = v;
                        })
                      }
                    />
                    <NumberField
                      label="Robot width"
                      value={project.robot.width}
                      min={0.01}
                      unit="m"
                      change={(v) =>
                        commit((p) => {
                          p.robot.width = v;
                        })
                      }
                    />
                  </div>
                </div>
                <div className="ms-settings-card">
                  <h3>
                    <CheckCircle2 size={17} />
                    Project validation
                  </h3>
                  {issues.length ? (
                    issues.map((i, index) => (
                      <p key={index}>
                        {i.severity}: {i.message}
                      </p>
                    ))
                  ) : (
                    <p className="ms-good">All project checks passed.</p>
                  )}
                  <p>
                    Units: meters, radians, seconds. Field coordinates use the
                    blue-alliance origin. Use State machines for a read-only
                    live connection. Robot code owns drivetrain conversion and
                    actuation.
                  </p>
                </div>
              </div>
            )}
            <div className="ms-logs-host" hidden={workspace !== "logs"}>
              <LogsView
                notify={notify}
                active={!legacy && workspace === "logs"}
              />
            </div>
            <footer className="ms-statusbar">
              <span>
                <CheckCircle2 size={12} />
                {issues.some((i) => i.severity === "error")
                  ? "Project has errors"
                  : "Project valid"}
                <span className="ms-status-divider">/</span>revision{" "}
                {project.revision}
              </span>
              <span>
                {diskConflict
                  ? "File conflict — local edits retained"
                  : projectPath
                    ? "Project file linked"
                    : playing
                      ? "Preview execution"
                      : "Local workspace"}
                <span className="ms-status-divider">/</span>Mayhem suite ·{" "}
                {appPackage.version}
              </span>
            </footer>
          </main>
        </div>
      </div>
    </>
  );
}
