import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SuiteApp from "../src/suite/SuiteApp";
import { PROJECT_KEY } from "../src/suite/storage";
vi.mock("../src/suite/LogsView", () => ({ LogsView: () => null }));
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
beforeEach(() => localStorage.clear());
it("creates an empty routine, places a goal by clicking the field, then supports undo/redo", () => {
  render(<SuiteApp />);
  fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
  const field = screen.getByLabelText("Autonomous field editor");
  fireEvent.pointerDown(field, { clientX: 5, clientY: 4, button: 0 });
  expect(screen.getByRole("button", { name: '1 Pose',exact:true })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "z", metaKey: true });
  expect(screen.queryByRole("button", { name: '1 Pose',exact:true })).toBeNull();
  fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
  expect(screen.getByRole("button", { name: '1 Pose',exact:true })).toBeTruthy();
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
  expect(
    screen.getByRole("button", { name: "Translation", exact: true }).className,
  ).toBe("active");
  fireEvent.click(
    screen.getByRole("button", { name: "Inspector", exact: true }),
  );
  fireEvent.keyDown(screen.getByLabelText("State name"), { key: "w" });
  expect(
    screen.getByRole("button", { name: "Translation", exact: true }).className,
  ).toBe("active");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(
    screen.getByRole("button", { name: "Select", exact: true }).className,
  ).toBe("active");
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
