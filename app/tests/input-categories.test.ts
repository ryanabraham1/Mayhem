// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { categoryLookup, categoryOf, conditionKeys, transitionCause } from "../src/suite/core/inputCategories.ts";
import { exampleMachine, parseMachineManifest } from "../src/suite/core/machines.ts";
import { parseProject, validateProject, type Condition, type Transition } from "../src/suite/core/model.ts";
import { glyphText } from "../src/suite/states/ConditionText.tsx";

const sig = (key: string, value: boolean | number = true, op: "eq" | "gt" | "lt" = "eq"): Condition => ({ kind: "signal", key, op, value });
const all = (...conditions: Condition[]): Condition => ({ kind: "all", conditions });

describe("input categories", () => {
  it("default to internal, and the built-in stateTime to timer", () => {
    expect(categoryOf({ key: "deploy" })).toBe("internal");
    expect(categoryOf({ key: "deploy", category: "operator" })).toBe("operator");
    expect(categoryOf(undefined, "stateTime")).toBe("timer");
    const lookup = categoryLookup([{ key: "a", category: "sensor" }, { key: "b" }]);
    expect([lookup("a"), lookup("b"), lookup("stateTime"), lookup("unknown")]).toEqual(["sensor", "internal", "timer", "internal"]);
  });

  it("validate, round-trip, and reach the exported manifests", () => {
    const project = parseProject(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
    project.signals[0].category = "sensor";
    project.signals[1].category = "internal";
    project.signals[1].derivedFrom = [project.signals[0].key];
    const machine = structuredClone(exampleMachine);
    machine.inputs[0].category = "operator";
    machine.inputs[1] = { ...machine.inputs[1], category: "internal", derivedFrom: ["intake.requested"] };
    (project.extensions as any).machines = [machine];
    expect(validateProject(project)).toEqual([]);
    const again = parseProject(JSON.stringify(project));
    expect(again.signals[1]).toMatchObject({ category: "internal", derivedFrom: [project.signals[0].key] });
    const cpp = exportCpp(again);
    expect(cpp).toContain('\\"category\\":\\"operator\\"');
    expect(cpp).toContain('\\"derivedFrom\\":[\\"intake.requested\\"]');
    expect(cpp).toContain('\\"category\\":\\"sensor\\"'); // Autonomous manifest inputs

    const bad = structuredClone(project);
    (bad.signals[0] as any).category = "driver";
    bad.signals[1].derivedFrom = ["nope"];
    const problems = validateProject(bad).map((i) => `${i.path}: ${i.message}`);
    expect(problems).toContain("signals.0: category must be one of operator, sensor, internal, timer, auto.");
    expect(problems).toContain("signals.1: derivedFrom names unknown inputs: nope.");
    expect(() => parseMachineManifest({ ...machine, inputs: [{ ...machine.inputs[0], category: "pilot" }, ...machine.inputs.slice(1)] }))
      .toThrow(/Input intake.requested: category/);
  });
});

describe("transition causes", () => {
  const edges: Transition[] = [
    { id: "cancel", from: "READY", to: "PARKED", condition: sig("enabled", false) },
    { id: "jitter", from: "READY", to: "JITTERING", condition: all(sig("enabled"), sig("jitterDemand")) },
    { id: "stuck", from: "JITTERING", to: "FAULT", condition: sig("stateTime", 2.5, "gt") },
  ];
  it("names the inputs that changed for the edge taken", () => {
    const cause = transitionCause(edges, "READY", "JITTERING", { enabled: true, jitterDemand: false }, { enabled: true, jitterDemand: true });
    expect(cause?.transition.id).toBe("jitter");
    expect(cause?.keys).toEqual(["jitterDemand"]);
  });
  it("blames the timer for a deadline, and falls back to every input read", () => {
    expect(transitionCause(edges, "JITTERING", "FAULT", { stateTime: 1 }, { stateTime: 2.6 })?.keys).toEqual(["stateTime"]);
    // Live data that was not observed changing still explains the edge.
    expect(transitionCause(edges, "READY", "JITTERING", {}, {})?.keys).toEqual(["enabled", "jitterDemand"]);
    expect(transitionCause(edges, "READY", "NOWHERE", {}, {})).toBeUndefined();
    expect(conditionKeys(all(sig("a"), sig("b"), sig("a", false)))).toEqual(["a", "b"]);
  });
  it("renders glyphs for plain-text titles", () => {
    const cat = categoryLookup([{ key: "jitterDemand", category: "operator" }, { key: "enabled", category: "sensor" }]);
    const isKey = (k: string) => ["jitterDemand", "enabled", "stateTime"].includes(k);
    expect(glyphText("enabled ∧ jitterDemand", isKey, cat)).toBe("📡 enabled ∧ 🎮 jitterDemand");
    expect(glyphText("stateTime > 2.5", isKey, cat)).toBe("⏱\uFE0F stateTime > 2.5");
    expect(glyphText('mode = "enabled"', isKey, cat)).toBe('mode = "enabled"');
  });
});
