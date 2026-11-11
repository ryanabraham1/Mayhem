import { writeFile } from "node:fs/promises";
export function demoLog() {
  const parts = [Buffer.from("5750494c4f47000100000000", "hex")];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const string = (s) =>
    Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const record = (id, time, payload) => {
    const h = Buffer.alloc(13);
    h[0] = 0x3f;
    h.writeUInt32LE(id, 1);
    h.writeUInt32LE(payload.length, 5);
    h.writeUInt32LE(Math.round(time * 1e6), 9);
    parts.push(h, payload);
  };
  const entry = (id, name, type) =>
    record(
      0,
      0,
      Buffer.concat([
        Buffer.from([0]),
        u32(id),
        string(name),
        string(type),
        string(""),
      ]),
    );
  entry(1, "Robot/BatteryVoltage", "double");
  entry(2, "Robot/TotalCurrent", "double");
  entry(3, "Robot/BrownedOut", "boolean");
  entry(4, "Robot/Odometry/Pose", "struct:Pose2d");
  entry(5, "Mayhem/States/Intake/state", "string");
  entry(6, "intake.requested", "boolean");
  entry(7, "intake.hasPiece", "boolean");
  entry(8, "intake.release", "boolean");
  const double = (n) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return b;
  };
  for (let i = 0; i <= 600; i++) {
    const t = i * 0.02,
      sag = t >= 4 && t < 4.8;
    record(1, t, double(sag ? 8.4 : 12.4 - 0.04 * t));
    record(2, t, double(sag ? 205 : 40 + 15 * Math.sin(t)));
    record(3, t, Buffer.from([t >= 4.2 && t < 4.5 ? 1 : 0]));
    record(
      4,
      t,
      Buffer.concat([
        double(1.4 + t * 0.7),
        double(4 + Math.sin(t) * 1.3),
        double(t * 0.1),
      ]),
    );
    record(5, t, Buffer.from(t < 3 ? "Idle" : t < 7 ? "Acquiring" : "Holding"));
    record(6, t, Buffer.from([t >= 3 ? 1 : 0]));
    record(7, t, Buffer.from([t >= 7 ? 1 : 0]));
    record(8, t, Buffer.from([0]));
  }
  return Buffer.concat(parts);
}
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))
) {
  const destination = process.argv[2] ?? "examples/suite/power-demo.wpilog";
  await writeFile(destination, demoLog());
  console.log(destination);
}
