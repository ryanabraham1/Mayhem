import { describe, expect, it } from "vitest";
import { applySeason, seasonOf, SEASONS } from "../src/suite/core/seasons";
import { routeWarnings } from "../src/suite/core/routes";
import { scenarioSet } from "../src/suite/core/review/scenarios";
import { validateProject, type SuiteProject } from "../src/suite/core/model";
import { sampleProject } from "../src/suite/core/sample";

const y2025 = SEASONS.find((s) => s.year === 2025)!;
const y2026 = SEASONS.find((s) => s.year === 2026)!;
const project = (): SuiteProject => structuredClone(sampleProject);

describe("game year", () => {
  it("reads the year from the project's field, then its size", () => {
    expect(seasonOf({ name: "2025 REEFSCAPE", width: 17.548, height: 8.052 })).toBe(y2025);
    expect(seasonOf({ name: "Shop field", width: 17.55, height: 8.05 })).toBe(y2025);
    expect(seasonOf({ name: "2026 REBUILT", width: 16.541, height: 8.0692 })).toBe(y2026);
    expect(seasonOf({ name: "Practice", width: 10, height: 5 })).toBe(y2026);
    expect(seasonOf(undefined)).toBe(y2026);
  });

  it("switching to 2025 changes the field and auto period and keeps the project valid", () => {
    const p = project();
    for (const r of p.routines) for (const n of r.nodes) if (n.goal) n.goal.y = 8.06; // on the 2026 field, off the 2025 one
    applySeason(p, y2025);
    expect(p.field).toEqual({ name: "2025 REEFSCAPE", width: 17.548, height: 8.052 });
    expect(seasonOf(p.field).autoSeconds).toBe(15);
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    expect(p.routines.flatMap((r) => r.nodes).every((n) => !n.goal || n.goal.y <= 8.052)).toBe(true);
    const auto = scenarioSet(p, undefined).scenarios.find((s) => s.group === "auto")!;
    expect(auto.steps).toContain("wait 15");
    applySeason(p, y2026);
    expect(scenarioSet(p, undefined).scenarios.find((s) => s.group === "auto")!.steps).toContain("wait 20");
  });

  it("checks routes against that year's obstacles", () => {
    const p = project();
    applySeason(p, y2025);
    const r = p.routines[0];
    // Straight through the blue reef.
    r.start = { x: 2.5, y: 4.03, heading: 0 };
    const goal = r.nodes.find((n) => n.kind === "pose" && n.goal)!;
    goal.goal = { ...goal.goal!, x: 6.5, y: 4.03 };
    expect(routeWarnings(p, r).some((w) => w.message.includes("Blue Reef"))).toBe(true);
    expect(routeWarnings(p, r).some((w) => w.message.includes("Hub"))).toBe(false);
  });
});
