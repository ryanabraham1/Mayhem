import { describe, expect, it } from "vitest";
import { flipHeading, flipPoint, footprint, insertionIndex, newWaypoint, pointInPolygon, sampleAt, wrap } from "./model";
import type { Field, RobotConfig, TrajectoryOutput } from "./types";

const field = { length: 16.541, width: 8.0692, symmetry: "rotational" } as Field;

describe("geometry helpers", () => {
  it("wraps angles into [-pi, pi)", () => {
    expect(wrap(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrap(-0.5)).toBeCloseTo(-0.5);
  });

  it("flips rotationally and by mirror", () => {
    expect(flipPoint(field, [1, 2])).toEqual([15.541, 6.0692]);
    expect(flipHeading(field, 0.3)).toBeCloseTo(0.3 + Math.PI);
    const mirror = { ...field, symmetry: "mirror" } as Field;
    expect(flipPoint(mirror, [1, 2])).toEqual([15.541, 2]);
    expect(flipHeading(mirror, 0.3)).toBeCloseTo(Math.PI - 0.3);
  });

  it("builds a rotated footprint", () => {
    const robot = { bumper: { front: 0.5, back: 0.5, left: 0.4, right: 0.4 } } as RobotConfig;
    const fp = footprint(robot, 0, 0, Math.PI / 2);
    expect(fp[0][0]).toBeCloseTo(-0.4);
    expect(fp[0][1]).toBeCloseTo(0.5);
    expect(pointInPolygon([0, 0], fp)).toBe(true);
    expect(pointInPolygon([1, 1], fp)).toBe(false);
  });

  it("inserts new waypoints on the nearest leg, otherwise appends", () => {
    const wps = [newWaypoint(0, 0), newWaypoint(4, 0), newWaypoint(4, 4)];
    expect(insertionIndex(wps, [2, 0.2])).toBe(1);
    expect(insertionIndex(wps, [4.2, 2])).toBe(2);
    expect(insertionIndex(wps, [9, 9])).toBe(3);
  });
});

describe("sampleAt", () => {
  const out = {
    samples: [
      { t: 0, x: 0, y: 0, heading: 0, vx: 0, vy: 0, omega: 0, ax: 2, ay: 0, alpha: 0, fx: [0], fy: [0] },
      { t: 1, x: 1, y: 0, heading: 0, vx: 2, vy: 0, omega: 0, ax: 0, ay: 0, alpha: 0, fx: [10], fy: [0] },
    ],
  } as unknown as TrajectoryOutput;

  it("integrates constant acceleration within an interval", () => {
    const s = sampleAt(out, 0.5);
    expect(s.x).toBeCloseTo(0.25);
    expect(s.vx).toBeCloseTo(1);
    expect(s.fx[0]).toBeCloseTo(5);
  });

  it("clamps outside the time range", () => {
    expect(sampleAt(out, -1).x).toBe(0);
    expect(sampleAt(out, 5).x).toBe(1);
  });
});
