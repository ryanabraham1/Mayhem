import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_GOAL,
  parseProject,
  validateProject,
  type AutoNode,
  type Signals,
  type SuiteProject,
} from "./core/model.ts";
import {
  initialFrame,
  simulate,
  step,
  type ActionStatus,
  type Frame,
  type PreviewMode,
} from "./core/runtime.ts";
import { activateProject, loadProject, saveProject } from "./storage";
import { desktop, invoke } from "./native";

/** How far ahead the preview forecast simulates a routine. */
export const FORECAST_SECONDS = 60;
export type PlaceTool = "select" | "pose" | "translation" | "handoff";

const initialSignals = (p: SuiteProject): Signals =>
  Object.fromEntries(p.signals.map((s) => [s.key, s.initial]));

/**
 * All project state, history, file linking and preview playback.
 * The UI renders from this; nothing here knows about layout.
 */
export function useSuiteProject() {
  const [loaded] = useState(loadProject);
  const [project, setProject] = useState(loaded.project);
  const [notice, setNotice] = useState(loaded.error ?? "");
  const notify = useCallback((message: string) => setNotice(message), []);
  const [routineId, setRoutineId] = useState(project.routines[0].id);
  const [selected, setSelected] = useState(project.routines[0].initial);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("path");
  const [actions, setActions] = useState<Record<string, ActionStatus>>({});
  const [playing, setPlaying] = useState(false);
  const [freezeDrive, setFreezeDrive] = useState(false);
  const [signals, setSignals] = useState(() => initialSignals(project));
  const routine =
    project.routines.find((r) => r.id === routineId) ?? project.routines[0];
  const node =
    routine.nodes.find((n) => n.id === selected) ?? routine.nodes[0];
  const [frames, setFrames] = useState<Frame[]>(() => [
    initialFrame(project, routine),
  ]);
  const [cursor, setCursor] = useState(0);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [diskConflict, setDiskConflict] = useState(false);
  const conflictRef = useRef(false);
  const pendingWrites = useRef(0);
  const writeChain = useRef(Promise.resolve());
  const projectIO = useRef(false);
  const past = useRef<SuiteProject[]>([]);
  const future = useRef<SuiteProject[]>([]);
  const [, setHistoryTick] = useState(0);

  useEffect(() => {
    document.title = `${project.name} · Mayhem`;
  }, [project.name]);

  const issues = useMemo(() => validateProject(project), [project]);
  const frame = frames[Math.min(cursor, frames.length - 1)];
  const latest = frames[frames.length - 1];

  const reset = useCallback(
    (p: SuiteProject, id: string) => {
      const r = p.routines.find((r) => r.id === id) ?? p.routines[0];
      setPlaying(false);
      setActions({});
      setFrames([initialFrame(p, r)]);
      setCursor(0);
    },
    [],
  );
  const resetPreview = () => reset(project, routine.id);

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
  const reconcileSignals = (next: SuiteProject) =>
    setSignals(
      (current) =>
        Object.fromEntries(
          next.signals.map((signal) => [
            signal.key,
            typeof current[signal.key] === signal.type
              ? current[signal.key]
              : signal.initial,
          ]),
        ) as Signals,
    );

  /** Apply a validated edit. Returns the new project, or undefined when rejected. */
  const commit = (edit: (draft: SuiteProject) => void) => {
    try {
      if (projectIO.current)
        throw new Error("Finish opening or saving the project before editing.");
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
      reconcileSignals(next);
      reset(next, routine.id);
      setNotice("");
      return next;
    } catch (e) {
      notify(
        `Change not applied: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const editRoutine = (edit: (r: SuiteProject["routines"][number]) => void) =>
    commit((p) => edit(p.routines.find((r) => r.id === routine.id)!));
  const editNode = (edit: (n: AutoNode) => void, id = node.id) =>
    editRoutine((r) => edit(r.nodes.find((n) => n.id === id)!));

  const restoreHistory = (next: SuiteProject) => {
    const r =
      next.routines.find((r) => r.id === routine.id) ?? next.routines[0];
    setProject(next);
    reconcileSignals(next);
    setRoutineId(r.id);
    setSelected(
      selected === "@start" || r.nodes.some((n) => n.id === selected)
        ? selected
        : r.initial,
    );
    reset(next, r.id);
    setHistoryTick((t) => t + 1);
  };
  const undo = () => {
    if (projectIO.current) return;
    const previous = past.current.at(-1);
    if (!previous) return;
    const next = { ...previous, revision: project.revision + 1 };
    persist(next);
    future.current.push(project);
    past.current.pop();
    restoreHistory(next);
  };
  const redo = () => {
    if (projectIO.current) return;
    const next = future.current.at(-1);
    if (!next) return;
    const revised = { ...next, revision: project.revision + 1 };
    persist(revised);
    past.current.push(project);
    future.current.pop();
    restoreHistory(revised);
  };

  /** Replace the whole working project (open, import, switch, disk reload). */
  const adopt = (next: SuiteProject, path: string | null, message: string) => {
    setProject(next);
    setProjectPath(path);
    conflictRef.current = false;
    setDiskConflict(false);
    setRoutineId(next.routines[0].id);
    setSelected(next.routines[0].initial);
    setSignals(initialSignals(next));
    past.current = [];
    future.current = [];
    reset(next, next.routines[0].id);
    notify(message);
  };
  const guardIO = async (work: () => Promise<void>) => {
    if (projectIO.current) return;
    projectIO.current = true;
    try {
      await work();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      projectIO.current = false;
    }
  };

  // Preview playback: replay recorded frames first, then extend the run.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (cursor < frames.length - 1) {
        setCursor(Math.min(cursor + 2, frames.length - 1));
        return;
      }
      if (latest.status !== "running") {
        setPlaying(false);
        return;
      }
      const additions: Frame[] = [];
      let current = latest;
      for (let i = 0; i < 2 && current.status === "running"; i++) {
        current = step(project, routine, current, signals, 0.02, freezeDrive, {
          mode: previewMode,
          actions,
        });
        additions.push(current);
      }
      if (additions.length) {
        setFrames([...frames, ...additions]);
        setCursor(frames.length + additions.length - 1);
      }
    }, 40);
    return () => clearInterval(timer);
  }, [
    playing,
    project,
    routine,
    signals,
    freezeDrive,
    cursor,
    frames,
    latest,
    previewMode,
    actions,
  ]);
  // Whole-run forecast from the start: total time and timeline markers.
  const forecast = useMemo(
    () =>
      simulate(project, routine, signals, {
        mode: previewMode,
        actions,
        freezeDrive,
        maxSeconds: FORECAST_SECONDS,
      }),
    [project, routine, signals, previewMode, actions, freezeDrive],
  );
  // Jump to a time, simulating forward from the recorded run when needed.
  const seek = (time: number) => {
    setPlaying(false);
    let recorded = frames;
    if (time > latest.time && latest.status === "running") {
      const additions: Frame[] = [];
      let current = latest;
      while (current.status === "running" && current.time < time - 1e-9 && additions.length < 30000) {
        current = step(project, routine, current, signals, 0.02, freezeDrive, {
          mode: previewMode,
          actions,
        });
        additions.push(current);
      }
      recorded = [...frames, ...additions];
      setFrames(recorded);
    }
    let index = recorded.findIndex((f) => f.time >= time - 1e-9);
    if (index < 0) index = recorded.length - 1;
    setCursor(index);
  };
  const togglePlay = () => {
    if (!playing && latest.status !== "running" && cursor >= frames.length - 1)
      resetPreview();
    setPlaying((p) => !p);
  };

  // Linked project file: pick up agent edits made on disk.
  useEffect(() => {
    if (!projectPath || !desktop || diskConflict) return;
    let cancelled = false,
      inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight || pendingWrites.current || projectIO.current) return;
      inFlight = true;
      try {
        const value = await invoke<unknown>("read_suite_project", {
          path: projectPath,
        });
        const next = parseProject(JSON.stringify(value));
        if (
          !cancelled &&
          !projectIO.current &&
          !pendingWrites.current &&
          next.revision !== project.revision
        ) {
          saveProject(next, project);
          adopt(next, projectPath, "Project updated from disk by another editor.");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, project.revision, diskConflict, notify]);

  const openNativeProject = () =>
    guardIO(async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Mayhem project", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await writeChain.current;
      const value = await invoke<unknown>("read_suite_project", { path });
      const next = parseProject(JSON.stringify(value));
      activateProject(next, project);
      adopt(next, path, "Project file linked. Edits from agents on disk appear here automatically.");
    });
  const saveNativeProject = () =>
    guardIO(async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `${project.id}.mayhem.json`,
        filters: [{ name: "Mayhem project", extensions: ["json"] }],
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
      activateProject(next, project);
      setProject(next);
      setProjectPath(path);
      conflictRef.current = false;
      setDiskConflict(false);
      notify("Project file saved and linked. Edits now save to it automatically.");
    });
  const importProject = (file?: File) =>
    file
      ? guardIO(async () => {
          await writeChain.current;
          const next = parseProject(await file.text());
          activateProject(next, project);
          adopt(next, null, `Opened ${next.name}.`);
        })
      : Promise.resolve();
  const switchProject = async (next: SuiteProject) => {
    if (projectIO.current)
      throw new Error("A project operation is already in progress.");
    projectIO.current = true;
    try {
      await writeChain.current;
      activateProject(next, project);
      adopt(next, null, `Opened ${next.name}.`);
    } finally {
      projectIO.current = false;
    }
  };
  const applyJson = (text: string) => {
    try {
      const next = parseProject(text);
      const saved = commit((p) => Object.assign(p, next));
      if (saved) setSignals(initialSignals(next));
      return !!saved;
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const selectRoutine = (id: string) => {
    const r = project.routines.find((r) => r.id === id);
    if (!r) return;
    setRoutineId(id);
    setSelected(r.initial);
    reset(project, id);
  };

  const addGoal = (
    tool: PlaceTool,
    at?: { x: number; y: number },
    copyId?: string,
  ) => {
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
    const next = editRoutine((r) => {
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
          "Select a step with an outgoing transition to insert a goal after it.",
        );
    });
    if (next) setSelected(id);
  };

  const addActionStep = (kind: "action" | "custom") => {
    if (selected === "@start" || node.kind === "finish") {
      notify("Select a step to insert the action after.");
      return;
    }
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const next = editRoutine((r) => {
      const edge = r.transitions.find((t) => t.from === node.id);
      if (!edge) throw new Error("This step has no outgoing transition.");
      const oldTarget = edge.to;
      edge.to = id;
      r.nodes.splice(r.nodes.findIndex((n) => n.id === node.id) + 1, 0, {
        id,
        name: kind === "action" ? "Robot action" : "Custom callback",
        kind,
        action: kind === "action" ? "robot.action" : "robot.custom",
        timeout: 5,
      });
      r.transitions.push({
        id: `after-${id}`,
        from: id,
        to: oldTarget,
        condition: { kind: "always" },
      });
    });
    if (next) setSelected(id);
  };

  const removeNode = (id = selected) => {
    if (id === "@start") return;
    const target = routine.nodes.find((n) => n.id === id);
    if (!target || target.kind === "finish") {
      notify("Every routine keeps its finish step.");
      return;
    }
    const next = editRoutine((r) => {
      const incoming = r.transitions.filter(
          (t) => t.to === id && t.from !== id,
        ),
        outgoing = r.transitions.filter((t) => t.from === id && t.to !== id);
      if (outgoing.length !== 1)
        throw new Error("Reconnect this branching step before deleting it.");
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
    editRoutine((r) => {
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
          "This routine branches. Reconnect transitions in State machines to change its order.",
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
      reset(next, id);
    }
    return !!next;
  };
  const duplicateRoutine = (id: string) => {
    const r = project.routines.find((r) => r.id === id);
    if (!r) return;
    const copy = structuredClone(r);
    copy.id = `auto-${crypto.randomUUID().slice(0, 8)}`;
    copy.name = `${r.name} copy`;
    const next = commit((p) => p.routines.push(copy));
    if (next) {
      setRoutineId(copy.id);
      setSelected(copy.initial);
      reset(next, copy.id);
    }
  };
  const deleteRoutine = (id: string) => {
    const next = commit((p) => {
      p.routines = p.routines.filter((old) => old.id !== id);
    });
    if (next && id === routine.id) {
      setRoutineId(next.routines[0].id);
      setSelected(next.routines[0].initial);
      reset(next, next.routines[0].id);
    }
  };
  const renameRoutine = (id: string, name: string) =>
    commit((p) => {
      p.routines.find((r) => r.id === id)!.name = name;
    });

  return {
    project,
    issues,
    notice,
    notify,
    clearNotice: () => setNotice(""),
    routine,
    node,
    selected,
    setSelected,
    selectRoutine,
    commit,
    editRoutine,
    editNode,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    // project files
    projectPath,
    diskConflict,
    openNativeProject,
    saveNativeProject,
    importProject,
    switchProject,
    applyJson,
    // routine editing
    addGoal,
    addActionStep,
    removeNode,
    reorder,
    createRoutine,
    duplicateRoutine,
    deleteRoutine,
    renameRoutine,
    // preview
    frames,
    frame,
    latest,
    cursor,
    setCursor,
    playing,
    setPlaying,
    togglePlay,
    resetPreview,
    forecast,
    seek,
    previewMode,
    setPreviewMode,
    actions,
    setActions,
    signals,
    setSignals,
    freezeDrive,
    setFreezeDrive,
  };
}
export type SuiteState = ReturnType<typeof useSuiteProject>;
