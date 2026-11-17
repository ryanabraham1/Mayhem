import { expect, it } from "vitest";
import { replayValueAt } from "../src/suite/core/replay";
import type { Channel } from "../src/suite/core/analysis";
const channel = (values: [number, number][]): Channel => ({
  name: "pose", type: "double", samples: values.map(([time, value]) => ({time, value})),
});
it("interpolates normal pose updates without changing the log", () => {
  const c = channel([[1, 2], [1.04, 4]]);
  expect(replayValueAt(c, 1.01)).toBeCloseTo(2.5);
  expect(replayValueAt(c, 1.04)).toBe(4);
  expect(replayValueAt(c, 5)).toBe(4);
  expect(c.samples[0].value).toBe(2);
  expect(replayValueAt(c, 0)).toBeUndefined();
  expect(replayValueAt(undefined, 1)).toBeUndefined();
});
it("rotates through the short arc when heading wraps across pi", () => {
  const c = channel([[0, Math.PI - 0.1], [0.04, -Math.PI + 0.1]]);
  expect(replayValueAt(c, 0.02, true)).toBeCloseTo(Math.PI);
});
it("holds across telemetry gaps instead of fabricating a trajectory through a reset", () => {
  const c = channel([[1.21, 0], [2.72, 4.49]]);
  expect(replayValueAt(c, 2)).toBe(0);
  expect(replayValueAt(c, 2.72)).toBe(4.49);
});
it("handles duplicate timestamps and invalid samples without invalid transforms", () => {
  expect(replayValueAt(channel([[0, 1], [0, 2], [0.04, 4]]), 0.02)).toBeCloseTo(3);
  expect(replayValueAt(channel([[0, NaN], [0.04, 4]]), 0.02)).toBeUndefined();
  expect(replayValueAt(channel([[0, 1], [0.04, Infinity]]), 0.02)).toBe(1);
});
it("breaks the field trail at odometry resets instead of drawing a line to the start pose", async () => {
  const { poseTrail } = await import("../src/suite/core/plot");
  // Sitting at the origin, then the auto resets the pose to its start, then drives.
  const xs = channel([[0, 0], [0.02, 0], [0.04, 3.5], [0.06, 3.55], [0.08, 3.6]]);
  const ys = channel([[0, 0], [0.02, 0], [0.04, 2], [0.06, 2], [0.08, 2.01]]);
  const trail = poseTrail(xs, ys);
  expect(trail).toHaveLength(2);
  expect(trail[1][0]).toEqual({ x: 3.5, y: 2 });
  expect(trail[0].at(-1)).toEqual({ x: 0, y: 0 });
  // Normal driving stays one segment.
  expect(poseTrail(channel([[0, 1], [0.02, 1.05], [0.04, 1.1]]), channel([[0, 1], [0.02, 1], [0.04, 1]]))).toHaveLength(1);
});
