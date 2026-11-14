import type { Recording } from "../analysis.ts";

/** The commit a log's robot code was built from (the Mayhem/Build stamp the robot logs at boot). */
export function buildOf(recording: Recording): string | undefined {
  const c = recording.channels.find((x) => /(^|\/)Mayhem\/Build$/.test(x.name) && !x.name.startsWith("NT:") && x.samples.length);
  try {
    const sha = JSON.parse(String(c?.samples[0].value)).sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
