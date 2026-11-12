// @vitest-environment node
import { describe, expect, it } from "vitest";
import { rdp, simplifyStroke, sketchGoals, type Point } from "../src/suite/core/sketch.ts";

/** Densely sampled stroke through `corners`, like a pointer drag. */
const drawn = (...corners: Point[]): Point[] =>
  corners.slice(1).flatMap((b, i) => {
    const a = corners[i],
      n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.035));
    return Array.from({ length: n + (i === corners.length - 2 ? 1 : 0) }, (_, k) => ({
      x: a.x + ((b.x - a.x) * k) / n,
      y: a.y + ((b.y - a.y) * k) / n,
    }));
  });

describe("stroke simplification", () => {
  it("keeps only the corners of a polyline", () => {
    const points = simplifyStroke(drawn({ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }));
    expect(points).toEqual([{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }]);
  });

  it("ignores wobble under the tolerance", () => {
    const wobbly = drawn({ x: 1, y: 2 }, { x: 6, y: 2 }).map((p, i) => ({ ...p, y: p.y + 0.05 * Math.sin(i) }));
    expect(simplifyStroke(wobbly)).toHaveLength(2);
  });

  it("caps a long squiggle at 18 points", () => {
    const squiggle = Array.from({ length: 2000 }, (_, i) => ({ x: i * 0.008, y: 4 + 1.5 * Math.sin(i / 12) }));
    const points = simplifyStroke(squiggle);
    expect(points.length).toBeLessThanOrEqual(18);
    expect(points[0]).toEqual(squiggle[0]);
    expect(points.at(-1)).toEqual(squiggle.at(-1));
  });

  it("RDP keeps the farthest point beyond tolerance", () => {
    expect(rdp([{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 0 }], 0.2)).toHaveLength(3);
    expect(rdp([{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 0 }], 0.2)).toHaveLength(2);
  });
});

describe("sketch goals", () => {
  const stroke = drawn({ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 });

  it("adds pass-throughs and ends facing the drawn direction", () => {
    const goals = sketchGoals(stroke, 0, { previous: { x: 2, y: 2 } });
    expect(goals.map((g) => [g.x, g.y, g.pass])).toEqual([
      [5, 2, true],
      [5, 5, false],
    ]);
    expect(goals[0].heading).toBeCloseTo(Math.PI / 4);
    expect(goals[1].heading).toBeCloseTo(Math.PI / 2);
  });

  it("keeps the previous heading with keepHeading", () => {
    const goals = sketchGoals(stroke, 1.2, { previous: { x: 2, y: 2 }, keepHeading: true });
    expect(goals.at(-1)!.heading).toBe(1.2);
  });

  it("keeps a stroke start away from the previous goal", () => {
    const goals = sketchGoals(stroke, 0, { previous: { x: 0, y: 0 } });
    expect(goals).toHaveLength(3);
    expect(goals[0]).toMatchObject({ x: 2, y: 2, pass: true });
  });

  it("joins the next goal instead of stopping beside it", () => {
    const goals = sketchGoals(stroke, 0, { previous: { x: 2, y: 2 }, next: { x: 5.1, y: 5 } });
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ x: 5, y: 2, pass: true });
  });
});
