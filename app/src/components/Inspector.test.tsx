import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../backend", () => ({
  backend: { status: "down", onStatus: vi.fn(), on: vi.fn(), connect: vi.fn(), call: vi.fn(() => Promise.resolve()) },
  isTauri: () => false,
}));

import { useStore, useCurrentTraj } from "../store";
import { newConstraint, newMarker } from "../model";
import { makeProject, makeTraj } from "../test/fixtures";
import type { Constraint, Trajectory } from "../types";
import { ConstraintEditor, WaypointEditor } from "./Inspector";

const upd = (fn: (t: Trajectory) => void) => useStore.getState().updateTraj("A", fn);
const traj = () => useStore.getState().trajectories.A;

function LiveConstraint({ id }: { id: string }) {
  const t = useCurrentTraj()!;
  const c = t.constraints.find((x) => x.id === id);
  return c ? <ConstraintEditor traj={t} c={c} upd={upd} /> : null;
}

function setup(t: Trajectory) {
  useStore.setState({
    project: makeProject(), dir: null, trajectories: { A: t }, order: ["A"], selectedTraj: "A",
    selection: null, solves: {}, stale: {}, past: [], future: [],
  });
}

const typeSelect = () => screen.getAllByRole("combobox")[0];

describe("ConstraintEditor", () => {
  let c: Constraint;
  beforeEach(() => {
    const t = makeTraj("A", [[1, 1], [2, 1], [3, 1]]);
    c = newConstraint("maxVelocity", 3, undefined, 1, 1);
    t.constraints = [c];
    setup(t);
  });

  it("gives a straight line a range of waypoints when switched from a single-waypoint constraint", () => {
    render(<LiveConstraint id={c.id} />);
    expect(traj().constraints[0].scope.kind).toBe("waypoint");
    fireEvent.change(typeSelect(), { target: { value: "straightLine" } });
    const s = traj().constraints[0].scope;
    expect([s.kind, s.from, s.to]).toEqual(["range", 1, 2]);
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("To")).toBeTruthy();
  });

  it("turns a zone into a range when switched to a straight line", () => {
    upd((t) => { t.constraints[0].scope = { kind: "zone", from: 0, to: 2, region: [[0, 0], [1, 0], [1, 1]] }; });
    render(<LiveConstraint id={c.id} />);
    fireEvent.change(typeSelect(), { target: { value: "straightLine" } });
    const s = traj().constraints[0].scope;
    expect([s.kind, s.from, s.to]).toEqual(["range", 0, 2]);
  });

  it("moves a keep-out region into a rough-terrain zone", () => {
    upd((t) => { t.constraints[0].data = { type: "keepOut", points: [[0, 0], [1, 0], [1, 1]], margin: 0 }; });
    render(<LiveConstraint id={c.id} />);
    fireEvent.change(typeSelect(), { target: { value: "roughTerrain" } });
    const s = traj().constraints[0].scope;
    expect(s.kind).toBe("zone");
    expect(s.region).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("keeps the range consistent when picking From after To", () => {
    upd((t) => { t.constraints[0].scope = { kind: "range", from: 0, to: 1, region: [] }; });
    render(<LiveConstraint id={c.id} />);
    const [, from] = screen.getAllByRole("combobox");
    fireEvent.change(from, { target: { value: "2" } });
    const s = traj().constraints[0].scope;
    expect([s.from, s.to]).toEqual([2, 2]);
  });
});

describe("WaypointEditor", () => {
  it("deletes the waypoint along with its markers, shifting marker zones", () => {
    const t = makeTraj("A", [[1, 1], [2, 1], [3, 1], [4, 1]]);
    t.markers = [newMarker(1), { ...newMarker(0), endWaypoint: 3 }];
    setup(t);
    render(<WaypointEditor traj={t} index={1} upd={upd} />);
    fireEvent.click(screen.getByTitle("Delete waypoint (⌫)"));
    expect(traj().waypoints.map((w) => w.x)).toEqual([1, 3, 4]);
    expect(traj().markers.map((m) => [m.waypoint, m.endWaypoint])).toEqual([[0, 2]]);
    expect(useStore.getState().selection).toBeNull();
  });

  it("edits a linked pose variable instead of the waypoint", () => {
    const t = makeTraj("A");
    t.waypoints[0].poseRef = "p1";
    setup(t);
    useStore.setState((s) => { s.project!.poses = [{ id: "p1", name: "Start", x: 7, y: 2, heading: 0 }]; });
    render(<WaypointEditor traj={t} index={0} upd={upd} />);
    const x = screen.getAllByRole("textbox")[0];
    expect((x as HTMLInputElement).value).toBe("7");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "8" } });
    fireEvent.blur(x);
    expect(useStore.getState().project!.poses[0].x).toBe(8);
    expect(traj().waypoints[0].x).toBe(1);
  });
});
