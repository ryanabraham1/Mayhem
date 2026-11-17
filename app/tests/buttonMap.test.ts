import { describe, expect, it } from "vitest";
import { backgroundOf } from "../src/suite/changes/ButtonMap";
import type { ScenarioResult } from "../src/suite/core/review/simproof";

const run = (id: string, tracks: Record<string, [number, string][]>): ScenarioResult => ({
  scenario: { id, name: id, group: "button", alliance: "blue", field: true, steps: [], expect: [] },
  after: { tracks: Object.entries(tracks).map(([name, ch]) => ({ name, channel: name, changes: ch.map(([time, value]) => ({ time, value })) })), poses: [], offset: 0, duration: 3.5 },
  checks: [],
  differences: [],
  failed: false,
  logs: {},
});

describe("button map", () => {
  // The shooter spins up on its own 1.2 s into teleop, whatever is pressed; only X intakes.
  const shooter: [number, string][] = [[0, "IDLE"], [1.2, "REV"]];
  const results = ["A", "B", "Y", "RT", "Back", "Start"].map((b) => run(`tap-${b}`, { Shooter: shooter, Intake: [[0, "STOWED"]] }));
  results.push(run("tap-X", { Shooter: shooter, Intake: [[0, "STOWED"], [1.02, "INTAKING"]] }));
  const does = backgroundOf(results);
  it("does not credit a button with what the robot does after every press", () => {
    expect(does(results[3], "after", "Shooter")).toBe(false);
    expect(does(results[6], "after", "Shooter")).toBe(false);
  });
  it("credits the button that changes a machine", () => {
    expect(does(results[6], "after", "Intake")).toBe(true);
    expect(does(results[0], "after", "Intake")).toBe(false);
  });
  it("credits a button that stops what usually happens", () => {
    const held = run("tap-LB", { Shooter: [[0, "IDLE"]], Intake: [[0, "STOWED"]] });
    expect(backgroundOf([...results, held])(held, "after", "Shooter")).toBe(true);
  });
});
