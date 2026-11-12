// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL, type AutoNode, type AutoRoutine } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import { routineLegs } from "../src/suite/core/legs.ts";

const pose = (id: string, x: number, extra: Partial<AutoNode["goal"]> = {}): AutoNode => ({
  id,
  name: id.toUpperCase(),
  kind: "pose",
  timeout: 5,
  goal: { ...DEFAULT_GOAL, x, y: 2, heading: 0, ...extra },
});
const always = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  condition: { kind: "always" as const },
});

describe("routine legs", () => {
  it("splits at stops and keeps pass-through poses with their stop", () => {
    const routine: AutoRoutine = {
      id: "r",
      name: "r",
      initial: "a",
      nodes: [
        pose("a", 2),
        pose("b", 3, { stop: true }),
        { id: "act", name: "Intake", kind: "action", action: "intake", timeout: 1 },
        pose("c", 4),
        pose("d", 5),
        { id: "end", name: "Done", kind: "finish", timeout: 1 },
      ],
      transitions: [
        always("a", "b"),
        always("b", "act"),
        always("act", "c"),
        always("c", "d"),
        always("d", "end"),
      ],
    };
    const legs = routineLegs(sampleProject, routine);
    expect(legs.map((l) => l.nodeIds)).toEqual([["a", "b"], ["c", "d"]]);
    expect(legs.map((l) => l.id)).toEqual(["b", "d"]);
    expect(legs[1].name).toBe("D");
  });

  it("covers every pose step of the sample routine exactly once", () => {
    const routine = sampleProject.routines[0];
    const ids = routineLegs(sampleProject, routine).flatMap((l) => l.nodeIds);
    const poses = routine.nodes.filter((n) => n.kind === "pose").map((n) => n.id);
    expect([...ids].sort()).toEqual([...poses].sort());
  });
});
