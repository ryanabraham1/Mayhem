// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_GOAL,
  parseProject,
  resolveNodeConstraints,
  validateProject,
  type AutoNode,
  type AutoRoutine,
} from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import {
  constraintSignature,
  generateConstraints,
} from "../src/suite/core/constraintGeneration.ts";
import { simulate } from "../src/suite/core/runtime.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";

import reference from "./fixtures/bline-constraints.json";

function fixture() {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 1, y: 1, heading: 0 };
  p.robot.constraints = { ...DEFAULT_CONSTRAINTS };
  const nodes: AutoNode[] = [
    [4, 1],
    [4, 4],
    [7, 4],
  ].map(([x, y], i) => ({
    id: `p${i}`,
    name: `Pose ${i + 1}`,
    kind: "pose",
    timeout: 30,
    goal: { ...DEFAULT_GOAL, x, y },
  }));
  nodes.push({ id: "f", name: "Finish", kind: "finish", timeout: 1 });
  const r: AutoRoutine = {
    id: "constraints",
    name: "Constraints",
    initial: "p0",
    nodes,
    transitions: nodes.slice(0, -1).map((n, i) => ({
      id: `t${i}`,
      from: n.id,
      to: nodes[i + 1].id,
      condition: { kind: "always" },
    })),
  };
  p.routines = [r];
  return { p, r };
}
describe("path constraints", () => {
  it("inherits path limits, prioritizes segment overrides, and exports the same values", () => {
    const { p, r } = fixture();
    r.constraints = {
      maxVelocity: 1,
      maxAcceleration: 2,
      maxAngularVelocity: 1.5,
    };
    r.nodes[0].generatedConstraints = { maxVelocity: 0.8, handoffRadius: 0.2 };
    r.nodes[0].constraints = { maxVelocity: 0.6 };
    const sim = simulate(p, r, {}, { mode: "path" });
    expect(sim.status).toBe("completed");
    expect(
      Math.max(
        ...sim.frames
          .filter((f) => f.node === "p0")
          .map((f) => Math.hypot(f.velocity.vx, f.velocity.vy)),
      ),
    ).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(
      Math.max(
        ...sim.frames.map((f) => Math.hypot(f.velocity.vx, f.velocity.vy)),
      ),
    ).toBeLessThanOrEqual(1 + 1e-9);
    expect(exportCpp(p)).toContain("{0.6,2,1.5,");
    expect(parseProject(JSON.stringify(p))).toEqual(p);
    r.constraints.maxAcceleration = -1;
    expect(
      validateProject(p).some(
        (i) => i.path === "routines.0.constraints.maxAcceleration",
      ),
    ).toBe(true);
  });
  it("runs BLine generation, preserves manual ownership and leaves the endpoint radius inert", () => {
    const { p, r } = fixture();
    r.nodes[0].constraints = { maxVelocity: 1.2 };
    r.nodes[0].goal!.handoffRadius = 0.25;
    const before = structuredClone(p);
    const result = generateConstraints(p, r);
    expect(p).toEqual(before);
    expect(result.status).not.toBe("unsolvable");
    expect(result.limits).toHaveLength(3);
    expect(result.limits[0].maxVelocity).toBeUndefined();
    expect(result.limits[0].handoffRadius).toBeUndefined();
    expect(result.limits[1].maxVelocity).toBeGreaterThan(0);
    expect(result.limits[1].handoffRadius).toBeGreaterThan(0);
    expect(result.limits[2].handoffRadius).toBeUndefined();
    for (const resultNode of result.limits) {
      const { id, ...values } = resultNode;
      r.nodes.find((n) => n.id === id)!.generatedConstraints = values;
    }
    r.constraintGeneration = {
      signature: result.signature,
      status: result.status,
    };
    expect(constraintSignature(p, r)).toBe(result.signature);
    expect(simulate(p, r, {}, { mode: "path" }).status).toBe("completed");
    r.nodes[1].goal!.x += 0.2;
    expect(constraintSignature(p, r)).not.toBe(result.signature);
  });
});

for (const testCase of reference.cases)
  it(`matches untouched upstream constraint generation (${testCase.pinned ? "manual pins" : "automatic"})`, () => {
    const { p, r } = fixture();
    if (testCase.pinned) {
      r.nodes[0].constraints = { maxVelocity: 1.2 };
      r.nodes[0].goal!.handoffRadius = 0.25;
    }
    const generated = generateConstraints(p, r);
    expect(generated.status).toBe(testCase.status);
    expect(generated.limits).toEqual(testCase.limits);
  });

it("keeps generated speed caps below newly lowered path limits", () => {
  const { p, r } = fixture();
  r.nodes[0].generatedConstraints = { maxVelocity: 4 };
  r.constraints = { maxVelocity: 1 };
  expect(resolveNodeConstraints(p, r, r.nodes[0]).maxVelocity).toBe(1);
  r.nodes[0].constraints = { maxVelocity: 0.5 };
  expect(resolveNodeConstraints(p, r, r.nodes[0]).maxVelocity).toBe(0.5);
});
