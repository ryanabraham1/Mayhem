export interface Sample {
  time: number;
  value: number | boolean | string;
}
export interface Channel {
  name: string;
  type: string;
  samples: Sample[];
}
export interface Recording {
  name: string;
  duration: number;
  channels: Channel[];
  warnings: string[];
}
export interface Finding {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail: string;
  start: number;
  end: number;
  channel: string;
}
export interface PowerMapping {
  voltage?: string;
  current?: string;
  brownout?: string;
  /** Exact supply-current channels in amperes. Undefined uses detection; [] disables it. */
  deviceCurrents?: string[];
}
/** A portable, agent-editable mapping. Reject typos rather than silently guessing. */
export function parsePowerMapping(value: unknown, channels?: Channel[]): PowerMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a signal mapping object.");
  const input = value as Record<string, unknown>;
  const result: PowerMapping = {};
  for (const key of Object.keys(input)) {
    if (!["voltage", "current", "brownout", "deviceCurrents"].includes(key)) throw new Error(`Unknown mapping field: ${key}`);
  }
  for (const key of ["voltage", "current", "brownout"] as const) {
    const name = input[key];
    if (name === undefined) continue;
    if (typeof name !== "string" || !name.trim()) throw new Error(`Invalid ${key} signal name.`);
    result[key] = name;
  }
  if (input.deviceCurrents !== undefined) {
    if (!Array.isArray(input.deviceCurrents) || input.deviceCurrents.length > 4096 || !input.deviceCurrents.every(n => typeof n === "string" && n.trim())) throw new Error("deviceCurrents must be an array of exact signal names.");
    result.deviceCurrents = [...new Set(input.deviceCurrents as string[])];
  }
  if (channels) {
    const byName = new Map(channels.map(c => [c.name, c]));
    for (const [role, names] of Object.entries(result)) {
      for (const name of typeof names === "string" ? [names] : names) {
        const channel = byName.get(name);
        if (!channel) throw new Error(`Signal not found: ${name}`);
        if (role === "brownout" ? channel.type !== "boolean" : !["double", "float", "int64", "number"].includes(channel.type)) throw new Error(`Wrong signal type for ${role}: ${name}`);
      }
    }
  }
  return result;
}
/** Conservative name hints only; explicit mappings take precedence. */
export function isDeviceCurrentSignal(name: string): boolean {
  const leaf = name.replace(/\/\d+$/, "").split("/").pop() ?? "";
  if (/stator/i.test(name) || /totalcurrent|currentlimit|setpoint|target/i.test(leaf)) return false;
  return /currents?(?:left|right)?$/i.test(leaf) || /(?:^|[_ .-])amps?$/i.test(leaf) || /[a-z]Amps?$/.test(leaf);
}
/** Sum battery-side currents over their common recorded span, holding each sample
 * until its next update. Never sum peaks, or mix motor supply and PDH measurements. */
export function estimateTotalCurrent(recording: Recording, mapping: PowerMapping): { channel: Channel; inputs: string[] } | undefined {
  const explicit = mapping.deviceCurrents === undefined ? undefined : new Set(mapping.deviceCurrents);
  let candidates = recording.channels.filter(c => c.name !== mapping.current &&
    (explicit ? explicit.has(c.name) : isDeviceCurrentSignal(c.name) && /supplycurrents?|(?:pdh|pdp|powerdistribution).*currents?/i.test(c.name)));
  if (!explicit && candidates.some(c => /supplycurrent/i.test(c.name))) {
    candidates = candidates.filter(c => /supplycurrent/i.test(c.name));
  }
  const seen = new Set<string>();
  const streams = candidates.filter(c => {
    const canonical = c.name.replace(/^NT:/i, "").replace(/^\/+/, "");
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  }).map(c => ({ name: c.name, samples: c.samples.filter((s): s is Sample & {value: number} =>
    typeof s.value === "number" && Number.isFinite(s.value) && Number.isFinite(s.time)) })).filter(c => c.samples.length >= 2);
  if (!streams.length) return;
  const start = Math.max(0, ...streams.map(c => c.samples[0].time));
  const end = Math.min(recording.duration, ...streams.map(c => c.samples[c.samples.length - 1].time));
  if (end <= start) return;
  const deltas = new Map<number, number>();
  let total = 0;
  for (const stream of streams) {
    let previous = 0;
    for (const s of stream.samples) {
      const value = Math.abs(s.value);
      if (s.time <= start) total += value - previous;
      else if (s.time <= end) deltas.set(s.time, (deltas.get(s.time) ?? 0) + value - previous);
      else break;
      previous = value;
    }
  }
  const samples: Sample[] = [{time: start, value: total}];
  for (const [time, delta] of [...deltas].sort((a, b) => a[0] - b[0])) {
    total += delta;
    samples.push({time, value: Math.max(0, total)});
  }
  if (samples[samples.length - 1].time < end) samples.push({time: end, value: total});
  return { channel: {name: "Estimated total supply current", type: "double", samples}, inputs: streams.map(c => c.name) };
}
export interface LogRule {
  id: string; channel: string; op: "lt" | "gt" | "eq"; value: number | boolean | string;
  duration: number; severity: "error" | "warning"; title: string; detail: string;
}
export interface LogPolicy { defaultRules?: boolean; rules: LogRule[] }
export function parseLogPolicy(value: unknown): LogPolicy {
  if (value === undefined) return { rules: [] };
  const p = value as LogPolicy;
  if (!p || !Array.isArray(p.rules) || p.rules.length > 256 || (p.defaultRules !== undefined && typeof p.defaultRules !== "boolean")) throw new Error("Invalid project log policy: expected rules and optional defaultRules.");
  const ids = new Set<string>();
  for (const r of p.rules) {
    if (!r || ![r.id,r.channel,r.title,r.detail].every(x => typeof x === "string" && x.length > 0) || ids.has(r.id) || !["lt","gt","eq"].includes(r.op) || !["number","boolean","string"].includes(typeof r.value) || (typeof r.value === "number" && !Number.isFinite(r.value)) || (r.op !== "eq" && typeof r.value !== "number") || !Number.isFinite(r.duration) || r.duration < 0 || !["warning","error"].includes(r.severity)) throw new Error("Invalid project log rule. Check IDs, channel, comparison, duration and severity.");
    ids.add(r.id);
  }
  return p;
}
export interface Analysis {
  findings: Finding[];
  coverage: string[];
  mapping: PowerMapping;
  estimatedCurrent?: Channel;
  power: {
    currentSource?: "measured" | "estimated";
    currentChannels?: string[];
    minVoltage?: number;
    peakCurrent?: number;
    energyWh?: number;
    averagePower?: number;
  };
}
export function suggestMapping(channels: Channel[]): PowerMapping {
  const names = channels.map((c) => c.name);
  return {
    voltage: names.find((n) =>
      /(?:batteryvoltage|inputvoltage|powerdistribution\/voltage|pdh\/voltage|pdp\/voltage)$/i.test(
        n,
      ),
    ),
    current: names.find((n) =>
      /(?:totalcurrent|powerdistribution\/totalcurrent|pdh\/current|pdp\/current)$/i.test(
        n,
      ),
    ),
    brownout: names.find((n) =>
      /(?:brownedout|isbrownedout|brownout)$/i.test(n),
    ),
  };
}
export function analyze(
  recording: Recording,
  supplied?: PowerMapping,
  policyInput?: unknown,
): Analysis {
  const policy = parseLogPolicy(policyInput);
  const mapping = supplied ?? suggestMapping(recording.channels);
  const channels = new Map(recording.channels.map((c) => [c.name, c]));
  const findings: Finding[] = [],
    coverage: string[] = [];
  const measured = channels.get(mapping.current ?? "");
  const hasMeasured = measured?.samples.some(s => typeof s.value === "number" && Number.isFinite(s.value));
  const estimate = hasMeasured ? undefined : estimateTotalCurrent(recording, mapping);
  const voltage = channels.get(mapping.voltage ?? ""),
    current = hasMeasured ? measured : estimate?.channel,
    brownout = channels.get(mapping.brownout ?? "");
  const excursions = (
    channel: Channel,
    test: (v: Sample["value"]) => boolean,
    title: string,
    detail: string,
    severity: Finding["severity"],
    minDuration = 0,
  ) => {
    let start: number | undefined;
    const close = (end: number) => {
      if (start !== undefined && end - start >= minDuration)
        findings.push({
          id: `${channel.name}:${start}`,
          severity,
          title,
          detail,
          start,
          end,
          channel: channel.name,
        });
      start = undefined;
    };
    for (const s of channel.samples) {
      if (test(s.value)) start ??= s.time;
      else if (start !== undefined) close(s.time);
    }
    if (start !== undefined) close(recording.duration);
  };
  const numbers = (c?: Channel) =>
    c?.samples.filter(
      (s): s is Sample & { value: number } =>
        typeof s.value === "number" && Number.isFinite(s.value),
    ) ?? [];
  const v = numbers(voltage),
    a = numbers(current);
  if (!v.length)
    coverage.push(
      "Battery voltage missing: voltage sag and power calculations unavailable.",
    );
  else
    excursions(
      voltage!,
      (n) => typeof n === "number" && n < 9,
      "Low battery voltage",
      "Measured battery voltage below 9 V for at least 100 ms. Inspect simultaneous current and mechanism activity; this alone does not identify the cause.",
      "warning",
      0.1,
    );
  if (estimate) coverage.push(`Total current estimated from ${estimate.inputs.length} supply/branch current signals over their common recorded span. Unlogged loads are omitted; duplicate device sources must be removed using Signal mapping. This is a partial load estimate, not a measured battery total.`);
  if (!a.length)
    coverage.push(
      "No measured total or usable supply/branch current signals: total load and energy calculations unavailable.",
    );
  else
    excursions(
      current!,
      (n) => typeof n === "number" && n > 180,
      estimate ? "Sustained high estimated current" : "Sustained high current",
      `${estimate ? "Estimated summed supply current" : "Measured total current"} above 180 A for at least 250 ms. Threshold is a starting diagnostic, not a breaker model.`,
      "warning",
      0.25,
    );
  if (brownout)
    excursions(
      brownout,
      (n) => n === true,
      "Robot reported a brownout",
      "The recorded brownout flag was asserted.",
      "error",
    );
  else
    coverage.push(
      "Brownout flag missing: low voltage is not proof that the robot browned out.",
    );
  let diagnosticChannels = 0;
  for (const channel of recording.channels) {
    if (
      /(?:LoopTimeMs|LoopDurationMs|LoopTimeMilliseconds|LoopPeriodMs)$/i.test(channel.name)
    ) {
      diagnosticChannels++;
      const isPeriod = /LoopPeriodMs$/i.test(channel.name);
      excursions(
        channel,
        (v) => typeof v === "number" && v > (isPeriod ? 25 : 20),
        isPeriod ? "Control loop period over 25 ms" : "Control loop over 20 ms",
        isPeriod
          ? "Recorded loop start-to-start period exceeds 25 ms for at least 100 ms. This allows ordinary jitter around a 20 ms loop; compare with the robot’s configured period."
          : "Recorded loop duration exceeds 20 ms for at least 100 ms. Compare with the robot’s configured loop period; this rule only accepts signals explicitly named in milliseconds.",
        "warning",
        0.1,
      );
    }
    if (
      channel.type === "boolean" &&
      /(?:HasFault|Faulted|ResetOccurred|HasReset|TimedOut)$/i.test(
        channel.name,
      )
    ) {
      diagnosticChannels++;
      excursions(
        channel,
        (v) => v === true,
        "Robot reported a fault or timeout",
        `The recorded flag ${channel.name} was asserted. Inspect that device or action at this time.`,
        "error",
      );
    }
    if (
      channel.type === "boolean" &&
      /(?:Connected|IsConnected)$/i.test(channel.name)
    ) {
      diagnosticChannels++;
      excursions(
        channel,
        (v) => v === false,
        "Device reported disconnected",
        `The recorded connection flag ${channel.name} was false for at least 250 ms.`,
        "warning",
        0.25,
      );
    }
    if (channel.type === "string" && /(?:^|\/)(?:state|currentstate)$/i.test(channel.name)) {
      diagnosticChannels++;
      const changes = channel.samples.filter(
        (s, i) => i === 0 || s.value !== channel.samples[i - 1].value,
      );
      let left = 0,
        lastEnd = -Infinity;
      for (let right = 0; right < changes.length; right++) {
        while (changes[right].time - changes[left].time > 1) left++;
        if (right - left >= 10 && changes[left].time > lastEnd) {
          const start = changes[left].time,
            end = changes[right].time;
          findings.push({
            id: `chatter:${channel.name}:${start}`,
            severity: "warning",
            title: "Rapid state switching",
            detail:
              "At least ten state changes occurred within one second. Inspect inputs and transition guards for chatter.",
            start,
            end,
            channel: channel.name,
          });
          lastEnd = end;
        }
      }
    }
  }
  if (!diagnosticChannels)
    coverage.push(
      "No recognized loop, device-fault, connection, or state-machine signals were recorded. General robot diagnostics are limited.",
    );
  coverage.push(
    "Rules flag recorded symptoms, not proven root causes. Custom mechanisms need suitable signals and team-specific checks.",
  );
  if (policy.defaultRules === false) findings.length = 0;
  for (const rule of policy.rules) {
    const channel = channels.get(rule.channel);
    if (!channel) { coverage.push(`Rule ${rule.id}: missing channel ${rule.channel}.`); continue; }
    const before = findings.length;
    excursions(channel, v => rule.op === "eq" ? v === rule.value : typeof v === "number" && typeof rule.value === "number" && (rule.op === "lt" ? v < rule.value : v > rule.value), rule.title, rule.detail, rule.severity, rule.duration);
    for (let i = before; i < findings.length; i++) findings[i].id = `rule:${rule.id}:${findings[i].start}`;
  }
  let energy = 0,
    covered = 0;
  // Zero-order-hold integration over both streams, restricted to their common time span.
  if (v.length && a.length) {
    const start = Math.max(v[0].time, a[0].time);
    const end = Math.min(
      recording.duration,
      v[v.length - 1].time,
      a[a.length - 1].time,
    );
    let vi = 0,
      ai = 0,
      time = start;
    while (vi + 1 < v.length && v[vi + 1].time <= time) vi++;
    while (ai + 1 < a.length && a[ai + 1].time <= time) ai++;
    while (time < end) {
      const next = Math.min(
        v[vi + 1]?.time ?? end,
        a[ai + 1]?.time ?? end,
        end,
      );
      if (next > time) {
        energy += Math.max(0, v[vi].value * a[ai].value) * (next - time);
        covered += next - time;
      }
      time = next;
      while (vi + 1 < v.length && v[vi + 1].time <= time) vi++;
      while (ai + 1 < a.length && a[ai + 1].time <= time) ai++;
    }
  }
  let minVoltage: number | undefined, peakCurrent: number | undefined;
  for (const s of v) minVoltage = Math.min(minVoltage ?? Infinity, s.value);
  for (const s of a) peakCurrent = Math.max(peakCurrent ?? -Infinity, s.value);
  return {
    mapping,
    estimatedCurrent: estimate?.channel,
    findings: findings.sort((a, b) => a.start - b.start),
    coverage,
    power: {
      currentSource: a.length ? estimate ? "estimated" : "measured" : undefined,
      currentChannels: estimate?.inputs,
      minVoltage,
      peakCurrent,
      energyWh: covered > 0 ? energy / 3600 : undefined,
      averagePower: covered > 0 ? energy / covered : undefined,
    },
  };
}
export function parseRecordingJSON(text: string): Recording {
  const input = JSON.parse(text);
  if (
    !input ||
    typeof input.name !== "string" ||
    !Number.isFinite(input.duration) ||
    input.duration < 0 ||
    !Array.isArray(input.channels)
  )
    throw new Error("Expected a recording with name, duration, and channels.");
  const names = new Set<string>();
  for (const channel of input.channels) {
    if (
      !channel ||
      typeof channel.name !== "string" ||
      typeof channel.type !== "string" ||
      names.has(channel.name) ||
      !Array.isArray(channel.samples)
    )
      throw new Error(
        "Channel names must be unique and samples must be arrays.",
      );
    names.add(channel.name);
    let last = -Infinity;
    for (const sample of channel.samples) {
      if (
        !sample ||
        !Number.isFinite(sample.time) ||
        sample.time < 0 ||
        sample.time > input.duration ||
        sample.time < last ||
        !["number", "boolean", "string"].includes(typeof sample.value) ||
        (typeof sample.value === "number" && !Number.isFinite(sample.value))
      )
        throw new Error("Invalid or unordered channel sample.");
      last = sample.time;
    }
  }
  if (
    input.warnings !== undefined &&
    (!Array.isArray(input.warnings) ||
      input.warnings.some((w: unknown) => typeof w !== "string"))
  )
    throw new Error("Recording warnings must be text.");
  return {
    ...input,
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}
export function valueAt(
  channel: Channel | undefined,
  time: number,
): Sample["value"] | undefined {
  if (!channel?.samples.length || channel.samples[0].time > time)
    return undefined;
  let lo = 0,
    hi = channel.samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (channel.samples[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return channel.samples[lo].value;
}

export interface CurrentUse {
  channel: string;
  peak: number;
  average: number;
  /** Charge drawn over the recording, in milliamp-hours. */
  mAh: number;
}
/**
 * Rank individual current signals (motor controllers, PDH channels) by charge
 * drawn. Excludes the mapped total so it doesn't dominate the list.
 */
export function currentBreakdown(
  recording: Recording,
  exclude?: string,
  limit = 24,
  deviceCurrents?: readonly string[],
): CurrentUse[] {
  const result: CurrentUse[] = [];
  const explicit = deviceCurrents === undefined ? undefined : new Set(deviceCurrents);
  for (const channel of recording.channels) {
    if (channel.name === exclude) continue;
    if (explicit ? !explicit.has(channel.name) : !isDeviceCurrentSignal(channel.name)) continue;
    const samples = channel.samples.filter(
      (s): s is Sample & { value: number } =>
        typeof s.value === "number" && Number.isFinite(s.value),
    );
    if (samples.length < 2) continue;
    let charge = 0,
      peak = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i].value);
      peak = Math.max(peak, value);
      const next = samples[i + 1]?.time ?? samples[i].time;
      charge += value * Math.max(0, next - samples[i].time);
    }
    const span = samples[samples.length - 1].time - samples[0].time;
    result.push({
      channel: channel.name,
      peak,
      average: span > 0 ? charge / span : 0,
      mAh: (charge / 3600) * 1000,
    });
  }
  return result.sort((a, b) => b.mAh - a.mAh).slice(0, limit);
}
