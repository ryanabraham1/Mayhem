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
  power: {
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
  const voltage = channels.get(mapping.voltage ?? ""),
    current = channels.get(mapping.current ?? ""),
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
  if (!a.length)
    coverage.push(
      "Total current missing: total load and energy calculations unavailable.",
    );
  else
    excursions(
      current!,
      (n) => typeof n === "number" && n > 180,
      "Sustained high current",
      "Measured total current above 180 A for at least 250 ms. Threshold is a starting diagnostic, not a breaker model.",
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
    findings: findings.sort((a, b) => a.start - b.start),
    coverage,
    power: {
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
