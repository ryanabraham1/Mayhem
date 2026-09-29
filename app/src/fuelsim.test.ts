import { describe, expect, it } from "vitest";
import rebuilt from "../../solver/src/mayhem_solver/fields/rebuilt-2026.json";
import { blocksFuel, fuelAt, fuelStart, intakenBy, newSimRobot, SETTLE_TIME, simRobotEnd, simRobotPose, simRobotTrack, simulateFuel } from "./fuelsim";
import type { Field, RobotConfig, Sample, SimRobot, TrajectoryOutput } from "./types";

const field = rebuilt as unknown as Field;
const robot = {
  bumper: { front: 0.45, back: 0.45, left: 0.45, right: 0.45 },
  intake: { side: "front", extension: 0.3, width: 0, offset: 0 },
} as RobotConfig;

/** Constant-speed drive along y = y0 from x0 to x1, heading +x. */
function straight(x0: number, x1: number, y0: number, v: number, intake: boolean): TrajectoryOutput {
  const T = (x1 - x0) / v;
  const samples: Sample[] = [];
  for (let k = 0; k <= 100; k++) {
    const t = (T * k) / 100;
    samples.push({ t, x: x0 + v * t, y: y0, heading: 0, vx: v, vy: 0, omega: 0, ax: 0, ay: 0, alpha: 0, fx: [], fy: [] });
  }
  return { samples, intake: intake ? [{ t: 0, endT: T }] : [] } as unknown as TrajectoryOutput;
}

describe("fuel sim", () => {
  const y = 5.2; // through the middle of the upper neutral-zone pile

  it("pushes fuel out of the robot's way without an intake", () => {
    const sim = simulateFuel(field, robot, straight(6, 10.5, y, 2, false), { intakeRate: 10, capacity: 0, robots: [] })!;
    const start = fuelStart(field).pts;
    const end = fuelAt(sim, 99);
    expect(intakenBy(sim, "us", 99)).toBe(0);
    let moved = 0;
    for (let i = 0; i < sim.n; i++) {
      const [x, yy] = [end[2 * i], end[2 * i + 1]];
      if (Math.hypot(x - start[i][0], yy - start[i][1]) > 0.05) moved++;
      // nothing left inside the final robot footprint
      if (Math.abs(x - 10.5) < 0.45 && Math.abs(yy - y) < 0.45) throw new Error(`ball ${i} inside the robot`);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(yy).toBeLessThanOrEqual(field.width);
    }
    expect(moved).toBeGreaterThan(20);
    // the lower pile across the center line is untouched
    const lower = start.findIndex(([, py]) => py < 3);
    expect(end[2 * lower]).toBeCloseTo(start[lower][0], 3);
  });

  it("intakes at most its rate and pushes the rest", () => {
    const out = straight(6, 10.5, y, 2, true);
    const T = 4.5 / 2;
    const sim = simulateFuel(field, robot, out, { intakeRate: 10, capacity: 0, robots: [] })!;
    const got = intakenBy(sim, "us", T);
    expect(got).toBeGreaterThan(5);
    expect(got).toBeLessThanOrEqual(Math.ceil(10 * T) + 2);
    // far more fuel was in the swept path than the intake could take
    const swept = fuelStart(field).pts.filter(([px, py]) => px > 6 && Math.abs(py - y) < 0.45 + 0.075).length;
    expect(swept).toBeGreaterThan(got * 2);
  });

  it("respects hopper capacity", () => {
    const sim = simulateFuel(field, robot, straight(6, 10.5, y, 2, true), { intakeRate: 50, capacity: 8, robots: [] })!;
    expect(intakenBy(sim, "us", 99)).toBe(8);
  });

  const bot = (over: Partial<SimRobot>): SimRobot => ({
    id: "b1", name: "Opp", alliance: "red", points: [[11, 5.2], [8.3, 5.2], [6, 5.2]], maxVelocity: 3, maxAcceleration: 3,
    startDelay: 0.5, size: 0.9, intake: true, intakeRate: 8, capacity: 0, enabled: true, ...over,
  });

  it("drives other robots along their curve with a speed profile", () => {
    const tr = simRobotTrack(bot({}));
    expect(tr.length).toBeCloseTo(5, 1);
    expect(simRobotPose(tr, 0).x).toBeCloseTo(11);
    expect(simRobotPose(tr, 0.5).vx).toBeCloseTo(0);
    const mid = simRobotPose(tr, 0.5 + tr.driveTime / 2);
    expect(mid.x).toBeCloseTo(8.5, 1);
    expect(Math.abs(mid.heading)).toBeCloseTo(Math.PI, 2);
    expect(mid.vx).toBeLessThan(-2.5);
    expect(simRobotPose(tr, 99).x).toBeCloseTo(6);
    expect(simRobotEnd(tr)).toBeCloseTo(0.5 + 5 / 3 + 1, 5);
  });

  it("slows other robots for bends instead of snapping through them", () => {
    // a hairpin: out, then sharply back
    const tr = simRobotTrack(bot({ points: [[3, 2], [6, 2], [6.3, 2.6], [3, 3.2]], startDelay: 0 }));
    const straight = simRobotTrack(bot({ points: [[3, 2], [9, 2]], startDelay: 0 }));
    expect(tr.driveTime).toBeGreaterThan(straight.driveTime * 1.1); // it had to brake for the turn
    let prev = simRobotPose(tr, 0), maxLat = 0, maxOmega = 0, maxAccel = 0, maxJump = 0;
    const dt = 0.005;
    for (let t = dt; t <= tr.driveTime; t += dt) {
      const q = simRobotPose(tr, t), v = Math.hypot(q.vx, q.vy);
      maxLat = Math.max(maxLat, v * Math.abs(q.omega));
      maxOmega = Math.max(maxOmega, Math.abs(q.omega));
      maxAccel = Math.max(maxAccel, Math.abs(v - Math.hypot(prev.vx, prev.vy)) / dt);
      maxJump = Math.max(maxJump, Math.abs(Math.atan2(Math.sin(q.heading - prev.heading), Math.cos(q.heading - prev.heading))));
      prev = q;
    }
    expect(maxAccel).toBeLessThanOrEqual(3 + 1e-6);
    expect(maxLat).toBeLessThan(3 * 1.3);
    expect(maxOmega).toBeLessThan(2 * Math.PI * 1.3);
    expect(maxJump).toBeLessThan(2 * Math.PI * 1.3 * dt);
  });

  it("lets other robots push and intake fuel with no path of ours", () => {
    const sim = simulateFuel(field, robot, null, { intakeRate: 10, capacity: 0, robots: [bot({})] })!;
    expect(sim.duration).toBeGreaterThan(3);
    const got = intakenBy(sim, "b1", sim.duration);
    expect(got).toBeGreaterThan(5);
    expect(got).toBeLessThanOrEqual(Math.ceil(8 * sim.duration) + 2);
    expect(intakenBy(sim, "us", sim.duration)).toBe(0);
    // disabled robots do nothing
    expect(simulateFuel(field, robot, null, { intakeRate: 10, capacity: 0, robots: [bot({ enabled: false })] })).toBeNull();
  });

  it("keeps simulating until pushed fuel comes to rest", () => {
    const sim = simulateFuel(field, robot, straight(6, 10.5, y, 3, false), { intakeRate: 10, capacity: 0, robots: [] })!;
    const T = 4.5 / 3;
    expect(sim.duration).toBeGreaterThan(T + 0.5); // kicked fuel was still rolling when the robot stopped
    expect(sim.duration).toBeLessThanOrEqual(T + SETTLE_TIME + 1e-9);
    const a = fuelAt(sim, sim.duration - 0.1), b = fuelAt(sim, sim.duration);
    let moved = 0;
    for (let k = 0; k < a.length; k++) moved = Math.max(moved, Math.abs(a[k] - b[k]));
    expect(moved).toBeLessThan(0.01);
  });

  it("mirrors new opponents' default autos from the ally ones", () => {
    const ally = newSimRobot(field, "blue", []);
    const opp = newSimRobot(field, "red", [ally]);
    expect(opp.alliance).toBe("red");
    expect(opp.points[0][0]).toBeCloseTo(field.length - ally.points[0][0]);
    expect(opp.points[0][1]).toBeCloseTo(field.width - ally.points[0][1]);
    expect(newSimRobot(field, "blue", [ally]).points).not.toEqual(ally.points); // second ally gets another lane
  });

  it("lets obstacles block fuel without blocking paths, and the reverse", () => {
    const o = field.obstacles.find((x) => x.name === "Red Bump (right)")!;
    expect(o.enabled).toBe(false); // robots drive over it...
    expect(blocksFuel(o)).toBe(true); // ...but fuel can't roll across (preset)
    expect(blocksFuel({ ...o, fuelCollision: "paths" })).toBe(false);
    expect(blocksFuel({ ...o, enabled: true, fuelCollision: "pass" })).toBe(false);

    // plow the upper pile toward the red bump at speed
    const onBump = (f: Field) => {
      const sim = simulateFuel(f, robot, straight(6, 10.6, y, 4, false), { intakeRate: 0, capacity: 0, robots: [] })!;
      const end = fuelAt(sim, sim.duration);
      let n = 0;
      for (let i = 0; i < sim.n; i++) {
        const [x, yy] = [end[2 * i], end[2 * i + 1]];
        if (x > 11.3532 + 0.08 && x < 12.4792 && yy > 4.6286 && yy < 6.4849) n++;
      }
      return n;
    };
    expect(onBump(field)).toBe(0);
    const passable = { ...field, obstacles: field.obstacles.map((x) => (x.name.includes("Bump") ? { ...x, fuelCollision: "pass" as const } : x)) };
    expect(onBump(passable)).toBeGreaterThan(0);
  });
});
