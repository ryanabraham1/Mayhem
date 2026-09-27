import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { useStore } from "./store";

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
