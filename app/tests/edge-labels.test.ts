// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactCondition, edgeLabels, elideMiddle } from "../src/suite/core/edgeLabels.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { exampleMachine, parseMachineManifest } from "../src/suite/core/machines.ts";
import { parseProject, validateProject, type Condition, type Transition } from "../src/suite/core/model.ts";

const sig = (key: string, value: boolean | number | string = true, op: "eq" | "gt" | "lt" = "eq"): Condition => ({ kind: "signal", key, op, value });
const all = (...conditions: Condition[]): Condition => ({ kind: "all", conditions });
const any = (...conditions: Condition[]): Condition => ({ kind: "any", conditions });
const not = (condition: Condition): Condition => ({ kind: "not", condition });
const edge = (id: string, condition: Condition, extra: Partial<Transition> = {}): Transition => ({ id, from: "A", to: `to-${id}`, condition, ...extra });
const team = JSON.parse(readFileSync(new URL("../../examples/suite/team3256-offseason-2026.mayhem.json", import.meta.url), "utf8"));

describe("compact condition text", () => {
  it("uses symbols and drops = true", () => {
    expect(compactCondition(all(sig("deploy"), sig("hoodClear", false)))).toBe("deploy ∧ ¬hoodClear");
    expect(compactCondition(sig("stateTime", 2.5, "gt"))).toBe("stateTime > 2.5");
    expect(compactCondition(any(sig("shotDemand"), not(sig("enabled"))))).toBe("shotDemand ∨ ¬enabled");
    expect(compactCondition(not(sig("enabled", false)))).toBe("enabled");
    expect(compactCondition(sig("mode", "auto"))).toBe('mode = "auto"');
    expect(compactCondition(not(sig("speed", 3, "lt")))).toBe("¬(speed < 3)");
    expect(compactCondition({ kind: "always" })).toBe("Always");
  });
  it("flattens same-kind groups and parenthesizes mixed ones", () => {
    expect(compactCondition(all(all(sig("a"), sig("b")), sig("c")))).toBe("a ∧ b ∧ c");
    expect(compactCondition(all(sig("a"), any(sig("b"), sig("c"))))).toBe("a ∧ (b ∨ c)");
    expect(compactCondition(not(all(sig("a"), sig("b"))))).toBe("¬(a ∧ b)");
  });
  it("elides the middle so the last term survives", () => {
    const text = "enabled ∧ poseValid ∧ ¬cancel ∧ outtake";
    const short = elideMiddle(text, 24);
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short.endsWith("outtake")).toBe(true);
    expect(short).toContain("…");
    expect(elideMiddle("short", 24)).toBe("short");
    expect(elideMiddle("averyveryverylongsignalname", 10)).toBe("averyveryverylongsignalname");
  });
});

describe("edge labels", () => {
  it("keeps only the terms that tell sibling edges apart, from the specific end", () => {
    const guard = all(sig("enabled"), sig("poseValid"), sig("cancel", false));
    const labels = edgeLabels([
      edge("home", all(guard, sig("home"))),
      edge("out", all(guard, sig("outtake"))),
      edge("shoot", all(guard, sig("shoot"), sig("intake"))),
      edge("shootOnly", all(guard, sig("shoot"), sig("intake", false))),
    ], 21);
    expect(labels.get("home")!.label).toBe("… home");
    expect(labels.get("out")!.label).toBe("… outtake");
    expect(labels.get("shoot")!.label).toBe("… intake");
    expect(labels.get("shootOnly")!.label).toBe("… ¬intake");
    // Short conditions are shown whole.
    expect(edgeLabels([edge("x", all(sig("deploy"), sig("hoodClear", false)))]).get("x")!.label).toBe("deploy ∧ ¬hoodClear");
    expect(labels.get("home")!.condition).toBe("enabled ∧ poseValid ∧ ¬cancel ∧ home");
    expect([...labels.values()].map((l) => l.priority)).toEqual([1, 2, 3, 4]);
  });
  it("prefers names, and shows conditions when names collide", () => {
    const labels = edgeLabels([
      edge("a", all(sig("deploy"), sig("hoodClear")), { name: "Deploy", description: "Hood is clear" }),
      edge("b", all(sig("deploy"), sig("hoodClear", false)), { name: "Deploy" }),
      edge("c", sig("x"), { name: "Unique" }),
    ]);
    expect(labels.get("c")!.label).toBe("Unique");
    expect(labels.get("a")!.label).not.toBe(labels.get("b")!.label);
    expect(labels.get("a")!.label).toMatch(/^Deploy · .*hoodClear$/);
    expect(labels.get("b")!.label).toMatch(/¬hoodClear$/);
    expect(labels.get("a")!.title).toBe("Deploy\ndeploy ∧ hoodClear\nHood is clear");
  });
  it("names the target when name and condition are identical", () => {
    const same = sig("go");
    const labels = edgeLabels([edge("a", same), edge("b", same)], 21, (id) => id.toUpperCase());
    expect(labels.get("a")!.label).toBe("go → TO-A");
    expect(labels.get("b")!.label).toBe("go → TO-B");
  });
  it("gives every edge of the team 3256 machines a distinct, readable label", () => {
    const machines = team.extensions.machines.map(parseMachineManifest);
    expect(machines.length).toBeGreaterThan(0);
    for (const m of machines) {
      const labels = edgeLabels(m.transitions);
      for (const state of m.states) {
        for (const t of m.transitions.filter((x: Transition) => x.from === state.id)) expect(labels.get(t.id)!.label.length).toBeLessThanOrEqual(t.name ? 80 : 40);
        const texts = m.transitions.filter((t: Transition) => t.from === state.id).map((t: Transition) => labels.get(t.id)!.label);
        expect(new Set(texts).size, `${m.id}/${state.id}: ${texts.join(" | ")}`).toBe(texts.length);
        for (const text of texts) expect(text).not.toMatch(/= true/);
      }
    }
  });
});

describe("transition name and description fields", () => {
  it("validate, round-trip, and reach the exported manifest", () => {
    const project = parseProject(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
    project.routines[0].transitions[0].name = "Arrived";
    project.routines[0].transitions[0].description = "Pose reached";
    const machine = structuredClone(exampleMachine);
    machine.transitions[0].name = "Requested";
    machine.transitions[0].description = "Driver asked for intake";
    (project.extensions as any).machines = [machine];
    expect(validateProject(project)).toEqual([]);
    const again = parseProject(JSON.stringify(project));
    expect(again.routines[0].transitions[0]).toMatchObject({ name: "Arrived", description: "Pose reached" });
    const cpp = exportCpp(again);
    expect(cpp).toContain('\\"name\\":\\"Requested\\"');
    expect(cpp).toContain('\\"description\\":\\"Pose reached\\"');
    const bad = structuredClone(project);
    (bad.routines[0].transitions[0] as any).name = 4;
    expect(validateProject(bad).map((i) => i.path)).toContain("routines.0.transitions.0.name");
    expect(() => parseMachineManifest({ ...machine, transitions: [{ ...machine.transitions[0], name: "" }] })).toThrow(/name/);
  });
});

it("uses signal display labels for positive and negative booleans", () => {
  const label = (key: string) => key === "pieceDetected" ? "Piece detected" : key;
  expect(compactCondition(sig("pieceDetected"), label)).toBe("Piece detected");
  expect(compactCondition(sig("pieceDetected", false), label)).toBe("¬(Piece detected)");
});
