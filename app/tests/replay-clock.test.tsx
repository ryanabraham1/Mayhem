import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Replay } from "../src/suite/changes/SimProofView";
import { FeedbackProvider } from "../src/suite/tasks/feedback";
import type { ScenarioResult } from "../src/suite/core/review/simproof";

afterEach(() => vi.useRealTimers());

it("plays the sim replay in real time", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "setInterval"] });
  const outcome = { tracks: [{ name: "Shooter", channel: "x", changes: [{ time: 0, value: "OFF" }] }], poses: [], offset: 0, duration: 10 };
  const result: ScenarioResult = {
    scenario: { id: "s", name: "S", group: "custom", alliance: "blue", field: false, steps: [], expect: [] },
    before: outcome,
    after: outcome,
    checks: [],
    differences: [],
    failed: false,
    logs: {},
  };
  render(
    <FeedbackProvider notify={() => {}}>
      <Replay result={result} />
    </FeedbackProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  const t = Number((screen.getByLabelText("Replay time") as HTMLInputElement).value);
  expect(t).toBeGreaterThan(0.9);
  expect(t).toBeLessThan(1.1);
});
