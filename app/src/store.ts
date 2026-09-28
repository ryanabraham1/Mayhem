import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet, produce } from "immer";
import { backend, type BackendStatus } from "./backend";
import { flippedName, flipTrajectoryY, folderList, newTrajectory } from "./model";
import type { ConstraintType, DrivetrainInfo, Field, FuelSimConfig, Issue, Project, Trajectory, Vec2 } from "./types";
import { DEFAULT_FUEL_SIM } from "./fuelsim";

enableMapSet();

export type View = "paths" | "field";
export type SettingsTab = "robot" | "path" | "project" | "appearance" | "shortcuts" | "about";
export type Tool = "select" | "pose" | "translation" | "guide" | "constraint" | "region" | "polygon" | "circle";
export type Selection =
  | { kind: "waypoint"; index: number }
  | { kind: "constraint"; id: string }
  | { kind: "marker"; id: string }
  | { kind: "obstacle"; id: string }
  | { kind: "issue"; index: number }
  | { kind: "pose"; id: string }
  | { kind: "simRobot"; id: string }
  | null;

/** Constraint being placed: pick the first waypoint, then the last (or draw a region). */
export interface PendingConstraint {
  type: ConstraintType;
  from: number | null;
}

export interface SolveState {
  status: "idle" | "solving" | "ok" | "failed";
  requestId?: number;
  jobId?: string;
  stage?: string;
  iteration?: number;
  preview?: [number, number, number][];
  previews?: Record<number, [number, number, number][]>;
  candidates?: Vec2[][][];
  issues: Issue[];
  startedAt?: number;
  lastSeconds?: number;
}

interface Snapshot {
  project: Project;
  trajectories: Record<string, Trajectory>;
  order: string[];
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

interface State {
  backendStatus: BackendStatus;
  fields: Field[];
  dir: string | null;
  project: Project | null;
  trajectories: Record<string, Trajectory>;
  order: string[];
  stale: Record<string, boolean>;
  view: View;
  selectedTraj: string | null;
  selection: Selection;
  tool: Tool;
  drawing: Vec2[];
  pending: PendingConstraint | null;
  solves: Record<string, SolveState>;
  generatingAll: boolean;
  playback: { t: number; playing: boolean; speed: number };
  showRed: boolean;
  showGraphs: boolean;
  /** fuel physics playback (app preference; the robots it uses live in project.fuelSim) */
  fuelSimOn: boolean;
  settings: SettingsTab | null;
  drivetrainInfo: DrivetrainInfo | null;
  past: Snapshot[];
  future: Snapshot[];
  toasts: Toast[];
}

interface Actions {
  init(): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;
  openProject(dir: string): Promise<void>;
  createProject(dir: string, field?: Field): Promise<void>;
  closeProject(): void;
  setView(v: View): void;
  setTool(t: Tool): void;
  setDrawing(pts: Vec2[]): void;
  select(s: Selection): void;
  selectTraj(name: string | null): void;
  checkpoint(): void;
  updateProject(fn: (p: Project) => void, opts?: { history?: boolean; affectsSolve?: boolean }): void;
  updateTraj(name: string, fn: (t: Trajectory) => void, opts?: { history?: boolean }): void;
  addTrajectory(name?: string, folder?: string | null): string;
  duplicateTrajectory(name: string): void;
  /** Mirrors a path top <-> bottom (across the field's long center line) and re-solves it; `copy` keeps the original. */
  flipTrajectory(name: string, copy?: boolean): void;
  deleteTrajectory(name: string): void;
  renameTrajectory(oldName: string, newName: string): Promise<void>;
  /** Put a path in a folder (null = top level), optionally placing it before another path. */
  moveTrajectory(name: string, folder: string | null, before?: string | null): void;
  addFolder(name?: string): string;
  renameFolder(oldName: string, newName: string): void;
  /** Removes the folder; its paths move to the top level. */
  deleteFolder(name: string): void;
  undo(): void;
  redo(): void;
  solve(name: string): Promise<void>;
  solveAll(names?: string[]): Promise<void>;
  cancelSolve(name: string): void;
  cancelGeneration(): void;
  syncDeployFolder(): Promise<void>;
  setPlayback(p: Partial<State["playback"]>): void;
  setShowRed(v: boolean): void;
  startConstraint(type: ConstraintType): void;
  setShowGraphs(v: boolean): void;
  setFuelSimOn(v: boolean): void;
  /** Edit the project's fuel sim setup (other robots, our intake rate); never marks paths stale. */
  updateFuelSim(fn: (f: FuelSimConfig) => void, opts?: { history?: boolean }): void;
  openSettings(tab: SettingsTab | null): void;
  refreshDrivetrain(): void;
}

const FUEL_SIM_KEY = "mayhem.fuelSim";

// Debounced disk writes, keyed per file. `flushSaves` runs whatever is still pending right away
// (the updater calls it before restarting the app).
const saveTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }>();

function cancelSave(key: string) {
  clearTimeout(saveTimers.get(key)?.timer);
  saveTimers.delete(key);
}

export async function flushSaves() {
  const pending = [...saveTimers.values()];
  saveTimers.clear();
  pending.forEach((p) => clearTimeout(p.timer));
  await Promise.all(pending.map((p) => p.run()));
}

const trimDir = (d: string) => d.trim().replace(/[\\/]+$/, "");

/** Compares folder paths the way Windows does too: either separator, any case there. */
export function sameDir(a: string, b: string | null | undefined) {
  if (b == null) return false;
  const norm = (d: string) => trimDir(d).replace(/\\/g, "/");
  const [x, y] = [norm(a), norm(b)];
  return /^[a-z]:/i.test(x) || x.startsWith("//") ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export const RECENTS_KEY = "mayhem.recentProjects";

export function recentProjects(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(dir: string) {
  try {
    const list = [dir, ...recentProjects().filter((d) => d !== dir)].slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

let toastId = 1;

export const useStore = create<State & Actions>()(
  immer((set, get) => {
    let nextSolveRequest = 0;
    let activeBatch: { cancelled: boolean } | null = null;
    const earlyDone = new Map<number, any[]>();
    const snapshot = (): Snapshot | null => {
      const s = get();
      return s.project ? { project: s.project, trajectories: s.trajectories, order: s.order } : null;
    };

    const scheduleSave = (key: string, fn: () => Promise<unknown>) => {
      cancelSave(key);
      const run = () => {
        if (saveTimers.get(key)?.run === run) saveTimers.delete(key);
        return fn().then(() => {}, (e) => get().toast("error", `Save failed: ${e.message}`));
      };
      saveTimers.set(key, { timer: setTimeout(run, 400), run });
    };

    // The robot project's deploy folder, when it is somewhere other than the project folder.
    // Generated paths are copied there on every save, so there is no separate deploy step.
    const deployDir = () => {
      const { dir, project } = get();
      const d = project && trimDir(project.deployDir);
      return d && !sameDir(d, dir) ? d : null;
    };

    const saveTraj = (name: string) => {
      const { dir, project, trajectories, stale } = get();
      const t = trajectories[name];
      if (!dir || !project || !t) return;
      const target = trimDir(project.deployDir);
      const mirror = !!t.output && !stale[name] && !!target && !sameDir(target, dir);
      scheduleSave(`t:${dir}:${name}`, async () => {
        await backend.call("saveTrajectory", { dir, trajectory: t });
        if (mirror) {
          try {
            await backend.call("deploy", { dir, project, trajectories: [t] });
          } catch (e: any) {
            get().toast("error", `Saved ${name}, but could not copy to deploy folder: ${e.message}`);
            return;
          }
        }
        get().toast("success", mirror ? `Saved ${name} · copied to deploy folder`
          : stale[name] && target ? `Saved ${name} · regenerate to update deploy folder` : `Saved ${name}`);
      });
    };

    const removeDeployed = (name: string) => {
      const d = deployDir();
      if (d) backend.call("deleteTrajectory", { dir: d, name })
        .catch((e) => get().toast("error", `Could not remove ${name} from deploy folder: ${e.message}`));
    };

    const saveProject = () => {
      const { dir, project } = get();
      if (!dir || !project) return;
      scheduleSave(`project:${dir}`, () => backend.call("saveProject", { dir, project }));
    };

    const markStale = (name: string) => {
      set((s) => {
        if (s.trajectories[name]?.output) s.stale[name] = true;
      });
    };

    const recomputeStale = async () => {
      const { project, trajectories } = get();
      if (!project) return;
      for (const [name, t] of Object.entries(trajectories)) {
        if (!t.output) continue;
        try {
          const h = await backend.call<string>("inputHash", { project, trajectory: t });
          set((s) => {
            s.stale[name] = h !== t.output?.inputHash;
          });
        } catch {
          /* ignore */
        }
      }
    };

    const finishSolve = (p: any) => {
      const name = p.name as string;
      const st = get().solves[name];
      if (!st || st.status !== "solving") return;
      // A fast solve can finish before the RPC response supplies its job ID.
      if (!st.jobId) {
        if (st.requestId !== undefined) {
          earlyDone.set(st.requestId, [...(earlyDone.get(st.requestId) ?? []), p]);
        }
        return;
      }
      if (st.jobId !== p.jobId) return;
      set((s) => {
        const cur = s.solves[name];
        cur.status = p.success ? "ok" : "failed";
        cur.issues = p.issues ?? [];
        cur.lastSeconds = cur.startedAt ? (Date.now() - cur.startedAt) / 1000 : undefined;
        cur.preview = p.success ? undefined : p.preview ?? cur.preview;
        cur.candidates = undefined;
        cur.previews = undefined;
        if (p.success && s.trajectories[name]) {
          s.trajectories[name].output = p.output;
          s.stale[name] = false;
        }
      });
      if (p.success) saveTraj(name);
      else if (!p.cancelled) get().toast("error", `${name}: generation failed — see Issues`);
    };

    /** Undo/redo: swap in the newest snapshot of `from`, pushing the current state onto `to`. */
    const restore = (from: "past" | "future", to: "past" | "future") => {
      const target = get()[from][get()[from].length - 1];
      const cur = snapshot();
      if (!target || !cur) return;
      // Paths the snapshot doesn't have (undone adds, the new name of an undone rename) lose their files.
      const removed = cur.order.filter((n) => !target.trajectories[n]);
      removed.forEach((n) => get().cancelSolve(n));
      set((s) => {
        s[from].pop();
        s[to].push(cur);
        s.project = target.project;
        s.trajectories = target.trajectories;
        s.order = target.order;
        if (s.selectedTraj && !target.trajectories[s.selectedTraj]) s.selectedTraj = target.order[0] ?? null;
        s.selection = null;
      });
      const { dir } = get();
      for (const n of removed) {
        cancelSave(`t:${dir}:${n}`);
        if (dir) backend.call("deleteTrajectory", { dir, name: n }).catch(() => {});
        removeDeployed(n);
      }
      get().order.forEach((n) => saveTraj(n));
      saveProject();
      void recomputeStale();
    };

    return {
      backendStatus: "connecting",
      fields: [],
      dir: null,
      project: null,
      trajectories: {},
      order: [],
      stale: {},
      view: "paths",
      selectedTraj: null,
      selection: null,
      tool: "select",
      drawing: [],
      solves: {},
      generatingAll: false,
      playback: { t: 0, playing: false, speed: 1 },
      showRed: false,
      pending: null,
      showGraphs: false,
      fuelSimOn: (() => { try { return localStorage.getItem(FUEL_SIM_KEY) === "1"; } catch { return false; } })(),
      settings: null,
      drivetrainInfo: null,
      past: [],
      future: [],
      toasts: [],

      init() {
        backend.onStatus((st) => {
          set((s) => {
            s.backendStatus = st;
          });
          if (st === "ready") {
            backend.call<Field[]>("listFields").then((f) => set((s) => { s.fields = f; }));
            get().refreshDrivetrain();
          }
        });
        backend.on("solveProgress", (p: any) => {
          const name = p.name as string;
          set((s) => {
            const st = s.solves[name];
            if (!st || st.status !== "solving" || st.jobId !== p.jobId) return;
            if (p.type === "stage") st.stage = p.stage;
            if (p.type === "iteration") {
              st.iteration = p.iteration;
              st.stage = p.stage;
              st.previews = { ...(st.previews ?? {}), [p.candidate ?? 0]: p.path };
            }
            if (p.type === "candidates") st.candidates = p.routes;
          });
        });
        backend.on("solveDone", (p: any) => {
          finishSolve(p);
        });
        void backend.connect();
      },

      toast(kind, text) {
        const id = toastId++;
        set((s) => {
          s.toasts.push({ id, kind, text });
        });
        setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
      },

      dismissToast(id) {
        set((s) => {
          s.toasts = s.toasts.filter((t) => t.id !== id);
        });
      },

      async openProject(dir) {
        const res = await backend.call<{ dir: string; project: Project; trajectories: any[] }>("openProject", { dir });
        get().cancelGeneration();
        earlyDone.clear();
        const trajectories: Record<string, Trajectory> = {};
        const order: string[] = [];
        for (const t of res.trajectories) {
          if (t.error) {
            get().toast("error", `Could not read ${t.name}: ${t.error}`);
            continue;
          }
          trajectories[t.name] = t;
          order.push(t.name);
        }
        res.project.folders ??= [];
        set((s) => {
          s.dir = res.dir;
          s.project = res.project;
          s.trajectories = trajectories;
          s.order = order;
          s.selectedTraj = order[0] ?? null;
          s.selection = null;
          s.solves = {};
          s.stale = {};
          s.past = [];
          s.future = [];
          s.view = "paths";
          s.playback = { t: 0, playing: false, speed: 1 };
        });
        rememberRecent(res.dir);
        get().refreshDrivetrain();
        void recomputeStale();
      },

      async createProject(dir, field) {
        let project: Project | undefined;
        if (field) {
          project = await backend.call<Project>("defaultProject");
          project.field = field;
        }
        await backend.call("createProject", { dir, project });
        await get().openProject(dir);
        if (get().order.length === 0) get().addTrajectory("Auto 1");
      },

      closeProject() {
        get().cancelGeneration();
        earlyDone.clear();
        set((s) => {
          s.dir = null;
          s.project = null;
          s.trajectories = {};
          s.order = [];
          s.selectedTraj = null;
          s.solves = {};
        });
      },

      setView(v) {
        set((s) => {
          s.view = v;
          s.tool = "select";
          s.pending = null;
          s.drawing = [];
          s.selection = null;
        });
      },

      setTool(t) {
        set((s) => {
          s.tool = t;
          s.drawing = [];
          s.pending = null;
        });
      },

      setDrawing(pts) {
        set((s) => {
          s.drawing = pts;
        });
      },

      select(sel) {
        set((s) => {
          s.selection = sel;
        });
      },

      selectTraj(name) {
        set((s) => {
          s.selectedTraj = name;
          s.selection = null;
          s.playback.t = 0;
          s.playback.playing = false;
        });
      },

      checkpoint() {
        const snap = snapshot();
        if (!snap) return;
        set((s) => {
          s.past.push(snap);
          if (s.past.length > 150) s.past.shift();
          s.future = [];
        });
      },

      updateProject(fn, opts) {
        if (!get().project) return;
        if (opts?.history !== false) get().checkpoint();
        set((s) => {
          if (s.project) fn(s.project);
        });
        saveProject();
        if (opts?.affectsSolve !== false) {
          get().order.forEach((n) => markStale(n));
          get().refreshDrivetrain();
        }
      },

      updateTraj(name, fn, opts) {
        if (!get().trajectories[name]) return;
        if (opts?.history !== false) get().checkpoint();
        set((s) => {
          const t = s.trajectories[name];
          if (t) fn(t);
        });
        saveTraj(name);
        markStale(name);
      },

      addTrajectory(name, folder) {
        const existing = new Set(get().order);
        let n = name ?? "New Path";
        let i = 2;
        while (existing.has(n)) n = `${name ?? "New Path"} ${i++}`;
        get().checkpoint();
        set((s) => {
          s.trajectories[n] = newTrajectory(n);
          if (folder) s.trajectories[n].folder = folder;
          s.order.push(n);
          s.selectedTraj = n;
          s.selection = null;
        });
        saveTraj(n);
        return n;
      },

      duplicateTrajectory(name) {
        const t = get().trajectories[name];
        if (!t) return;
        const n = get().addTrajectory(`${name} copy`);
        set((s) => {
          s.trajectories[n] = produce(t, (d) => {
            d.name = n;
          });
          s.stale[n] = !!s.stale[name];
        });
        saveTraj(n);
      },

      flipTrajectory(name, copy) {
        const { project, trajectories } = get();
        const t = trajectories[name];
        if (!project || !t) return;
        const flipped = flipTrajectoryY(t, project.field, project.poses);
        let target = name;
        if (copy) {
          target = get().addTrajectory(flippedName(name), t.folder);
          set((s) => {
            s.trajectories[target] = { ...flipped, name: target, folder: t.folder };
          });
          saveTraj(target);
        } else {
          get().cancelSolve(name); // a solve already running would land the unflipped result
          get().updateTraj(name, (d) => { Object.assign(d, flipped); });
          set((s) => { delete s.stale[name]; });
        }
        if (get().backendStatus === "ready" && flipped.waypoints.length >= 2) void get().solve(target);
      },

      deleteTrajectory(name) {
        const { dir } = get();
        const saveKey = `t:${dir}:${name}`;
        cancelSave(saveKey);
        get().checkpoint();
        set((s) => {
          delete s.trajectories[name];
          delete s.stale[name];
          s.order = s.order.filter((n) => n !== name);
          if (s.selectedTraj === name) s.selectedTraj = s.order[0] ?? null;
        });
        if (dir) backend.call("deleteTrajectory", { dir, name }).catch(() => {});
        removeDeployed(name);
      },

      async renameTrajectory(oldName, newName) {
        newName = newName.trim();
        if (!newName || newName === oldName) return;
        if (get().trajectories[newName]) {
          get().toast("error", `A path named "${newName}" already exists`);
          return;
        }
        const { dir } = get();
        const saveKey = `t:${dir}:${oldName}`;
        cancelSave(saveKey);
        if (dir) await backend.call("renameTrajectory", { dir, old: oldName, new: newName });
        removeDeployed(oldName);
        get().checkpoint();
        set((s) => {
          const t = s.trajectories[oldName];
          delete s.trajectories[oldName];
          t.name = newName;
          s.trajectories[newName] = t;
          s.stale[newName] = !!s.stale[oldName];
          delete s.stale[oldName];
          s.order = s.order.map((n) => (n === oldName ? newName : n));
          if (s.selectedTraj === oldName) s.selectedTraj = newName;
          if (s.solves[oldName]) {
            s.solves[newName] = s.solves[oldName];
            delete s.solves[oldName];
          }
        });
        saveTraj(newName);
      },

      moveTrajectory(name, folder, before) {
        const t = get().trajectories[name];
        if (!t || name === before) return;
        get().checkpoint();
        set((s) => {
          s.trajectories[name].folder = folder;
          if (folder && s.project && !s.project.folders.includes(folder)) s.project.folders.push(folder);
          if (before !== undefined) {
            const rest = s.order.filter((n) => n !== name);
            const at = before ? rest.indexOf(before) : -1;
            rest.splice(at < 0 ? rest.length : at, 0, name);
            s.order = rest;
          }
        });
        saveTraj(name);
        saveProject();
      },

      addFolder(name) {
        const existing = new Set(folderList(get().project, get().trajectories));
        let n = name?.trim() || "New Folder";
        const base = n;
        let i = 2;
        while (existing.has(n)) n = `${base} ${i++}`;
        get().checkpoint();
        set((s) => {
          s.project?.folders.push(n);
        });
        saveProject();
        return n;
      },

      renameFolder(oldName, newName) {
        newName = newName.trim();
        if (!newName || newName === oldName) return;
        if (folderList(get().project, get().trajectories).includes(newName)) {
          get().toast("error", `A folder named "${newName}" already exists`);
          return;
        }
        const moved = get().order.filter((n) => get().trajectories[n].folder === oldName);
        get().checkpoint();
        set((s) => {
          if (s.project) {
            const i = s.project.folders.indexOf(oldName);
            if (i >= 0) s.project.folders[i] = newName;
            else s.project.folders.push(newName);
          }
          moved.forEach((n) => { s.trajectories[n].folder = newName; });
        });
        moved.forEach(saveTraj);
        saveProject();
      },

      deleteFolder(name) {
        const moved = get().order.filter((n) => get().trajectories[n].folder === name);
        get().checkpoint();
        set((s) => {
          if (s.project) s.project.folders = s.project.folders.filter((f) => f !== name);
          moved.forEach((n) => { s.trajectories[n].folder = null; });
        });
        moved.forEach(saveTraj);
        saveProject();
      },

      undo() {
        restore("past", "future");
      },

      redo() {
        restore("future", "past");
      },

      async solve(name) {
        const { project, trajectories } = get();
        const t = trajectories[name];
        if (!project || !t) return;
        if (get().solves[name]?.status === "solving") return;
        if (t.waypoints.length < 2) {
          set((s) => {
            s.solves[name] = { status: "failed", issues: [{ severity: "error", message: "Add at least 2 waypoints." }] };
          });
          return;
        }
        const { output: _o, ...inputs } = t;
        void _o;
        const requestId = ++nextSolveRequest;
        set((s) => {
          s.solves[name] = { status: "solving", requestId, issues: [], startedAt: Date.now(), stage: "starting" };
        });
        try {
          const { jobId } = await backend.call<{ jobId: string }>("solve", { project, trajectory: inputs });
          if (get().solves[name]?.requestId !== requestId || get().solves[name]?.status !== "solving") {
            earlyDone.delete(requestId);
            void backend.call("cancel", { jobId }).catch(() => {});
            return;
          }
          set((s) => {
            s.solves[name].jobId = jobId;
          });
          const done = earlyDone.get(requestId)?.find((p) => p.jobId === jobId);
          earlyDone.delete(requestId);
          if (done) finishSolve(done);
        } catch (e: any) {
          earlyDone.delete(requestId);
          set((s) => {
            if (s.solves[name]?.requestId === requestId && s.solves[name].status === "solving") {
              s.solves[name] = { status: "failed", issues: [{ severity: "error", message: e.message }] };
            }
          });
        }
      },

      async solveAll(names) {
        if (activeBatch || Object.values(get().solves).some((s) => s.status === "solving")) return;
        // Each solve already runs its route candidates in parallel processes, so only run two
        // paths at a time to avoid oversubscribing the CPU.
        const queue = (names ?? get().order).filter((n) => get().trajectories[n]?.waypoints.length >= 2);
        if (!queue.length) return;
        const batch = { cancelled: false };
        activeBatch = batch;
        set((s) => { s.generatingAll = true; });
        const waitDone = (n: string) => new Promise<void>((resolve) => {
          const check = () => (get().solves[n]?.status === "solving" ? setTimeout(check, 250) : resolve());
          check();
        });
        const worker = async () => {
          while (!batch.cancelled && queue.length) {
            const n = queue.shift()!;
            await get().solve(n);
            await waitDone(n);
          }
        };
        try {
          await Promise.all([worker(), worker()]);
        } finally {
          if (activeBatch === batch) {
            activeBatch = null;
            set((s) => { s.generatingAll = false; });
          }
        }
      },

      cancelSolve(name) {
        const st = get().solves[name];
        if (st?.status !== "solving") return;
        if (st.requestId !== undefined) earlyDone.delete(st.requestId);
        if (st?.jobId) backend.call("cancel", { jobId: st.jobId }).catch(() => {});
        set((s) => {
          s.solves[name] = { status: "idle", issues: [] };
        });
      },

      cancelGeneration() {
        if (activeBatch) activeBatch.cancelled = true;
        Object.entries(get().solves).forEach(([name, st]) => {
          if (st.status === "solving") get().cancelSolve(name);
        });
        if (activeBatch) {
          activeBatch = null;
          set((s) => { s.generatingAll = false; });
        }
      },

      async syncDeployFolder() {
        const { dir, project, order, trajectories, stale } = get();
        const target = deployDir();
        if (!dir || !project || !target) return;
        const list = order.filter((n) => !stale[n]).map((n) => trajectories[n]).filter((t) => t.output);
        if (!list.length) {
          if (order.some((n) => trajectories[n].output && stale[n])) get().toast("info", "Regenerate out-of-date paths to copy them to the deploy folder.");
          return;
        }
        try {
          const res = await backend.call<{ dir: string; written: string[] }>("deploy", { dir, project, trajectories: list });
          get().toast("success", `Copied ${res.written.length} path${res.written.length === 1 ? "" : "s"} to ${res.dir}`);
        } catch (e: any) {
          get().toast("error", `Could not copy to the deploy folder: ${e.message}`);
        }
      },

      setPlayback(p) {
        set((s) => {
          Object.assign(s.playback, p);
        });
      },

      setShowRed(v) {
        set((s) => {
          s.showRed = v;
        });
      },

      startConstraint(type) {
        const region = type === "keepIn" || type === "keepOut" || type === "roughTerrain";
        set((s) => {
          s.tool = region ? "region" : "constraint";
          s.pending = { type, from: null };
          s.drawing = [];
          s.selection = null;
        });
      },

      setShowGraphs(v) {
        set((s) => {
          s.showGraphs = v;
        });
      },

      setFuelSimOn(v) {
        try { localStorage.setItem(FUEL_SIM_KEY, v ? "1" : "0"); } catch { /* ignore */ }
        set((s) => {
          s.fuelSimOn = v;
          if (!v && s.selection?.kind === "simRobot") s.selection = null;
        });
      },

      updateFuelSim(fn, opts) {
        get().updateProject((p) => {
          p.fuelSim ??= structuredClone(DEFAULT_FUEL_SIM);
          fn(p.fuelSim);
        }, { history: opts?.history, affectsSolve: false });
      },

      openSettings(tab) {
        set((s) => {
          s.settings = tab;
        });
      },

      refreshDrivetrain() {
        const p = get().project;
        if (!p || backend.status !== "ready") return;
        backend.call<DrivetrainInfo>("drivetrainInfo", { robot: p.robot })
          .then((info) => set((s) => { s.drivetrainInfo = info; }))
          .catch(() => {});
      },
    };
  }),
);

export const useCurrentTraj = () => useStore((s) => (s.selectedTraj ? s.trajectories[s.selectedTraj] : undefined));
