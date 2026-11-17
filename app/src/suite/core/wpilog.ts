import type { Channel, Recording, Sample } from "./analysis.ts";
/** WPILOG 1.0 reader. Decodes scalars, numeric/string arrays and structs (and struct arrays) into derived channels.
 * Spec: allwpilib v2026.2.2/wpiutil/doc/datalog.adoc; struct layouts: wpiutil/doc/struct.adoc.
 *
 * Two passes. The first reads only record headers and the `/.schema/struct:*` entries, so it knows every
 * struct layout and how many samples each signal would produce. When that total is above `maxSamples`,
 * high-rate numeric signals are thinned so the rest fits: plain numbers and numeric arrays keep the lowest
 * and highest value of each run of records (peaks and dips survive), structs keep one record per run so
 * their fields stay aligned. States, text and booleans are never thinned. Thinned channels carry
 * `sourceSamples` and the recording gets a warning naming them. */
export interface ParseOptions {
  /** Most samples kept in memory (about 80 bytes each). */
  maxSamples?: number;
}
export const DEFAULT_MAX_SAMPLES = 2_000_000;

type Value = Sample["value"];
/** One decoded value inside a struct: its path below the struct and how to read it. */
interface Leaf {
  path: string;
  read: (view: DataView, bytes: Uint8Array, base: number) => Value | undefined;
}
interface Layout {
  size: number;
  leaves: Leaf[];
}

const DECODER = new TextDecoder();
const SCALAR_SIZES: Record<string, number> = { boolean: 1, double: 8, float: 4, int64: 8 };
const ARRAY_WIDTHS: Record<string, number> = { "double[]": 8, "float[]": 4, "int64[]": 8, "boolean[]": 1 };
/** Common WPILib types keep their established channel names (`/x`, `/y`, `/heading`, ...): analysis, the field
 * view and replay read those. Each is a flat run of doubles. */
const KNOWN_STRUCTS: Record<string, string[]> = {
  Pose2d: ["x", "y", "heading"],
  Translation2d: ["x", "y"],
  Rotation2d: ["heading"],
  ChassisSpeeds: ["vx", "vy", "omega"],
  Transform2d: ["x", "y", "heading"],
  SwerveModuleState: ["speed", "angle"],
  SwerveModulePosition: ["distance", "angle"],
  Translation3d: ["x", "y", "z"],
  Pose3d: ["x", "y", "z", "qw", "qx", "qy", "qz"],
  Transform3d: ["x", "y", "z", "qw", "qx", "qy", "qz"],
};
const MAX_ARRAY_ELEMENTS = 512;
const MAX_STRUCT_ELEMENTS = 32;

const PRIMITIVES: Record<string, { size: number; kind: "bool" | "char" | "int" | "uint" | "float" }> = {
  bool: { size: 1, kind: "bool" },
  char: { size: 1, kind: "char" },
  int8: { size: 1, kind: "int" },
  int16: { size: 2, kind: "int" },
  int32: { size: 4, kind: "int" },
  int64: { size: 8, kind: "int" },
  uint8: { size: 1, kind: "uint" },
  uint16: { size: 2, kind: "uint" },
  uint32: { size: 4, kind: "uint" },
  uint64: { size: 8, kind: "uint" },
  float: { size: 4, kind: "float" },
  float32: { size: 4, kind: "float" },
  double: { size: 8, kind: "float" },
  float64: { size: 8, kind: "float" },
};

function readInteger(view: DataView, at: number, size: number, signed: boolean): number | undefined {
  switch (size) {
    case 1:
      return signed ? view.getInt8(at) : view.getUint8(at);
    case 2:
      return signed ? view.getInt16(at, true) : view.getUint16(at, true);
    case 4:
      return signed ? view.getInt32(at, true) : view.getUint32(at, true);
    default: {
      const n = Number(signed ? view.getBigInt64(at, true) : view.getBigUint64(at, true));
      return Number.isSafeInteger(n) ? n : undefined;
    }
  }
}

/** Compiles `struct:` schemas (`double x;Rotation2d rotation;enum {a=1} int8 mode;uint8 flag:1`) into flat leaves. */
function structLayouts(schemas: Map<string, string>, warn: (message: string) => void) {
  const compiled = new Map<string, Layout | null>();
  const compile = (name: string, depth = 0): Layout | null => {
    if (compiled.has(name)) return compiled.get(name)!;
    const schema = schemas.get(name);
    if (schema === undefined || depth > 16) return null;
    compiled.set(name, null); // cycle guard
    const leaves: Leaf[] = [];
    let offset = 0;
    // Consecutive bit-fields share one storage unit of their declared size.
    let unit: { at: number; size: number; used: number } | undefined;
    for (const raw of schema.split(";")) {
      const declaration = raw.trim();
      if (!declaration) continue;
      const m = /^(?:enum\s*\{([^}]*)\}\s*)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*(?::\s*(\d+))?$/.exec(declaration);
      if (!m) {
        warn(`struct:${name}: could not read the field "${declaration}"; its channels are listed without samples.`);
        compiled.set(name, null);
        return null;
      }
      const [, enumText, type, field, countText, bitsText] = m;
      const names = new Map<number, string>();
      for (const pair of (enumText ?? "").split(",")) {
        const e = /^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*$/.exec(pair);
        if (e) names.set(Number(e[2]), e[1]);
      }
      const label = (n: number | undefined) => (n === undefined ? undefined : names.size ? (names.get(n) ?? String(n)) : n);
      const primitive = PRIMITIVES[type];
      if (bitsText !== undefined && primitive && (primitive.kind === "int" || primitive.kind === "uint" || primitive.kind === "bool")) {
        const bits = Number(bitsText);
        const size = primitive.kind === "bool" ? (unit?.size ?? 1) : primitive.size;
        if (!unit || unit.size !== size || unit.used + bits > size * 8) {
          unit = { at: offset, size, used: 0 };
          offset += size;
        }
        const { at } = unit,
          shift = unit.used,
          signed = primitive.kind === "int";
        unit.used += bits;
        leaves.push({
          path: field,
          read: (view, _bytes, base) => {
            const word = size === 8 ? view.getBigUint64(base + at, true) : BigInt(readInteger(view, base + at, size, false)!);
            // BigInt(...) rather than 1n literals: the team site compiles for ES2017.
            const one = BigInt(1);
            let value = (word >> BigInt(shift)) & ((one << BigInt(bits)) - one);
            if (signed && bits > 1 && value >> BigInt(bits - 1)) value -= one << BigInt(bits);
            if (primitive.kind === "bool") return value !== BigInt(0);
            const n = Number(value);
            return label(Number.isSafeInteger(n) ? n : undefined);
          },
        });
        continue;
      }
      unit = undefined;
      const count = countText === undefined ? undefined : Number(countText);
      if (primitive?.kind === "char") {
        const at = offset,
          length = count ?? 1;
        leaves.push({
          path: field,
          read: (_view, bytes, base) => {
            const text = bytes.subarray(base + at, base + at + length);
            const end = text.indexOf(0);
            return DECODER.decode(end < 0 ? text : text.subarray(0, end));
          },
        });
        offset += length;
        continue;
      }
      const nested = primitive ? undefined : compile(type, depth + 1);
      if (!primitive && !nested) {
        if (!schemas.has(type)) warn(`struct:${name}: no schema for its struct:${type} field; its channels are listed without samples.`);
        compiled.set(name, null);
        return null;
      }
      const size = primitive ? primitive.size : nested!.size;
      for (let i = 0; i < (count ?? 1); i++) {
        const at = offset + i * size,
          path = count === undefined ? field : `${field}/${i}`;
        if (nested)
          for (const leaf of nested.leaves)
            leaves.push({ path: `${path}/${leaf.path}`, read: (view, bytes, base) => leaf.read(view, bytes, base + at) });
        else if (primitive!.kind === "bool") leaves.push({ path, read: (_view, bytes, base) => bytes[base + at] !== 0 });
        else if (primitive!.kind === "float")
          leaves.push({
            path,
            read: (view, _bytes, base) => (size === 8 ? view.getFloat64(base + at, true) : view.getFloat32(base + at, true)),
          });
        else {
          const signed = primitive!.kind === "int";
          leaves.push({ path, read: (view, _bytes, base) => label(readInteger(view, base + at, size, signed)) });
        }
      }
      offset += size * (count ?? 1);
    }
    const layout = { size: offset, leaves };
    compiled.set(name, layout);
    return layout;
  };
  return (type: string): Layout | null => {
    const known = KNOWN_STRUCTS[type];
    const schemaLayout = compile(type);
    // The known names apply when the logged layout is the usual run of doubles (or no schema was logged).
    if (known && (!schemaLayout || schemaLayout.size === known.length * 8))
      return {
        size: known.length * 8,
        leaves: known.map((path, i) => ({ path, read: (view, _bytes, base) => view.getFloat64(base + i * 8, true) })),
      };
    return schemaLayout;
  };
}

interface Stats {
  name: string;
  type: string;
  records: number;
  bytes: number;
  /** Samples numeric arrays would add (elements per record, after the per-record limit). */
  elements: number;
  /** Records left after collapsing runs of identical records to their first and last. */
  kept: number;
  run: number;
  last?: [number, number];
}
function samePayload(bytes: Uint8Array, a: [number, number] | undefined, offset: number, end: number) {
  if (!a || a[1] - a[0] !== end - offset) return false;
  for (let i = 0; i < end - offset; i++) if (bytes[a[0] + i] !== bytes[offset + i]) return false;
  return true;
}
/** How a signal is kept: everything, low and high of every `every` records, or one record in `every`. */
type Plan = { mode: "all" } | { mode: "range" | "stride"; every: number };
interface EntryState {
  channel: Channel;
  plan: Plan;
  /** Records seen so far (all of them, kept or not). */
  seen: number;
  /** Records decoded so far: what thinning counts. */
  decoded: number;
  /** When collapsing repeats: the payload of the last decoded record, and the latest repeat of it. */
  last?: [number, number];
  pending?: { size: number; time: number; offset: number; end: number };
  /** For struct types: the compiled layout, or null when the log has no usable schema. */
  struct?: Layout | null;
  /** Channels derived from this entry (array elements, struct fields). */
  parts: Set<Channel>;
}
/** Types whose samples are kept whole: states, text and flags. */
const UNTHINNED = new Set(["boolean", "string", "json", "string[]"]);
/** Signals log analysis reads by name (battery voltage, total current, loop timing; see detectMapping and the
 * loop check in analysis.ts) stay whole while they fit in half the budget: their timing and alignment feed
 * the brownout, battery-resistance and loop-overrun findings. */
const ANALYZED =
  /(?:batteryvoltage|inputvoltage|(?:powerdistribution|pdh|pdp)\/voltage|totalcurrent(?:amps)?|(?:pdh|pdp)\/current|LoopTimeMs|LoopDurationMs|LoopTimeMilliseconds|LoopPeriodMs)$/i;

function readRecords(
  bytes: Uint8Array,
  view: DataView,
  visit: (id: number, size: number, time: number, offset: number, end: number) => void,
) {
  if (bytes.length < 12 || DECODER.decode(bytes.subarray(0, 6)) !== "WPILOG")
    throw new Error("This file is not a WPILOG recording.");
  const version = view.getUint16(6, true);
  if (version !== 0x0100) throw new Error(`Unsupported WPILOG version 0x${version.toString(16)}. Expected version 1.0.`);
  let offset = 12 + view.getUint32(8, true);
  if (offset > bytes.length) throw new Error("Truncated WPILOG header.");
  const uint = (length: number) => {
    if (offset + length > bytes.length) throw new Error("Truncated record header.");
    let result = 0;
    for (let i = 0; i < length; i++) result += bytes[offset++] * 2 ** (8 * i);
    if (!Number.isSafeInteger(result)) throw new Error("Timestamp exceeds supported integer precision.");
    return result;
  };
  while (offset < bytes.length) {
    const flags = bytes[offset++];
    if (flags & 0x80) throw new Error("Invalid WPILOG record header.");
    const id = uint((flags & 3) + 1),
      size = uint(((flags >> 2) & 3) + 1),
      time = uint(((flags >> 4) & 7) + 1) / 1e6;
    const end = offset + size;
    if (end > bytes.length)
      throw new Error("Recording ends in an incomplete record. Wait for the robot to finish writing, then download again.");
    visit(id, size, time, offset, end);
    offset = end;
  }
}

/** A start control record: entry id, name and type. */
function readStart(view: DataView, bytes: Uint8Array, offset: number, end: number) {
  if (offset + 5 > end) throw new Error("Invalid start record.");
  const entry = view.getUint32(offset + 1, true);
  let at = offset + 5;
  const string = () => {
    if (at + 4 > end) throw new Error("Invalid entry string.");
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > end) throw new Error("Truncated entry string.");
    const text = DECODER.decode(bytes.subarray(at, at + length));
    at += length;
    return text;
  };
  const name = string(),
    type = string();
  string();
  return { entry, name, type };
}

export function parseWPILog(buffer: ArrayBuffer, name: string, options: ParseOptions = {}): Recording {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  const budget = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const warnings = new Set<string>();
  const warn = (message: string) => void warnings.add(message);
  const key = (entryName: string, type: string) => `${entryName}\u0000${type}`;

  // Pass 1: entries, schemas and how much each signal holds.
  const stats = new Map<string, Stats>(),
    schemas = new Map<string, string>();
  {
    const active = new Map<number, Stats>();
    readRecords(bytes, view, (id, size, _time, offset, end) => {
      if (id === 0) {
        if (!size) return;
        const control = bytes[offset];
        if (control === 0) {
          const start = readStart(view, bytes, offset, end);
          const k = key(start.name, start.type);
          let s = stats.get(k);
          if (!s) stats.set(k, (s = { name: start.name, type: start.type, records: 0, bytes: 0, elements: 0, kept: 0, run: 0 }));
          active.set(start.entry, s);
        } else if (control === 1) {
          if (offset + 5 > end) throw new Error("Invalid finish record.");
          active.delete(view.getUint32(offset + 1, true));
        }
        return;
      }
      const s = active.get(id);
      if (!s) return;
      s.records++;
      s.bytes += size;
      if (samePayload(bytes, s.last, offset, end)) s.run++;
      else {
        s.kept += Math.min(s.run, 2);
        s.run = 1;
        s.last = [offset, end];
      }
      const width = ARRAY_WIDTHS[s.type];
      if (width && size % width === 0 && size / width <= MAX_ARRAY_ELEMENTS) s.elements += size / width;
      if (s.type === "structschema" && s.name.startsWith("/.schema/struct:"))
        schemas.set(s.name.slice("/.schema/struct:".length), DECODER.decode(bytes.subarray(offset, end)));
    });
  }
  for (const s of stats.values()) s.kept += Math.min(s.run, 2);
  const layoutOf = structLayouts(schemas, warn);

  // The thinning plan. Over the budget, runs of identical records first collapse to their first and last record
  // (nothing is lost: the value at any time and every graph stay the same); only then are signals thinned.
  const plans = new Map<string, Plan>();
  let collapse = false;
  {
    const costOf = (s: Stats) => {
      const base = s.type.endsWith("[]") ? s.type.slice(0, -2) : s.type;
      const layout = base.startsWith("struct:") ? layoutOf(base.slice(7)) : undefined;
      if (ARRAY_WIDTHS[s.type]) return s.elements;
      if (layout) return layout.size > 0 ? Math.ceil(s.type.endsWith("[]") ? Math.min(s.bytes / layout.size, s.records * MAX_STRUCT_ELEMENTS) : s.records) * layout.leaves.length : 0;
      return SCALAR_SIZES[s.type] || UNTHINNED.has(s.type) ? s.records : 0;
    };
    let total = 0;
    for (const s of stats.values()) total += costOf(s);
    collapse = total > budget;
  }
  if (collapse) {
    // Costs after collapsing repeats.
    const keptCost = (s: Stats, cost: number) => (s.records ? (cost * s.kept) / s.records : 0);
    const costs: { key: string; cost: number; mode: "range" | "stride"; records: number }[] = [];
    let fixed = 0;
    for (const s of stats.values()) if (UNTHINNED.has(s.type)) fixed += s.kept;
    let analyzed = 0;
    for (const s of stats.values()) if (SCALAR_SIZES[s.type] && s.type !== "boolean" && ANALYZED.test(s.name)) analyzed += s.kept;
    const keepAnalyzed = fixed + analyzed <= budget / 2;
    if (keepAnalyzed) fixed += analyzed;
    for (const [k, s] of stats) {
      const base = s.type.endsWith("[]") ? s.type.slice(0, -2) : s.type;
      const layout = base.startsWith("struct:") ? layoutOf(base.slice(7)) : undefined;
      if (SCALAR_SIZES[s.type] && s.type !== "boolean") {
        if (!(keepAnalyzed && ANALYZED.test(s.name))) costs.push({ key: k, cost: s.kept, mode: "range", records: s.kept });
      }
      else if (ARRAY_WIDTHS[s.type])
        costs.push({ key: k, cost: keptCost(s, s.elements), mode: s.type === "boolean[]" ? "stride" : "range", records: s.kept });
      else if (layout && layout.size > 0) {
        const elements = s.type.endsWith("[]") ? Math.min(s.bytes / layout.size, s.records * MAX_STRUCT_ELEMENTS) : s.records;
        costs.push({ key: k, cost: keptCost(s, Math.ceil(elements) * layout.leaves.length), mode: "stride", records: s.kept });
      }
    }
    if (fixed > budget)
      throw new Error(
        `This recording has more than ${budget.toLocaleString("en-US")} state, text and flag samples, which are never thinned. No partial analysis was produced.`,
      );
    let left = budget - fixed;
    costs.sort((a, b) => a.cost - b.cost);
    const thinned: { name: string; keeps: number }[] = [];
    costs.forEach((c, i) => {
      const share = left / (costs.length - i);
      if (c.cost <= share) {
        left -= c.cost;
        return;
      }
      // A low/high pair per run keeps two samples, so its runs are twice as long.
      const every = Math.max(c.mode === "range" ? 3 : 2, Math.ceil(((c.mode === "range" ? 2 : 1) * c.cost) / Math.max(share, 1)));
      plans.set(c.key, { mode: c.mode, every });
      left -= c.cost / every * (c.mode === "range" ? 2 : 1);
      thinned.push({ name: stats.get(c.key)!.name, keeps: c.mode === "range" ? every / 2 : every });
    });
    if (thinned.length) {
      thinned.sort((a, b) => b.keeps - a.keeps);
      const examples = thinned
        .slice(0, 3)
        .map((t) => `${t.name} (about 1 in ${Math.round(t.keeps)})`)
        .join(", ");
      warn(
        `Large recording: repeated values were collapsed and ${thinned.length} high-rate signal${thinned.length === 1 ? " was" : "s were"} thinned to keep it under ${budget.toLocaleString("en-US")} samples. Each keeps its lowest and highest values (struct fields: evenly spaced records), so peaks and dips are still there. Most thinned: ${examples}.`,
      );
    } else
      warn(
        `Large recording: runs of repeated values were collapsed to their first and last sample to keep it under ${budget.toLocaleString("en-US")} samples. Values and graphs are unchanged.`,
      );
  }

  // Pass 2: decode.
  const active = new Map<number, EntryState>(),
    channels: Channel[] = [],
    byKey = new Map<string, EntryState>(),
    derivedChannels = new Map<string, Channel>(),
    buckets = new Map<Channel, { n: number; low: Sample; high: Sample }>();
  let minTime = Infinity,
    maxTime = 0,
    sampleCount = 0;
  const push = (target: Channel, sample: Sample) => {
    if (++sampleCount > budget * 1.25)
      throw new Error(
        `This recording exceeds the ${budget.toLocaleString("en-US")} sample limit even after thinning. No partial analysis was produced.`,
      );
    target.samples.push(sample);
  };
  const flush = (target: Channel) => {
    const b = buckets.get(target);
    if (!b) return;
    buckets.delete(target);
    const [first, second] = b.low.time <= b.high.time ? [b.low, b.high] : [b.high, b.low];
    push(target, first);
    if (second !== first) push(target, second);
  };
  const decode = (state: EntryState, size: number, time: number, offset: number, end: number) => {
    const { channel, plan } = state;
    const record = state.decoded++;
    if (plan.mode === "stride" && record % plan.every) return;
    const append = (target: Channel, value: Value) => {
      if (typeof value === "number" && !Number.isFinite(value)) return;
      if (plan.mode !== "range" || typeof value !== "number") {
        push(target, { time, value });
        return;
      }
      const sample = { time, value };
      const b = buckets.get(target);
      if (!b) buckets.set(target, { n: 1, low: sample, high: sample });
      else {
        b.n++;
        if (value < (b.low.value as number)) b.low = sample;
        if (value > (b.high.value as number)) b.high = sample;
      }
      if (buckets.get(target)!.n >= plan.every) flush(target);
    };
    const derived = (suffix: string, value: Value) => {
      const derivedName = `${channel.name}/${suffix}`;
      let target = derivedChannels.get(derivedName);
      if (!target) {
        target = {
          name: derivedName,
          type: typeof value === "number" ? "double" : typeof value === "boolean" ? "boolean" : "string",
          samples: [],
        };
        channels.push(target);
        derivedChannels.set(derivedName, target);
        state.parts.add(target);
      }
      append(target, value);
    };
    if (SCALAR_SIZES[channel.type] && size !== SCALAR_SIZES[channel.type])
      throw new Error(`Invalid scalar payload size for ${channel.name}.`);
    const width = ARRAY_WIDTHS[channel.type];
    if (width) {
      if (size % width) throw new Error(`Invalid numeric array payload size in ${channel.name}.`);
      const count = size / width;
      // Field2d paths can contain thousands of values. Treat the expansion limit as a per-entry decoding
      // limit, not a file-format error, so visualization arrays cannot crowd out mechanism channels.
      if (count > MAX_ARRAY_ELEMENTS) {
        warn(`${channel.name}: numeric arrays above ${MAX_ARRAY_ELEMENTS} elements were skipped; other channels were decoded normally.`);
        return;
      }
      for (let i = 0; i < count; i++) {
        const at = offset + i * width;
        if (channel.type === "int64[]") {
          const n = Number(view.getBigInt64(at, true));
          if (!Number.isSafeInteger(n)) {
            warn(`${channel.name}: imprecise integer array samples were skipped.`);
            continue;
          }
          derived(String(i), n);
        } else
          derived(
            String(i),
            channel.type === "double[]" ? view.getFloat64(at, true) : channel.type === "float[]" ? view.getFloat32(at, true) : bytes[at] !== 0,
          );
      }
      return;
    }
    if (state.struct !== undefined) {
      const layout = state.struct;
      if (!layout) {
        warn(`${channel.type}: this log has no usable schema for it; entries are listed without samples.`);
        return;
      }
      const isArray = channel.type.endsWith("[]");
      if (!layout.size || (isArray ? size % layout.size : size !== layout.size)) {
        warn(`${channel.name}: records that don't match the ${channel.type} layout were skipped.`);
        return;
      }
      const count = isArray ? size / layout.size : 1;
      if (count > MAX_STRUCT_ELEMENTS) warn(`${channel.name}: only the first ${MAX_STRUCT_ELEMENTS} array elements were decoded.`);
      for (let e = 0; e < Math.min(count, MAX_STRUCT_ELEMENTS); e++)
        for (const leaf of layout.leaves) {
          const value = leaf.read(view, bytes, offset + e * layout.size);
          if (value !== undefined) derived(isArray ? `${e}/${leaf.path}` : leaf.path, value);
        }
      return;
    }
    let value: Value | undefined;
    if (channel.type === "string[]") {
      const items: string[] = [];
      let at = offset;
      if (at + 4 <= end) {
        const count = view.getUint32(at, true);
        at += 4;
        for (let i = 0; i < count && i < 256 && at + 4 <= end; i++) {
          const length = view.getUint32(at, true);
          at += 4;
          if (at + length > end) break;
          items.push(DECODER.decode(bytes.subarray(at, at + length)));
          at += length;
        }
      }
      value = JSON.stringify(items);
    } else
      switch (channel.type) {
        case "boolean":
          value = bytes[offset] !== 0;
          break;
        case "double":
          value = view.getFloat64(offset, true);
          break;
        case "float":
          value = view.getFloat32(offset, true);
          break;
        case "int64": {
          const n = view.getBigInt64(offset, true);
          if (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(n);
          else warn(`${channel.name}: large integers cannot be represented exactly and were skipped.`);
          break;
        }
        case "string":
        case "json":
          value = DECODER.decode(bytes.subarray(offset, end));
          break;
        case "structschema":
          break; // read in the first pass; the struct entries carry the data
        default:
          warn(`${channel.type}: decoding is not available yet; entries are listed without samples.`);
      }
    if (value !== undefined) append(channel, value);
  };
  readRecords(bytes, view, (id, size, time, offset, end) => {
    if (id === 0) {
      if (!size) return;
      const control = bytes[offset];
      if (control === 0) {
        const start = readStart(view, bytes, offset, end);
        const k = key(start.name, start.type);
        let state = byKey.get(k);
        if (!state) {
          const duplicate = channels.some((c) => c.name === start.name && c.type !== start.type);
          const channel: Channel = { name: duplicate ? `${start.name} (${start.type})` : start.name, type: start.type, samples: [] };
          channels.push(channel);
          const base = start.type.endsWith("[]") ? start.type.slice(0, -2) : start.type;
          state = {
            channel,
            plan: plans.get(k) ?? { mode: "all" },
            seen: 0,
            decoded: 0,
            struct: base.startsWith("struct:") ? layoutOf(base.slice(7)) : undefined,
            parts: new Set(),
          };
          byKey.set(k, state);
        }
        active.set(start.entry, state);
      } else if (control === 1) active.delete(view.getUint32(offset + 1, true));
      return;
    }
    const state = active.get(id);
    if (!state) {
      warn("Some records referenced unknown entry IDs and were skipped.");
      return;
    }
    minTime = Math.min(minTime, time);
    maxTime = Math.max(maxTime, time);
    state.seen++;
    if (collapse) {
      // Hold a repeat back; only the last of a run is decoded, when the run ends.
      if (samePayload(bytes, state.last, offset, end)) {
        state.pending = { size, time, offset, end };
        return;
      }
      if (state.pending) {
        const p = state.pending;
        state.pending = undefined;
        decode(state, p.size, p.time, p.offset, p.end);
      }
      state.last = [offset, end];
    }
    decode(state, size, time, offset, end);
  });
  for (const state of byKey.values())
    if (state.pending) {
      const p = state.pending;
      state.pending = undefined;
      decode(state, p.size, p.time, p.offset, p.end);
    }
  for (const target of [...buckets.keys()]) flush(target);
  // Thinned signals say how many samples the file had.
  for (const state of byKey.values()) {
    if (state.plan.mode === "all" && state.decoded === state.seen) continue;
    for (const target of [state.channel, ...state.parts])
      if (target.samples.length) target.sourceSamples = state.seen;
  }
  if (minTime === Infinity) minTime = 0;
  for (const c of channels) {
    c.samples.sort((a, b) => a.time - b.time);
    for (const s of c.samples) s.time -= minTime;
  }
  return {
    name,
    duration: maxTime - minTime,
    channels,
    warnings: [...warnings],
  };
}
