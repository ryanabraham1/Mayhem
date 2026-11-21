// @vitest-environment node
// Reusable step groups: a template with parameters, used several times by a routine.
import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL, parseProject, validateProject, type AutoRoutine, type SuiteProject } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import { addGroupUse, createGroup, detachGroupUse, reconcileGroups, removeGroupUse, syncGroups } from "../src/suite/core/groups.ts";
import { simulate } from "../src/suite/core/runtime.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";

const always = { kind: "always" as const };
const goal = (x: number, y: number) => ({ ...DEFAULT_GOAL, x, y });

/** Three scoring cycles (drive to the pickup, arm, drive in and score) as written by hand: no produced steps. */
function source() {
  const p = structuredClone(sampleProject) as SuiteProject;
  p.robot.start = { x: 1, y: 1, heading: 0 };
  p.signals = [];
  p.groups = [
    {
      id: "cycle",
      name: "Cycle",
      params: [{ name: "pickup" }, { name: "score" }, { name: "level", default: "arm.L3" }, { name: "next" }],
      nodes: [
        { id: "pickup", name: "Pickup", kind: "pose", timeout: 15, goal: "$pickup" } as any,
        { id: "arm", name: "Arm", kind: "action", timeout: 3, action: "$level" },
        { id: "score", name: "Score", kind: "pose", timeout: 15, goal: "$score", during: ["$level"] } as any,
      ],
      transitions: [
        { id: "got", from: "pickup", to: "arm", condition: always },
        { id: "up", from: "arm", to: "score", condition: always },
        { id: "scored", from: "score", to: "$next", condition: always },
      ],
    },
  ];
  p.routines = [
    {
      id: "three", name: "Three", initial: "c1.pickup",
      nodes: [{ id: "done", name: "Done", kind: "finish", timeout: 1 }],
      transitions: [],
      uses: [
        { id: "c1", group: "cycle", name: "Cycle 1", args: { pickup: goal(3, 1), score: goal(3, 3), next: "c2.pickup" } },
        { id: "c2", group: "cycle", name: "Cycle 2", args: { pickup: goal(5, 1), score: goal(5, 3), next: "c3.pickup" } },
        { id: "c3", group: "cycle", name: "Cycle 3", args: { pickup: goal(7, 1), score: goal(7, 3), level: "arm.L4", next: "done" } },
      ],
    } as AutoRoutine,
  ];
  return p;
}
const ids = (r: AutoRoutine) => r.nodes.map((n) => n.id);

describe("step groups", () => {
  it("produces each use's steps and exits when a project is loaded", () => {
    const p = parseProject(JSON.stringify(source()));
    const r = p.routines[0];
    expect(ids(r)).toEqual(["done", "c1.pickup", "c1.arm", "c1.score", "c2.pickup", "c2.arm", "c2.score", "c3.pickup", "c3.arm", "c3.score"]);
    const node = (id: string) => r.nodes.find((n) => n.id === id)!;
    expect(node("c2.pickup")).toMatchObject({ name: "Pickup (Cycle 2)", goal: { x: 5, y: 1 }, fromGroup: { use: "c2", node: "pickup" } });
    expect(node("c1.arm").action).toBe("arm.L3"); // the parameter's default
    expect(node("c3.arm").action).toBe("arm.L4");
    expect(node("c3.score").during).toEqual(["arm.L4"]);
    // An exit to a step of the group is this use's step; "$next" is whatever the use says.
    expect(r.transitions.map((t) => [t.id, t.from, t.to])).toEqual([
      ["c1.got", "c1.pickup", "c1.arm"], ["c1.up", "c1.arm", "c1.score"], ["c1.scored", "c1.score", "c2.pickup"],
      ["c2.got", "c2.pickup", "c2.arm"], ["c2.up", "c2.arm", "c2.score"], ["c2.scored", "c2.score", "c3.pickup"],
      ["c3.got", "c3.pickup", "c3.arm"], ["c3.up", "c3.arm", "c3.score"], ["c3.scored", "c3.score", "done"],
    ]);
    // Everything downstream sees ordinary steps.
    const run = simulate(p, r, {}, { mode: "path" });
    expect(run.status).toBe("completed");
    expect(Math.hypot(run.frame.pose.x - 7, run.frame.pose.y - 3)).toBeLessThanOrEqual(0.03);
    const header = exportCpp(p);
    expect(header).toContain('{"c2.pickup",mayhem::NodeKind::Pose');
    expect(header).toContain('{"c3.arm",mayhem::NodeKind::Action,{},3,"arm.L4"');
  });
  it("round-trips: the saved file keeps the groups, the uses and the produced steps", () => {
    const once = parseProject(JSON.stringify(source()));
    const twice = parseProject(JSON.stringify(once));
    expect(twice).toEqual(once);
    expect(twice.groups![0].nodes[0].goal).toBe("$pickup");
    expect(validateProject(once)).toEqual([]);
    // A file whose produced steps are stale loads from the template, with a warning.
    const stale = structuredClone(once);
    stale.routines[0].nodes.find((n) => n.id === "c1.arm")!.timeout = 99;
    expect(validateProject(stale).map((i) => [i.severity, i.path])).toEqual([["warning", "groups"]]);
    expect(parseProject(JSON.stringify(stale)).routines[0].nodes.find((n) => n.id === "c1.arm")!.timeout).toBe(3);
  });
  it("reports unknown groups, wrong arguments and broken templates", () => {
    const paths = (edit: (p: SuiteProject) => void) => {
      const p = source();
      edit(p);
      return validateProject(p).filter((i) => i.severity === "error").map((i) => i.path);
    };
    expect(paths((p) => (p.routines[0].uses![0].group = "nope"))).toContain("routines.0.uses.0.group");
    expect(paths((p) => delete p.routines[0].uses![1].args.next)).toContain("routines.0.uses.1.args");
    expect(paths((p) => (p.routines[0].uses![1].args.extra = 1))).toContain("routines.0.uses.1.args.extra");
    expect(paths((p) => (p.routines[0].uses![1].id = "c1"))).toContain("routines.0.uses.1");
    expect(paths((p) => (p.groups![0].transitions[0].from = "elsewhere"))).toContain("groups.0.transitions.0.from");
    expect(paths((p) => p.groups![0].params.push({ name: "pickup" }))).toContain("groups.0.params.4");
    // A wrong argument value is reported on the step it produces.
    expect(paths((p) => (p.routines[0].uses![2].args.pickup = { x: "far" }))).toContain("routines.0.nodes.7.goal.x");
  });
  it("writes an edit of a produced step back to the use's argument or to the template", () => {
    const p = parseProject(JSON.stringify(source()));
    const r = p.routines[0];
    const node = (id: string) => r.nodes.find((n) => n.id === id)!;
    // The goal is a parameter: dragging cycle 2's pickup changes only cycle 2.
    node("c2.pickup").goal!.x = 5.5;
    // The timeout is in the template: changing it on one step changes every use.
    node("c2.arm").timeout = 4;
    node("c2.arm").name = "Raise arm (Cycle 2)";
    // Retargeting the "$next" exit changes this use's argument.
    r.transitions.find((t) => t.id === "c1.scored")!.to = "c3.pickup";
    reconcileGroups(p);
    expect(r.uses![1].args.pickup).toMatchObject({ x: 5.5, y: 1 });
    expect([node("c1.pickup").goal!.x, node("c2.pickup").goal!.x, node("c3.pickup").goal!.x]).toEqual([3, 5.5, 7]);
    expect(p.groups![0].nodes[0].goal).toBe("$pickup");
    expect(["c1.arm", "c2.arm", "c3.arm"].map((id) => [node(id).timeout, node(id).name])).toEqual([
      [4, "Raise arm (Cycle 1)"], [4, "Raise arm (Cycle 2)"], [4, "Raise arm (Cycle 3)"],
    ]);
    expect(r.uses![0].args.next).toBe("c3.pickup");
    expect(p.groups![0].transitions[2].to).toBe("$next");
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    // Constraint-generator output stays on its own step.
    node("c1.pickup").generatedConstraints = { maxVelocity: 2 };
    reconcileGroups(p);
    expect(node("c1.pickup").generatedConstraints).toEqual({ maxVelocity: 2 });
    expect(node("c2.pickup").generatedConstraints).toBeUndefined();
    expect((p.groups![0].nodes[0] as any).generatedConstraints).toBeUndefined();
  });
  it("adds, removes and detaches uses", () => {
    const p = parseProject(JSON.stringify(source()));
    const r = p.routines[0];
    const use = addGroupUse(p, r, "cycle", r.uses![2]);
    expect(use).toMatchObject({ id: "cycle4", name: "Cycle 4", args: { level: "arm.L4", next: "done" } });
    expect(ids(r).slice(-3)).toEqual(["cycle4.pickup", "cycle4.arm", "cycle4.score"]);
    removeGroupUse(p, r, "c2");
    expect(ids(r).some((id) => id.startsWith("c2."))).toBe(false);
    expect(r.transitions.some((t) => t.to.startsWith("c2.") || t.from.startsWith("c2."))).toBe(false);
    // Cycle 1 led to cycle 2: it now carries on to where cycle 2 led.
    expect(r.transitions.find((t) => t.id === "c1.scored")!.to).toBe("c3.pickup");
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    detachGroupUse(p, r, "c3");
    const detached = r.nodes.find((n) => n.id === "c3.arm")!;
    expect(detached.fromGroup).toBeUndefined();
    detached.timeout = 9; // now an ordinary step
    syncGroups(p);
    expect(r.nodes.find((n) => n.id === "c3.arm")!.timeout).toBe(9);
    expect(r.nodes.find((n) => n.id === "c1.arm")!.timeout).toBe(3);
  });
  it("makes a group out of existing steps, which become its first use", () => {
    const p = parseProject(JSON.stringify(source()));
    const flat = p.routines[0];
    for (const u of [...flat.uses!]) detachGroupUse(p, flat, u.id);
    delete p.groups;
    // Plain steps a, b, c and their exits; the rest of the routine follows c.
    const rename = new Map([["c1.pickup", "a"], ["c1.arm", "b"], ["c1.score", "c"]]);
    for (const n of flat.nodes) n.id = rename.get(n.id) ?? n.id;
    for (const t of flat.transitions) (t.from = rename.get(t.from) ?? t.from), (t.to = rename.get(t.to) ?? t.to);
    flat.initial = "a";
    const before = simulate(p, flat, {}, { mode: "path" }).frame.pose;
    const group = createGroup(p, flat, {
      id: "lap", name: "Lap", steps: ["a", "b", "c"],
      params: { pickup: "a.goal", score: "c.goal", next: "exit:c1.scored.to" },
    });
    expect(group.params.map((x) => x.name)).toEqual(["pickup", "score", "next"]);
    expect(group.nodes[0].goal).toBe("$pickup");
    expect(flat.initial).toBe("lap1.a");
    expect(flat.uses).toEqual([{ id: "lap1", group: "lap", name: "Lap 1", args: { pickup: goal(3, 1), score: goal(3, 3), next: "c2.pickup" } }]);
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    // Same routine as before, now with a reusable lap.
    const after = simulate(p, flat, {}, { mode: "path" });
    expect(after.status).toBe("completed");
    expect(after.frame.pose).toEqual(before);
    expect(() => createGroup(p, flat, { id: "lap", steps: ["done"] })).toThrow("already exists");
    expect(() => createGroup(p, flat, { id: "end", steps: ["done"] })).toThrow("finish step");
  });
  it("leaves a project without groups alone", () => {
    const p = structuredClone(sampleProject);
    expect(parseProject(JSON.stringify(p))).toEqual(p);
    expect(syncGroups(structuredClone(p))).toEqual(p);
  });
});
