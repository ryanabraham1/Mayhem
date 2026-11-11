import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PoseReplay } from "../src/suite/PoseReplay";
import type { Recording } from "../src/suite/core/analysis";

const recording: Recording = {
  name: "Delayed pose", duration: 5, warnings: [],
  channels: [
    { name: "NT:/DriveState/Pose/x", type: "double", samples: [{ time: 1.21, value: 2 }, { time: 3, value: 4 }] },
    { name: "NT:/DriveState/Pose/y", type: "double", samples: [{ time: 1.22, value: 3 }, { time: 3, value: 4 }] },
    { name: "NT:/DriveState/Pose/heading", type: "double", samples: [{ time: 1.21, value: 0 }] },
  ],
};

it("keeps the field visible before pose logging starts and reveals the robot when samples arrive", () => {
  const { container, rerender } = render(<PoseReplay recording={recording} time={0.4} />);
  expect(screen.getByLabelText("Recorded robot field replay")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Pose data starts at 1.22 s");
  expect(container.querySelector('g[transform^="translate(2,"]')).toBeNull();
  rerender(<PoseReplay recording={recording} time={1.22} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector('g[transform^="translate(2,"]')).toBeTruthy();
  rerender(<PoseReplay recording={recording} time={0} />);
  expect(screen.getByRole("status").textContent).toContain("Pose data starts");
});

it("keeps the field and mapping guidance visible when a position signal is unmapped", () => {
  render(<PoseReplay recording={recording} time={2} />);
  fireEvent.change(screen.getByLabelText("X position (m)"), { target: { value: "" } });
  expect(screen.getByLabelText("Recorded robot field replay")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Choose recorded X and Y");
});
