import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

vi.mock("../backend", () => ({
  backend: { status: "down", onStatus: vi.fn(), on: vi.fn(), connect: vi.fn(), call: vi.fn(() => Promise.resolve()) },
  isTauri: () => false,
}));

import { useStore } from "../store";
import { newConstraint } from "../model";
import { makeProject, makeTraj } from "../test/fixtures";
import { FieldCanvas } from "./FieldCanvas";

function setup(points: [number, number][], extra: (t: ReturnType<typeof makeTraj>) => void = () => {}) {
  const traj = makeTraj("A", points);
  extra(traj);
  useStore.setState({
    project: makeProject(), dir: null, trajectories: { A: traj }, order: ["A"], selectedTraj: "A",
    selection: null, tool: "select", drawing: [], pending: null, solves: {}, stale: {}, showRed: false,
    past: [], future: [],
  });
  return render(<FieldCanvas mode="path" />);
}

const handle = (c: HTMLElement, h: string) => c.querySelector(`[data-h="${h}"]`) as SVGElement;

/** True if the element, or an ancestor below `stop`, has pointer-events="none". */
const inert = (el: Element, stop: Element) => {
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
    if (e.getAttribute("pointer-events") === "none") return true;
  }
  return false;
};

beforeEach(() => useStore.getState().select(null));

describe("FieldCanvas hit targets", () => {
  it("only the dot and heading knob of a waypoint capture the pointer", () => {
    // Two poses close enough that the second robot's bumper box covers the first one's knob.
    const { container } = setup([[1, 1], [1.6, 1]]);
    const groups = [...container.querySelectorAll('[data-h^="wp:"]')].map((el) => el.parentElement!);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      for (const el of g.querySelectorAll("polygon, polyline, line, rect, circle, path")) {
        if (el.hasAttribute("data-h")) continue;
        expect(inert(el, g), `${el.outerHTML} should not capture clicks`).toBe(true);
      }
    }
  });

  it("draws the selected zone's corner handles above the waypoints", () => {
    const { container } = setup([[1, 1], [3, 1]], (t) => {
      const c = newConstraint("roughTerrain", 2);
      c.id = "zone";
      c.scope = { kind: "zone", from: 0, to: 1, region: [[0.8, 0.8], [2, 0.8], [2, 2], [0.8, 2]] };
      t.constraints.push(c);
    });
    act(() => { useStore.getState().select({ kind: "constraint", id: "zone" }); });
    const all = [...container.querySelectorAll("[data-h]")].map((el) => el.getAttribute("data-h")!);
    const lastWaypointHandle = Math.max(...all.map((h, i) => (/^(wp|hd):/.test(h) ? i : -1)));
    const firstCorner = all.findIndex((h) => h.startsWith("rv:zone:"));
    expect(firstCorner).toBeGreaterThan(lastWaypointHandle);
  });
});

describe("FieldCanvas dragging", () => {
  it("rotates a pose by dragging its heading knob", () => {
    const { container } = setup([[1, 1], [3, 1]]);
    const svg = container.querySelector("svg.field:not(.field-art)")!;
    fireEvent.pointerDown(handle(container, "hd:0"), { button: 0, clientX: 1.67, clientY: 1 });
    fireEvent.pointerMove(svg, { clientX: 1, clientY: 2 });
    fireEvent.pointerUp(svg, { clientX: 1, clientY: 2 });
    expect(useStore.getState().trajectories.A.waypoints[0].heading).toBeCloseTo(Math.PI / 2);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it("moves a zone corner by dragging it", () => {
    const { container } = setup([[1, 1], [3, 1]], (t) => {
      const c = newConstraint("roughTerrain", 2);
      c.id = "zone";
      c.scope = { kind: "zone", from: 0, to: 1, region: [[0.8, 0.8], [2, 0.8], [2, 2], [0.8, 2]] };
      t.constraints.push(c);
    });
    act(() => { useStore.getState().select({ kind: "constraint", id: "zone" }); });
    const svg = container.querySelector("svg.field:not(.field-art)")!;
    fireEvent.pointerDown(handle(container, "rv:zone:0"), { button: 0, clientX: 0.8, clientY: 0.8 });
    fireEvent.pointerMove(svg, { clientX: 0.5, clientY: 0.4 });
    fireEvent.pointerUp(svg, { clientX: 0.5, clientY: 0.4 });
    const c = useStore.getState().trajectories.A.constraints[0];
    expect(c.scope.region[0]).toEqual([0.5, 0.4]);
  });

  it("adds a waypoint at the end with the pose tool and moves the stop", () => {
    const { container } = setup([[1, 1], [3, 1]]);
    act(() => { useStore.getState().setTool("pose"); });
    const svg = container.querySelector("svg.field:not(.field-art)")!;
    fireEvent.pointerDown(svg, { button: 0, clientX: 5, clientY: 4 });
    const w = useStore.getState().trajectories.A.waypoints;
    expect(w).toHaveLength(3);
    expect([w[2].x, w[2].y, w[2].stop, w[1].stop]).toEqual([5, 4, true, false]);
    expect(useStore.getState().selection).toEqual({ kind: "waypoint", index: 2 });
  });

  it("deletes the selected waypoint with the Delete key", () => {
    setup([[1, 1], [3, 1], [5, 1]]);
    act(() => { useStore.getState().select({ kind: "waypoint", index: 1 }); });
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(useStore.getState().trajectories.A.waypoints.map((w) => w.x)).toEqual([1, 5]);
    expect(useStore.getState().selection).toBeNull();
  });

  it("ignores edits in the read-only red alliance preview", () => {
    const { container } = setup([[1, 1], [3, 1]]);
    act(() => { useStore.getState().setShowRed(true); });
    act(() => { useStore.getState().select({ kind: "waypoint", index: 0 }); });
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(useStore.getState().trajectories.A.waypoints).toHaveLength(2);
    expect(container.querySelector('[data-h="hd:0"]')).toBeNull();
    act(() => { useStore.getState().setShowRed(false); });
  });
});
