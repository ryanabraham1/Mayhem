import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_GOAL,
  parseProject,
  validateProject,
  type AutoNode,
  type AutoRoutine,
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
import { interpolatePreviewFrame } from "./core/playback.ts";
import { sketchGoals } from "./core/sketch.ts";
import { activateProject, keepCopy, listProjects, loadProject, projectLink, saveProject, setProjectLink } from "./storage";
import { diskDecision, projectDiff, projectKey } from "./core/diskSync.ts";
import { desktop, invoke } from "./native";

/** How far ahead the preview forecast simulates a routine. */
export const FORECAST_SECONDS = 60;
/** Length of the autonomous period in the 2026 game (REBUILT). */
export const AUTO_PERIOD_SECONDS = 20;
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
  const [renderTime, setRenderTime] = useState(0);
  // A desktop launch relinks the project's file and picks up whatever agents wrote meanwhile.
  const [projectPath, setProjectPathState] = useState<string | null>(() => (desktop ? projectLink(loaded.project.id) : null));
  const [diskConflict, setDiskConflict] = useState(false);
  /** The file's version while it conflicts with unsaved edits here. */
  const [diskVersion, setDiskVersion] = useState<SuiteProject | null>(null);
  /** Why the linked file can't be loaded (the last good version stays on screen). */
  const [diskError, setDiskError] = useState<string | null>(null);
  const [reloadedAt, setReloadedAt] = useState<Date | null>(null);
  /** Canonical text of the file at the last read or write, and the revision known to match it. */
  const lastDiskKey = useRef<string | undefined>(undefined);
  const syncedRevision = useRef<number | undefined>(undefined);
  const projectRef = useRef(project);
  projectRef.current = project;
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
  const frame = interpolatePreviewFrame(
    frames[Math.min(cursor, frames.length - 1)], frames[cursor + 1], renderTime,
  );
  const playbackRef = useRef({ frames, renderTime });
  playbackRef.current = { frames, renderTime };
  const latest = frames[frames.length - 1];

  const reset = useCallback(
    (p: SuiteProject, id: string) => {
      const r = p.routines.find((r) => r.id === id) ?? p.routines[0];
      setPlaying(false);
      setActions({});
      setFrames([initialFrame(p, r)]);
      setCursor(0);
      setRenderTime(0);
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
          if (!conflictRef.current) {
            await invoke("write_suite_project", {
              path,
              project: next,
              expectedRevision: next.revision - 1,
            });
            lastDiskKey.current = projectKey(next);
            syncedRevision.current = next.revision;
          }
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
  const setProjectPath = (path: string | null, id = project.id) => {
    setProjectPathState(path);
    if (desktop) setProjectLink(id, path);
    lastDiskKey.current = undefined;
    syncedRevision.current = undefined;
    setDiskError(null);
    setDiskVersion(null);
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
    setProjectPath(path, next.id);
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

  // Fixed 20 ms simulation, display-refresh rendering. Keep one sample ahead
  // so the robot can interpolate instead of jumping two samples every 40 ms.
  useEffect(() => {
    if (!playing) return;
    let recorded = playbackRef.current.frames;
    let playhead = playbackRef.current.renderTime;
    let previous: number | undefined;
    let request = 0;
    const animate = (timestamp: number) => {
      // Hidden/background windows pause instead of jumping the entire routine.
      const elapsed = previous === undefined ? 0 : Math.min(0.1, Math.max(0, (timestamp - previous) / 1000));
      previous = timestamp;
      playhead += elapsed;
      const additions: Frame[] = [];
      let current = recorded[recorded.length - 1];
      while (current.status === "running" && current.time < playhead + 0.02) {
        current = step(project, routine, current, signals, 0.02, freezeDrive, {
          mode: previewMode, actions,
        });
        additions.push(current);
      }
      if (additions.length) {
        recorded = [...recorded, ...additions];
        setFrames(recorded);
      }
      playhead = Math.min(playhead, current.time);
      let index = recorded.findIndex(f => f.time > playhead + 1e-9);
      index = index < 0 ? recorded.length - 1 : Math.max(0, index - 1);
      setCursor(index);
      setRenderTime(playhead);
      if (current.status !== "running" && playhead >= current.time - 1e-9) {
        setPlaying(false);
        return;
      }
      request = requestAnimationFrame(animate);
    };
    request = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(request);
  }, [playing, project, routine, signals, freezeDrive, previewMode, actions]);
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
    setRenderTime(recorded[index].time);
  };
  const togglePlay = () => {
    if (!playing && latest.status !== "running" && cursor >= frames.length - 1)
      resetPreview();
    setPlaying((p) => !p);
  };

  /** Adopt the file's version in place: keep the routine, step and other pages' selections. */
  const reloadFromDisk = (next: SuiteProject) => {
    saveProject(next, projectRef.current);
    past.current = [...past.current.slice(-49), projectRef.current];
    future.current = [];
    setProject(next);
    lastDiskKey.current = projectKey(next);
    syncedRevision.current = next.revision;
    conflictRef.current = false;
    setDiskConflict(false);
    setDiskVersion(null);
    const r = next.routines.find((r) => r.id === routine.id) ?? next.routines[0];
    setRoutineId(r.id);
    setSelected(selected === "@start" || r.nodes.some((n) => n.id === selected) ? selected : r.initial);
    reconcileSignals(next);
    reset(next, r.id);
    setReloadedAt(new Date());
    setHistoryTick((t) => t + 1);
  };
  const reloadRef = useRef(reloadFromDisk);
  reloadRef.current = reloadFromDisk;

  // Linked project file: pick up edits made on disk (agents, generators, git). Polling handles
  // temp-file-plus-rename saves; a file that fails to parse twice in a row is reported, and the
  // last good version stays until the next good write. Our own writes are recognized by content.
  useEffect(() => {
    if (!projectPath || !desktop) return;
    let cancelled = false,
      inFlight = false,
      failures = 0;
    const poll = async () => {
      if (inFlight || pendingWrites.current || projectIO.current) return;
      inFlight = true;
      try {
        let next: SuiteProject;
        try {
          next = parseProject(JSON.stringify(await invoke<unknown>("read_suite_project", { path: projectPath })));
        } catch (e) {
          // A half-written file usually parses on the next read; only report it if it persists.
          if (!cancelled && ++failures >= 2) setDiskError(e instanceof Error ? e.message : String(e));
          return;
        }
        failures = 0;
        if (cancelled || projectIO.current || pendingWrites.current) return;
        setDiskError(null);
        const decision = diskDecision(next, projectRef.current, {
          lastDiskKey: lastDiskKey.current,
          synced: syncedRevision.current,
          conflict: conflictRef.current,
        });
        lastDiskKey.current = projectKey(next);
        if (decision === "same") {
          if (projectKey(next) === projectKey(projectRef.current)) syncedRevision.current = projectRef.current.revision;
          return;
        }
        if (decision === "conflict") {
          conflictRef.current = true;
          setDiskConflict(true);
          setDiskVersion(next);
          return;
        }
        reloadRef.current(next);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  /** Resolve a conflict: take the file (your version is kept as a copy in Projects), or keep yours. */
  const takeDiskVersion = () => {
    const disk = diskVersion;
    if (!disk || !projectPath) return;
    const copy = keepCopy(projectRef.current, `my edits ${new Date().toLocaleTimeString()}`);
    reloadFromDisk(disk);
    notify(`Loaded the file's version. Your edits are kept as the project "${copy.name}" (Switch project).`);
  };
  const keepMyVersion = () =>
    guardIO(async () => {
      const path = projectPath;
      if (!path) return;
      await writeChain.current;
      const disk = parseProject(JSON.stringify(await invoke<unknown>("read_suite_project", { path })));
      const next = { ...projectRef.current, revision: disk.revision + 1 };
      await invoke("write_suite_project", { path, project: next, expectedRevision: disk.revision });
      saveProject(next, projectRef.current);
      setProject(next);
      lastDiskKey.current = projectKey(next);
      syncedRevision.current = next.revision;
      conflictRef.current = false;
      setDiskConflict(false);
      setDiskVersion(null);
      notify("Your version was saved to the project file.");
    });
  const diskChanges = useMemo(() => (diskVersion ? projectDiff(project, diskVersion) : []), [project, diskVersion]);

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
  /**
   * Open a project file handed to the app from outside (`open -a Mayhem <file>`, a
   * mayhem://open link, `mayhem.mjs open`). Its project becomes active and linked: the copy
   * already in the library is reused, and the watcher then reloads it from the file, or asks
   * first if that copy has edits the file lacks.
   */
  const openProjectPath = (path: string) =>
    guardIO(async () => {
      await writeChain.current;
      const next = parseProject(JSON.stringify(await invoke<unknown>("read_suite_project", { path })));
      const current = projectRef.current;
      if (next.id === current.id) {
        if (projectPath !== path) setProjectPath(path, next.id);
        notify(`Watching ${path}.`);
        return;
      }
      const saved = listProjects().find((p) => p.id === next.id) ?? next;
      activateProject(saved, current);
      adopt(saved, path, `Opened ${saved.name}; watching ${path}.`);
    });
  const openPathRef = useRef(openProjectPath);
  openPathRef.current = openProjectPath;
  useEffect(() => {
    if (!desktop) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    const take = async () => {
      for (const path of await invoke<string[]>("take_opened_projects", {}).catch(() => [] as string[]))
        await openPathRef.current(path);
    };
    void take();
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("open-project", () => void take()).then((unlisten) => (cancelled ? unlisten() : (stop = unlisten))),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

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
      setProjectPath(path, next.id);
      lastDiskKey.current = projectKey(next);
      syncedRevision.current = next.revision;
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
      const path = desktop ? projectLink(next.id) : null;
      adopt(next, path, path ? `Opened ${next.name}; watching ${path}.` : `Opened ${next.name}.`);
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

  /** Where new goals go: after the selected step (or the start), and the goal they follow. */
  const insertionPoint = (copyId?: string) => {
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
    const target = anchor && routine.nodes.find((n) => n.id === anchor.to);
    return { anchorNode, atStart, anchor, previousGoal, nextGoal: target?.goal };
  };
  /** Insert `nodes` as a chain of "Always" steps at the insertion point. */
  const insertChain = (
    r: AutoRoutine,
    nodes: AutoNode[],
    { atStart, anchor }: ReturnType<typeof insertionPoint>,
  ) => {
    const link = (to: string) =>
      nodes.forEach((n, i) =>
        r.transitions.push({
          id: i === nodes.length - 1 ? `to-${to}-${n.id}` : `to-${nodes[i + 1].id}-${n.id}`,
          from: n.id,
          to: i === nodes.length - 1 ? to : nodes[i + 1].id,
          condition: { kind: "always" },
        }),
      );
    if (atStart || (!anchor && r.nodes.length === 1 && r.nodes[0].kind === "finish")) {
      const initial = r.initial;
      r.nodes.unshift(...nodes);
      r.initial = nodes[0].id;
      link(initial);
    } else if (anchor) {
      const edge = r.transitions.find((t) => t.id === anchor.id)!;
      const oldTarget = edge.to;
      edge.to = nodes[0].id;
      r.nodes.splice(
        r.nodes.findIndex((n) => n.id === anchor.from) + 1,
        0,
        ...nodes,
      );
      link(oldTarget);
    } else
      throw new Error(
        "Select a step with an outgoing transition to insert a goal after it.",
      );
  };
  const newPoseId = () => `pose-${crypto.randomUUID().slice(0, 8)}`;

  const addGoal = (
    tool: PlaceTool,
    at?: { x: number; y: number },
    copyId?: string,
  ) => {
    const id = newPoseId();
    const where = insertionPoint(copyId);
    const { anchorNode, previousGoal } = where;
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
                ? "Pass through"
                : tool === "translation"
                  ? "Any heading"
                  : `Pose ${r.nodes.filter((n) => n.kind === "pose").length + 1}`,
            kind: "pose",
            goal,
            timeout: 8,
          };
      insertChain(r, [nextNode], where);
    });
    if (next) setSelected(id);
  };

  /**
   * Add goals along a stroke drawn on the field (BLine's "Add curve"): pass-through
   * points with any heading, ending in a pose that faces the drawn direction.
   */
  const addSketch = (
    stroke: { x: number; y: number }[],
    keepHeading = false,
  ) => {
    const where = insertionPoint();
    const goals = sketchGoals(stroke, where.previousGoal.heading, {
      previous: where.previousGoal,
      next: where.nextGoal,
      keepHeading,
    });
    if (!goals.length) return 0;
    const ids = goals.map(newPoseId);
    const next = editRoutine((r) => {
      let count = r.nodes.filter((n) => n.kind === "pose").length;
      insertChain(
        r,
        goals.map(({ pass, ...pose }, i) => ({
          id: ids[i],
          name: pass ? "Pass through" : `Pose ${++count}`,
          kind: "pose",
          goal: { ...DEFAULT_GOAL, ...pose, ...(pass ? { headingMode: "free" as const } : {}) },
          timeout: 8,
        })),
        where,
      );
    });
    if (next) setSelected(ids.at(-1)!);
    return next ? goals.length : 0;
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
    diskError,
    diskChanges,
    reloadedAt,
    takeDiskVersion,
    keepMyVersion,
    openNativeProject,
    saveNativeProject,
    importProject,
    switchProject,
    applyJson,
    // routine editing
    addGoal,
    addSketch,
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
    setCursor: (index: number) => {
      const bounded = Math.max(0, Math.min(index, frames.length - 1));
      setCursor(bounded);
      setRenderTime(frames[bounded].time);
    },
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
