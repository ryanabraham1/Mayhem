/**
 * The robot's devices (motors, encoders, gyro) and the settings that apply to each, assembled from
 * the extracted settings: a CAN ID constant names a device; a motor configuration applies to the
 * devices its name matches (`RightMotorConfigs` → the right motor; `MotorConfigs` → every motor
 * of that subsystem). Read from source: what the code says, not what the motors were sent.
 */
import { plainName, type Setting } from "./settings.ts";

export type DeviceKind = "Talon FX" | "CANcoder" | "Pigeon 2" | "CANdle";

export interface Device {
  /** `Shooter / Motor 1 (top left)`; stable across revisions while the constant keeps its name. */
  key: string;
  subsystem: string;
  name: string;
  kind: DeviceKind;
  canId?: number;
  /** Plain fields a person checks, e.g. `Brake / coast when idle` → `Brake`. */
  fields: Record<string, string>;
  /** Setting keys these fields came from (to link a device row to its source line). */
  sources: string[];
  /** The setting (and list entry) each field is written in, for editing. */
  fieldSources: Record<string, { key: string; index?: number }>;
}

/** Fields shown for a device, in order. */
export const DEVICE_FIELDS = [
  "CAN ID",
  "Positive direction",
  "Opposes leader",
  "Brake / coast when idle",
  "Stator current limit",
  "Supply current limit",
  "Gear ratio",
  "Forward travel limit",
  "Reverse travel limit",
  "Calibration offset",
] as const;

function kindOf(name: string): DeviceKind {
  if (/Encoder|CANcoder/i.test(name)) return "CANcoder";
  if (/Pigeon|Gyro|IMU/i.test(name)) return "Pigeon 2";
  if (/Candle/i.test(name)) return "CANdle";
  return "Talon FX";
}

/** The device part of a CAN ID constant: `kFrontLeftDriveMotorId` → `FrontLeftDriveMotor`. */
const deviceStem = (short: string) =>
  short.replace(/^k/, "").replace(/(ID|Id)s?(?=[A-Z]|$)/, "").replace(/^[a-z]/, (c) => c.toUpperCase());

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The device a configuration name targets: `RightMotorConfigs` → `right`, `driveInitialConfigs` → `drive`. */
const configStem = (short: string) =>
  squash(short.replace(/(Initial)?(Motor)?(Config(s|uration)?|Gains)$/i, ""));

const FIELD_OF: [RegExp, (typeof DEVICE_FIELDS)[number]][] = [
  [/MotorOutput\.Inverted$/, "Positive direction"],
  [/MotorOutput\.NeutralMode$/, "Brake / coast when idle"],
  [/CurrentLimits\.StatorCurrentLimit$/, "Stator current limit"],
  [/CurrentLimits\.SupplyCurrentLimit$/, "Supply current limit"],
  [/Feedback\.SensorToMechanismRatio$/, "Gear ratio"],
  [/ForwardSoftLimitThreshold$/, "Forward travel limit"],
  [/ReverseSoftLimitThreshold$/, "Reverse travel limit"],
];

export function readDevices(settings: Setting[]): Device[] {
  const devices: Device[] = [];
  const short = (s: Setting) => s.key.split("::").pop()!.split(".")[0];
  for (const s of settings) {
    if (s.category !== "can-id") continue;
    const stem = deviceStem(short(s));
    if (s.list) {
      s.list.forEach((id, i) => {
        const note = s.elementNotes?.[i];
        const base = plainName(stem || "Device").replace(/s$/, "");
        const name = `${base} ${i + 1}${note ? ` (${note})` : ""}`;
        devices.push({
          key: `${s.subsystem} / ${base} ${i + 1}`,
          subsystem: s.subsystem,
          name: i === 0 && /leader/i.test(s.doc ?? "") ? `${name} · leader` : name,
          kind: kindOf(stem),
          ...(Number.isFinite(Number(id)) ? { canId: Number(id) } : {}),
          fields: { "CAN ID": id },
          sources: [s.key],
          fieldSources: { "CAN ID": { key: s.key, index: i } },
        });
      });
    } else {
      const name = plainName(stem || "Device");
      devices.push({
        key: `${s.subsystem} / ${name}`,
        subsystem: s.subsystem,
        name,
        kind: kindOf(stem),
        ...(s.number !== undefined ? { canId: s.number } : {}),
        fields: { "CAN ID": s.display },
        sources: [s.key],
        fieldSources: { "CAN ID": { key: s.key } },
      });
    }
  }

  // Motor configurations: the most specific matching configuration per device wins.
  const configs = new Map<string, Setting[]>();
  for (const s of settings) if (s.config && s.category !== "simulation") configs.set(s.config, [...(configs.get(s.config) ?? []), s]);
  for (const d of devices) {
    const name = squash(d.name);
    const mine = [...configs.entries()].filter(([, rows]) => rows[0].subsystem === d.subsystem);
    const specific = mine.filter(([config]) => {
      const stem = configStem(config.split("::").pop()!);
      return stem && name.includes(stem);
    });
    const general = mine.filter(([config]) => !configStem(config.split("::").pop()!));
    const chosen = d.kind === "Talon FX" ? (specific.length ? specific : general) : specific;
    for (const [, rows] of chosen)
      for (const row of rows) {
        const field = FIELD_OF.find(([pattern]) => pattern.test(row.key))?.[1];
        if (!field) continue;
        d.fields[field] = row.display;
        d.sources.push(row.key);
        d.fieldSources[field] = { key: row.key };
      }
  }

  // Per-device constants: `kFrontLeftSteerMotorInverted`, `kFrontLeftEncoderOffset`, opposed followers.
  for (const s of settings) {
    if (s.category === "simulation" || s.category === "can-id") continue;
    const own = short(s);
    if (s.category === "inversion" && s.list) {
      // A per-motor list beside a CAN ID list of the same length (`kMotorOpposed` / `kMotorIds`).
      const group = devices.filter((d) => d.subsystem === s.subsystem && d.sources[0] && settings.find((x) => x.key === d.sources[0])?.list?.length === s.list!.length);
      group.forEach((d, i) => {
        d.fields["Opposes leader"] = s.list![i];
        d.sources.push(s.key);
        d.fieldSources["Opposes leader"] = { key: s.key, index: i };
      });
      continue;
    }
    const side = /^kInvert(Left|Right)Side$/.exec(own);
    for (const d of devices) {
      if (d.subsystem !== s.subsystem) continue;
      const stem = squash(d.name);
      if (side) {
        if (d.kind === "Talon FX" && /drive/.test(stem) && stem.includes(side[1].toLowerCase())) {
          d.fields["Positive direction"] = s.display === "On" ? "Inverted (side)" : "Normal (side)";
          d.sources.push(s.key);
          d.fieldSources["Positive direction"] = { key: s.key };
        }
        continue;
      }
      const prefix = squash(own.replace(/^k/, "").replace(/(Inverted|Invert|Offset)$/, ""));
      if (!prefix || prefix !== stem) continue;
      const field = s.category === "inversion" ? "Positive direction" : s.category === "calibration" ? "Calibration offset" : undefined;
      if (!field) continue;
      d.fields[field] = s.category === "inversion" ? (s.display === "On" ? "Inverted" : "Normal") : s.display;
      d.sources.push(s.key);
      d.fieldSources[field] = { key: s.key };
    }
  }
  // Gear ratios shared by a kind of motor (`kDriveGearRatio` → drive motors).
  for (const s of settings) {
    if (s.category !== "gear-ratio" || s.config) continue;
    const stem = squash(short(s).replace(/^k/, "").replace(/(Motor)?(Gear)?Ratio$/, ""));
    if (!stem) continue;
    for (const d of devices)
      if (d.subsystem === s.subsystem && d.kind === "Talon FX" && squash(d.name).includes(stem) && !d.fields["Gear ratio"]) {
        d.fields["Gear ratio"] = s.display;
        d.sources.push(s.key);
        d.fieldSources["Gear ratio"] = { key: s.key };
      }
  }
  return devices;
}

export interface DeviceChange {
  kind: "added" | "removed" | "changed";
  key: string;
  subsystem: string;
  name: string;
  before?: Device;
  after?: Device;
  fields: { field: string; before?: string; after?: string }[];
}

export function diffDevices(before: Device[], after: Device[]): DeviceChange[] {
  const old = new Map(before.map((d) => [d.key, d]));
  const now = new Map(after.map((d) => [d.key, d]));
  const out: DeviceChange[] = [];
  for (const [key, b] of old) {
    const a = now.get(key);
    if (!a) {
      out.push({ kind: "removed", key, subsystem: b.subsystem, name: b.name, before: b, fields: [] });
      continue;
    }
    const names = [...new Set([...Object.keys(b.fields), ...Object.keys(a.fields)])];
    const fields = names.filter((f) => b.fields[f] !== a.fields[f]).map((f) => ({ field: f, before: b.fields[f], after: a.fields[f] }));
    if (fields.length) out.push({ kind: "changed", key, subsystem: a.subsystem, name: a.name, before: b, after: a, fields });
  }
  for (const [key, a] of now) if (!old.has(key)) out.push({ kind: "added", key, subsystem: a.subsystem, name: a.name, after: a, fields: [] });
  return out;
}

/** Devices of the same kind sharing a CAN ID (a conflict if they are on the same bus). */
export function duplicateIds(devices: Device[]): { kind: DeviceKind; canId: number; devices: string[] }[] {
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    if (d.canId === undefined) continue;
    const key = `${d.kind}\u0000${d.canId}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ kind: g[0].kind, canId: g[0].canId!, devices: g.map((d) => d.key) }));
}
