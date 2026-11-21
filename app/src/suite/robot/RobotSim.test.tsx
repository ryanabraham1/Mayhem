import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKTREE } from "../core/review/report.ts";

const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock("../native", () => ({
  desktop: true,
  nativeRead: vi.fn(),
  invoke: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "review_snapshot") return { rev: WORKTREE, label: "This computer", files: {} };
    if (name === "review_sim_prepare") throw new Error("build failed: missing gradlew");
    return undefined;
  }),
}));
vi.mock("../robotRepo", () => ({ useRobotRepo: () => ["/robot", () => {}], chooseRepo: vi.fn() }));
const { RobotSim } = await import("./RobotSim");

beforeEach(() => {
  calls.length = 0;
});

describe("Robot → Simulation", () => {
  it("builds only the code on this computer, with nothing to compare against", async () => {
    render(<RobotSim />);
    fireEvent.click(await screen.findByRole("button", { name: "Run simulation" }));
    expect(await screen.findByText(/build failed: missing gradlew/)).toBeTruthy();
    const builds = calls.filter((c) => c.name === "review_sim_prepare");
    expect(builds).toEqual([{ name: "review_sim_prepare", args: expect.objectContaining({ repo: "/robot", rev: WORKTREE }) }]);
    // The files are read again right before building, so the run uses what is on disk now.
    expect(calls.filter((c) => c.name === "review_snapshot").length).toBe(2);
  });
});
