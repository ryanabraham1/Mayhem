import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SuiteApp from "../src/suite/SuiteApp";
import { PROJECT_KEY } from "../src/suite/storage";
import { IDBFactory } from "fake-indexeddb";
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage() {}
  terminate() {}
}
vi.stubGlobal("Worker", FakeWorker);
class Point {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  matrixTransform() {
    return this;
  }
}
Object.assign(globalThis, { DOMPoint: Point });
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  // Most tests exercise the autonomous editor; the app remembers the last page.
  localStorage.setItem("mayhem.page.v1", "autos");
});
const pressed = (name: string) =>
  screen.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
it("creates an empty routine, places a goal by clicking the field, then supports undo/redo", () => {
  render(<SuiteApp />);
  fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
  const field = screen.getByLabelText("Autonomous field editor");
  fireEvent.pointerDown(field, { clientX: 5, clientY: 4, button: 0 });
  expect(screen.getByRole("button", { name: '1 Pose 1',exact:true })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "z", metaKey: true });
  expect(screen.queryByRole("button", { name: '1 Pose 1',exact:true })).toBeNull();
  fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
  expect(screen.getByRole("button", { name: '1 Pose 1',exact:true })).toBeTruthy();
});
it("switches the full workspace theme and restores the choice after reopening", () => {
  const view = render(<SuiteApp />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("mayhem.theme")).toBe("dark");
  view.unmount();
  render(<SuiteApp />);
  expect(
    screen.getByRole("button", { name: "Switch to light mode" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("changes placement tools with shortcuts without changing them while typing", () => {
  render(<SuiteApp />);
  fireEvent.keyDown(document.body, { key: "t" });
  expect(pressed("Translation")).toBe("true");
  fireEvent.keyDown(screen.getByLabelText("State name"), { key: "w" });
  expect(pressed("Translation")).toBe("true");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(pressed("Select")).toBe("true");
});
it("does not reset the preview just by selecting an existing goal", () => {
  render(<SuiteApp />);
  const goal = screen.getByLabelText("Select goal Approach pickup");
  fireEvent.pointerDown(goal, {
    clientX: 5.8,
    clientY: 5.6,
    button: 0,
    pointerId: 1,
  });
  fireEvent.pointerUp(goal, {
    clientX: 5.8,
    clientY: 5.6,
    button: 0,
    pointerId: 1,
  });
  expect(screen.getByText(/revision 0/)).toBeTruthy();
});
it("edits the routine start without changing the robot default and inserts a first goal from Start", () => {
  render(<SuiteApp />);
  fireEvent.click(
    screen.getByRole("button", { name: "Starting pose", exact: true }),
  );
  const input = screen.getByRole("spinbutton", {
    name: "Starting X",
    exact: true,
  });
  fireEvent.change(input, { target: { value: "1.8" } });
  fireEvent.blur(input);
  let saved = JSON.parse(localStorage.getItem(PROJECT_KEY)!);
  expect(saved.routines[0].start.x).toBe(1.8);
  expect(saved.robot.start.x).toBe(1.4);
  fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
  fireEvent.keyDown(document.body, { key: "w" });
  fireEvent.pointerDown(screen.getByLabelText("Autonomous field editor"), {
    clientX: 2.4,
    clientY: 3,
    button: 0,
  });
  saved = JSON.parse(localStorage.getItem(PROJECT_KEY)!);
  const r = saved.routines[0];
  expect(r.nodes[0].goal.x).toBe(2.4);
  expect(r.initial).toBe(r.nodes[0].id);
  expect(
    r.transitions.find((t: { from: string }) => t.from === r.initial).to,
  ).toBe("pickup");
});
it("keeps autonomous controls inside Autos and preserves the routine when switching tools", () => {
  render(<SuiteApp />);
  expect(screen.getByRole("complementary",{name:"Autonomous routines"})).toBeTruthy();
  for(const name of ["State machines", "Logs", "Robot", "Agents", "Overview"]){
    fireEvent.click(screen.getByRole("button",{name,exact:true}));
    expect(screen.queryByRole("complementary",{name:"Autonomous routines"})).toBeNull();
    expect(screen.queryByRole("button",{name:"Export project",exact:true})).toBeNull();
    expect(screen.queryByRole("button",{name:"Preview",exact:true})).toBeNull();
  }
  fireEvent.click(screen.getByRole("button",{name:"Autonomous",exact:true}));
  expect(screen.getByRole("button",{name:"Collect & score",exact:true})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Robot",exact:true}));
  expect(screen.queryByRole("complementary",{name:"Autonomous routines"})).toBeNull();
});

it("replays recorded frames after scrubbing instead of jumping to the live end", async () => {
  vi.useFakeTimers();
  try {
    render(<SuiteApp />);
    fireEvent.click(screen.getByRole("button", {name:"Play simulation"}));
    for(let i=0;i<8;i++) await act(()=>vi.advanceTimersByTimeAsync(45));
    fireEvent.click(screen.getByRole("button", {name:"Pause simulation"}));
    const slider=screen.getByRole("slider",{name:"Preview time"}) as HTMLInputElement;
    const end=Number(slider.max);
    expect(end).toBeGreaterThan(4);
    fireEvent.change(slider,{target:{value:"0"}});
    fireEvent.click(screen.getByRole("button", {name:"Play simulation"}));
    await act(()=>vi.advanceTimersByTimeAsync(45));
    expect(Number(slider.value)).toBeGreaterThan(0);
    expect(Number(slider.value)).toBeLessThan(end);
  } finally {vi.useRealTimers();}
});

it("creates, renames, and switches projects while preserving the previous workspace", async () => {
  render(<SuiteApp />);
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Practice robot" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create project", exact: true })));
  expect(screen.getByRole("button", { name: "Switch project" }).textContent).toContain("Practice robot");
  expect(screen.queryByRole("button", { name: "Collect & score", exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Practice v2" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Competition robot.*1 routines/ })));
  expect(screen.getByRole("button", { name: "Collect & score", exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
  expect(screen.getByRole("button", { name: /Practice v2/ })).toBeTruthy();
});
it("completes the sample path in the default preview and exposes full-routine inputs", async () => {
  vi.useFakeTimers();
  try {
    render(<SuiteApp />);
    fireEvent.click(screen.getByRole("button", { name: "Play simulation" }));
    for (let i = 0; i < 450; i++) await act(() => vi.advanceTimersByTimeAsync(40));
    expect(screen.getByText("Preview completed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Preview mode"), { target: { value: "routine" } });
    expect(screen.getByText(/Set simulated callback results/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Piece detected" })).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it("opens on the overview by default with a card per routine that leads into the editor", () => {
  localStorage.removeItem("mayhem.page.v1");
  render(<SuiteApp />);
  expect(screen.getByRole("heading", { name: "Competition robot", level: 1 })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Collect & score/ }));
  expect(screen.getByRole("complementary", { name: "Autonomous routines" })).toBeTruthy();
  expect(localStorage.getItem("mayhem.page.v1")).toBe("autos");
});
it("steps a robot state machine when its simulated inputs change", () => {
  localStorage.setItem("mayhem.page.v1", "states");
  render(<SuiteApp />);
  fireEvent.click(screen.getByRole("button", { name: /Intake state machine/ }));
  const active = () => document.querySelector(".mx-state.is-active")?.textContent ?? "";
  expect(active()).toContain("Idle");
  fireEvent.click(screen.getByRole("switch", { name: "Intake requested" }));
  expect(active()).toContain("Acquiring");
  fireEvent.click(screen.getByRole("button", { name: "Reset", exact: true }));
  expect(active()).toContain("Idle");
});
it("shows an inviting empty log library and links to robot collection", () => {
  localStorage.setItem("mayhem.page.v1", "logs");
  render(<SuiteApp />);
  expect(screen.getByRole("heading", { name: "Bring in your first log" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Set up robot collection" }));
  expect(screen.getByRole("heading", { name: "Robot", level: 1 })).toBeTruthy();
  expect(screen.getByRole("switch", { name: /Collect logs whenever the robot is plugged in/ })).toBeTruthy();
});
it("derives the robot address from the team number", () => {
  localStorage.setItem("mayhem.page.v1", "robot");
  render(<SuiteApp />);
  fireEvent.change(screen.getByLabelText("Team number"), { target: { value: "254" } });
  expect(screen.getByText(/roborio-254-frc\.local/)).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("mayhem.robot.v1")!).team).toBe(254);
});
