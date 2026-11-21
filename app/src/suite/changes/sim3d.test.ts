import { describe, expect, it } from "vitest";
import { sampleAt, track3D } from "./sim3d.ts";

/** A minimal WPILOG writer: start records, then double-array payloads. */
function wpilog(entries: { name: string; type: string; samples: { t: number; values: number[] }[] }[]) {
  const parts: number[] = [];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const str = (s: string) => [...u32(s.length), ...new TextEncoder().encode(s)];
  // Header byte: 4-byte id, 4-byte size, 8-byte time.
  const rec = (id: number, t: number, payload: number[]) => {
    parts.push(3 | (3 << 2) | (7 << 4), ...u32(id), ...u32(payload.length), ...u32(Math.round(t * 1e6)), 0, 0, 0, 0, ...payload);
  };
  entries.forEach((e, i) => rec(0, 0, [0, ...u32(i + 1), ...str(e.name), ...str(e.type), ...str("")]));
  entries.forEach((e, i) =>
    e.samples.forEach((s) => {
      const b = new Uint8Array(new Float64Array(s.values).buffer);
      rec(i + 1, s.t, [...b]);
    }),
  );
  const head = [...new TextEncoder().encode("WPILOG"), 0, 1, ...u32(0)];
  return Uint8Array.from([...head, ...parts]).buffer;
}

describe("track3D", () => {
  it("reads every piece, not just the first 32, plus the robot, components and pose estimate", () => {
    const ground = Array.from({ length: 360 }, (_, i) => [i * 0.01, 1, 0.075]).flat();
    const log = wpilog([
      { name: "/RealOutputs/Other", type: "double", samples: [{ t: 0, values: [0] }] },
      { name: "/RealOutputs/Sim/RobotPose", type: "struct:Pose3d", samples: [{ t: 1, values: [2, 3, 0, 1, 0, 0, 0] }, { t: 2, values: [4, 3, 0.1, 0, 0, 0, 1] }] },
      { name: "/RealOutputs/Sim/Components", type: "struct:Pose3d[]", samples: [{ t: 1, values: [0, 0, 0.5, 1, 0, 0, 0, 0.2, 0, 0, 1, 0, 0, 0] }] },
      { name: "/RealOutputs/Sim/Fuel", type: "struct:Translation3d[]", samples: [{ t: 1, values: ground }, { t: 3, values: ground.slice(0, 300) }] },
      { name: "/RealOutputs/Sim/FlyingFuel", type: "struct:Translation3d[]", samples: [{ t: 1, values: [] }, { t: 2.5, values: [5, 4, 1.8, 5.2, 4, 1.9] }] },
      { name: "NT:/DriveState/Pose", type: "struct:Pose2d", samples: [{ t: 1, values: [2.05, 3, 0.1] }] },
    ]);
    const track = track3D(log)!;
    expect(track.robot).toHaveLength(2);
    expect(track.robot[1].p).toEqual([4, 3, 0.1]);
    expect(track.robot[1].q).toEqual([0, 0, 1, 0]); // x, y, z, w
    expect(track.components).toHaveLength(2);
    expect(track.components[1][0].p).toEqual([0.2, 0, 0]);
    expect(track.fuel[0].xyz.length / 3).toBe(360);
    expect(sampleAt(track.fuel, 3.5)!.xyz.length / 3).toBe(100);
    expect(sampleAt(track.flying, 1.5)!.xyz.length).toBe(0);
    expect(sampleAt(track.flying, 2.7)!.xyz.length / 3).toBe(2);
    expect(track.estimate[0]).toMatchObject({ x: 2.05, y: 3, heading: 0.1 });
    expect(track.maxPieces).toBe(362);
    // Times start at the log's first record, as the general reader's do.
    expect(track.robot[0].t).toBe(1);
  });

  it("reads 2025 coral as poses (orientation kept) and algae as points", () => {
    const half = Math.SQRT1_2;
    const log = wpilog([
      { name: "/RealOutputs/Sim/RobotPose", type: "struct:Pose3d", samples: [{ t: 0, values: [2, 3, 0, 1, 0, 0, 0] }] },
      // Two coral: one on the carpet (identity), one turned 90 degrees about z (w, x, y, z).
      { name: "NT:/AdvantageKit/RealOutputs/Sim/Coral", type: "struct:Pose3d[]", samples: [{ t: 1, values: [1, 2, 0.057, 1, 0, 0, 0, 4, 5, 1.2, half, 0, 0, half] }] },
      { name: "/RealOutputs/Sim/Algae", type: "struct:Translation3d[]", samples: [{ t: 1, values: [6, 7, 0.2] }] },
      { name: "/RealOutputs/Sim/Fuel", type: "struct:Translation3d[]", samples: [{ t: 1, values: [1, 2, 0.057, 4, 5, 1.2] }] },
    ]);
    const track = track3D(log)!;
    expect(track.coral).toHaveLength(1);
    expect(track.coral[0].pose.length / 7).toBe(2);
    expect(Array.from(track.coral[0].pose.subarray(7, 14))).toEqual(Array.from(Float32Array.from([4, 5, 1.2, half, 0, 0, half])));
    expect(track.maxCoral).toBe(2);
    expect(Array.from(track.algae[0].xyz)).toEqual(Array.from(Float32Array.from([6, 7, 0.2])));
    expect(track.maxAlgae).toBe(1);
    // Sim/Fuel is still read for runs and seasons that draw it.
    expect(track.fuel[0].xyz.length / 3).toBe(2);
  });

  it("has no coral poses when the run logs only Sim/Fuel", () => {
    const log = wpilog([
      { name: "/RealOutputs/Sim/RobotPose", type: "struct:Pose3d", samples: [{ t: 0, values: [2, 3, 0, 1, 0, 0, 0] }] },
      { name: "/RealOutputs/Sim/Fuel", type: "struct:Translation3d[]", samples: [{ t: 1, values: [1, 2, 0.057] }] },
    ]);
    const track = track3D(log)!;
    expect(track.coral).toEqual([]);
    expect(track.algae).toEqual([]);
    expect(track.maxCoral).toBe(0);
  });

  it("has nothing to draw without a robot pose", () => {
    expect(track3D(wpilog([{ name: "/RealOutputs/Sim/Fuel", type: "struct:Translation3d[]", samples: [{ t: 0, values: [1, 2, 3] }] }]))).toBeUndefined();
  });
});
