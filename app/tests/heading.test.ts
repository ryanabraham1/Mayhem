// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { headingLints } from "../src/suite/core/headingLint.ts";
import { DEFAULT_CONSTRAINTS, DEFAULT_GOAL, validateProject, type Goal } from "../src/suite/core/model.ts";
import { follow, freshState, pathAhead, simulate, wrap, type Frame } from "../src/suite/core/runtime.ts";
import { sampleProject } from "../src/suite/core/sample.ts";

const deg = (r: number) => (r * 180) / Math.PI;
const anchor = (id: string, x: number, y: number, extra: Partial<Goal> = {}, constraints?: Record<string, number>) => ({
  id, name: id, kind: "pose" as const, timeout: 15,
  goal: { ...DEFAULT_GOAL, x, y, ...extra },
  ...(constraints ? { constraints } : {}),
});
/**
 * Start (1,1) facing +y; drive +x through a pickup on A→B, then up to C and end facing -x.
 * A Free/Fixed blend rotates from +y toward -x the whole way, so it hits the piece sideways.
 */
function pickupRoute(pickup: Partial<Goal>, options: { capped?: boolean; anticipate?: boolean } = {}) {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 1, y: 1, heading: Math.PI / 2 };
  if (options.anticipate) p.robot.constraints.anticipateSpeedCaps = true;
  p.routines = [{
    id: "pickup", name: "Pickup", initial: "a",
    nodes: [
      anchor("a", 4, 1, { headingMode: "free" }),
      anchor("b", 7, 1, { headingMode: "free", markers: [{ kind: "event", t: 0.6, key: "intake" }], ...pickup }, options.capped ? { maxVelocity: 1 } : undefined),
      anchor("c", 7, 4, { heading: Math.PI }),
      { id: "f", name: "F", kind: "finish" as const, timeout: 1 },
    ],
    transitions: [
      { id: "1", from: "a", to: "b", condition: { kind: "always" as const } },
      { id: "2", from: "b", to: "c", condition: { kind: "always" as const } },
      { id: "3", from: "c", to: "f", condition: { kind: "always" as const } },
    ],
  } as any];
  return { p, routine: p.routines[0] };
}
const run = (pickup: Partial<Goal>, options?: { capped?: boolean; anticipate?: boolean }) => {
  const { p, routine } = pickupRoute(pickup, options);
  const result = simulate(p, routine, {}, { mode: "path" });
  expect(result.status).toBe("completed");
  return { ...result, p, routine };
};
const atEvent = (frames: Frame[]) => {
  const f = frames.find((x) => x.events.some((e) => e.kind === "event" && e.time === x.time))!;
  expect(f).toBeDefined();
  return { f, travel: Math.atan2(f.velocity.vy, f.velocity.vx) };
};

describe("Motion heading", () => {
  it("faces the direction of travel through a pickup (the free/fixed blend does not)", () => {
    const free = atEvent(run({}).frames);
    expect(deg(Math.abs(wrap(free.f.pose.heading - free.travel)))).toBeGreaterThan(45);
    const motion = atEvent(run({ headingMode: "motion" }).frames);
    expect(deg(Math.abs(wrap(motion.f.pose.heading - motion.travel)))).toBeLessThan(10);
  });

  it("is already facing travel when the Motion segment starts, and never snaps across handoffs", () => {
    const { p, routine } = pickupRoute({ headingMode: "motion" });
    let pose = { ...p.robot.start }, v = { vx: 0, vy: 0, omega: 0 }, state = freshState(pose);
    let node = routine.nodes[0], last: number | undefined, maxJump = 0, entryError = Infinity;
    for (let i = 0; i < 2000; i++) {
      const r = follow(pose, v, pathAhead(routine, node, p), DEFAULT_CONSTRAINTS, state, 0.02);
      if (last !== undefined) maxJump = Math.max(maxJump, Math.abs(wrap(r.targetHeading - last)));
      last = r.targetHeading;
      if (r.handoff && node.id === "a") entryError = Math.abs(wrap(r.targetHeading));
      v = r.command; state = r.state;
      pose = { x: pose.x + v.vx * 0.02, y: pose.y + v.vy * 0.02, heading: wrap(pose.heading + v.omega * 0.02) };
      if (r.handoff) node = routine.nodes.find((n) => n.id === routine.transitions.find((t) => t.from === node.id)!.to)!;
      if (r.reached && !r.handoff) break;
    }
    // The heading target leaving A already points along A→B (+x, the Motion segment).
    expect(deg(entryError)).toBeLessThan(3);
    // No step change in the requested heading anywhere, including both handoffs.
    expect(deg(maxJump)).toBeLessThan(6);
  });

  it("headingOffset π drives backward through the pickup", () => {
    const { f, travel } = atEvent(run({ headingMode: "motion", headingOffset: Math.PI }).frames);
    expect(deg(Math.abs(wrap(f.pose.heading - travel - Math.PI)))).toBeLessThan(10);
    const { p } = pickupRoute({ headingMode: "motion", headingOffset: Number.NaN });
    expect(validateProject(p).map((i) => i.path)).toContain("routines.0.nodes.1.goal.headingOffset");
  });

  it("a rotation marker holds a heading until progress t, then rotates to the end heading", () => {
    // Enter B→C facing +x (Motion on B), hold +x until 70 % of the segment, then turn to -x.
    const { p, routine } = pickupRoute({ headingMode: "motion" });
    routine.nodes[2].goal!.markers = [{ kind: "rotation", t: 0.7, heading: 0 }];
    const frames = simulate(p, routine, {}, { mode: "path" }).frames;
    const onC = frames.filter((f) => f.node === "c");
    const at = (y: number) => onC.reduce((a, b) => (Math.abs(b.pose.y - y) < Math.abs(a.pose.y - y) ? b : a));
    expect(deg(Math.abs(wrap(at(2).pose.heading)))).toBeLessThan(5);
    expect(deg(Math.abs(wrap(at(2.9).pose.heading)))).toBeLessThan(10);
    expect(deg(Math.abs(wrap(onC.at(-1)!.pose.heading - Math.PI)))).toBeLessThan(3);
  });
});

describe("speed-cap anticipation", () => {
  const entrySpeed = (frames: Frame[]) => {
    const i = frames.findIndex((f) => f.node === "b");
    return Math.hypot(frames[i].velocity.vx, frames[i].velocity.vy);
  };
  it("reaches a slower step's handoff at its cap instead of braking after it", () => {
    const late = run({}, { capped: true });
    const early = run({}, { capped: true, anticipate: true });
    expect(entrySpeed(late.frames)).toBeGreaterThan(2);
    expect(entrySpeed(early.frames)).toBeLessThanOrEqual(1.05);
    // Without a slower step ahead the option changes nothing (same follower engine).
    const motion = { headingMode: "motion" as const };
    expect(run(motion).frame.time).toBeCloseTo(run(motion, { anticipate: true }).frame.time, 6);
    expect(validateProject(early.p)).toEqual([]);
  });
});

describe("pickup heading lint", () => {
  it("flags an event that fires with the front > 45° off travel, and not a Motion pickup", () => {
    const bad = run({});
    const lints = headingLints(bad.frames);
    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatchObject({ key: "intake", node: "b" });
    expect(lints[0].degrees).toBeGreaterThan(45);
    expect(lints[0].message).toMatch(/Motion heading/);
    expect(headingLints(run({ headingMode: "motion" }).frames)).toEqual([]);
  });
});

describe("native follower parity", () => {
  it("keeps a path on the native follower after a Motion step instead of restarting from rest", () => {
    const frames = run({ headingMode: "motion" }).frames;
    // No step-change in commanded speed at the handoff into the Fixed final step.
    const i = frames.findIndex((f) => f.node === "c");
    const speed = (f: Frame) => Math.hypot(f.velocity.vx, f.velocity.vy);
    expect(Math.abs(speed(frames[i]) - speed(frames[i - 1]))).toBeLessThan(DEFAULT_CONSTRAINTS.maxAcceleration * 0.02 + 1e-9);
  });
  it("generated C++ matches the preview for Motion + offset + anticipation", () => {
    const cases = [
      [{ headingMode: "motion" as const }, {}],
      [{ headingMode: "motion" as const, headingOffset: Math.PI }, {}],
      [{ headingMode: "motion" as const }, { capped: true, anticipate: true }],
    ] as const;
    const dir = mkdtempSync(resolve(tmpdir(), "mayhem-heading-"));
    for (const [n, [pickup, options]] of cases.entries()) {
      const { p, routine } = pickupRoute(pickup, options);
      const preview = simulate(p, routine, {}, { mode: "path" });
      writeFileSync(resolve(dir, `r${n}.hpp`), exportCpp(p));
      writeFileSync(resolve(dir, `m${n}.cpp`), `#include "r${n}.hpp"
#include <cstdio>
int main() {
  mayhem::RobotHooks hooks; mayhem::AutoRunner runner(mayhem_generated::routine_0::routine, hooks);
  mayhem::Pose pose = mayhem_generated::routine_0::startPose; mayhem::Velocity v; runner.Start();
  double t = 0, entry = -1;
  for (int i = 0; i < 3000 && runner.Status() == mayhem::RunStatus::Running; ++i) {
    v = runner.Tick(pose, v, .02); t += .02;
    if (entry < 0 && runner.ActiveState() == "b") entry = std::hypot(v.vx, v.vy);
    pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
  }
  std::printf("%d %.4f %.4f %.4f %.3f %.3f\\n", int(runner.Status()), pose.x, pose.y, pose.heading, t, entry);
}`);
      const exe = resolve(dir, `m${n}`);
      execFileSync(process.env.CXX ?? "clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror",
        `-I${fileURLToPath(new URL("../../lib-cpp/include", import.meta.url))}`, resolve(dir, `m${n}.cpp`), "-o", exe]);
      const [status, x, y, heading, time] = execFileSync(exe, { encoding: "utf8" }).trim().split(" ").map(Number);
      expect(status).toBe(2);
      expect(x).toBeCloseTo(preview.frame.pose.x, 2);
      expect(y).toBeCloseTo(preview.frame.pose.y, 2);
      // Both settle inside the 2° end tolerance of the Fixed heading (π).
      expect(Math.abs(wrap(heading - Math.PI))).toBeLessThanOrEqual(DEFAULT_GOAL.rotationTolerance + 1e-6);
      expect(Math.abs(wrap(preview.frame.pose.heading - Math.PI))).toBeLessThanOrEqual(DEFAULT_GOAL.rotationTolerance + 1e-6);
      expect(Math.abs(time - preview.frame.time)).toBeLessThan(0.1);
    }
  });
});
