// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactCondition, edgeLabels, elideMiddle } from "../src/suite/core/edgeLabels.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { exampleMachine, parseMachineManifest } from "../src/suite/core/machines.ts";
import { leavesState, parseProject, validateProject, type Condition, type Transition } from "../src/suite/core/model.ts";
import { transitionCause } from "../src/suite/core/inputCategories.ts";

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

describe('transitions from any state ("*")', () => {
  const machine = () => ({
    format: "mayhem-machine", version: 1, id: "Super", name: "Super", initial: "IDLE",
    states: ["IDLE", "SHOOT", "HOME"].map((id) => ({ id, name: id })),
    inputs: ["home", "shoot"].map((key) => ({ key, name: key, type: "boolean", initial: false })),
    transitions: [
      { id: "toHome", from: "*", to: "HOME", condition: sig("home") },
      { id: "toShoot", from: "*", to: "SHOOT", except: ["HOME"], condition: sig("shoot") },
    ] as any[],
  });
  it("leave every state but the target and except, and explain a state change", () => {
    const m = parseMachineManifest(machine());
    const [home, shoot] = m.transitions;
    expect(["IDLE", "SHOOT", "HOME"].filter((s) => leavesState(home, s))).toEqual(["IDLE", "SHOOT"]);
    expect(["IDLE", "SHOOT", "HOME"].filter((s) => leavesState(shoot, s))).toEqual(["IDLE"]);
    expect(leavesState({ id: "x", from: "IDLE", to: "SHOOT", condition: sig("shoot") }, "IDLE")).toBe(true);
    expect(transitionCause(m.transitions, "SHOOT", "HOME", { home: false }, { home: true })?.transition.id).toBe("toHome");
    expect(transitionCause(m.transitions, "HOME", "SHOOT", {}, {})).toBeUndefined();
  });
  it("reject except without \"*\" and unknown except states", () => {
    const plain = machine();
    plain.transitions[1] = { ...plain.transitions[1], from: "IDLE" };
    expect(() => parseMachineManifest(plain)).toThrow(/toShoot: except needs from "\*"/);
    const unknown = machine();
    unknown.transitions[1].except = ["NOPE"];
    expect(() => parseMachineManifest(unknown)).toThrow(/except/);
    const badFrom = machine();
    badFrom.transitions[0].from = "**";
    expect(() => parseMachineManifest(badFrom)).toThrow(/Invalid machine transition/);
  });
});

describe("state graph layout", () => {
  it("keeps label boxes clear of each other and of states, and draws back edges toward their target", async () => {
    const { layoutGraph } = await import("../src/suite/states/StateGraph.tsx");
    const nodes = ["OFF", "SPIN", "AIM", "FEED", "FAULT"];
    const wires = [
      ["a", "OFF", "SPIN"], ["b", "SPIN", "AIM"], ["c", "AIM", "FEED"], ["d", "FEED", "SPIN"],
      ["e", "AIM", "SPIN"], ["f", "SPIN", "FAULT"], ["g", "AIM", "FAULT"], ["h", "FAULT", "OFF"],
    ].map(([key, from, to]) => ({ key, from, to }));
    const labels = new Map(wires.map((w) => [w.key, { w: 150, h: 40 }]));
    const { positions, geometry } = layoutGraph(nodes, "OFF", wires, labels, () => 0);
    const boxes = [
      ...nodes.map((id) => ({ id, ...positions.get(id)!, w: 196, h: 78 })),
      ...wires.map((w) => {
        const g = geometry.get(w.key)!;
        return { id: w.key, x: g.lx - 75, y: g.ly - 20, w: 150, h: 40 };
      }),
    ];
    const hits = boxes.flatMap((a, i) =>
      boxes.slice(i + 1).filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).map((b) => `${a.id}/${b.id}`),
    );
    expect(hits).toEqual([]);
    // FAULT → OFF closes a cycle: laid out reversed, but its points still end at OFF.
    const back = geometry.get("h")!.points;
    const off = positions.get("OFF")!;
    const end = back[back.length - 1];
    expect(Math.abs(end.x - (off.x + 98))).toBeLessThan(98 + 1);
    expect(Math.abs(end.y - (off.y + 39))).toBeLessThan(39 + 1);
  });
});

describe('priority select ("selection": "priority")', () => {
  it("checks a \"*\" row in its own target too, validates the flag, and words conditions plainly", async () => {
    const { checkedIn } = await import("../src/suite/core/model.ts");
    const { plainText } = await import("../src/suite/states/PlainCondition.tsx");
    const row: Transition = { id: "home", from: "*", to: "HOME", condition: sig("home") };
    expect([checkedIn(row, "HOME", false), checkedIn(row, "HOME", true), checkedIn(row, "IDLE", false)]).toEqual([false, true, true]);
    expect(checkedIn({ ...row, except: ["HOME"] }, "HOME", true)).toBe(false);
    const machine = { ...exampleMachine, selection: "priority" };
    expect(parseMachineManifest(machine).selection).toBe("priority");
    expect(() => parseMachineManifest({ ...exampleMachine, selection: "first" })).toThrow(/selection/);
    const p = parseProject(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
    (p.extensions as any).machines = [machine];
    expect(exportCpp(p)).toMatch(/transitions\.size\(\),manifest,true\};/);
    const info = { name: (k: string) => ({ home: "Home requested (B)", enabled: "Robot enabled" })[k] ?? k, unit: (k: string) => (k === "stateTime" ? "s" : undefined), category: () => "operator" as const };
    expect(plainText(all(sig("enabled"), any(sig("home"), not(sig("cancel")))), info)).toBe("Robot enabled and (Home requested (B) or not cancel)");
    expect(plainText(sig("stateTime", 2.5, "gt"), info)).toBe("stateTime over 2.5 s");
    expect(plainText(not(all(sig("a"), sig("b"))), info)).toBe("not (a and b)");
  });
});

describe("autonomous path runs", () => {
  it("collapse pass-through poses into one view node and keep steps that do something", async () => {
    const { collapsePaths, chainOrder } = await import("../src/suite/states/autoPaths.ts");
    const pose = (id: string, goal: object = {}) => ({ id, name: id, kind: "pose" as const, timeout: 5, goal: { x: id.length, y: 0, heading: 0, translationTolerance: 0.05, rotationTolerance: 0.05, velocityTolerance: 0.1, settleTime: 0, handoffRadius: 0, headingMode: "fixed" as const, stop: false, ...goal } });
    const always = { kind: "always" as const };
    const nodes = [pose("a"), pose("bb"), pose("ccc"), pose("dddd", { markers: [{ kind: "event", key: "s.setState.INTAKE", t: 0.5 }] }), pose("e"), pose("ff"), pose("ggg", { stop: true }), { id: "done", name: "Done", kind: "finish" as const, timeout: 1 }];
    const ids = nodes.map((n) => n.id);
    const routine = { id: "r", name: "R", initial: "a", nodes, transitions: ids.slice(1).map((to, i) => ({ id: `t${i}`, from: ids[i], to, condition: always })) } as any;
    const view = collapsePaths(routine, new Set());
    expect(view.graph.nodes.map((n: any) => n.id)).toEqual(["@path:a", "dddd", "@path:e", "ggg", "done"]);
    expect(view.runs.get("@path:a")!.nodes.map((n: any) => n.id)).toEqual(["a", "bb", "ccc"]);
    expect(view.graph.initial).toBe("@path:a");
    expect(chainOrder(view.graph)).toEqual(["@path:a", "dddd", "@path:e", "ggg", "done"]);
    // Expanded runs and the project itself are unchanged.
    expect(collapsePaths(routine, new Set(["@path:a"])).graph.nodes.map((n: any) => n.id).slice(0, 3)).toEqual(["a", "bb", "ccc"]);
    expect(routine.nodes).toHaveLength(8);
    // A branch is not a chain.
    expect(chainOrder({ ...routine, transitions: [...routine.transitions, { id: "x", from: "a", to: "done", condition: always }] })).toBeUndefined();
  });
});
