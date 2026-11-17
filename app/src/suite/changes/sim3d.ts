/**
 * What the 3D replay draws from one simulation log, read straight from the WPILOG: the same
 * channels the robot's AdvantageScope 3D Field tab uses (docs/sim/README.md in the robot repo):
 * the true robot pose and its articulated components, the pose estimate as a ghost, and every
 * game piece (on the ground and in flight).
 *
 * The general log reader (core/wpilog.ts) keeps only the first 32 elements of a struct array, and
 * the 2026 field has hundreds of Fuel, so this reads the few entries it needs on its own, whole.
 */

export interface Pose3 {
  t: number;
  p: [number, number, number];
  /** x, y, z, w (three.js order). */
  q: [number, number, number, number];
}
export interface Pose2 {
  t: number;
  x: number;
  y: number;
  heading: number;
}
/** A changing set of points: each sample holds every point as x, y, z triples. */
export interface Points {
  t: number;
  xyz: Float32Array;
}
export interface Track3D {
  robot: Pose3[];
  components: Pose3[][];
  /** Pieces resting or rolling on the field. */
  fuel: Points[];
  /** Pieces in the air (shots). */
  flying: Points[];
  /** The robot code's own pose estimate (odometry and vision), drawn as a ghost. */
  estimate: Pose2[];
  /** The most points any sample holds (ground and flying together), to size the instanced meshes. */
  maxPieces: number;
  duration: number;
}

/** AdvantageKit's names, and the same keys as seen over NetworkTables. */
const names = (key: string) => [`/RealOutputs/${key}`, `NT:/AdvantageKit/RealOutputs/${key}`, `/AdvantageKit/RealOutputs/${key}`];
const KEYS = {
  robot: names("Sim/RobotPose"),
  components: names("Sim/Components"),
  fuel: names("Sim/Fuel"),
  flying: names("Sim/FlyingFuel"),
  estimate: ["NT:/DriveState/Pose", ...names("DriveState/Pose"), ...names("Odometry/Robot")],
};

interface Raw {
  type: string;
  samples: { t: number; values: Float64Array }[];
}

/** Reads the named entries' struct samples (doubles); times are seconds from the log's first record, as core/wpilog.ts does. */
export function readEntries(buffer: ArrayBuffer, wanted: Set<string>): Map<string, Raw> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = new TextDecoder();
  if (bytes.length < 12 || text.decode(bytes.subarray(0, 6)) !== "WPILOG") throw new Error("This file is not a WPILOG recording.");
  let offset = 12 + view.getUint32(8, true);
  const active = new Map<number, Raw>();
  const out = new Map<string, Raw>();
  let minTime = Infinity;
  const uint = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v += bytes[offset++] * 2 ** (8 * i);
    return v;
  };
  while (offset < bytes.length) {
    const flags = bytes[offset++];
    const id = uint((flags & 3) + 1);
    const size = uint(((flags >> 2) & 3) + 1);
    const time = uint(((flags >> 4) & 7) + 1) / 1e6;
    const end = offset + size;
    if (end > bytes.length) break; // a log still being written: keep what is complete
    if (id === 0) {
      if (size && bytes[offset] === 0) {
        let at = offset + 1;
        const entry = view.getUint32(at, true);
        at += 4;
        const str = () => {
          const n = view.getUint32(at, true);
          at += 4;
          const s = text.decode(bytes.subarray(at, at + n));
          at += n;
          return s;
        };
        const name = str();
        const type = str();
        if (wanted.has(name)) {
          const raw = out.get(name) ?? { type, samples: [] };
          out.set(name, raw);
          active.set(entry, raw);
        } else active.delete(entry);
      } else if (size >= 5 && bytes[offset] === 1) active.delete(view.getUint32(offset + 1, true));
    } else {
      minTime = Math.min(minTime, time);
      const raw = active.get(id);
      if (raw && size % 8 === 0) {
        const values = new Float64Array(size / 8);
        for (let i = 0; i < values.length; i++) values[i] = view.getFloat64(offset + i * 8, true);
        raw.samples.push({ t: time, values });
      }
    }
    offset = end;
  }
  if (minTime === Infinity) minTime = 0;
  for (const raw of out.values()) {
    raw.samples.sort((a, b) => a.t - b.t);
    for (const s of raw.samples) s.t -= minTime;
  }
  return out;
}

const pose3 = (t: number, v: Float64Array, i = 0): Pose3 => ({ t, p: [v[i], v[i + 1], v[i + 2]], q: [v[i + 4], v[i + 5], v[i + 6], v[i + 3]] });

export function track3D(buffer: ArrayBuffer): Track3D | undefined {
  const all = new Set(Object.values(KEYS).flat());
  const raw = readEntries(buffer, all);
  const pick = (keys: string[]) => keys.map((k) => raw.get(k)).find((r) => r && r.samples.length);
  const robotRaw = pick(KEYS.robot);
  if (!robotRaw) return undefined;
  const robot = robotRaw.samples.filter((s) => s.values.length >= 7).map((s) => pose3(s.t, s.values));
  if (!robot.length) return undefined;
  const components: Pose3[][] = [];
  for (const s of pick(KEYS.components)?.samples ?? [])
    for (let i = 0; i * 7 + 7 <= s.values.length; i++) (components[i] ??= []).push(pose3(s.t, s.values, i * 7));
  const points = (r?: Raw): Points[] => (r?.samples ?? []).map((s) => ({ t: s.t, xyz: Float32Array.from(s.values.subarray(0, s.values.length - (s.values.length % 3))) }));
  const fuel = points(pick(KEYS.fuel));
  const flying = points(pick(KEYS.flying));
  const estimate = (pick(KEYS.estimate)?.samples ?? []).filter((s) => s.values.length >= 3).map((s) => ({ t: s.t, x: s.values[0], y: s.values[1], heading: s.values[2] }));
  const most = (list: Points[]) => list.reduce((m, s) => Math.max(m, s.xyz.length / 3), 0);
  const last = (list: { t: number }[]) => list[list.length - 1]?.t ?? 0;
  return {
    robot,
    components,
    fuel,
    flying,
    estimate,
    maxPieces: most(fuel) + most(flying),
    duration: Math.max(last(robot), last(fuel), last(flying), ...components.map(last)),
  };
}

/** The latest sample at or before `t` (logs record a value only when it changes, so it holds until the next). */
export function sampleAt<T extends { t: number }>(list: T[], t: number): T | undefined {
  if (!list.length) return undefined;
  if (t <= list[0].t) return list[0];
  let lo = 0,
    hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
}
