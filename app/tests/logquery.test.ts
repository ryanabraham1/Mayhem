// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Recording } from "../src/suite/core/analysis";
import {
  findAnomalies,
  listChannels,
  logEvents,
  logTable,
  machineStates,
  whatChanged,
} from "../src/suite/core/logquery";

const series = (f: (t: number) => number | boolean | string, from = 0, to = 20, dt = 0.02) =>
  Array.from({ length: Math.round((to - from) / dt) + 1 }, (_, i) => {
    const time = from + i * dt;
    return { time, value: f(time) };
  });
const recording: Recording = {
  name: "t",
  duration: 20,
  warnings: [],
  channels: [
    // Normal noisy battery with a dip at 10 s.
    { name: "/Battery", type: "double", samples: series((t) => 12.4 + 0.05 * Math.sin(t * 40) - (t > 10 && t < 10.2 ? 3 : 0)) },
    // Current spike at the same moment.
    { name: "/Arm/supplyCurrent", type: "double", samples: series((t) => 20 + 2 * Math.sin(t * 30) + (t > 10 && t < 10.2 ? 150 : 0)) },
    // Sensor that sticks from 5 s to 12 s.
    { name: "/Enc/position", type: "double", samples: series((t) => (t > 5 && t < 12 ? 5 : Math.sin(t))) },
    // Stops logging at 8 s.
    { name: "/Gone", type: "double", samples: series((t) => Math.cos(t), 0, 8) },
    { name: "/Mode", type: "string", samples: [{ time: 0, value: "IDLE" }, { time: 10, value: "SHOOT" }, { time: 15, value: "IDLE" }] },
    { name: "/Flap", type: "boolean", samples: series((t) => t > 3 && t < 3.5 ? Math.round(t * 40) % 2 === 0 : false, 0, 6, 0.0125) },
  ],
};

it("lists and filters channels with stats", () => {
  const r = listChannels(recording, { filter: ["arm"] });
  expect(r.channels).toHaveLength(1);
  expect(r.channels[0]).toMatchObject({ name: "/Arm/supplyCurrent", max: 171.9733 });
});
it("aligns channels on one clock and reports correlation", () => {
  const t = logTable(recording, { channels: ["/Battery", "supplyCurrent"], from: 9.1, to: 11.1, step: 0.5 }) as any;
  expect(t.columns).toEqual(["time", "/Battery", "/Arm/supplyCurrent"]);
  expect(t.rows).toHaveLength(5);
  expect(t.rows[2][2]).toBeGreaterThan(100); // 10.1 s
  expect(t.correlation[0].r).toBeLessThan(0); // battery sags when current spikes
});
it("ranks real anomalies and reports each kind", () => {
  const a = findAnomalies(recording);
  const kinds = (c: string) => a.anomalies.filter((x) => x.channel === c).map((x) => x.kind);
  expect(kinds("/Arm/supplyCurrent")).toContain("outlier");
  expect(kinds("/Enc/position")).toContain("flatline");
  expect(kinds("/Gone")).toContain("stopped-logging");
  expect(kinds("/Flap")).toContain("flapping");
});
it("shows what deviated around a moment", () => {
  const w = whatChanged(recording, { time: 10, window: 0.5 });
  expect(w.top.slice(0, 2).map((r) => r.channel).sort()).toEqual(["/Arm/supplyCurrent", "/Battery"]);
});
it("lists non-numeric transitions in order", () => {
  const e = logEvents(recording, { channels: ["/Mode"] });
  expect(e.events.map((x) => x.to)).toEqual(["IDLE", "SHOOT", "IDLE"]);
});

describe("machine states for agents", () => {
  const ch = (name: string, samples: [number, string | boolean][]) => ({ name, type: typeof samples[0][1] === "string" ? "string" : "boolean", samples: samples.map(([time, value]) => ({ time, value })) });
  const flicker = Array.from({ length: 30 }, (_, i) => [2 + i * 0.02, i % 2 ? "OFF" : "SHOOTING"] as [number, string]);
  const recording = {
    name: "sim.wpilog",
    duration: 4,
    warnings: [],
    channels: [
      ch("Mayhem/States/ShooterMode/state", [[0, "OFF"], ...flicker]),
      ch("Mayhem/States/ShooterMode/transition", [[2, "OFF-to-SHOOTING"]]),
      ch("/RealOutputs/Mayhem/States/ShooterMode/inputs/shootHeld", [[0, false], [1.9, true]]),
      ch("/RealOutputs/Mayhem/States/ShooterMode/inputs/outtakeHeld", [[0, false], [1.5, true]]),
      ch("NT:/Mayhem/States/ShooterMode/state", [[0, "OFF"], ...flicker]),
      ch("NT:/SmartDashboard/Field/.type", [[0, "Field2d"]]),
    ],
  } as unknown as Recording;
  it("explains a machine fighting itself with the inputs that kept both transitions true", () => {
    const { machines } = machineStates(recording);
    expect(machines).toHaveLength(1);
    expect(machines[0].history[1]).toMatchObject({
      flapping: true,
      changes: 30,
      transitions: ["OFF → SHOOTING", "SHOOTING → OFF"],
      inputs: { shootHeld: true, outtakeHeld: true },
    });
  });
  it("ranks flapping first and keeps dashboard plumbing and NT copies out of events", () => {
    expect(findAnomalies(recording).anomalies[0]).toMatchObject({ kind: "flapping", channel: "Mayhem/States/ShooterMode/state" });
    const names = new Set(logEvents(recording, { limit: 500 }).events.map((e) => e.channel));
    expect(names.has("NT:/SmartDashboard/Field/.type")).toBe(false);
    expect(names.has("NT:/Mayhem/States/ShooterMode/state")).toBe(false);
    expect(names.has("Mayhem/States/ShooterMode/state")).toBe(true);
  });
});
