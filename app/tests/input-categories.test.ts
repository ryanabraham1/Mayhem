// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { categoryLookup, categoryOf, conditionKeys, resolveInputRef, rootCategories, transitionCause, type InputScope } from "../src/suite/core/inputCategories.ts";
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

describe("derivedFrom across machines", () => {
  const input = (key: string, extra: object = {}) => ({ key, name: key, type: "boolean", initial: false, ...extra });
  const machine = (id: string, inputs: object[]) => ({
    format: "mayhem-machine", version: 1, id, name: id, initial: "A", states: [{ id: "A", name: "A" }], transitions: [], inputs,
  });
  const superstructure = machine("Superstructure", [input("jitter", { category: "operator", name: "Jitter requested (Y)" }), input("intake.requested", { category: "operator" })]);
  const intake = machine("IntakeSequence", [
    input("jitterDemand", { category: "internal", derivedFrom: [{ machine: "Superstructure", key: "jitter" }] }),
    input("deploy", { derivedFrom: ["jitterDemand", { machine: "Superstructure", key: "intake.requested" }] }),
  ]);
  const project = () => {
    const p = parseProject(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
    (p.extensions as any).machines = structuredClone([superstructure, intake]);
    return p;
  };

  it("validate against the project's machines and reach the C++ manifests", () => {
    expect(validateProject(project())).toEqual([]);
    // A single manifest (import, live schema) cannot see other machines: only the shape is checked.
    expect(parseMachineManifest(intake).inputs[0].derivedFrom).toEqual([{ machine: "Superstructure", key: "jitter" }]);
    expect(exportCpp(project())).toContain('\\"derivedFrom\\":[{\\"key\\":\\"jitter\\",\\"machine\\":\\"Superstructure\\"}]');
    const signals = project();
    signals.signals[0].derivedFrom = [{ machine: "IntakeSequence", key: "deploy" }];
    expect(validateProject(signals)).toEqual([]);
  });

  it("reject unknown machines, unknown keys and malformed refs", () => {
    const problems = (edit: (inputs: any[]) => void) => {
      const p = project();
      edit((p.extensions as any).machines[1].inputs);
      return validateProject(p).map((i) => `${i.path}: ${i.message}`);
    };
    expect(problems((i) => (i[0].derivedFrom = [{ machine: "Nope", key: "jitter" }])))
      .toEqual(["extensions.machines.1.inputs.0: derivedFrom names unknown machines: Nope."]);
    expect(problems((i) => (i[0].derivedFrom = [{ machine: "Superstructure", key: "nope" }, "missing"])))
      .toEqual(["extensions.machines.1.inputs.0: derivedFrom names unknown inputs: Superstructure.nope, missing."]);
    // The dotted string is a same-machine key (keys may contain dots), not a cross-machine ref.
    expect(problems((i) => (i[0].derivedFrom = ["Superstructure.jitter"])))
      .toEqual(["extensions.machines.1.inputs.0: derivedFrom names unknown inputs: Superstructure.jitter."]);
    for (const bad of [{ machine: "Superstructure" }, { machine: "Superstructure", key: "jitter", extra: 1 }, { machine: "", key: "jitter" }, 3])
      expect(problems((i) => (i[0].derivedFrom = [bad]))).toEqual([
        'extensions.machines.1.inputs.0: derivedFrom must be a list of input keys or { "machine", "key" } references.',
      ]);
    expect(() => parseMachineManifest({ ...intake, inputs: [input("x", { derivedFrom: [{ machine: "S" }] })] })).toThrow(/Input x: derivedFrom/);
  });

  it("resolve sources and root categories through other machines", () => {
    const scope: InputScope = new Map([
      ["Superstructure", superstructure.inputs as any],
      ["IntakeSequence", intake.inputs as any],
    ]);
    expect(resolveInputRef({ machine: "Superstructure", key: "jitter" }, "IntakeSequence", scope).input?.name).toBe("Jitter requested (Y)");
    expect(resolveInputRef("jitterDemand", "IntakeSequence", scope).machine).toBe("IntakeSequence");
    expect(rootCategories("IntakeSequence", "jitterDemand", scope)).toEqual(["operator"]);
    expect(rootCategories("IntakeSequence", "deploy", scope)).toEqual(["operator"]);
    expect(rootCategories("Superstructure", "jitter", scope)).toEqual(["operator"]);
    // Cycles and unknown sources add nothing.
    const loop: InputScope = new Map([["M", [{ key: "a", derivedFrom: ["b"] }, { key: "b", derivedFrom: ["a", { machine: "X", key: "y" }] }]]]);
    expect(rootCategories("M", "a", loop)).toEqual([]);
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
  it("names categories in plain-text titles", () => {
    const cat = categoryLookup([{ key: "jitterDemand", category: "operator" }, { key: "enabled", category: "sensor" }]);
    const isKey = (k: string) => ["jitterDemand", "enabled", "stateTime"].includes(k);
    expect(glyphText("enabled ∧ jitterDemand", isKey, cat)).toBe("enabled (sensor) ∧ jitterDemand (operator)");
    expect(glyphText("stateTime > 2.5", isKey, cat)).toBe("stateTime (timer) > 2.5");
    expect(glyphText('mode = "enabled"', isKey, cat)).toBe('mode = "enabled"');
  });
});
