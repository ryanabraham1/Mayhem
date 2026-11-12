// @vitest-environment node
import { expect, it } from "vitest";
import { parseWPILog } from "../src/suite/core/wpilog.ts";

function log(arrayType: string, payload: Buffer) {
  const parts = [Buffer.from("5750494c4f47000100000000", "hex")];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const text = (s: string) =>
    Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const record = (id: number, time: number, data: Buffer) => {
    const header = Buffer.alloc(13);
    header[0] = 0x3f;
    header.writeUInt32LE(id, 1);
    header.writeUInt32LE(data.length, 5);
    header.writeUInt32LE(time, 9);
    parts.push(header, data);
  };
  const entry = (id: number, name: string, type: string) =>
    record(
      0,
      0,
      Buffer.concat([
        Buffer.from([0]),
        u32(id),
        text(name),
        text(type),
        text(""),
      ]),
    );
  entry(1, "NT:/SmartDashboard/Field Visualize/AutoPath", arrayType);
  entry(2, "/Slide/position", "double");
  entry(3, "/Shot/phase", "string");
  entry(4, "/Shot/fault", "boolean");
  const scalar = Buffer.alloc(8);
  scalar.writeDoubleLE(0.42);
  for (let i = 0; i < 3; i++) {
    record(1, i * 20000, payload);
    record(2, i * 20000, scalar);
    record(3, i * 20000, Buffer.from("FEEDING"));
    record(4, i * 20000, Buffer.from([0]));
  }
  const bytes = Buffer.concat(parts);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
for (const [type, width] of [
  ["double[]", 8],
  ["float[]", 4],
  ["int64[]", 8],
  ["boolean[]", 1],
] as const)
  it(`skips large valid ${type} samples without losing unrelated mechanism records`, () => {
    const recording = parseWPILog(
      log(type, Buffer.alloc(513 * width)),
      "large field path",
    );
    const samples = (name: string) =>
      recording.channels
        .find((c) => c.name === name)!
        .samples.map((s) => s.value);
    expect(samples("/Slide/position")).toEqual([0.42, 0.42, 0.42]);
    expect(samples("/Shot/phase")).toEqual(["FEEDING", "FEEDING", "FEEDING"]);
    expect(samples("/Shot/fault")).toEqual([false, false, false]);
    expect(
      recording.channels.some((c) =>
        c.name.startsWith("NT:/SmartDashboard/Field Visualize/AutoPath/"),
      ),
    ).toBe(false);
    expect(recording.warnings).toEqual([
      expect.stringContaining("arrays above 512 elements were skipped"),
    ]);
  });
it("decodes numeric arrays at the expansion limit", () => {
  const recording = parseWPILog(log("double[]", Buffer.alloc(512 * 8)), "512");
  expect(
    recording.channels.find((c) => c.name.endsWith("AutoPath/511"))?.samples
      .length,
  ).toBe(3);
  expect(recording.warnings).toEqual([]);
});
it("continues rejecting misaligned numeric payloads as malformed WPILOG", () => {
  expect(() =>
    parseWPILog(log("double[]", Buffer.alloc(513 * 8 + 1)), "invalid"),
  ).toThrow(/Invalid numeric array payload size/);
});
