/**
 * The robot explained for people who don't read code: each part (subsystem) with its devices, the
 * state machines and driver buttons that drive it, and the team's own words from
 * tools/mayhem/explainer.json.
 */
import type { MachineManifest } from "../machines.ts";
import type { Device } from "./hardware.ts";
import type { Setting } from "./settings.ts";

export interface ExplainerFile {
  /** Part name (as on the robot map) → what it does, in the team's words. */
  parts: Record<string, string>;
}

export function parseExplainer(text: string | undefined): ExplainerFile {
  if (!text?.trim()) return { parts: {} };
  try {
    const v = JSON.parse(text);
    const parts = v && typeof v.parts === "object" && !Array.isArray(v.parts) ? Object.fromEntries(Object.entries(v.parts).filter(([, t]) => typeof t === "string")) : {};
    return { parts: parts as Record<string, string> };
  } catch {
    return { parts: {} };
  }
}
export const serializeExplainer = (e: ExplainerFile) => JSON.stringify({ parts: e.parts }, null, 2) + "\n";

export interface Part {
  name: string;
  devices: Device[];
  /** Source folders and files with this part's code (for its recent changes). */
  paths: string[];
  /** Machines that drive this part (matched by name). */
  machines: MachineManifest[];
  /** Driver buttons that reach it, through those machines. */
  controls: { input: string; machine: string }[];
  /** The team's words, if written. */
  about?: string;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** One part per subsystem with devices, in robot-map order. */
export function robotParts(devices: Device[], settings: Setting[], machines: MachineManifest[], explainer: ExplainerFile): Part[] {
  const names = [...new Set(devices.map((d) => d.subsystem))];
  return names.map((name) => {
    const files = [...new Set(settings.filter((s) => s.subsystem === name).map((s) => s.file))];
    // The subsystem's folder (src/main/include/subsystems/shooter/…) and its .cpp twin.
    const dirs = [...new Set(files.map((f) => /^(src\/main\/include\/subsystems\/[^/]+)\//.exec(f)?.[1]).filter(Boolean) as string[])];
    const paths = dirs.length ? dirs.flatMap((d) => [d, d.replace("/include/", "/cpp/")]) : files;
    const first = words(name)[0];
    const own = machines.filter((m) => first && words(`${m.name} ${m.id.replace(/([a-z])([A-Z])/g, "$1 $2")}`)[0] === first);
    const controls = own.flatMap((m) => m.inputs.filter((i) => i.category === "operator").map((i) => ({ input: i.name, machine: m.name })));
    return {
      name,
      devices: devices.filter((d) => d.subsystem === name),
      paths,
      machines: own,
      controls: controls.filter((c, i) => controls.findIndex((x) => x.input === c.input) === i),
      ...(explainer.parts[name] ? { about: explainer.parts[name] } : {}),
    };
  });
}
