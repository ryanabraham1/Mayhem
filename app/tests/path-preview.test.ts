// @vitest-environment node
import { describe, expect, it } from "vitest";
import corpus from "./fixtures/path-preview.json";
import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_GOAL,
  type AutoNode,
  type AutoRoutine,
} from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import { initialFrame, simulate, step } from "../src/suite/core/runtime.ts";
import { interpolatePreviewFrame } from "../src/suite/core/playback.ts";

describe("upstream reference parity", () => {
  for (const fixture of corpus.cases)
    it(fixture.name, () => {
      const p = structuredClone(sampleProject);
      p.robot.start = fixture.start;
      p.robot.constraints = { ...DEFAULT_CONSTRAINTS };
      const nodes: AutoNode[] = fixture.goals.map((g, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        kind: "pose",
        timeout: 30,
        goal: { ...DEFAULT_GOAL, ...g } as typeof DEFAULT_GOAL,
      }));
      nodes.push({ id: "finish", name: "Finish", kind: "finish", timeout: 1 });
      const routine: AutoRoutine = {
        id: "parity",
        name: "Parity",
        initial: "p0",
        nodes,
        transitions: nodes.slice(0, -1).map((n, i) => ({
          id: `t${i}`,
          from: n.id,
          to: nodes[i + 1].id,
          condition: { kind: "always" },
        })),
      };
      const result = simulate(p, routine, {}, { mode: "path", maxSeconds: 60 });
      expect(result.status).toBe("completed");
      expect(result.frames.length).toBe(fixture.samples.length);
      fixture.samples.forEach(([x, y, heading, segment], i) => {
        expect(result.frames[i].pose.x, `x at tick ${i}`).toBeCloseTo(x, 12);
        expect(result.frames[i].pose.y, `y at tick ${i}`).toBeCloseTo(y, 12);
        expect(
          result.frames[i].pose.heading,
          `heading at tick ${i}`,
        ).toBeCloseTo(heading, 12);
        if (i > 0 && i < fixture.samples.length - 1)
          expect(result.frames[i].node).toBe(`p${segment}`);
      });
      // Upstream labels its first integrated tick t=0. Mayhem records the start
      // at t=0 and the first tick at dt, so duration differs by exactly one tick.
      expect(result.frame.time).toBeCloseTo(fixture.total_time_s + 0.02, 10);
      if (fixture.name.includes("event markers"))
        expect(
          result.frame.events
            .filter((e) => e.kind === "event")
            .map((e) => e.message),
        ).toEqual(["Event trigger intake"]);
    });
});

it("interpolates sub-tick motion and takes the short turn across pi", () => {
  const p = structuredClone(sampleProject),
    a = initialFrame(p, p.routines[0]);
  a.pose = { x: 1, y: 2, heading: 3.1 };
  const b = { ...a, time: 0.02, pose: { x: 1.2, y: 2.4, heading: -3.1 } };
  const displayed = interpolatePreviewFrame(a, b, 0.01);
  expect(displayed.time).toBe(0.01);
  expect(displayed.pose.x).toBeCloseTo(1.1);
  expect(displayed.pose.y).toBeCloseTo(2.2);
  expect(Math.abs(displayed.pose.heading)).toBeCloseTo(Math.PI);
  expect(a.pose).toEqual({ x: 1, y: 2, heading: 3.1 });
  expect(interpolatePreviewFrame(a, undefined, 0.1)).toBe(a);
});

it("completes a rolling endpoint and ignores final-anchor handoff radius", () => {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 1, y: 1, heading: 0 };
  p.robot.constraints = { ...DEFAULT_CONSTRAINTS, minVelocity: 0.5 };
  const routine: AutoRoutine = {
    id: "rolling",
    name: "Rolling",
    initial: "p",
    nodes: [
      {
        id: "p",
        name: "Pose",
        kind: "pose",
        timeout: 10,
        goal: { ...DEFAULT_GOAL, x: 4, y: 1, handoffRadius: 0.45 },
      },
      { id: "f", name: "Finish", kind: "finish", timeout: 1 },
    ],
    transitions: [
      { id: "t", from: "p", to: "f", condition: { kind: "always" } },
    ],
  };
  const result = simulate(p, routine, {}, { mode: "path" });
  expect(result.status).toBe("completed");
  expect(result.frame.pose.x).toBe(4);
});

it("starts concurrent callbacks fresh when a segment hands off", () => {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 1, y: 1, heading: 0 };
  const nodes: AutoNode[] = [2, 5].map((x, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    kind: "pose",
    timeout: 10,
    during: ["shared.action"],
    goal: { ...DEFAULT_GOAL, x, y: 1 },
  }));
  nodes.push({ id: "f", name: "Finish", kind: "finish", timeout: 1 });
  const routine: AutoRoutine = {
    id: "callbacks",
    name: "Callbacks",
    initial: "p0",
    nodes,
    transitions: nodes.slice(0, -1).map((n, i) => ({
      id: `t${i}`,
      from: n.id,
      to: nodes[i + 1].id,
      condition: { kind: "always" },
    })),
  };
  let frame = initialFrame(p, routine);
  for (let i = 0; i < 200 && frame.node === "p0"; i++) {
    const status = i === 0 ? "succeeded" : "running";
    frame = step(p, routine, frame, {}, 0.02, false, {
      mode: "routine",
      actions: { "shared.action": status },
    });
  }
  expect(frame.node).toBe("p1");
  expect(frame.actions["shared.action"]).toBe("running");
});
