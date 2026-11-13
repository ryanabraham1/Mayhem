/**
 * Robot settings (constants and motor configurations) from C++ sources, with units, plain names,
 * evaluated values and a safety category. Deterministic: values come from the code as written;
 * anything that cannot be evaluated is shown as its expression.
 */
import { readCpp, splitTop, type CppConfig, type CppConstant } from "./cpp.ts";

export type Category =
  | "can-id"
  | "inversion"
  | "current-limit"
  | "neutral-mode"
  | "soft-limit"
  | "gear-ratio"
  | "calibration"
  | "gains"
  | "motion"
  | "setpoint"
  | "lookup-table"
  | "feature-flag"
  | "timing"
  | "geometry"
  | "other"
  | "simulation";

export const CATEGORY_NAMES: Record<Category, string> = {
  "can-id": "CAN IDs",
  inversion: "Motor directions",
  "current-limit": "Current limits",
  "neutral-mode": "Brake / coast",
  "soft-limit": "Travel limits",
  "gear-ratio": "Gear ratios",
  calibration: "Calibration offsets",
  gains: "Control gains",
  motion: "Motion profiles",
  setpoint: "Speeds and positions",
  "lookup-table": "Lookup tables",
  "feature-flag": "On/off switches",
  timing: "Timing",
  geometry: "Robot geometry",
  other: "Other values",
  simulation: "Simulation only",
};

/** Safety-relevant hardware settings: a change is marked red. */
export const SAFETY_CATEGORIES: ReadonlySet<Category> = new Set([
  "can-id",
  "inversion",
  "current-limit",
  "neutral-mode",
  "soft-limit",
  "gear-ratio",
  "calibration",
]);

export interface Setting {
  /** Stable identity across revisions: the qualified C++ name (configs: `Fn.Group.Key`). */
  key: string;
  subsystem: string;
  label: string;
  category: Category;
  /** What a person reads: `80 A`, `Brake`, `44, 45, 42, 41`. */
  display: string;
  number?: number;
  unit?: string;
  list?: string[];
  table?: [number, number][];
  /** Units of a lookup table's input and output columns, from its comment. */
  tableUnits?: [string, string];
  expression: string;
  /** Names this value is computed from (for "changed because X changed"). */
  refs: string[];
  doc?: string;
  file: string;
  line: number;
  /** Per-element labels of a list (`top left`). */
  elementNotes?: string[];
  /** Device configuration this belongs to (configs only). */
  config?: string;
  /** Where the value is written, for editing: a constant, or a `.With…` call inside a configuration. */
  origin: SettingOrigin;
}

export interface SettingOrigin {
  file: string;
  line: number;
  /** Declared name (constants) or configuration function/variable name (configs). */
  name: string;
  /** Configs: the `.With…` path, e.g. `CurrentLimits.StatorCurrentLimit`. */
  path?: string;
  /** Configs inherited from another configuration (edits there change both). */
  inheritedFrom?: string;
}

const LITERAL_UNITS: Record<string, string> = {
  A: "A",
  V: "V",
  s: "s",
  ms: "ms",
  Hz: "Hz",
  tps: "rot/s",
  tr_per_s: "rot/s",
  tr_per_s_sq: "rot/s²",
  tr_per_s_cu: "rot/s³",
  rpm: "rpm",
  tr: "rot",
  rad: "rad",
  deg: "°",
  rad_per_s: "rad/s",
  deg_per_s: "°/s",
  mps: "m/s",
  mps_sq: "m/s²",
  m: "m",
  cm: "cm",
  mm: "mm",
  in: "in",
  ft: "ft",
  kg: "kg",
  lb: "lb",
  kg_sq_m: "kg·m²",
  N: "N",
  Nm: "N·m",
};
const TYPE_UNITS: Record<string, string> = {
  ampere_t: "A",
  volt_t: "V",
  second_t: "s",
  millisecond_t: "ms",
  hertz_t: "Hz",
  turns_per_second_t: "rot/s",
  turn_t: "rot",
  radian_t: "rad",
  degree_t: "°",
  radians_per_second_t: "rad/s",
  degrees_per_second_t: "°/s",
  meters_per_second_t: "m/s",
  meters_per_second_squared_t: "m/s²",
  meter_t: "m",
  inch_t: "in",
  kilogram_t: "kg",
  kilogram_square_meter_t: "kg·m²",
  scalar_t: "",
};

/** Plain words for a C++ name: `kStowPosition` → `Stow position`, `aziKP` → `Azi kP`. */
export function plainName(name: string): string {
  const words = name
    .replace(/^k(?=[A-Z])/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  const text = words
    .map((w, i) =>
      /^K[PIDSVAGpidsvag]$/.test(w)
        ? `k${w[1].toUpperCase()}`
        : /^(ID|Id)s?$/.test(w)
          ? `CAN ID${w.endsWith("s") ? "s" : ""}`
          : /^[A-Z0-9]{2,}$/.test(w)
            ? w
            : i
              ? w.toLowerCase()
              : w,
    )
    .join(" ");
  return /^k[A-Z]$/.test(words[0] ?? "") || /^K[PIDSVAG]$/i.test(words[0] ?? "") ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

const CONFIG_LABELS: Record<string, string> = {
  StatorCurrentLimit: "Stator current limit",
  StatorCurrentLimitEnable: "Stator current limit on",
  SupplyCurrentLimit: "Supply current limit",
  SupplyCurrentLimitEnable: "Supply current limit on",
  SupplyCurrentLowerLimit: "Supply current lower limit",
  SupplyCurrentLowerTime: "Supply current lower-limit delay",
  NeutralMode: "Brake / coast when idle",
  Inverted: "Positive direction",
  SensorToMechanismRatio: "Gear ratio (motor : mechanism)",
  RotorToSensorRatio: "Gear ratio (rotor : sensor)",
  ForwardSoftLimitThreshold: "Forward travel limit",
  ReverseSoftLimitThreshold: "Reverse travel limit",
  ForwardSoftLimitEnable: "Forward travel limit on",
  ReverseSoftLimitEnable: "Reverse travel limit on",
  MotionMagicCruiseVelocity: "Profile cruise speed",
  MotionMagicAcceleration: "Profile acceleration",
  MotionMagicJerk: "Profile jerk",
  GravityType: "Gravity compensation",
  MotionMagicExpo_kV: "Profile expo kV",
  MotionMagicExpo_kA: "Profile expo kA",
};

function configLabel(path: string) {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  const slot = parts.find((p) => /^Slot\d$/.test(p));
  const base = CONFIG_LABELS[leaf] ?? plainName(leaf);
  return slot && slot !== "Slot0" ? `${base} (slot ${slot.slice(4)})` : base;
}

function configCategory(path: string): Category {
  if (/CurrentLimit|CurrentLower|SlipCurrent/.test(path)) return "current-limit";
  if (/NeutralMode/.test(path)) return "neutral-mode";
  if (/Inverted/.test(path)) return "inversion";
  if (/SoftLimit|SoftwareLimitSwitch|HardwareLimitSwitch/.test(path)) return "soft-limit";
  if (/Ratio/.test(path)) return "gear-ratio";
  if (/Offset/.test(path)) return "calibration";
  if (/(^|\.)Slot\d|Gains|(^|\.)K[PIDSVAG]$|GravityType|StaticFeedforward/.test(path)) return "gains";
  if (/MotionMagic/.test(path)) return "motion";
  return "other";
}

function constantCategory(c: CppConstant, unit?: string): Category {
  const n = c.short;
  const t = c.type;
  const integer = /\bint\b|uint|int(8|16|32|64)_t/.test(t);
  if (/Map|LUT|Interpolating/i.test(t) || /LUT$/.test(n)) return "lookup-table";
  if (/^field/.test(c.scope[0] ?? "")) return "geometry";
  if (
    integer &&
    /(ID|Id)s?(?=[A-Z]|$)|Motor(Left|Right|Top|Bottom|Front|Back|\d)?$|Encoder$|Pigeon$|CANcoder$|CANdle$/.test(n) &&
    !/Port$|Index$|Slot$|Num|Count|Retries/.test(n)
  )
    return "can-id";
  if (/\bbool\b/.test(t) && /Invert|Opposed|Reversed/.test(n)) return "inversion";
  if (unit === "A" || /Current/.test(n)) return "current-limit";
  if (/SoftLimit|ForwardLimit|ReverseLimit/.test(n)) return "soft-limit";
  if (/Gear|Ratio|Gearing/.test(n)) return "gear-ratio";
  if (/EncoderOffset|Offset$/.test(n)) return "calibration";
  if (/K[PIDSVAG]$|^k[PIDSVAG]$|(^|[a-z])K[pid]$/.test(n)) return "gains";
  if (/\bbool\b/.test(t) && /^kUse|Enabled$|^kEnable|^kSimulate/.test(n)) return "feature-flag";
  if (/(X|Y)Pos$|Radius|Width|Length|Height|Mass|MOI|Inertia/.test(n) && !/Position$/.test(n)) return "geometry";
  if (/Position|Angle|Speed|Velocity|Rate|Voltage|Setpoint|Target|Multiplier/.test(n)) return "setpoint";
  if (unit === "s" || unit === "ms" || unit === "Hz" || /Timeout|Time$|Delay|Frequency|Period|Seconds$/.test(n)) return "timing";
  return "other";
}

/** Subsystem name from a robot source path and C++ scope. */
export function subsystemOf(file: string, scope: string[]): string {
  const top = scope[0] ?? "";
  if (/TunerConstants|swerve/i.test(top) || /\/swerve\//.test(file)) return "Drivetrain";
  if (top === "constants") return "Robot";
  if (/^field/.test(top)) return "Field";
  const dir = /\/subsystems\/([^/]+)\//.exec(file)?.[1];
  if (top && top !== "(anonymous)") return plainName(top.replace(/_constants$/, ""));
  return dir ? plainName(dir) : plainName(file.split("/").pop()!.replace(/\.(h|hpp|cpp)$/, ""));
}

const simulationOnly = (c: { scope: string[]; file: string; short?: string }) =>
  c.scope.includes("sim") ||
  /^k?Sim[A-Z]/.test(c.short ?? "") || /\/sim\//.test(c.file) || /SimConstants|Sim\.(h|cpp)$/.test(c.file);

const MATH: Record<string, number> = {
  "std::numbers::pi": Math.PI,
  "std::numbers::e": Math.E,
  "std::numbers::sqrt2": Math.SQRT2,
  "std::numbers::inv_pi": 1 / Math.PI,
  M_PI: Math.PI,
};

interface Value {
  v: number;
  unit?: string;
}

/** Evaluates `+ - * /`, parentheses, numbers with unit literals and references. */
function evaluate(expression: string, lookup: (name: string) => Value | undefined): Value | undefined {
  const text = expression
    .replace(/\.value\(\)/g, "")
    // WPILib-style helpers that return meters/radians as plain numbers.
    .replace(/\bInches\s*\(/g, "0.0254*(")
    .replace(/\bFeet\s*\(/g, "0.3048*(")
    .replace(/\bDegrees\s*\(/g, "0.017453292519943295*(")
    .replace(/\b(units::)?\w+_t\s*[{(]/g, "(") // units::degree_t{45} → (45)
    .replace(/\bstatic_cast<[^>]+>\s*\(/g, "(");
  const tokens = text.match(/\d*\.?\d+(?:[eE][+-]?\d+)?(?:_\w+)?|[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*|[-+*/(){}]|\S/g);
  if (!tokens) return undefined;
  let k = 0;
  const peek = () => tokens[k];
  const fail = Symbol();
  const primary = (): Value => {
    const t = tokens[k++];
    if (t === undefined) throw fail;
    if (t === "(" || t === "{") {
      const v = sum();
      if (tokens[k++] !== (t === "(" ? ")" : "}")) throw fail;
      return v;
    }
    if (t === "-") {
      const v = primary();
      return { ...v, v: -v.v };
    }
    if (t === "+") return primary();
    const number = /^(\d*\.?\d+(?:[eE][+-]?\d+)?)(?:_(\w+))?$/.exec(t);
    if (number) return { v: Number(number[1]), ...(number[2] ? { unit: LITERAL_UNITS[number[2]] ?? number[2] } : {}) };
    if (t === "true" || t === "false") return { v: t === "true" ? 1 : 0 };
    if (t in MATH) return { v: MATH[t] };
    if (/^[A-Za-z_]/.test(t)) {
      const v = lookup(t);
      if (!v) throw fail;
      return v;
    }
    throw fail;
  };
  const product = (): Value => {
    let left = primary();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[k++];
      const right = primary();
      const unit = left.unit && right.unit ? undefined : op === "/" && right.unit ? undefined : left.unit ?? right.unit;
      left = { v: op === "*" ? left.v * right.v : left.v / right.v, ...(unit ? { unit } : {}) };
    }
    return left;
  };
  const sum = (): Value => {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[k++];
      const right = product();
      const unit = left.unit === right.unit ? left.unit : left.unit ?? right.unit;
      left = { v: op === "+" ? left.v + right.v : left.v - right.v, ...(unit ? { unit } : {}) };
    }
    return left;
  };
  try {
    const v = sum();
    return k === tokens.length && Number.isFinite(v.v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `[rot/s]`, `(m/s)` or `in INCHES` in a doc comment. */
function docUnits(doc?: string): string[] {
  if (!doc) return [];
  return [...doc.matchAll(/\[([^\]]{1,24})\]/g)].map((m) => m[1].trim()).filter((u) => /^[A-Za-z°][\w/^²³ ·.-]*$/.test(u));
}

/** A unit spelled in the name: `kAimToleranceRad`, `kDeployWarnSeconds`. */
function nameUnit(name: string): string | undefined {
  const m = /(Seconds|Secs|Ms|Meters|Degrees|Deg|Rad|Volts|Mps|Rps|Rpm|Amps|Inches)$/.exec(name);
  if (!m) return undefined;
  return ({ Seconds: "s", Secs: "s", Ms: "ms", Meters: "m", Degrees: "°", Deg: "°", Rad: "rad", Volts: "V", Mps: "m/s", Rps: "rot/s", Rpm: "rpm", Amps: "A", Inches: "in" } as Record<string, string>)[m[1]];
}

const fmt = (v: number) => {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  return String(Number(v.toPrecision(abs >= 1000 ? 6 : 4)));
};
export const formatValue = (v: number, unit?: string) =>
  `${fmt(v)}${unit ? (unit === "°" ? "°" : ` ${unit}`) : ""}`;

const ENUM_WORDS: Record<string, string> = {
  Clockwise_Positive: "Clockwise",
  CounterClockwise_Positive: "Counter-clockwise",
};
function enumText(value: string) {
  const leaf = value.split("::").pop()!;
  return ENUM_WORDS[leaf] ?? leaf.replace(/_/g, " ");
}

/** Names an expression refers to (identifiers that are not literals, keywords or std). */
function references(expression: string): string[] {
  const names = expression.match(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g) ?? [];
  return [...new Set(names.filter((n) => !/^(std|units|true|false|ctre|frc|static_cast|value)\b/.test(n) && !/_t$/.test(n)))];
}

export interface SourceFile {
  path: string;
  text: string;
}

/** Which robot source files hold settings. */
export const isSettingsSource = (path: string) =>
  /^src\/main\/(include|cpp)\/.+\.(h|hpp)$/.test(path) && !/\/mayhem\//.test(path) && !/MayhemProject\.h$/.test(path);

export function readSettings(files: SourceFile[]): Setting[] {
  const parsed = files.filter((f) => isSettingsSource(f.path)).map((f) => ({ file: f.path, ...readCpp(f.path, f.text) }));
  const constants = parsed.flatMap((p) => p.constants);
  const configs = parsed.flatMap((p) => p.configs);
  const byName = new Map<string, CppConstant>();
  for (const c of constants) if (!byName.has(c.name)) byName.set(c.name, c);
  // Resolve a reference the way C++ would from a scope: innermost scope first, then outward.
  const resolve = (name: string, scope: string[]): CppConstant | undefined => {
    for (let depth = scope.length; depth >= 0; depth--) {
      const hit = byName.get([...scope.slice(0, depth), name].join("::"));
      if (hit) return hit;
    }
    // A qualified name written relative to an outer namespace (`field_constants::x` from inside `a::b`).
    const tail = `::${name}`;
    return constants.find((c) => c.name.endsWith(tail));
  };
  const cache = new Map<string, Value | undefined>();
  const visiting = new Set<string>();
  const valueOf = (c: CppConstant): Value | undefined => {
    if (cache.has(c.name)) return cache.get(c.name);
    if (visiting.has(c.name)) return undefined;
    visiting.add(c.name);
    const v = evaluate(c.expression.replace(/^\{(.*)\}$/, "$1"), (ref) => {
      const hit = resolve(ref, c.scope);
      return hit ? valueOf(hit) : undefined;
    });
    visiting.delete(c.name);
    const typeUnit = TYPE_UNITS[c.type.split("::").pop() ?? ""];
    const result = v && { v: v.v, unit: v.unit ?? (typeUnit || undefined) };
    cache.set(c.name, result);
    return result;
  };

  const out: Setting[] = [];
  for (const c of constants) {
    // Only values a person tunes: numbers, switches, units, lists and tables (not log keys or objects).
    if (/char|string|std::string_view|Pose|Rotation|Translation|Transform|optional|CANBus|Configuration|Constants\b|\bauto\b/.test(c.type)) continue;
    const scalar = /^(double|float|int|bool|unsigned|long|size_t|u?int\d+_t)$|units::/.test(c.type) || c.type in TYPE_UNITS;
    const isList = /std::array|\[\]/.test(c.type) || /^\{[^{}]*\}$/.test(c.expression) && !scalar;
    const isTable = /Map|LUT|Interpolating/i.test(c.type);
    const isEnum = /^ctre::|signals::/.test(c.expression) && /::\w+$/.test(c.expression) && !scalar;
    if (!scalar && !isList && !isTable && !isEnum) continue;
    const refs = references(c.expression).filter((r) => resolve(r, c.scope));
    const base = {
      key: c.name,
      subsystem: subsystemOf(c.file, c.scope),
      label: plainName(c.short),
      expression: c.expression,
      refs: refs.map((r) => resolve(r, c.scope)!.name),
      ...(c.doc ? { doc: c.doc } : {}),
      file: c.file,
      line: c.line,
      ...(c.elementNotes ? { elementNotes: c.elementNotes } : {}),
      origin: { file: c.file, line: c.line, name: c.short },
    };
    const sim = simulationOnly(c);
    if (isTable) {
      const pairs = [...c.expression.matchAll(/\{\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\}/g)].map(
        (m) => [Number(m[1]), Number(m[2])] as [number, number],
      );
      const units = docUnits(c.doc);
      out.push({
        ...base,
        category: sim ? "simulation" : "lookup-table",
        display: `${pairs.length} points`,
        table: pairs,
        ...(units.length >= 2 ? { tableUnits: [units[1], units[0]] as [string, string] } : {}),
      });
      continue;
    }
    if (isList) {
      const items = splitTop(c.expression.replace(/^\{\s*|\s*\}$/g, "")).filter(Boolean);
      if (items.some((item) => item.startsWith('"'))) continue; // log keys and names
      const bools = items.every((item) => item === "true" || item === "false");
      const values = items.map((item) => {
        const v = evaluate(item, (ref) => {
          const hit = resolve(ref, c.scope);
          return hit ? valueOf(hit) : undefined;
        });
        if (bools) return item === "true" ? "Yes" : "No";
        return v ? formatValue(v.v, v.unit) : item;
      });
      const category = sim ? "simulation" : constantCategory({ ...c, type: c.type.replace(/std::array<(\w+).*/, "$1") });
      out.push({ ...base, category, display: values.join(", "), list: values });
      continue;
    }
    if (isEnum) {
      out.push({ ...base, category: sim ? "simulation" : "other", display: enumText(c.expression) });
      continue;
    }
    const v = valueOf(c);
    const unit = v?.unit ?? (/\bbool\b/.test(c.type) ? undefined : docUnits(c.doc)[0] ?? nameUnit(c.short));
    const display = /\bbool\b/.test(c.type)
      ? c.expression === "true"
        ? "On"
        : c.expression === "false"
          ? "Off"
          : v
            ? v.v
              ? "On"
              : "Off"
            : c.expression
      : v
        ? formatValue(v.v, unit)
        : c.expression;
    out.push({
      ...base,
      category: sim ? "simulation" : constantCategory(c, unit),
      display,
      ...(v ? { number: v.v } : {}),
      ...(unit ? { unit } : {}),
    });
  }

  // Motor configurations: flatten inheritance (`auto c = RightMotorConfigs();`), then one setting each.
  const configByName = new Map(configs.map((c) => [c.name, c]));
  /** Each setting with the configuration that writes it (a base's value unless overridden). */
  const flat = (c: CppConfig, seen = new Set<string>()): Record<string, { value: string; from: CppConfig }> => {
    const base = c.base && !seen.has(c.base) ? configByName.get(c.base) ?? configs.find((o) => o.short === c.base!.split("::").pop() && o.scope.join("::") === c.scope.join("::")) : undefined;
    const own = Object.fromEntries(Object.entries(c.settings).map(([k, value]) => [k, { value, from: c }]));
    return { ...(base ? flat(base, new Set([...seen, c.name])) : {}), ...own };
  };
  for (const c of configs) {
    const sim = simulationOnly(c);
    for (const [path, { value, from }] of Object.entries(flat(c))) {
      // Bare references (`WithSlipCurrent(kSlipCurrent)`) repeat a constant listed already.
      if (/^[A-Za-z_][\w.]*(\(\))?$/.test(value) && !value.includes("::")) continue;
      const v = evaluate(value.replace(/\s*\/\s*1_\w+$/, ""), () => undefined);
      const display = /^(true|false)$/.test(value)
        ? value === "true"
          ? "On"
          : "Off"
        : /::/.test(value)
          ? enumText(value)
          : v
            ? formatValue(v.v, v.unit)
            : value;
      out.push({
        key: `${c.name}.${path}`,
        subsystem: subsystemOf(c.file, c.scope),
        label: configLabel(path),
        category: sim ? "simulation" : configCategory(path),
        display,
        ...(v ? { number: v.v } : {}),
        ...(v?.unit ? { unit: v.unit } : {}),
        expression: value,
        refs: [],
        file: c.file,
        line: c.line,
        config: c.name,
        origin: { file: from.file, line: from.line, name: from.short, path, ...(from !== c ? { inheritedFrom: from.name } : {}) },
      });
    }
  }
  return out;
}

export type ChangeKind = "added" | "removed" | "changed";

export interface SettingChange {
  kind: ChangeKind;
  key: string;
  subsystem: string;
  label: string;
  category: Category;
  before?: Setting;
  after?: Setting;
  /** Only the computed value changed, because these inputs changed. */
  because?: string[];
  /** Lookup tables: the rows that differ. */
  rows?: { input: number; before?: number; after?: number }[];
}

const same = (a: Setting, b: Setting) =>
  a.display === b.display &&
  JSON.stringify(a.table ?? null) === JSON.stringify(b.table ?? null);

export function diffSettings(before: Setting[], after: Setting[]): SettingChange[] {
  const old = new Map(before.map((s) => [s.key, s]));
  const now = new Map(after.map((s) => [s.key, s]));
  const changes: SettingChange[] = [];
  for (const [key, b] of old) {
    const a = now.get(key);
    if (!a) {
      changes.push({ kind: "removed", key, subsystem: b.subsystem, label: b.label, category: b.category, before: b });
      continue;
    }
    if (same(a, b)) continue;
    const change: SettingChange = { kind: "changed", key, subsystem: a.subsystem, label: a.label, category: worst(a.category, b.category), before: b, after: a };
    if (a.expression === b.expression) change.because = a.refs.filter((r) => {
      const x = old.get(r),
        y = now.get(r);
      return !x || !y || !same(x, y);
    });
    if (a.table || b.table) {
      const inputs = [...new Set([...(b.table ?? []), ...(a.table ?? [])].map(([x]) => x))].sort((p, q) => p - q);
      change.rows = inputs
        .map((input) => ({ input, before: b.table?.find(([x]) => x === input)?.[1], after: a.table?.find(([x]) => x === input)?.[1] }))
        .filter((r) => r.before !== r.after);
    }
    changes.push(change);
  }
  for (const [key, a] of now)
    if (!old.has(key)) changes.push({ kind: "added", key, subsystem: a.subsystem, label: a.label, category: a.category, after: a });
  // A value that only moved (another file or namespace) with the same name and value is no change.
  const moved = (c: SettingChange) => `${c.subsystem}\u0000${c.label}\u0000${(c.after ?? c.before)!.display}`;
  const added = new Map(changes.filter((c) => c.kind === "added").map((c) => [moved(c), c]));
  const drop = new Set<SettingChange>();
  for (const c of changes)
    if (c.kind === "removed") {
      const twin = added.get(moved(c));
      if (twin && !drop.has(twin)) drop.add(c).add(twin);
    }
  return changes.filter((c) => !drop.has(c));
}

/** The more safety-relevant of two categories (a value moving into a safety category counts). */
function worst(a: Category, b: Category): Category {
  if (SAFETY_CATEGORIES.has(a)) return a;
  if (SAFETY_CATEGORIES.has(b)) return b;
  return a;
}
