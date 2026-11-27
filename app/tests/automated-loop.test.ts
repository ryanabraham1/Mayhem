import { describe, expect, it } from "vitest";
import { checkMachines } from "../src/suite/core/review/modelcheck";
import { scenarioCoverage } from "../src/suite/core/review/coverage";
import type { MachineManifest } from "../src/suite/core/machines";
import type { Condition } from "../src/suite/core/model";
// @ts-expect-error plain ES module without types
import { lintFiles } from "../../scripts/lint.mjs";

const sig = (key: string, value: boolean | number | string = true, op: "eq" | "gt" | "lt" = "eq"): Condition => ({ kind: "signal", key, op, value });
const machine = (over: Partial<MachineManifest>): MachineManifest =>
  ({
    format: "mayhem-machine",
    version: 1,
    id: "ee",
    name: "End effector",
    initial: "IDLE",
    states: [
      { id: "IDLE", name: "Idle" },
      { id: "EJECT", name: "Ejecting" },
    ],
    inputs: [
      { key: "ejectHeld", name: "Eject (RS)", type: "boolean", initial: false, category: "operator" },
      { key: "enabled", name: "Enabled", type: "boolean", initial: true },
    ],
    transitions: [],
    ...over,
  }) as MachineManifest;

describe("model check", () => {
  it("finds the loop a held button causes while disabled, with the inputs that cause it", () => {
    const m = machine({
      transitions: [
        { id: "eject", from: "IDLE", to: "EJECT", condition: sig("ejectHeld") },
        { id: "disabled", from: "EJECT", to: "IDLE", condition: sig("enabled", false) },
      ],
    });
    const r = checkMachines([m]);
    const loops = r.problems.filter((p) => p.kind === "loops");
    expect(loops).toHaveLength(1);
    expect(loops[0].inputs).toEqual({ ejectHeld: true, enabled: false });
    // Fixed: the eject edge also needs the robot enabled.
    m.transitions[0].condition = { kind: "all", conditions: [sig("ejectHeld"), sig("enabled")] };
    expect(checkMachines([m]).problems.filter((p) => p.kind === "loops")).toEqual([]);
  });

  it("finds unreachable states, traps, shadowed transitions and unknown inputs", () => {
    const m = machine({
      states: [
        { id: "IDLE", name: "Idle" },
        { id: "EJECT", name: "Ejecting" },
        { id: "STUCK", name: "Stuck" },
        { id: "LOST", name: "Lost" },
      ],
      transitions: [
        { id: "any", from: "IDLE", to: "EJECT", name: "Anything", condition: { kind: "always" } },
        { id: "eject", from: "IDLE", to: "STUCK", name: "Eject", condition: sig("ejectHeld") },
        { id: "back", from: "EJECT", to: "IDLE", condition: sig("enabled", false) },
        { id: "typo", from: "EJECT", to: "STUCK", name: "Typo", condition: sig("ejectHled") },
      ],
    });
    const kinds = checkMachines([m]).problems.map((p) => `${p.kind} ${p.state ?? p.transition}`);
    expect(kinds).toContain("unknown-input Typo");
    expect(kinds).toContain("never-fires Eject");
    expect(kinds).toContain("unreachable STUCK");
    expect(kinds).toContain("unreachable LOST");
    const shadow = checkMachines([m]).problems.find((p) => p.transition === "Eject")!;
    expect(shadow.text).toMatch(/“Anything” comes first in priority order/);
  });

  it("splits numbers at each threshold, so a gap between thresholds is found", () => {
    const m = machine({
      inputs: [{ key: "speed", name: "Speed", type: "number", initial: 0 }],
      transitions: [
        { id: "fast", from: "IDLE", to: "EJECT", condition: sig("speed", 10, "gt") },
        { id: "slow", from: "EJECT", to: "IDLE", condition: sig("speed", 5, "lt") },
      ],
    });
    expect(checkMachines([m]).problems).toEqual([]);
    // Overlapping thresholds: at 7 both are true, and it flips every loop.
    m.transitions[1].condition = sig("speed", 12, "lt");
    const loop = checkMachines([m]).problems.find((p) => p.kind === "loops");
    expect(loop?.inputs?.speed).toBeGreaterThan(10);
    expect(loop?.inputs?.speed).toBeLessThan(12);
  });

  it("treats a priority supervisor's rows as deciding even when they keep the state", () => {
    const m = machine({
      selection: "priority",
      transitions: [
        { id: "off", from: "*", to: "IDLE", condition: sig("enabled", false) },
        { id: "eject", from: "*", to: "EJECT", condition: sig("ejectHeld") },
        { id: "otherwise", from: "*", to: "IDLE", condition: { kind: "always" } },
      ],
    });
    expect(checkMachines([m]).problems).toEqual([]);
  });
});

describe("feature map", () => {
  it("lists every state with how it is reached and what proves it", () => {
    const m = machine({ transitions: [{ id: "eject", from: "IDLE", to: "EJECT", condition: sig("ejectHeld") }] });
    const run = (name: string, expect: string[]) => ({
      scenario: { id: name, name, group: "custom" as const, alliance: "blue" as const, field: true, steps: ["teleop", "hold RS 1"], expect },
      after: { tracks: [{ name: "End effector", channel: "x", changes: [{ time: 0, value: "IDLE" }, { time: 0.4, value: "EJECT" }] }], poses: [], offset: 0, duration: 2 },
    });
    const c = scenarioCoverage([m], [run("Eject", ["End effector reaches EJECT"]), run("Eject again", [])]);
    expect(c.map).toEqual([
      { machine: "End effector", state: "EJECT", name: "Ejecting", status: "proven", reachedBy: { scenario: "Eject", steps: ["teleop", "hold RS 1"], time: 0.4 }, provenBy: ["Eject"] },
    ]);
  });
});

describe("lint", () => {
  const lint = (path: string, text = "") => lintFiles([{ path, text }]).map((p: { rule: string }) => p.rule);
  it("keeps core portable and the synced log core standalone", () => {
    expect(lint("app/src/suite/core/x.ts", 'import { FieldArt } from "../FieldArt";')).toEqual(["core-is-portable"]);
    expect(lint("app/src/suite/core/x.ts", 'import { memo } from "react";')).toEqual(["core-is-portable"]);
    expect(lint("app/src/suite/core/review/x.ts", 'import { a } from "../model.ts";')).toEqual([]);
    expect(lint("app/src/suite/core/plot.ts", 'import { a } from "./model.ts";')).toEqual(["log-core-standalone"]);
    expect(lint("app/src/suite/core/plot.ts", 'import { a } from "./analysis.ts";')).toEqual([]);
    expect(lint("scripts/x.mjs", 'await import("../app/src/suite/logs/LogsPage.tsx")')).toEqual(["scripts-use-core"]);
  });
  it("flags deferred quick fixes and the comments that justify them", () => {
    expect(lint("app/src/suite/x.ts", "// release later, in case it comes back\nsetTimeout(() => release(id), 0);")).toEqual(["no-deferred-fix", "no-workaround-comments"]);
    expect(lint("app/src/suite/x.ts", "setTimeout(() => save(), 500);")).toEqual([]);
    expect(lint("app/src/suite/x.ts", "// hack: for now skip the check")).toEqual(["no-workaround-comments"]);
  });
  it("flags focused tests and unsolicited markdown", () => {
    expect(lint("app/tests/a.test.ts", `it.${"only"}("x", () => {});`)).toEqual(["no-focused-tests"]);
    expect(lint("app/e2e/a.spec.ts", 'test.skip(!repo, "needs a robot repo");')).toEqual([]);
    expect(lint("NOTES.md")).toEqual(["no-unsolicited-markdown"]);
    expect(lint("app/src/suite/PLAN.md")).toEqual(["no-unsolicited-markdown"]);
    expect(lint("docs/NEW_PAGE.md")).toEqual([]);
    expect(lint("lib-cpp/README.md")).toEqual([]);
  });
});
