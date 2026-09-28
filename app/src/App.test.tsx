import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./backend", () => ({
  backend: { status: "down", onStatus: vi.fn(), on: vi.fn(), connect: vi.fn(), call: vi.fn(() => Promise.resolve()) },
  isTauri: () => false,
}));

import App from "./App";
import { RECENTS_KEY, useStore } from "./store";
import { newConstraint, newMarker } from "./model";
import { makeProject, makeTraj } from "./test/fixtures";

function openProject() {
  const t = makeTraj("Auto", [[1, 1], [3, 2], [5, 1]]);
  t.constraints = [newConstraint("maxVelocity", 3), newConstraint("pointAt", 3, [4, 4])];
  t.markers = [newMarker(1)];
  const project = makeProject();
  project.field.obstacles = [{ id: "o1", name: "Hub", kind: "circle", points: [], center: [8, 4], radius: 0.5, margin: 0, enabled: true }];
  useStore.setState({
    backendStatus: "ready", project, dir: "/proj", trajectories: { Auto: t }, order: ["Auto"], selectedTraj: "Auto",
    selection: null, view: "paths", tool: "select", settings: null, solves: {}, stale: {}, past: [], future: [],
  });
}

const key = (k: string, extra: object = {}) => act(() => { fireEvent.keyDown(document.body, { key: k, ...extra }); });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ project: null, backendStatus: "ready", settings: null, toasts: [] });
});

describe("App", () => {
  it("shows the welcome screen with recent projects", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(["/robots/2026/mayhem"]));
    render(<App />);
    expect(screen.getByText("New project")).toBeTruthy();
    expect(screen.getByText("mayhem")).toBeTruthy();
  });

  it("survives a corrupted recent-projects list", () => {
    localStorage.setItem(RECENTS_KEY, "{}");
    render(<App />);
    expect(screen.getByText("Open project")).toBeTruthy();
  });

  it("renders every inspector panel without crashing", () => {
    openProject();
    render(<App />);
    const t = useStore.getState().trajectories.Auto;
    for (const sel of [
      { kind: "waypoint", index: 0 }, { kind: "waypoint", index: 2 },
      { kind: "constraint", id: t.constraints[0].id }, { kind: "constraint", id: t.constraints[1].id },
      { kind: "marker", id: t.markers[0].id },
    ] as const) {
      act(() => useStore.getState().select(sel));
      expect(document.querySelector(".float.props")).toBeTruthy();
    }
  });

  it("switches tools with the keyboard, but not while typing", () => {
    openProject();
    render(<App />);
    key("w");
    expect(useStore.getState().tool).toBe("pose");
    key("g");
    expect(useStore.getState().tool).toBe("guide");
    act(() => useStore.getState().select({ kind: "waypoint", index: 0 }));
    const input = document.querySelector(".float.props input")!;
    act(() => { fireEvent.keyDown(input, { key: "t" }); });
    expect(useStore.getState().tool).toBe("guide");
  });

  it("undoes and redoes with ⌘Z / ⇧⌘Z", () => {
    openProject();
    render(<App />);
    act(() => useStore.getState().updateTraj("Auto", (t) => { t.waypoints[0].x = 9; }));
    key("z", { metaKey: true });
    expect(useStore.getState().trajectories.Auto.waypoints[0].x).toBe(1);
    key("z", { metaKey: true, shiftKey: true });
    expect(useStore.getState().trajectories.Auto.waypoints[0].x).toBe(9);
  });

  it("opens every settings tab", () => {
    openProject();
    render(<App />);
    key(",", { metaKey: true });
    for (const tab of ["Robot", "Path solver", "Project", "Appearance", "Shortcuts", "About & updates"]) {
      fireEvent.click(screen.getByText(tab, { selector: ".modal-nav .name" }));
      expect(document.querySelector(".modal-content")!.textContent).not.toBe("");
    }
  });

  it("shows the field view with its obstacle editor", () => {
    openProject();
    render(<App />);
    fireEvent.click(screen.getByText("Field"));
    expect(screen.getByText("Hub")).toBeTruthy();
    fireEvent.click(screen.getByText("Hub"));
    expect(screen.getByText("Obstacle")).toBeTruthy();
    key("p");
    expect(useStore.getState().tool).toBe("polygon");
  });

  it("lists generation issues and jumps to the waypoint when one is clicked", () => {
    openProject();
    useStore.setState({ solves: { Auto: { status: "failed", issues: [{ severity: "error", message: "Hits the hub", waypoint: 1 }] } } });
    render(<App />);
    fireEvent.click(screen.getByText("Hits the hub"));
    expect(useStore.getState().selection).toEqual({ kind: "waypoint", index: 1 });
  });
});
