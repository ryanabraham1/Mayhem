// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Channel, Recording } from "../src/suite/core/analysis";
import { compareLogs, diagnoseLog, phasesOf, trackingPairs } from "../src/suite/core/logdiagnose";
import { listChannels } from "../src/suite/core/logquery";

const series = (name: string, f: (t: number) => number | boolean | string, from = 0, to = 20, dt = 0.02): Channel => ({
  name,
  type: "double",
  samples: Array.from({ length: Math.round((to - from) / dt) + 1 }, (_, i) => {
    const time = from + i * dt;
    return { time, value: f(time) };
  }),
});
const typed = (c: Channel, type: string) => ({ ...c, type });
const events = (name: string, type: string, points: [number, unknown][]): Channel => ({ name, type, samples: points.map(([time, value]) => ({ time, value: value as string })) });

/** A 20 s sim run: auto 1-5 s, teleop 6-19 s. `hunting` makes the flywheel oscillate around its setpoint. */
function run({ hunting, poseJump }: { hunting: boolean; poseJump?: boolean }): Recording {
  const setpoint = (t: number) => (t >= 2 && t < 18 ? 60 : 0);
  const velocity = (t: number) => (t < 2 ? 0 : t < 18 ? 60 * (1 - Math.exp(-(t - 2) / 0.2)) + (hunting && t > 3 ? 6 * Math.sin(2 * Math.PI * 3 * t) : 0) : 0);
  const flicker = Array.from({ length: 26 }, (_, i) => [15 + i * 0.02, i % 2 ? "SHOOT" : "INTAKE"] as [number, string]);
  return {
    name: hunting ? "before.wpilog" : "after.wpilog",
    duration: 20,
    warnings: [],
    channels: [
      events("DS:enabled", "boolean", [[0, false], [1, true], [5, false], [6, true], [19, false]]),
      events("DS:autonomous", "boolean", [[0, false], [1, true], [5, false]]),
      series("/RealOutputs/Shooter/reqVelocity", setpoint),
      series("/Shooter/velocity", velocity),
      typed(series("/RealOutputs/Superstructure/ReadyFlywheel", (t) => setpoint(t) > 0 && Math.abs(velocity(t) - setpoint(t)) < 2), "boolean"),
      // Asked for 1.0 but the arm stops at 0.6 (a hard stop, or a gear ratio that is off).
      series("/RealOutputs/Arm/goalPosition", (t) => (t >= 6 && t < 12 ? 1 : 0.2)),
      series("/Arm/position", (t) => (t >= 6 && t < 12 ? Math.min(0.6, 0.2 + (t - 6)) : 0.2)),
      series("/RealOutputs/LoopTimeMS", (t) => (Math.abs(t - 10) < 0.01 ? 35 : 2)),
      events("NT:/SmartDashboard/Alerts/errors", "string[]", [[0, "[]"], [3, '["Arm encoder disconnected"]']]),
      events("/RealOutputs/Superstructure/State", "string", hunting ? [[0, "IDLE"], ...flicker, [16, "IDLE"]] : [[0, "IDLE"], [15, "SHOOT"], [16, "IDLE"]]),
      series("/RealOutputs/Drive/Pose/x", (t) => t * 0.2 + (poseJump && t > 9 ? 2 : 0)),
      series("/RealOutputs/Drive/Pose/y", () => 1),
    ],
  };
}

describe("diagnoseLog", () => {
  const d = diagnoseLog(run({ hunting: true }));
  const byKind = (kind: string) => d.findings.filter((f) => f.kind === kind);

  it("splits the run into match phases", () => {
    expect(phasesOf(run({ hunting: true })).map((p) => p.mode)).toEqual(["disabled", "auto", "disabled", "teleop", "disabled"]);
    expect(d.context.phases[1]).toMatchObject({ mode: "auto", start: 1, end: 5 });
  });
  it("pairs setpoints with what they control", () => {
    const pairs = trackingPairs(run({ hunting: true })).map((p) => [p.setpoint.name, p.measured.name]);
    expect(pairs).toContainEqual(["/RealOutputs/Shooter/reqVelocity", "/Shooter/velocity"]);
    expect(pairs).toContainEqual(["/RealOutputs/Arm/goalPosition", "/Arm/position"]);
  });
  it("reports a mechanism hunting around its setpoint", () => {
    expect(byKind("tracking-oscillates")[0]).toMatchObject({ id: "tracking-oscillates:/RealOutputs/Shooter/reqVelocity", severity: "warning" });
  });
  it("tells an unreachable setpoint from a mistuned one", () => {
    const f = byKind("tracking-unreachable")[0];
    expect(f).toMatchObject({ id: "tracking-unreachable:/RealOutputs/Arm/goalPosition", evidence: { setpoint: 1, maxEverMeasured: 0.6 } });
    expect(byKind("tracking-never-reached")).toHaveLength(0);
  });
  it("explains a flickering flag by the signal and threshold it follows", () => {
    const f = d.findings.find((x) => x.id === "flag-flicker:/RealOutputs/Superstructure/ReadyFlywheel")!;
    const follows = (f.evidence as { follows: { channel: string; when: string }[] }).follows[0];
    expect(follows.channel).toContain("/Shooter/velocity");
    expect(follows.when).toMatch(/^true when < 2(\.|$)/);
    expect(f.next).toMatchObject({ tool: "log_table" });
    expect((f.next!.args.channels as string[])).toContain("/Shooter/velocity");
  });
  it("finds state thrash, loop overruns and alerts, errors first", () => {
    expect(byKind("state-flicker")[0]).toMatchObject({ severity: "error", channels: ["/RealOutputs/Superstructure/State"] });
    expect(byKind("loop-overrun")[0]).toMatchObject({ severity: "error", at: [10] });
    expect(byKind("alert")[0]).toMatchObject({ severity: "error", title: "Alert: Arm encoder disconnected" });
    const ranks = d.findings.map((f) => ({ error: 0, warning: 1, info: 2 })[f.severity]);
    expect(ranks).toEqual([...ranks].sort());
  });
  it("drops ignored findings by id or kind", () => {
    const kinds = new Set(diagnoseLog(run({ hunting: true }), { ignore: ["alert", "Superstructure/State"] }).findings.map((f) => f.id));
    expect([...kinds].some((id) => id.startsWith("alert:") || id.includes("Superstructure/State"))).toBe(false);
  });
});

describe("compareLogs", () => {
  it("says what a fix fixed and what it broke", () => {
    const c = compareLogs(run({ hunting: true }), run({ hunting: false, poseJump: true }));
    const fixed = c.fixed.map((f) => f.id);
    expect(fixed).toContain("tracking-oscillates:/RealOutputs/Shooter/reqVelocity");
    expect(fixed).toContain("flag-flicker:/RealOutputs/Superstructure/ReadyFlywheel");
    expect(fixed).toContain("state-flicker:/RealOutputs/Superstructure/State");
    expect(c.new.map((f) => f.id)).toEqual(["pose-jump:/RealOutputs/Drive/Pose/x"]);
    expect(c.persisting.find((p) => p.id.startsWith("tracking-unreachable"))).toMatchObject({ trend: "same" });
    expect(c.states[0].channel).toBe("/RealOutputs/Superstructure/State");
    expect(c.verdict).toBe("mixed");
    expect(compareLogs(run({ hunting: true }), run({ hunting: true })).verdict).toBe("unchanged");
  });
});

it("lists a large array as one row", () => {
  const recording: Recording = {
    name: "t", duration: 1, warnings: [],
    channels: Array.from({ length: 150 }, (_, i) => ({ name: `NT:/SmartDashboard/Field/Path/${i}`, type: "double", samples: [{ time: 0, value: i }] })),
  };
  expect(listChannels(recording).channels).toEqual([expect.objectContaining({ name: "NT:/SmartDashboard/Field/Path/*", elements: 150 })]);
  expect(listChannels(recording, { expandArrays: true, limit: 300 }).total).toBe(150);
});
