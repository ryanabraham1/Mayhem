// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWPILog } from "../src/suite/core/wpilog.ts";
import { valueAt, type Channel } from "../src/suite/core/analysis.ts";

/** Builds a WPILOG in memory: `entry` starts an entry, `put` writes a record at `time` seconds. */
function builder() {
  const parts: Buffer[] = [Buffer.from("5750494c4f47000100000000", "hex")];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const text = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const record = (id: number, time: number, data: Buffer) => {
    const header = Buffer.alloc(13);
    header[0] = 0x3f;
    header.writeUInt32LE(id, 1);
    header.writeUInt32LE(data.length, 5);
    header.writeUInt32LE(Math.round(time * 1e6), 9);
    parts.push(header, data);
  };
  let next = 1;
  const ids = new Map<string, number>();
  return {
    entry(name: string, type: string) {
      const id = next++;
      ids.set(name, id);
      record(0, 0, Buffer.concat([Buffer.from([0]), u32(id), text(name), text(type), text("")]));
      return id;
    },
    schema(struct: string, schema: string) {
      const id = this.entry(`/.schema/struct:${struct}`, "structschema");
      record(id, 0, Buffer.from(schema));
    },
    put(name: string, time: number, data: Buffer) {
      record(ids.get(name)!, time, data);
    },
    buffer() {
      const bytes = Buffer.concat(parts);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}
const f64 = (...v: number[]) => Buffer.from(new Float64Array(v).buffer);
const channel = (r: { channels: Channel[] }, name: string) => r.channels.find((c) => c.name === name);
const first = (r: { channels: Channel[] }, name: string) => channel(r, name)?.samples[0]?.value;

describe("struct schemas", () => {
  it("decodes custom structs from the schemas in the log: nested, arrays, enums, bit-fields, text", () => {
    const log = builder();
    log.schema("Gains", "double kP;float kI");
    log.schema(
      "ShooterState",
      "Gains gains;double wheel[2];enum {IDLE=0, SPINUP=1, READY=2} uint8 mode;bool homed;int16 ticks;uint8 jammed:1;uint8 level:3;int8 trim:4;char tag[6]",
    );
    log.entry("/Shooter/State", "struct:ShooterState");
    // Same-width bit-fields share one storage unit (WPILib struct.adoc), so jammed, level and trim are one byte.
    const data = Buffer.alloc(8 + 4 + 16 + 1 + 1 + 2 + 1 + 6);
    let at = 0;
    data.writeDoubleLE(0.25, at); at += 8;
    data.writeFloatLE(0.5, at); at += 4;
    data.writeDoubleLE(100, at); at += 8;
    data.writeDoubleLE(-101, at); at += 8;
    data.writeUInt8(2, at); at += 1; // READY
    data.writeUInt8(1, at); at += 1;
    data.writeInt16LE(-300, at); at += 2;
    data.writeUInt8(0b1110_101_1, at); at += 1; // trim = -2 (bits 4-7, two's complement), level = 5 (bits 1-3), jammed = 1
    data.write("left\0\0", at, "latin1");
    log.put("/Shooter/State", 1, data);
    const r = parseWPILog(log.buffer(), "t");
    expect(first(r, "/Shooter/State/gains/kP")).toBe(0.25);
    expect(first(r, "/Shooter/State/gains/kI")).toBe(0.5);
    expect(first(r, "/Shooter/State/wheel/0")).toBe(100);
    expect(first(r, "/Shooter/State/wheel/1")).toBe(-101);
    expect(first(r, "/Shooter/State/mode")).toBe("READY");
    expect(first(r, "/Shooter/State/homed")).toBe(true);
    expect(first(r, "/Shooter/State/ticks")).toBe(-300);
    expect(first(r, "/Shooter/State/jammed")).toBe(1);
    expect(first(r, "/Shooter/State/level")).toBe(5);
    expect(first(r, "/Shooter/State/trim")).toBe(-2);
    expect(first(r, "/Shooter/State/tag")).toBe("left");
    expect(channel(r, "/Shooter/State/mode")?.type).toBe("string");
    expect(r.warnings).toEqual([]);
  });
  it("keeps the established names for common WPILib types and decodes their arrays", () => {
    const log = builder();
    log.schema("Translation2d", "double x;double y");
    log.schema("Rotation2d", "double value");
    log.schema("Pose2d", "Translation2d translation;Rotation2d rotation");
    log.entry("/Robot/Pose", "struct:Pose2d");
    log.entry("/Vision/Targets", "struct:Pose2d[]");
    log.put("/Robot/Pose", 1, f64(1, 2, 0.5));
    log.put("/Vision/Targets", 1, f64(3, 4, 0.1, 5, 6, 0.2));
    const r = parseWPILog(log.buffer(), "t");
    expect(first(r, "/Robot/Pose/x")).toBe(1);
    expect(first(r, "/Robot/Pose/heading")).toBe(0.5);
    expect(first(r, "/Vision/Targets/1/y")).toBe(6);
  });
  it("lists a struct without a schema and keeps reading the rest of the log", () => {
    const log = builder();
    log.entry("/Mystery", "struct:Unlogged");
    log.entry("/Arm/angle", "double");
    log.put("/Mystery", 1, Buffer.alloc(16));
    log.put("/Arm/angle", 1, f64(0.7));
    const r = parseWPILog(log.buffer(), "t");
    expect(channel(r, "/Mystery")?.samples).toEqual([]);
    expect(first(r, "/Arm/angle")).toBe(0.7);
    expect(r.warnings.join(" ")).toMatch(/struct:Unlogged/);
  });
  it("skips struct records whose size doesn't match the schema instead of failing the log", () => {
    const log = builder();
    log.schema("Pair", "double a;double b");
    log.entry("/Pair", "struct:Pair");
    log.put("/Pair", 1, f64(1, 2));
    log.put("/Pair", 2, f64(1));
    const r = parseWPILog(log.buffer(), "t");
    expect(channel(r, "/Pair/a")?.samples).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/don't match/);
  });
});

describe("large recordings", () => {
  /** 2,000 records each of a noisy current with spikes, a constant flag, a battery voltage and a pose. */
  function bigLog() {
    const log = builder();
    log.entry("/Intake/supplyCurrent", "double");
    log.entry("/Robot/Enabled", "boolean");
    log.entry("/SystemStats/BatteryVoltage", "double");
    log.entry("/Robot/Pose", "struct:Pose2d");
    for (let i = 0; i < 2000; i++) {
      const t = i * 0.02;
      log.put("/Intake/supplyCurrent", t, f64(i === 777 ? 95 : i === 1500 ? -3 : 10 + Math.sin(i)));
      log.put("/Robot/Enabled", t, Buffer.from([i >= 100 && i < 1900 ? 1 : 0]));
      log.put("/SystemStats/BatteryVoltage", t, f64(12 - (i % 50) * 0.01));
      log.put("/Robot/Pose", t, f64(i * 0.01, i * 0.02, i * 0.001));
    }
    return log.buffer();
  }
  const total = (r: { channels: Channel[] }) => r.channels.reduce((n, c) => n + c.samples.length, 0);

  it("reads a small log exactly as before", () => {
    const r = parseWPILog(bigLog(), "t");
    expect(total(r)).toBe(2000 * 6);
    expect(r.channels.some((c) => c.sourceSamples)).toBe(false);
  });
  it("collapses repeats losslessly, then thins high-rate signals keeping lows and highs", () => {
    const full = parseWPILog(bigLog(), "full");
    const r = parseWPILog(bigLog(), "thin", { maxSamples: 5000 });
    expect(total(r)).toBeLessThanOrEqual(5000 * 1.25);
    expect(r.warnings.join(" ")).toMatch(/Large recording/);
    // A flag logged every loop keeps only its changes' edges, and reads the same at every time.
    const enabled = channel(r, "/Robot/Enabled")!;
    expect(enabled.samples.length).toBeLessThan(10);
    expect(enabled.sourceSamples).toBe(2000);
    for (const t of [0, 1.99, 2, 2.01, 20, 37.99, 38, 39.98])
      expect(valueAt(enabled, t)).toBe(valueAt(channel(full, "/Robot/Enabled")!, t));
    // The current's spike and dip survive thinning.
    const current = channel(r, "/Intake/supplyCurrent")!;
    expect(current.sourceSamples).toBe(2000);
    expect(current.samples.length).toBeLessThan(2000);
    const values = current.samples.map((s) => s.value as number);
    expect(Math.max(...values)).toBe(95);
    expect(Math.min(...values)).toBe(-3);
    expect(current.samples.find((s) => s.value === 95)?.time).toBeCloseTo(777 * 0.02, 6);
    // Battery voltage feeds the analysis and stays whole.
    expect(channel(r, "/SystemStats/BatteryVoltage")!.samples).toHaveLength(2000);
    // Struct fields are thinned together, so x, y and heading stay aligned.
    const x = channel(r, "/Robot/Pose/x")!, y = channel(r, "/Robot/Pose/y")!;
    expect(x.samples.map((s) => s.time)).toEqual(y.samples.map((s) => s.time));
    for (const s of x.samples) expect(valueAt(y, s.time)).toBeCloseTo((s.value as number) * 2, 9);
  });
  it("refuses a log whose states and flags alone exceed the limit", () => {
    const log = builder();
    log.entry("/Mode", "string");
    for (let i = 0; i < 100; i++) log.put("/Mode", i * 0.02, Buffer.from(`state ${i}`));
    expect(() => parseWPILog(log.buffer(), "t", { maxSamples: 50 })).toThrow(/never thinned/);
  });
});
