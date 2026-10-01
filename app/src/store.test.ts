import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newTrajectory, newWaypoint } from "./model";
import type { Project } from "./types";

const listeners = vi.hoisted(() => new Map<string, (params: any) => void>());

vi.mock("./backend", () => ({
  backend: {
    onStatus: vi.fn(),
    on: vi.fn((method: string, cb: (params: any) => void) => listeners.set(method, cb)),
    connect: vi.fn(),
    call: vi.fn(),
  },
}));

import { backend } from "./backend";
import { flushSaves, RECENTS_KEY, recentProjects, useStore } from "./store";
import { makeProject, makeTraj } from "./test/fixtures";

const path = (name: string) => ({
  ...newTrajectory(name),
  waypoints: [newWaypoint(1, 1), newWaypoint(2, 2)],
});

beforeAll(() => useStore.getState().init());

beforeEach(() => {
  vi.mocked(backend.call).mockReset();
  useStore.setState({
    project: {} as Project,
    trajectories: { A: path("A"), B: path("B"), C: path("C") },
    order: ["A", "B", "C"],
    solves: {},
    generatingAll: false,
  });
});

describe("generation cancellation", () => {
  it("keeps an infeasibility event that arrives before the job ID", async () => {
    let reply!: (value: { jobId: string }) => void;
    vi.mocked(backend.call).mockImplementation((method) => method === "solve"
      ? new Promise((resolve) => { reply = resolve; })
      : Promise.resolve(true));
    const pending = useStore.getState().solve("A");
    listeners.get("solveProgress")?.({ name: "A", jobId: "early-job", type: "infeasible",
      issues: [{ severity: "error", message: "Early conflict" }] });
    reply({ jobId: "early-job" });
    await pending;
    expect(useStore.getState().solves.A.warnings?.[0].message).toBe("Early conflict");
  });

  it("streams distinct warnings, replaces them on completion, and preserves them on panel Stop", async () => {
    vi.mocked(backend.call).mockResolvedValue({ jobId: "warning-job" });
    await useStore.getState().solve("A");
    const issue = { severity: "error", message: "Constraint is infeasible", waypoint: 1 };
    const progress = { name: "A", jobId: "warning-job", type: "infeasible", issues: [issue, issue] };
    listeners.get("solveProgress")?.(progress);
    listeners.get("solveProgress")?.(progress);
    expect(useStore.getState().solves.A.warnings).toEqual([issue]);

    listeners.get("solveDone")?.({ name: "A", jobId: "warning-job", success: false,
      issues: [{ severity: "error", message: "Final issue" }] });
    expect(useStore.getState().solves.A.warnings).toBeUndefined();
    expect(useStore.getState().solves.A.issues[0].message).toBe("Final issue");

    await useStore.getState().solve("A");
    listeners.get("solveProgress")?.(progress);
    useStore.getState().stopWithWarnings("A");
    expect(backend.call).toHaveBeenCalledWith("cancel", { jobId: "warning-job" });
    expect(useStore.getState().solves.A).toMatchObject({ status: "failed", issues: [issue] });
    listeners.get("solveDone")?.({ name: "A", jobId: "warning-job", success: false,
      cancelled: true, issues: [{ severity: "info", message: "Cancelled." }] });
    expect(useStore.getState().solves.A.issues).toEqual([issue]);
  });
  it("finishes when the solver result arrives before its job ID", async () => {
    let reply!: (value: { jobId: string }) => void;
    vi.mocked(backend.call).mockImplementation((method) => method === "solve"
      ? new Promise((resolve) => { reply = resolve; })
      : Promise.resolve(true));

    const pending = useStore.getState().solve("A");
    listeners.get("solveDone")?.({ name: "A", jobId: "fast-job", success: false, issues: [{ severity: "error", message: "Failed" }] });
    reply({ jobId: "fast-job" });
    await pending;

    expect(useStore.getState().solves.A.status).toBe("failed");
    expect(useStore.getState().solves.A.issues[0].message).toBe("Failed");
  });

  it("cancels a job whose solve response arrives after cancellation and ignores late results", async () => {
    let reply!: (value: { jobId: string }) => void;
    vi.mocked(backend.call).mockImplementation((method) => method === "solve"
      ? new Promise((resolve) => { reply = resolve; })
      : Promise.resolve(true));

    const pending = useStore.getState().solve("A");
    expect(useStore.getState().solves.A.status).toBe("solving");
    useStore.getState().cancelGeneration();
    expect(useStore.getState().solves.A.status).toBe("idle");

    reply({ jobId: "late-job" });
    await pending;
    expect(backend.call).toHaveBeenCalledWith("cancel", { jobId: "late-job" });

    listeners.get("solveDone")?.({ name: "A", jobId: "late-job", success: true, output: { samples: [] } });
    expect(useStore.getState().trajectories.A.output).toBeNull();
    expect(useStore.getState().solves.A.status).toBe("idle");
  });

  it("keeps a new solve's early result when the cancelled request replies late", async () => {
    const replies: ((value: { jobId: string }) => void)[] = [];
    vi.mocked(backend.call).mockImplementation((method) => method === "solve"
      ? new Promise((resolve) => { replies.push(resolve); })
      : Promise.resolve(true));

    const oldSolve = useStore.getState().solve("A");
    useStore.getState().cancelGeneration();
    const newSolve = useStore.getState().solve("A");
    listeners.get("solveDone")?.({ name: "A", jobId: "new-job", success: false, issues: [{ severity: "error", message: "New result" }] });

    replies[0]({ jobId: "old-job" });
    await oldSolve;
    replies[1]({ jobId: "new-job" });
    await newSolve;

    expect(useStore.getState().solves.A.status).toBe("failed");
    expect(useStore.getState().solves.A.issues[0].message).toBe("New result");
    expect(backend.call).toHaveBeenCalledWith("cancel", { jobId: "old-job" });
  });

  it("stops both active jobs and does not start queued paths", async () => {
    let nextJob = 0;
    vi.mocked(backend.call).mockImplementation((method) => method === "solve"
      ? Promise.resolve({ jobId: `job-${++nextJob}` })
      : Promise.resolve(true));

    const batch = useStore.getState().solveAll();
    await vi.waitFor(() => expect(nextJob).toBe(2));
    expect(useStore.getState().generatingAll).toBe(true);

    useStore.getState().cancelGeneration();
    await batch;

    expect(nextJob).toBe(2);
    expect(useStore.getState().solves.A.status).toBe("idle");
    expect(useStore.getState().solves.B.status).toBe("idle");
    expect(useStore.getState().solves.C).toBeUndefined();
    expect(useStore.getState().generatingAll).toBe(false);
    expect(backend.call).toHaveBeenCalledWith("cancel", { jobId: "job-1" });
    expect(backend.call).toHaveBeenCalledWith("cancel", { jobId: "job-2" });
  });
});

describe("undo and redo keep files on disk in sync", () => {
  const calls = (method: string) => vi.mocked(backend.call).mock.calls.filter(([m]) => m === method).map(([, p]) => p as any);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(backend.call).mockImplementation(() => Promise.resolve(true));
    useStore.setState({
      dir: "/proj", project: makeProject(), trajectories: { A: makeTraj("A") }, order: ["A"], selectedTraj: "A",
      solves: {}, stale: {}, past: [], future: [], generatingAll: false,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("deletes the file of a path whose creation is undone, and doesn't save it again", async () => {
    const name = useStore.getState().addTrajectory("New Path");
    useStore.getState().undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls("deleteTrajectory")).toContainEqual({ dir: "/proj", name });
    expect(calls("saveTrajectory").map((p) => p.trajectory.name)).not.toContain(name);
    expect(useStore.getState().selectedTraj).toBe("A");
  });

  it("restores the old file name when a rename is undone, and the new one on redo", async () => {
    await useStore.getState().renameTrajectory("A", "B");
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(backend.call).mockClear();

    useStore.getState().undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls("deleteTrajectory")).toContainEqual({ dir: "/proj", name: "B" });
    expect(calls("saveTrajectory").map((p) => p.trajectory.name)).toEqual(["A"]);
    expect(useStore.getState().selectedTraj).toBe("A");

    vi.mocked(backend.call).mockClear();
    useStore.getState().redo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls("deleteTrajectory")).toContainEqual({ dir: "/proj", name: "A" });
    expect(calls("saveTrajectory").map((p) => p.trajectory.name)).toEqual(["B"]);
    expect(useStore.getState().selectedTraj).toBe("B");
  });

  it("moves the selection off a path that redo removes", () => {
    useStore.getState().addTrajectory("B");
    useStore.getState().deleteTrajectory("B");
    useStore.getState().undo();
    useStore.getState().selectTraj("B");
    useStore.getState().redo();
    expect(useStore.getState().trajectories.B).toBeUndefined();
    expect(useStore.getState().selectedTraj).toBe("A");
  });

  it("round-trips edits through undo and redo", () => {
    useStore.getState().updateTraj("A", (t) => { t.waypoints[0].x = 5; });
    useStore.getState().undo();
    expect(useStore.getState().trajectories.A.waypoints[0].x).toBe(1);
    useStore.getState().redo();
    expect(useStore.getState().trajectories.A.waypoints[0].x).toBe(5);
    expect(useStore.getState().future).toHaveLength(0);
  });
});

describe("generation stays consistent with edited inputs", () => {
  const output = { inputHash: "original", samples: [], waypointTimes: [], splits: [], events: [],
    recovery: { obstacles: [], roadmapNodes: [], roadmapEdges: [], mustHitTimes: [] },
    stats: { success: true, totalTime: 1, solveSeconds: 1, iterations: 1, candidate: 0, attempts: [] } };
  const done = () => listeners.get("solveDone")?.({name: "A", jobId: "job", success: true, output});
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(backend.call).mockImplementation((m) => Promise.resolve(m === "solve" ? {jobId: "job"} : true));
    useStore.setState({dir: "/proj", project: makeProject({deployDir: "/deploy"}),
      trajectories: {A: {...makeTraj("A"), output}}, order: ["A"], selectedTraj: "A",
      solves: {}, stale: {}, past: [], future: []});
  });
  afterEach(async () => { await flushSaves(); vi.useRealTimers(); });

  it("does not deploy old output after editing a generated path", async () => {
    useStore.getState().updateTraj("A", t => {t.waypoints[0].x = 7;});
    await flushSaves();
    expect(useStore.getState().stale.A).toBe(true);
    expect(vi.mocked(backend.call).mock.calls.some(([m]) => m === "deploy")).toBe(false);
    expect(useStore.getState().toasts.at(-1)?.text).toContain("regenerate");
  });

  it("ignores completion after a waypoint edit during generation", async () => {
    await useStore.getState().solve("A");
    useStore.getState().updateTraj("A", t => {t.waypoints[0].x = 7;});
    done();
    expect(backend.call).toHaveBeenCalledWith("cancel", {jobId: "job"});
    expect(useStore.getState().solves.A.status).toBe("idle");
    expect(useStore.getState().stale.A).toBe(true);
  });

  it("cancels a pending solve response after a robot edit", async () => {
    let reply!: (v: {jobId: string}) => void;
    vi.mocked(backend.call).mockImplementation(m => m === "solve"
      ? new Promise(resolve => {reply = resolve;}) : Promise.resolve(true));
    const pending = useStore.getState().solve("A");
    useStore.getState().updateProject(p => {p.robot.mass = 70;});
    reply({jobId: "job"});
    await pending;
    done();
    expect(backend.call).toHaveBeenCalledWith("cancel", {jobId: "job"});
    expect(useStore.getState().stale.A).toBe(true);
  });

  it("blocks deployment if robot inputs change during an in-flight save", async () => {
    let saved!: (v: boolean) => void;
    vi.mocked(backend.call).mockImplementation(m => m === "saveTrajectory"
      ? new Promise(resolve => {saved = resolve;}) : Promise.resolve(m === "solve" ? {jobId: "job"} : true));
    await useStore.getState().solve("A");
    done();
    const pending = flushSaves();
    useStore.getState().updateProject(p => {p.robot.mass = 70;});
    saved(true);
    await pending;
    expect(vi.mocked(backend.call).mock.calls.some(([m]) => m === "deploy")).toBe(false);
  });

  it("still deploys a completed solve with unchanged inputs", async () => {
    await useStore.getState().solve("A");
    done();
    await flushSaves();
    expect(backend.call).toHaveBeenCalledWith("deploy", expect.objectContaining({trajectories: [useStore.getState().trajectories.A]}));
  });

  it("cancels a running path when renamed and allows generation under the new name", async () => {
    await useStore.getState().solve("A");
    await useStore.getState().renameTrajectory("A", "B");
    done();
    expect(useStore.getState().solves.B.status).toBe("idle");
    expect(useStore.getState().stale.B).toBe(true);
    await useStore.getState().solve("B");
    expect(useStore.getState().solves.B.status).toBe("solving");
  });

  it("does not collide sanitized filenames when creating or renaming", async () => {
    useStore.setState({trajectories: {"A/B": makeTraj("A/B"), C: makeTraj("C")}, order: ["A/B", "C"]});
    expect(useStore.getState().addTrajectory("A_B")).toBe("A_B 2");
    await useStore.getState().renameTrajectory("C", "a_b");
    expect(useStore.getState().trajectories.C).toBeDefined();
    expect(vi.mocked(backend.call).mock.calls.some(([m]) => m === "renameTrajectory")).toBe(false);
  });
});

describe("recentProjects", () => {
  afterEach(() => localStorage.clear());

  it("ignores anything that isn't a list of folder paths", () => {
    for (const bad of ["{}", '"x"', "not json", "[1, null, \"/a\"]"]) {
      localStorage.setItem(RECENTS_KEY, bad);
      expect(recentProjects()).toEqual(bad.includes("/a") ? ["/a"] : []);
    }
  });
});

describe("sameDir", () => {
  it("ignores trailing separators and, for Windows paths, separator style and case", async () => {
    const { sameDir } = await import("./store");
    expect(sameDir("/robot/deploy/", "/robot/deploy")).toBe(true);
    expect(sameDir("/Robot/deploy", "/robot/deploy")).toBe(false);
    expect(sameDir("C:\\Robot\\deploy\\", "c:/robot/deploy")).toBe(true);
    expect(sameDir("C:\\robot\\deploy", "C:\\robot\\src")).toBe(false);
    expect(sameDir("C:\\robot", null)).toBe(false);
  });
});

describe("fuel sim setup", () => {
  it("edits project.fuelSim with undo and never marks paths stale", () => {
    useStore.setState({ project: makeProject(), stale: {}, past: [], future: [], dir: null });
    const a = useStore.getState();
    a.updateFuelSim((f) => { f.intakeRate = 6; });
    expect(useStore.getState().project!.fuelSim).toEqual({ intakeRate: 6, capacity: 0, robots: [] });
    expect(useStore.getState().stale).toEqual({});
    useStore.getState().undo();
    expect(useStore.getState().project!.fuelSim).toBeUndefined();
  });

  it("clears a selected sim robot when the sim is turned off", () => {
    useStore.setState({ selection: { kind: "simRobot", id: "r1" } });
    useStore.getState().setFuelSimOn(false);
    expect(useStore.getState().selection).toBeNull();
    expect(useStore.getState().fuelSimOn).toBe(false);
  });
});
