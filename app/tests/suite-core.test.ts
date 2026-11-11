// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
  initialFrame,
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
import { plotSeries } from "../src/suite/core/plot.ts";
import {
  exampleMachine,
  observedMachine,
  parseMachineManifest,
} from "../src/suite/core/machines.ts";
const clone = () => structuredClone(sampleProject);
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
    const r = simulate(p, p.routines[0], successSignals);
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
  it("requires a low measured speed and settling before final arrival", () => {
    const result = control(
      DEFAULT_GOAL,
      { vx: 2, vy: 0, omega: 0 },
      DEFAULT_GOAL,
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
    expect(a.coverage.some((c) => c.includes("Total current missing"))).toBe(
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
