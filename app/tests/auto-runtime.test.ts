// @vitest-environment node
// Braking profile, exits checked every tick, look-ahead through an open gate, distance and
// hold event markers: the TypeScript runtime and the generated C++ runner behave the same.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DEFAULT_GOAL, validateProject, type AutoRoutine, type SuiteProject } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import { autoNext, initialFrame, isIntermediate, pathAhead, simulate, step, type Frame } from "../src/suite/core/runtime.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";

const always = { kind: "always" as const };
const flag = (key: string) => ({ kind: "signal" as const, key, op: "eq" as const, value: true });
const pose = (id: string, x: number, y: number, goal: Partial<typeof DEFAULT_GOAL> = {}, extra: object = {}) => ({
  id, name: id, kind: "pose" as const, timeout: 15, goal: { ...DEFAULT_GOAL, x, y, ...goal }, ...extra,
});

/** Gate (conditional pass-through) → capped pickup raced with `coralSeen` → score, or the miss fallback. */
function project(): { p: SuiteProject; routine: AutoRoutine } {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 1, y: 1, heading: 0 };
  p.robot.constraints = { ...p.robot.constraints, anticipateSpeedCaps: true, stopDeceleration: 2, stopLag: 0.05 };
  p.signals = [
    { key: "left", name: "Left", type: "boolean", initial: false },
    { key: "coralSeen", name: "Coral seen", type: "boolean", initial: false },
  ];
  p.routines = [
    {
      id: "race", name: "Race", initial: "gate",
      nodes: [
        pose("gate", 4, 1, { handoffRadius: 0.5 }),
        pose("alt", 4, 3),
        pose("pickup", 7, 2, {
          markers: [
            { kind: "event", t: 1, key: "intake.down", distance: 1.3, at: { x: 6, y: 1.5 } },
            { kind: "event", t: 1, key: "arm.up", distance: 0.6, hold: true },
          ],
        }, { constraints: { maxVelocity: 1 } }),
        pose("score", 3, 3),
        pose("missed", 7, 3.5),
        { id: "done", name: "Done", kind: "finish", timeout: 1 },
      ],
      transitions: [
        { id: "left", from: "gate", to: "alt", condition: flag("left") },
        { id: "on", from: "gate", to: "pickup", condition: always },
        { id: "got", from: "pickup", to: "score", condition: flag("coralSeen"), interrupt: true },
        { id: "none", from: "pickup", to: "missed", condition: always },
        { id: "a", from: "alt", to: "done", condition: always },
        { id: "b", from: "score", to: "done", condition: always },
        { id: "c", from: "missed", to: "done", condition: always },
      ],
    } as AutoRoutine,
  ];
  return { p, routine: p.routines[0] };
}

/** Routine-mode run with `coralSeen` true from tick `seenAt` (never when negative). */
function run(p: SuiteProject, routine: AutoRoutine, seenAt: number, left = false) {
  let frame = initialFrame(p, routine);
  const frames: Frame[] = [];
  for (let i = 0; i < 1500 && frame.status === "running"; i++) {
    frame = step(p, routine, frame, { left, coralSeen: seenAt >= 0 && i >= seenAt }, 0.02, false, {});
    frames.push(frame);
  }
  return { frame, frames };
}
const speed = (f: Frame) => Math.hypot(f.velocity.vx, f.velocity.vy);
const entered = (frames: Frame[], node: string) => frames.find((f, i) => f.node === node && frames[i - 1]?.node !== node)!;

describe("braking profile", () => {
  it("never commands more speed than the robot can stop from, and still arrives", () => {
    const { p, routine } = project();
    const { frame, frames } = run(p, routine, -1);
    expect(frame.status).toBe("completed");
    // On the last step the path ends ahead: v <= sqrt(2·a·remaining) all the way in.
    for (const f of frames.filter((f) => f.node === "missed")) {
      const remaining = Math.hypot(7 - f.pose.x, 3.5 - f.pose.y);
      expect(speed(f)).toBeLessThanOrEqual(Math.sqrt(2 * 2 * (remaining + speed(f) * 0.02)) + 1e-6);
    }
    expect(Math.hypot(frame.pose.x - 7, frame.pose.y - 3.5)).toBeLessThanOrEqual(0.03);
    // Off (the default): the P law alone, which is faster into the stop.
    const plain = project();
    plain.p.robot.constraints.stopDeceleration = 0;
    expect(run(plain.p, plain.routine, -1).frame.time).toBeLessThan(frame.time);
  });
  it("is validated and inherited like the other path settings", () => {
    const { p } = project();
    p.routines[0].constraints = { stopDeceleration: 0, stopLag: 0 };
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    p.robot.constraints.stopDeceleration = -1;
    p.routines[0].nodes[0].constraints = { stopLag: Number.NaN };
    expect(validateProject(p).filter((i) => i.severity === "error").map((i) => i.path)).toEqual([
      "robot.constraints.stopDeceleration",
      "routines.0.nodes.0.constraints.stopLag",
    ]);
  });
});

describe("exits checked every tick", () => {
  it("leaves a pose step as soon as the condition is true, keeping its speed", () => {
    const { p, routine } = project();
    const { frame, frames } = run(p, routine, 130);
    expect(frame.status).toBe("completed");
    const score = entered(frames, "score");
    expect(frames.indexOf(score)).toBe(130);
    expect(Math.hypot(score.pose.x - 7, score.pose.y - 2)).toBeGreaterThan(0.5); // nowhere near the pickup pose
    expect(speed(score)).toBeGreaterThan(0.5);
    expect(frames.some((f) => f.node === "missed")).toBe(false);
    expect(frame.events.filter((e) => e.kind === "transition").map((e) => e.transition)).toEqual(["on", "got", "b"]);
  });
  it("takes the plain exit on arrival when the condition never comes true", () => {
    const { p, routine } = project();
    routine.nodes[2].goal!.stop = true; // stop on the pickup pose (otherwise it hands off to the next pose step)
    const { frame, frames } = run(p, routine, -1);
    const missed = entered(frames, "missed");
    const before = frames[frames.indexOf(missed) - 1];
    expect(Math.hypot(before.pose.x - 7, before.pose.y - 2)).toBeLessThanOrEqual(0.03);
    expect(frame.events.filter((e) => e.kind === "transition").map((e) => e.transition)).toEqual(["on", "none", "c"]);
  });
  it("is not part of a pass-through chain, and path-only playback drives the step to its end", () => {
    const { p, routine } = project();
    const pickup = routine.nodes[2];
    // One plain Always exit to a pose step: still a chain link despite the early exit.
    expect(autoNext(routine, pickup)?.id).toBe("missed");
    expect(isIntermediate(routine, pickup)).toBe(true);
    const path = simulate(p, routine, {}, { mode: "path" });
    expect(path.status).toBe("completed");
    // Path-only playback takes the first exit in list order once the step is reached.
    expect(path.frame.events.filter((e) => e.kind === "transition").map((e) => e.transition)).toEqual(["left", "a"]);
  });
  it("rejects an Always exit that would leave the step at once", () => {
    const { p } = project();
    p.routines[0].transitions[3].interrupt = true;
    expect(validateProject(p).filter((i) => i.severity === "error").map((i) => i.path)).toEqual(["routines.0.transitions.3.interrupt"]);
  });
});

describe("look-ahead through an open conditional pass-through", () => {
  it("anticipates the cap of the step the open exit leads to", () => {
    const { p, routine } = project();
    const gate = routine.nodes[0];
    const open = pathAhead(routine, gate, p, (n) => routine.transitions.find((t) => t.from === n.id && t.condition.kind === "always"));
    expect(open.anchors.map((a) => [a.x, a.y])).toEqual([[4, 1], [7, 2], [7, 3.5]]);
    expect(open.caps).toEqual([4.5, 1, 4.5]);
    expect(open.final).toBe(true);
    expect(pathAhead(routine, gate, p, () => undefined)).toMatchObject({ final: true, anchors: [{ x: 4, y: 1 }] });
    const { frames } = run(p, routine, -1);
    // Crossed the gate at the pickup step's 1 m/s cap, after driving faster before it.
    expect(speed(entered(frames, "pickup"))).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.max(...frames.filter((f) => f.node === "gate").map(speed))).toBeGreaterThan(1.5);
    // The other exit leads to an uncapped step that ends the path: no cap to slow for.
    const left = run(p, routine, -1, true);
    expect(left.frame.status).toBe("completed");
    expect(speed(entered(left.frames, "alt"))).toBeGreaterThan(1.2);
  });
});

describe("event markers by distance, and hold", () => {
  it("fires within the distance of a field point or of the step's goal", () => {
    const { p, routine } = project();
    const { frames } = run(p, routine, -1);
    const fired = (key: string) => frames.find((f) => f.events.some((e) => e.kind === "event" && e.message.includes(key)))!;
    const down = fired("intake.down"), up = fired("arm.up");
    const before = (f: Frame) => frames[frames.indexOf(f) - 1];
    // The tick's starting pose is inside the distance; the one before it was not.
    expect(Math.hypot(before(down).pose.x - 6, before(down).pose.y - 1.5)).toBeLessThanOrEqual(1.3);
    expect(Math.hypot(before(before(down)).pose.x - 6, before(before(down)).pose.y - 1.5)).toBeGreaterThan(1.3);
    expect(Math.hypot(before(up).pose.x - 7, before(up).pose.y - 2)).toBeLessThanOrEqual(0.6);
    expect(Math.hypot(before(before(up)).pose.x - 7, before(before(up)).pose.y - 2)).toBeGreaterThan(0.6);
    expect(up.events.at(-1)!.message).toBe("Event trigger arm.up (held until done)");
  });
  it("validates the distance, the field point and hold", () => {
    const { p } = project();
    const markers = p.routines[0].nodes[2].goal!.markers as any[];
    markers[0].distance = -1;
    markers[1].hold = "yes";
    markers.push({ kind: "event", t: 1, key: "x", at: { x: 1, y: 1 } });
    expect(validateProject(p).filter((i) => i.severity === "error").map((i) => i.path)).toEqual([
      "routines.0.nodes.2.goal.markers.0.distance",
      "routines.0.nodes.2.goal.markers.1.hold",
      "routines.0.nodes.2.goal.markers.2.distance",
    ]);
  });
});

describe("generated C++ runner", () => {
  it("drives the same poses, steps and events as the TypeScript runtime", () => {
    const { p, routine } = project();
    const dir = mkdtempSync(resolve(tmpdir(), "mayhem-auto-runtime-"));
    const header = exportCpp(p);
    expect(header).toContain('{"got","pickup","score",guard_2,true}');
    expect(header).toContain("mayhem::MarkerTrigger::PointDistance,1.3,6,1.5}");
    expect(header).toContain("mayhem::MarkerTrigger::GoalDistance,0.6,0,0,true}");
    expect(header).toContain(",true,2,0.05}"); // anticipateSpeedCaps, stopDeceleration, stopLag
    writeFileSync(resolve(dir, "routine.hpp"), header);
    writeFileSync(
      resolve(dir, "main.cpp"),
      `#include "routine.hpp"
#include <cstdio>
#include <cstdlib>
#include <string>
int main(int, char** argv) {
  const int seenAt = std::atoi(argv[1]); int tick = 0, held = 0;
  mayhem::AutoRunner runner(mayhem_generated::routine_0::routine);
  runner.BindSignal("left", [] { return mayhem::SignalValue{false}; })
        .BindSignal("coralSeen", [&] { return mayhem::SignalValue{seenAt >= 0 && tick >= seenAt}; })
        .Bind("intake.down", mayhem::Instant([&] { std::printf("E %d intake.down\\n", tick); }))
        .Bind("arm.up", {[&] { std::printf("E %d arm.up\\n", tick); },
                         [&] { held++; return mayhem::ActionStatus::Running; },
                         [&](bool cancelled) { std::printf("H %d %d\\n", held, int(cancelled)); }});
  if (!runner.Unbound().empty()) return 1;
  mayhem::Pose pose = mayhem_generated::routine_0::startPose; mayhem::Velocity v; runner.Start();
  for (; tick < 1500 && runner.Status() == mayhem::RunStatus::Running; ++tick) {
    v = runner.Tick(pose, v, .02);
    pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
    std::printf("P %s %.9f %.9f %.9f\\n", std::string(runner.ActiveState()).c_str(), pose.x, pose.y, pose.heading);
  }
  std::printf("S %d\\n", int(runner.Status()));
}`,
    );
    const exe = resolve(dir, "runtime");
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      `-I${fileURLToPath(new URL("../../lib-cpp/include", import.meta.url))}`,
      resolve(dir, "main.cpp"), "-o", exe,
    ]);
    for (const seenAt of [-1, 130]) {
      const lines = execFileSync(exe, [String(seenAt)], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(" "));
      const native = lines.filter((l) => l[0] === "P");
      const { frame, frames } = run(p, routine, seenAt);
      expect(lines.at(-1)).toEqual(["S", "2"]);
      expect(frame.status).toBe("completed");
      expect(native.length).toBe(frames.length);
      frames.forEach((f, i) => {
        expect(native[i][1]).toBe(f.node);
        expect(Number(native[i][2])).toBeCloseTo(f.pose.x, 7);
        expect(Number(native[i][3])).toBeCloseTo(f.pose.y, 7);
        expect(Number(native[i][4])).toBeCloseTo(f.pose.heading, 7);
      });
      // The same event markers on the same ticks.
      const events = frame.events.filter((e) => e.kind === "event").map((e) => [String(Math.round(e.time / 0.02) - 1), e.message.split(" ")[2]]);
      expect(lines.filter((l) => l[0] === "E").map((l) => [l[1], l[2]])).toEqual(events);
      // The held action was ticked from its marker until the step exited, then ended as unfinished.
      const held = lines.find((l) => l[0] === "H");
      if (events.some((e) => e[1] === "arm.up")) {
        expect(Number(held![1])).toBeGreaterThan(5);
        expect(held![2]).toBe("1");
      } else expect(held).toBeUndefined();
    }
  }, 60_000);
});
