import type { Channel, Recording, Sample } from "./analysis.ts";
/** WPILOG 1.0 reader. Binary structures remain visible as unsupported channels.
 * Spec: allwpilib v2026.2.2/wpiutil/doc/datalog.adoc. */
export function parseWPILog(buffer: ArrayBuffer, name: string): Recording {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer),
    decoder = new TextDecoder();
  if (bytes.length < 12 || decoder.decode(bytes.subarray(0, 6)) !== "WPILOG")
    throw new Error("This file is not a WPILOG recording.");
  const version = view.getUint16(6, true);
  if (version !== 0x0100)
    throw new Error(
      `Unsupported WPILOG version 0x${version.toString(16)}. Expected version 1.0.`,
    );
  let offset = 12 + view.getUint32(8, true);
  if (offset > bytes.length) throw new Error("Truncated WPILOG header.");
  const active = new Map<number, Channel>(),
    channels: Channel[] = [],
    derivedChannels = new Map<string, Channel>(),
    warnings = new Set<string>();
  let minTime = Infinity,
    maxTime = 0,
    sampleCount = 0;
  const uint = (length: number) => {
    if (offset + length > bytes.length)
      throw new Error("Truncated record header.");
    let result = 0;
    for (let i = 0; i < length; i++) result += bytes[offset++] * 2 ** (8 * i);
    if (!Number.isSafeInteger(result))
      throw new Error("Timestamp exceeds supported integer precision.");
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
      throw new Error(
        "Recording ends in an incomplete record. Wait for the robot to finish writing, then download again.",
      );
    if (id === 0 && size) {
      const control = bytes[offset++];
      if (control === 0) {
        if (offset + 4 > end) throw new Error("Invalid start record.");
        const entry = view.getUint32(offset, true);
        offset += 4;
        const string = () => {
          if (offset + 4 > end) throw new Error("Invalid entry string.");
          const length = view.getUint32(offset, true);
          offset += 4;
          if (offset + length > end) throw new Error("Truncated entry string.");
          const text = decoder.decode(bytes.subarray(offset, offset + length));
          offset += length;
          return text;
        };
        const entryName = string(),
          type = string();
        string();
        const existing = channels.find(
          (c) => c.name === entryName && c.type === type,
        );
        const duplicate = channels.some(
          (c) => c.name === entryName && c.type !== type,
        );
        const channel = existing ?? {
          name: duplicate ? `${entryName} (${type})` : entryName,
          type,
          samples: [],
        };
        if (!existing) channels.push(channel);
        active.set(entry, channel);
      } else if (control === 1) {
        if (offset + 4 > end) throw new Error("Invalid finish record.");
        active.delete(view.getUint32(offset, true));
      }
    } else if (id !== 0) {
      const channel = active.get(id);
      if (!channel)
        warnings.add(
          "Some records referenced unknown entry IDs and were skipped.",
        );
      else {
        minTime = Math.min(minTime, time);
        maxTime = Math.max(maxTime, time);
        const append = (target: Channel, value: Sample["value"]) => {
          if (typeof value === "number" && !Number.isFinite(value)) return;
          if (++sampleCount > 2_000_000)
            throw new Error(
              "This recording exceeds the current 2 million sample limit. No partial analysis was produced.",
            );
          target.samples.push({ time, value });
        };
        const derived = (suffix: string, value: number | boolean) => {
          const name = `${channel.name}/${suffix}`;
          let target = derivedChannels.get(name);
          if (!target) {
            target = {
              name,
              type: typeof value === "number" ? "double" : "boolean",
              samples: [],
            };
            channels.push(target);
            derivedChannels.set(name, target);
          }
          append(target, value);
        };
        let value: Sample["value"] | undefined;
        const scalarSizes: Record<string, number> = {
          boolean: 1,
          double: 8,
          float: 4,
          int64: 8,
        };
        if (scalarSizes[channel.type] && size !== scalarSizes[channel.type])
          throw new Error(`Invalid scalar payload size for ${channel.name}.`);
        const arrays: Record<string, number> = {
          "double[]": 8,
          "float[]": 4,
          "int64[]": 8,
          "boolean[]": 1,
        };
        const structures: Record<string, string[]> = {
          "struct:Pose2d": ["x", "y", "heading"],
          "struct:Translation2d": ["x", "y"],
          "struct:Rotation2d": ["heading"],
          "struct:ChassisSpeeds": ["vx", "vy", "omega"],
        };
        if (arrays[channel.type]) {
          const width = arrays[channel.type];
          if (size % width || size / width > 512)
            throw new Error(
              `Invalid or oversized numeric array in ${channel.name}.`,
            );
          for (let i = 0; i < size / width; i++) {
            const at = offset + i * width;
            if (channel.type === "int64[]") {
              const n = Number(view.getBigInt64(at, true));
              if (!Number.isSafeInteger(n)) {
                warnings.add(
                  `${channel.name}: imprecise integer array samples were skipped.`,
                );
                continue;
              }
              derived(String(i), n);
            } else
              derived(
                String(i),
                channel.type === "double[]"
                  ? view.getFloat64(at, true)
                  : channel.type === "float[]"
                    ? view.getFloat32(at, true)
                    : bytes[at] !== 0,
              );
          }
        } else if (structures[channel.type]) {
          const fields = structures[channel.type];
          if (size !== fields.length * 8)
            throw new Error(
              `Invalid ${channel.type} payload in ${channel.name}.`,
            );
          fields.forEach((field, i) =>
            derived(field, view.getFloat64(offset + i * 8, true)),
          );
        } else
          switch (channel.type) {
            case "boolean":
              if (size === 1) value = bytes[offset] !== 0;
              break;
            case "double":
              if (size === 8) value = view.getFloat64(offset, true);
              break;
            case "float":
              if (size === 4) value = view.getFloat32(offset, true);
              break;
            case "int64":
              if (size === 8) {
                const n = view.getBigInt64(offset, true);
                if (
                  n >= BigInt(Number.MIN_SAFE_INTEGER) &&
                  n <= BigInt(Number.MAX_SAFE_INTEGER)
                )
                  value = Number(n);
                else
                  warnings.add(
                    `${channel.name}: large integers cannot be represented exactly and were skipped.`,
                  );
              }
              break;
            case "string":
            case "json":
              value = decoder.decode(bytes.subarray(offset, end));
              break;
            default:
              warnings.add(
                `${channel.type}: decoding is not available yet; entries are listed without samples.`,
              );
          }
        if (value !== undefined) append(channel, value);
      }
    }
    offset = end;
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
