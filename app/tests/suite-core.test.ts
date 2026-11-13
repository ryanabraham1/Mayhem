// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_GOAL,
  evaluate,
  parseProject,
  validateProject,
} from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import {
  control,
  follow,
  freshState,
  isIntermediate,
  pathAhead,
  initialFrame,
  step,
  simulate,
  wrap,
  type ControllerState,
} from "../src/suite/core/runtime.ts";
import {
  analyze,
  valueAt,
  type Recording,
} from "../src/suite/core/analysis.ts";
import { parseWPILog } from "../src/suite/core/wpilog.ts";
import { routeSegments } from "../src/suite/core/routes.ts";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { plotSeries } from "../src/suite/core/plot.ts";
import {
  exampleMachine,
  observedMachine,
  parseMachineManifest,
} from "../src/suite/core/machines.ts";
const clone = () => structuredClone(sampleProject);
const successfulActions = { "intake.acquire": "succeeded", "shooter.fire": "succeeded" } as const;
const successSignals = {
  pieceDetected: true,
  shooterReady: true,
  shotComplete: true,
};
describe("measured-state autonomy", () => {
  it("uses each routine's starting pose for both execution and the visual route", () => {
    const p = clone(),
      r = p.routines[0];
    r.start = { x: 2.2, y: 2.5, heading: 0.5 };
    expect(initialFrame(p, r).pose).toEqual(r.start);
    expect(routeSegments(p, r)[0].from).toEqual(r.start);
    expect(p.robot.start.x).toBe(1.4);
    r.start.x = NaN;
    expect(validateProject(p).some((i) => i.path.includes("start.x"))).toBe(
      true,
    );
  });
  it("keeps unknown inputs false through negated and grouped conditions", () => {
    const unknown = {
      kind: "signal",
      key: "unknown",
      op: "eq",
      value: true,
    } as const;
    expect(evaluate({ kind: "not", condition: unknown }, {})).toBe(false);
    expect(
      evaluate(
        {
          kind: "not",
          condition: { kind: "signal", key: "sensor", op: "gt", value: 1 },
        },
        { sensor: NaN },
      ),
    ).toBe(false);
    expect(
      evaluate({ kind: "all", conditions: [{ kind: "always" }, unknown] }, {}),
    ).toBe(false);
    expect(
      evaluate({ kind: "any", conditions: [{ kind: "always" }, unknown] }, {}),
    ).toBe(true);
  });
  it("finishes only after reaching both goals and satisfying the sensor conditions", () => {
    const p = clone();
    const r = simulate(p, p.routines[0], successSignals, { actions: successfulActions });
    expect(r.status).toBe("completed");
    expect(Math.hypot(r.frame.pose.x - 3.2, r.frame.pose.y - 5.6)).toBeLessThan(
      DEFAULT_GOAL.translationTolerance,
    );
    expect(
      r.frame.events
        .filter((e) => e.kind === "transition")
        .map((e) => e.transition),
    ).toEqual(["at-pickup", "has-piece", "lane-reached", "at-score", "shot"]);
  });
  it("fails instead of advancing a frozen drivetrain on time", () => {
    const p = clone();
    const r = simulate(p, p.routines[0], successSignals, { freezeDrive: true });
    expect(r.status).toBe("failed");
    expect(r.frame.node).toBe("pickup");
    expect(r.frame.events.some((e) => e.kind === "transition")).toBe(false);
  });
  it("waits for an actual possession signal and records the evaluated inputs", () => {
    const p = clone();
    const r = simulate(p, p.routines[0], {
      ...successSignals,
      pieceDetected: false,
    });
    expect(r.status).toBe("failed");
    expect(r.frame.node).toBe("collect");
    expect(r.frame.signals.pieceDetected).toBe(false);
  });
  it("previews the whole path without getting stuck on mechanism inputs", () => {
    const p = clone();
    const result = simulate(p, p.routines[0], {}, { mode: "path" });
    expect(result.status).toBe("completed");
    expect(result.frame.events.filter(e => e.kind === "transition").map(e => e.transition)).toEqual(["at-pickup", "has-piece", "lane-reached", "at-score", "shot"]);
    expect(result.frame.pose.y).toBeCloseTo(5.6, 1);
  });
  it("requires action completion as well as passing guards in full routine mode", () => {
    const p = clone(), routine = p.routines[0];
    routine.initial = "collect";
    let frame = step(p, routine, initialFrame(p, routine), successSignals);
    expect(frame.node).toBe("collect");
    frame = step(p, routine, frame, successSignals, .02, false, { actions: successfulActions });
    expect(frame.node).toBe("return-lane");
    const failure = step(p, routine, initialFrame(p, routine), successSignals, .02, false, { actions: { "intake.acquire": "failed" } });
    expect(failure.status).toBe("failed");
    expect(failure.events.at(-1)?.message).toContain("intake.acquire failed");
  });
  it("reports failed concurrent actions and latches success while guards are blocked", () => {
    const p = clone(), routine = p.routines[0];
    routine.initial = "collect";
    routine.nodes.find(n => n.id === "collect")!.during = ["arm.hold"];
    let frame = step(p, routine, initialFrame(p, routine), {}, .02, false, { actions: successfulActions });
    expect(frame.node).toBe("collect");
    frame = step(p, routine, frame, successSignals);
    expect(frame.node).toBe("return-lane");
    frame = step(p, routine, initialFrame(p, routine), {}, .02, false, { actions: { "arm.hold": "failed" } });
    expect(frame.status).toBe("failed");
  });
  it("ends an action step as done when its window runs out with onTimeout succeed", () => {
    const p = clone(), routine = p.routines[0];
    routine.initial = "collect";
    const collect = routine.nodes.find(n => n.id === "collect")!;
    collect.timeout = 0.5;
    // The robot never reports success: the default watchdog fails the routine...
    let failed = initialFrame(p, routine);
    for (let i = 0; i < 40 && failed.status === "running"; i++) failed = step(p, routine, failed, successSignals, .02, false, { actions: {} });
    expect([failed.status, failed.node]).toEqual(["failed", "collect"]);
    // ...and onTimeout "succeed" counts the 0.5 s window as done and continues.
    collect.onTimeout = "succeed";
    let frame = initialFrame(p, routine);
    for (let i = 0; i < 40 && frame.node === "collect"; i++) frame = step(p, routine, frame, successSignals, .02, false, { actions: {} });
    expect([frame.status, frame.node]).toEqual(["running", "return-lane"]);
    expect(frame.time).toBeCloseTo(0.5, 5);
    expect(frame.events.some(e => e.message === "Collect: 0.5 s window ended; continuing" || e.message.endsWith("0.5 s window ended; continuing"))).toBe(true);
    // An explicit failure still fails inside the window.
    frame = step(p, routine, initialFrame(p, routine), successSignals, .02, false, { actions: { "intake.acquire": "failed" } });
    expect(frame.status).toBe("failed");
  });
  it("validates onTimeout: fail or succeed, and succeed only on action and custom steps", () => {
    const p = clone() as any;
    p.routines[0].nodes.find((n: any) => n.id === "collect").onTimeout = "succeed";
    expect(validateProject(p).filter(i => i.severity === "error")).toEqual([]);
    p.routines[0].nodes.find((n: any) => n.id === "collect").onTimeout = "later";
    expect(validateProject(p).map(i => i.path)).toContain("routines.0.nodes.1.onTimeout");
    p.routines[0].nodes.find((n: any) => n.id === "collect").onTimeout = "fail";
    p.routines[0].nodes[0].onTimeout = "succeed";
    expect(validateProject(p).find(i => i.path === "routines.0.nodes.0.onTimeout")?.message).toMatch(/has not arrived/);
  });
  it("bounds fast transition cycles before trace history can exhaust memory", () => {
    const p = clone(), routine = p.routines[0];
    routine.initial = "collect";
    routine.transitions.unshift({ id: "cycle", from: "collect", to: "collect", condition: { kind: "always" } });
    const result = simulate(p, routine, {}, { mode: "path" });
    expect(result.status).toBe("failed");
    expect(result.frame.events.at(-1)?.message).toContain("1000 execution events");
    expect(result.frame.events.length).toBeLessThanOrEqual(1001);
  });
  it("requires a low measured speed when a settle time is set", () => {
    const result = control(
      DEFAULT_GOAL,
      { vx: 2, vy: 0, omega: 0 },
      { ...DEFAULT_GOAL, settleTime: 0.12 },
      DEFAULT_CONSTRAINTS,
      { vx: 2, vy: 0, omega: 0, settled: 0 },
      0.02,
    );
    expect(result.reached).toBe(false);
    const handoff = control(
      DEFAULT_GOAL,
      { vx: 2, vy: 0, omega: 0 },
      { ...DEFAULT_GOAL, handoffRadius: 0.3 },
      DEFAULT_CONSTRAINTS,
      result.state,
      0.02,
    );
    expect(handoff.reached).toBe(true);
  });
  it("takes the short heading rotation across pi and supports point-at heading", () => {
    expect(wrap(-3.13 - 3.13)).toBeGreaterThan(0);
    const result = control(
      { x: 1, y: 1, heading: 0 },
      { vx: 0, vy: 0, omega: 0 },
      { ...DEFAULT_GOAL, headingMode: "pointAt", aimX: 1, aimY: 5 },
      DEFAULT_CONSTRAINTS,
      { vx: 0, vy: 0, omega: 0, settled: 0 },
      0.02,
    );
    expect(result.command.omega).toBeGreaterThan(0);
  });
});
describe("path following", () => {
  const anchor = (id: string, x: number, y: number, extra: Partial<typeof DEFAULT_GOAL> = {}) => ({
    id, name: id, kind: "pose" as const, timeout: 15,
    goal: { ...DEFAULT_GOAL, x, y, ...extra },
  });
  const chain = () => {
    const p = clone();
    const routine = {
      id: "chain", name: "Chain", initial: "a",
      nodes: [
        anchor("a", 4, 1, { headingMode: "free" }),
        anchor("b", 6, 3, {
          markers: [
            { kind: "event", t: 0.3, key: "intake" },
            { kind: "rotation", t: 0.6, heading: 1.2 },
          ],
        }),
        anchor("c", 9, 3, { heading: Math.PI / 2 }),
        { id: "f", name: "F", kind: "finish" as const, timeout: 1 },
      ],
      transitions: [
        { id: "1", from: "a", to: "b", condition: { kind: "always" as const } },
        { id: "2", from: "b", to: "c", condition: { kind: "always" as const } },
        { id: "3", from: "c", to: "f", condition: { kind: "always" as const } },
      ],
    };
    p.robot.start = { x: 1, y: 1, heading: 0 };
    p.routines = [routine as any];
    return { p, routine: p.routines[0] };
  };
  it("drives through intermediate anchors without slowing to a stop", () => {
    const { p, routine } = chain();
    const result = simulate(p, routine, {});
    expect(result.status).toBe("completed");
    const handoffs = result.frames.filter((f, i) => i > 0 && f.node !== result.frames[i - 1].node && f.node !== "f");
    expect(handoffs.map((f) => f.node)).toEqual(["b", "c"]);
    for (const f of handoffs) expect(Math.hypot(f.velocity.vx, f.velocity.vy)).toBeGreaterThan(1.5);
    expect(Math.hypot(result.frame.pose.x - 9, result.frame.pose.y - 3)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(wrap(result.frame.pose.heading - Math.PI / 2))).toBeLessThanOrEqual(DEFAULT_GOAL.rotationTolerance);
  });
  it("fires event triggers once by segment progress", () => {
    const { p, routine } = chain();
    const events = simulate(p, routine, {}).frame.events.filter((e) => e.kind === "event");
    expect(events.map((e) => e.message)).toEqual(["Event trigger intake"]);
    expect(events[0].node).toBe("b");
  });
  it("stops at an anchor marked stop or with a conditional exit", () => {
    const { p, routine } = chain();
    routine.nodes[0].goal!.stop = true;
    const stopped = simulate(p, routine, {});
    const at = stopped.frames.findIndex((f) => f.node === "b");
    expect(Math.hypot(stopped.frames[at].velocity.vx, stopped.frames[at].velocity.vy)).toBeLessThan(0.3);
    expect(isIntermediate(routine, routine.nodes[0])).toBe(false);
    expect(isIntermediate(routine, routine.nodes[1])).toBe(true);
    expect(pathAhead(routine, routine.nodes[1]).anchors.length).toBe(2);
  });
  it("interpolates heading toward rotation markers by progress", () => {
    const { p, routine } = chain();
    const frames = simulate(p, routine, {}).frames.filter((f) => f.node === "b");
    const headings = frames.map((f) => f.pose.heading);
    expect(Math.max(...headings)).toBeGreaterThan(0.6);
  });
  it("exports chain links, markers, and path settings to C++", () => {
    const { p } = chain();
    const cpp = exportCpp(p);
    expect(cpp).toContain("mayhem::MarkerKind::Event");
    expect(cpp).toContain('"intake"');
    expect(cpp).toMatch(/\{"a",mayhem::NodeKind::Pose,.*,1,true\},/);
    expect(cpp).toMatch(/\{"c",mayhem::NodeKind::Pose,.*,-1,false\},/);
  });
  it("generated C++ drives the chain through the native runner like the preview", () => {
    const { p } = chain();
    const dir = mkdtempSync(resolve(tmpdir(), "mayhem-chain-"));
    writeFileSync(resolve(dir, "routine.hpp"), exportCpp(p));
    writeFileSync(
      resolve(dir, "main.cpp"),
      `#include "routine.hpp"
#include <cstdio>
#include <string>
struct Hooks : mayhem::RobotHooks { std::string events; void PathEvent(std::string_view k) override { events += std::string(k) + ";"; } };
int main() {
  Hooks hooks; mayhem::AutoRunner runner(mayhem_generated::routine_0::routine, hooks);
  mayhem::Pose pose{1, 1, 0}; mayhem::Velocity v; runner.Start();
  double minHandoff = 1e9; std::string_view last = runner.ActiveState();
  for (int i = 0; i < 3000 && runner.Status() == mayhem::RunStatus::Running; ++i) {
    v = runner.Tick(pose, v, .02);
    if (runner.ActiveState() != last && runner.ActiveState() != "f") minHandoff = std::min(minHandoff, std::hypot(v.vx, v.vy));
    last = runner.ActiveState();
    pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
  }
  std::printf("%d %.3f %.3f %.3f %s\\n", int(runner.Status()), pose.x, pose.y, minHandoff, hooks.events.c_str());
}`,
    );
    const exe = resolve(dir, "chain");
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      `-I${fileURLToPath(new URL("../../lib-cpp/include", import.meta.url))}`,
      resolve(dir, "main.cpp"), "-o", exe,
    ]);
    const [status, x, y, minHandoff, events] = execFileSync(exe, { encoding: "utf8" }).trim().split(" ");
    expect(status).toBe("2"); // Completed
    expect(Math.hypot(Number(x) - 9, Number(y) - 3)).toBeLessThanOrEqual(0.03);
    expect(Number(minHandoff)).toBeGreaterThan(1.5);
    expect(events).toBe("intake;");
    const preview = simulate(p, p.routines[0], {}).frame.pose;
    expect(Number(x)).toBeCloseTo(preview.x, 2);
    expect(Number(y)).toBeCloseTo(preview.y, 2);
  });
  it("keeps the requested heading continuous across an early handoff", () => {
    const a = { ...DEFAULT_GOAL, x: 4, y: 1, heading: 1.5 };
    const b = { ...DEFAULT_GOAL, x: 4, y: 5, heading: 1.5 };
    let pose = { x: 1, y: 1, heading: 0 };
    let v = { vx: 0, vy: 0, omega: 0 };
    let state = freshState(pose);
    let anchors = [a, b];
    let last: number | undefined;
    let jump = 0;
    for (let i = 0; i < 400 && anchors.length; i++) {
      const r = follow(pose, v, { anchors, final: true }, DEFAULT_CONSTRAINTS, state, 0.02);
      if (last !== undefined) jump = Math.max(jump, Math.abs(wrap(r.targetHeading - last)));
      last = r.targetHeading;
      state = r.state;
      v = r.command;
      if (r.handoff) anchors = anchors.slice(1);
      else if (r.reached) break;
      pose = { x: pose.x + v.vx * 0.02, y: pose.y + v.vy * 0.02, heading: wrap(pose.heading + v.omega * 0.02) };
    }
    expect(jump).toBeLessThan(0.1);
  });
  it("integrates a loop overrun as 0.1 s instead of failing, like the C++ follower", () => {
    const start = { x: 0, y: 0, heading: 0 };
    const r = follow(start, { vx: 0, vy: 0, omega: 0 },
      { anchors: [{ ...DEFAULT_GOAL, x: 3, y: 0 }], final: true },
      DEFAULT_CONSTRAINTS, freshState(start), 0.4);
    expect(r.valid).toBe(true);
    expect(r.command.vx).toBeGreaterThan(0);
    expect(r.command.vx).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxAcceleration * 0.1 + 1e-9);
  });
  it("hands off immediately on a zero-length segment", () => {
    const g = { ...DEFAULT_GOAL, x: 2, y: 2 };
    const r = follow({ x: 2.05, y: 2, heading: 0 }, { vx: 0, vy: 0, omega: 0 },
      { anchors: [{ ...g, handoffRadius: 0.001 }, { ...g, x: 5 }], final: true },
      DEFAULT_CONSTRAINTS, freshState({ x: 2, y: 2, heading: 0 }), 0.02);
    expect(r.handoff).toBe(true);
  });
  it("does not let an unreached rotation marker hold back a later event", () => {
    const pose = { x: 3, y: 0, heading: 0 };
    const r = follow(pose, { vx: 0, vy: 0, omega: 0 }, {
      anchors: [{ ...DEFAULT_GOAL, x: 10, y: 0, markers: [
        { kind: "rotation", t: 0.9, heading: 1 }, { kind: "event", t: 0.2, key: "early" },
      ] }], final: true }, DEFAULT_CONSTRAINTS, { ...freshState({ x: 0, y: 0, heading: 0 }) }, 0.02);
    expect(r.fired).toEqual(["early"]);
  });
  it("drives through every point of a tight zigzag instead of cutting past it", () => {
    const p = clone();
    const pts: [number, number, Partial<typeof DEFAULT_GOAL>?][] = [
      [9, 2], [9.6, 5], [7.4, 5.1], [7.6, 4.3, { headingMode: "free" }], [7.5, 2.4], [4.4, 2.6],
    ];
    const nodes: any[] = pts.map(([x, y, extra], i) => ({
      id: `p${i}`, name: `p${i}`, kind: "pose", timeout: 30, goal: { ...DEFAULT_GOAL, x, y, ...extra },
    }));
    nodes.push({ id: "f", name: "f", kind: "finish", timeout: 1 });
    const routine: any = {
      id: "zig", name: "Zig", initial: "p0", nodes,
      transitions: nodes.slice(0, -1).map((n, i) => ({ id: `t${i}`, from: n.id, to: nodes[i + 1].id, condition: { kind: "always" } })),
    };
    p.robot.start = { x: 2.4, y: 2, heading: 0 };
    p.robot.constraints = { ...DEFAULT_CONSTRAINTS };
    const result = simulate(p, routine, {}, { maxSeconds: 60 });
    expect(result.status).toBe("completed");
    for (const [x, y] of pts)
      expect(Math.min(...result.frames.map((f) => Math.hypot(f.pose.x - x, f.pose.y - y)))).toBeLessThanOrEqual(0.45);
  });
  it("validates marker progress and kind", () => {
    const { p } = chain();
    (p.routines[0].nodes[1].goal!.markers as any[])[0].t = 1.5;
    expect(validateProject(p).some((i) => i.path.endsWith("markers.0"))).toBe(true);
  });
});
describe("public project format", () => {
  it("preserves agent extensions and custom C++ action IDs", () => {
    const p = clone();
    p.extensions.vendor = { controller: "custom", nested: { enabled: true } };
    p.routines[0].nodes[1].kind = "custom";
    p.routines[0].nodes[1].action = "robot.anything";
    expect(parseProject(JSON.stringify(p))).toEqual(p);
  });
  it("reports stale references, invalid limits, and duplicate identifiers", () => {
    const p = clone();
    p.routines[0].transitions[0].to = "missing";
    p.robot.constraints.maxVelocity = -1;
    p.signals.push({ ...p.signals[0] });
    expect(
      validateProject(p).filter((i) => i.severity === "error").length,
    ).toBeGreaterThanOrEqual(3);
  });
  it("evaluates typed and nested conditions without coercing strings", () => {
    expect(
      evaluate(
        {
          kind: "all",
          conditions: [
            { kind: "signal", key: "n", op: "gt", value: 2 },
            {
              kind: "not",
              condition: {
                kind: "signal",
                key: "blocked",
                op: "eq",
                value: true,
              },
            },
          ],
        },
        { n: 3, blocked: false },
      ),
    ).toBe(true);
    expect(
      evaluate({ kind: "signal", key: "n", op: "eq", value: 3 }, { n: "3" }),
    ).toBe(false);
  });
});
describe("power evidence", () => {
  it("preserves short current spikes and the final sample in display decimation", () => {
    const samples = Array.from({ length: 10000 }, (_, i) => ({
      time: i / 100,
      value: i === 537 ? 250 : 10,
    }));
    const c = { name: "current", type: "double", samples };
    const result = plotSeries(c, 100);
    expect(result.max).toBe(250);
    expect(result.samples).toContain(samples[537]);
    expect(result.samples.at(-1)).toBe(samples.at(-1));
    expect(result.samples.length).toBeLessThanOrEqual(202);
    expect(c.samples).toHaveLength(10000);
  });
  it("accepts a robot's custom state/input channel names with either leading-slash convention", () => {
    const m = structuredClone(exampleMachine);
    m.stateChannel = "Robot/IntakeState";
    m.inputs[0].channel = "Inputs/Intake";
    const recording: Recording = {
      name: "custom",
      duration: 2,
      warnings: [],
      channels: [
        {
          name: "/Robot/IntakeState",
          type: "string",
          samples: [{ time: 0, value: "Acquiring" }],
        },
        {
          name: "/Inputs/Intake",
          type: "boolean",
          samples: [{ time: 0, value: true }],
        },
      ],
    };
    expect(observedMachine(parseMachineManifest(m), recording, 1)).toEqual({
      state: "Acquiring",
      signals: { "intake.requested": true },
    });
    (m.inputs[0] as any).channel = 23;
    expect(() => parseMachineManifest(m)).toThrow(/input/);
  });
  const recording: Recording = {
    name: "power",
    duration: 2,
    warnings: [],
    channels: [
      {
        name: "Robot/BatteryVoltage",
        type: "double",
        samples: [
          { time: 0, value: 12 },
          { time: 2, value: 12 },
        ],
      },
      {
        name: "Robot/TotalCurrent",
        type: "double",
        samples: [
          { time: 0, value: 10 },
          { time: 2, value: 10 },
        ],
      },
    ],
  };
  it("integrates voltage/current over the common recorded interval", () => {
    const a = analyze(recording);
    expect(a.power.energyWh).toBeCloseTo(240 / 3600);
    expect(a.power.averagePower).toBe(120);
  });
  it("does not invent missing current or energy measurements", () => {
    const a = analyze({
      ...recording,
      channels: recording.channels.slice(0, 1),
    });
    expect(a.power.energyWh).toBeUndefined();
    expect(a.coverage.some((c) => c.includes("No measured total or usable supply/branch current signals"))).toBe(
      true,
    );
  });
  it("uses historical values at the playback cursor", () => {
    expect(valueAt(recording.channels[0], -0.01)).toBeUndefined();
    expect(valueAt(recording.channels[0], 1)).toBe(12);
  });
  it("decodes WPILOG pose structs, power, and state strings and flags actual brownouts", async () => {
    const { demoLog } = await import("../../scripts/make-demo-log.mjs");
    const bytes = demoLog();
    const recording = parseWPILog(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "demo",
    );
    expect(
      recording.channels.find((c) => c.name === "Robot/Odometry/Pose/x")
        ?.samples.length,
    ).toBe(601);
    expect(
      valueAt(
        recording.channels.find((c) => c.name === "Mayhem/States/Intake/state"),
        8,
      ),
    ).toBe("Holding");
    const a = analyze(recording);
    expect(
      a.findings.some((f) => f.title === "Robot reported a brownout"),
    ).toBe(true);
    expect(a.findings.some((f) => f.title === "Low battery voltage")).toBe(
      true,
    );
    expect(() =>
      parseWPILog(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength - 1,
        ),
        "truncated",
      ),
    ).toThrow(/incomplete/);
  });
  it("decodes struct arrays and string arrays", () => {
    const parts: number[] = [];
    const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const text = (t: string) => [...u32(t.length), ...new TextEncoder().encode(t)];
    const record = (id: number, time: number, payload: number[]) =>
      parts.push(0x10, id, payload.length, time & 255, time >> 8, ...payload);
    const f64 = (...v: number[]) =>
      [...new Uint8Array(new Float64Array(v).buffer)];
    parts.push(...new TextEncoder().encode("WPILOG"), 0, 1, ...u32(0));
    const start = (id: number, name: string, type: string) =>
      record(0, 0, [0, ...u32(id), ...text(name), ...text(type), ...text("")]);
    start(1, "/Swerve/States", "struct:SwerveModuleState[]");
    start(2, "/Alerts", "string[]");
    record(1, 1000, f64(1.5, 0.25, 2.5, 0.5));
    record(2, 2000, [...u32(1), ...text("hi")]);
    const bytes = new Uint8Array(parts);
    const recording = parseWPILog(bytes.buffer, "t");
    const at = (n: string) => recording.channels.find((c) => c.name === n)?.samples[0].value;
    expect(at("/Swerve/States/0/speed")).toBe(1.5);
    expect(at("/Swerve/States/1/angle")).toBe(0.5);
    expect(at("/Alerts")).toBe('["hi"]');
  });
});
describe("native/browser controller agreement", () => {
  const executable = resolve(
    mkdtempSync(resolve(tmpdir(), "mayhem-cpp-")),
    "controller",
  );
  beforeAll(() => {
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${fileURLToPath(new URL("../../lib-cpp/include", import.meta.url))}`,
      fileURLToPath(new URL("../../lib-cpp/tests/controller_test.cpp", import.meta.url)),
      "-o",
      executable,
    ]);
  });
  it("passes the native arrival, watchdog, limits, and handoff checks", () => {
    expect(execFileSync(executable, { encoding: "utf8" })).toContain(
      "Controller checks passed",
    );
  });
  it("matches the same 100-step native pose trace", () => {
    const native = execFileSync(executable, ["trace"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.split(" ").map(Number));
    let pose = { x: 1.4, y: 4, heading: 0 },
      velocity = { vx: 0, vy: 0, omega: 0 },
      state: ControllerState = { ...velocity, settled: 0 };
    for (let i = 0; i < 100; i++) {
      const r = control(
        pose,
        velocity,
        { ...DEFAULT_GOAL, x: 5.8, y: 2.4, heading: -0.35 },
        DEFAULT_CONSTRAINTS,
        state,
        0.02,
      );
      state = r.state;
      velocity = r.command;
      pose = {
        x: pose.x + velocity.vx * 0.02,
        y: pose.y + velocity.vy * 0.02,
        heading: wrap(pose.heading + velocity.omega * 0.02),
      };
      expect(pose.x).toBeCloseTo(native[i][0], 11);
      expect(pose.y).toBeCloseTo(native[i][1], 11);
      expect(pose.heading).toBeCloseTo(native[i][2], 11);
    }
  });
});

import { currentBreakdown, parsePowerMapping } from "../src/suite/core/analysis";
it("ranks individual current draws by charge and skips the total and stator signals", () => {
  const ramp = (value: number) =>
    Array.from({ length: 11 }, (_, i) => ({ time: i, value }));
  const ranked = currentBreakdown(
    {
      name: "match",
      duration: 10,
      warnings: [],
      channels: [
        { name: "PDH/TotalCurrent", type: "double", samples: ramp(100) },
        { name: "Drive/FL/SupplyCurrent", type: "double", samples: ramp(36) },
        { name: "Intake/SupplyCurrent", type: "double", samples: ramp(-12) },
        { name: "Drive/FL/StatorCurrent", type: "double", samples: ramp(80) },
        { name: "NT:/DriveState/Timestamp", type: "double", samples: ramp(482427) },
        { name: "/Vision/Camera0/poseObservations/0/timestamp", type: "double", samples: ramp(40) },
        { name: "Shooter/Velocity", type: "double", samples: ramp(5) },
        { name: "Drive/currentEffectiveWheelRadius", type: "double", samples: ramp(500) },
        { name: "/Shooter/shooterMotorSupplyCurrents/0", type: "double", samples: ramp(4) },
      ],
    },
    "PDH/TotalCurrent",
  );
  expect(ranked.map((r) => r.channel)).toEqual([
    "Drive/FL/SupplyCurrent",
    "Intake/SupplyCurrent",
    "/Shooter/shooterMotorSupplyCurrents/0",
  ]);
  expect(ranked[0].average).toBeCloseTo(36);
  expect(ranked[0].mAh).toBeCloseTo(100);
  expect(ranked[1].peak).toBe(12);
});

it("uses authoritative current mappings and validates exact signal names and types", () => {
  const channel = { name: "Custom/Load", type: "double", samples: [{time: 0, value: 36}, {time: 10, value: 36}] };
  const recording = { name: "test", duration: 10, warnings: [], channels: [channel] };
  expect(currentBreakdown(recording)).toEqual([]);
  const mapping = parsePowerMapping({ deviceCurrents: [channel.name] }, recording.channels);
  expect(currentBreakdown(recording, undefined, 24, mapping.deviceCurrents)[0].mAh).toBeCloseTo(100);
  expect(currentBreakdown(recording, undefined, 24, [])).toEqual([]);
  expect(currentBreakdown(recording, channel.name, 24, mapping.deviceCurrents)).toEqual([]);
  expect(() => parsePowerMapping({ deviceCurrents: ["missing"] }, recording.channels)).toThrow("Signal not found");
  expect(() => parsePowerMapping({ currents: [] })).toThrow("Unknown mapping field");
  expect(() => parsePowerMapping({ deviceCurrents: "bad" })).toThrow();
  expect(() => parsePowerMapping({ brownout: channel.name }, recording.channels)).toThrow("Wrong signal type");
});

it("estimates missing total current by aligning device supply readings", () => {
  const a = analyze({ name: "estimate", duration: 10, warnings: [], channels: [
    {name: "BatteryVoltage", type: "double", samples: [{time:0,value:12},{time:10,value:12}]},
    {name: "A/SupplyCurrent", type: "double", samples: [{time:0,value:100},{time:5,value:0},{time:10,value:0}]},
    {name: "B/SupplyCurrent", type: "double", samples: [{time:0,value:0},{time:5,value:100},{time:10,value:100}]},
  ] });
  expect(a.power.currentSource).toBe("estimated");
  expect(a.power.peakCurrent).toBe(100);
  expect(a.power.energyWh).toBeCloseTo(12000 / 3600);
  expect(a.estimatedCurrent?.samples).toHaveLength(3);
});
