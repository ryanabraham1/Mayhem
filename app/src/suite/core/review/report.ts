/**
 * The behavior review between two revisions of the robot code: what a person checks instead of
 * reading code, and how risky the change is. Computed only from the two revisions' files.
 */
import { diffRoutines, readProject, type RoutineDiff } from "./autos.ts";
import { diffDevices, duplicateIds, readDevices, type Device, type DeviceChange } from "./hardware.ts";
import { diffMachines, type MachineDiff } from "./machines.ts";
import { CATEGORY_NAMES, SAFETY_CATEGORIES, diffSettings, isSettingsSource, readSettings, type Setting, type SettingChange } from "./settings.ts";
import type { SuiteProject } from "../model.ts";

/** A revision's files that the review reads (path → text). */
export interface Snapshot {
  /** Git revision, or `WORKTREE` for uncommitted files on disk. */
  rev: string;
  /** What a person sees: `main`, `a1b2c3d Fix intake`, `This computer (not committed)`. */
  label: string;
  files: Record<string, string>;
}

export const WORKTREE = "WORKTREE";
export const MACHINES_FILE = "tools/mayhem/machines.json";
export const SCENARIOS_FILE = "tools/mayhem/scenarios.json";
/** The robot code generated from the project file (tools/mayhem/export.sh). */
export const GENERATED_FILE = "src/main/include/commands/MayhemProject.h";
/** Team-written descriptions of each part of the robot (Overview → How the robot works). */
export const EXPLAINER_FILE = "tools/mayhem/explainer.json";

/** Files a review needs from a revision. */
export const isReviewFile = (path: string) =>
  isSettingsSource(path) || path === MACHINES_FILE || path === SCENARIOS_FILE || path === GENERATED_FILE || path === EXPLAINER_FILE || /^[^/]+\.mayhem\.json$/.test(path);

export function projectFile(files: Record<string, string>): string | undefined {
  if ("robot.mayhem.json" in files) return "robot.mayhem.json";
  return Object.keys(files).filter((p) => /^[^/]+\.mayhem\.json$/.test(p)).sort()[0];
}

export type Level = "red" | "yellow" | "green" | "none";
export type Area = "controls" | "machines" | "settings" | "hardware" | "autos" | "generated";

export interface Finding {
  level: Exclude<Level, "none">;
  area: Area;
  text: string;
}

export interface ReviewReport {
  format: "mayhem-review";
  version: 1;
  createdAt: string;
  before: { rev: string; label: string };
  after: { rev: string; label: string };
  level: Level;
  findings: Finding[];
  settings: SettingChange[];
  devices: DeviceChange[];
  /** Every device in each revision, for the robot diagram. */
  hardware: { before: Device[]; after: Device[] };
  duplicates: ReturnType<typeof duplicateIds>;
  machines: MachineDiff[];
  routines: RoutineDiff[];
  field?: SuiteProject["field"];
  errors: string[];
}

const LEVELS: Level[] = ["none", "green", "yellow", "red"];
const worst = (a: Level, b: Level) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

export function settingsOf(snapshot: Snapshot): Setting[] {
  return readSettings(Object.entries(snapshot.files).map(([path, text]) => ({ path, text })));
}

export function buildReport(before: Snapshot, after: Snapshot): ReviewReport {
  const settingsBefore = settingsOf(before),
    settingsAfter = settingsOf(after);
  const settings = diffSettings(settingsBefore, settingsAfter);
  const hardware = { before: readDevices(settingsBefore), after: readDevices(settingsAfter) };
  const devices = diffDevices(hardware.before, hardware.after);
  const duplicatesBefore = new Set(duplicateIds(hardware.before).map((d) => `${d.kind}${d.canId}`));
  const duplicates = duplicateIds(hardware.after);
  const machines = diffMachines(before.files[MACHINES_FILE], after.files[MACHINES_FILE]);
  const pb = projectFile(before.files),
    pa = projectFile(after.files);
  const routines = diffRoutines(pb && before.files[pb], pa && after.files[pa]);

  const findings: Finding[] = [];
  // Hardware and safety settings: red. Devices of one subsystem with the
  // same change (four shooter motors sharing a configuration) are one finding.
  const byChange = new Map<string, DeviceChange[]>();
  for (const d of devices) {
    const what =
      d.kind === "changed"
        ? d.fields.map((f) => `${f.field} ${f.before ?? "—"} → ${f.after ?? "—"}`).join(", ")
        : d.kind === "added"
          ? "new device"
          : "device removed";
    const key = `${d.subsystem}\u0000${d.fields.some((f) => f.field === "CAN ID") ? d.key : ""}\u0000${what}`;
    byChange.set(key, [...(byChange.get(key) ?? []), d]);
  }
  for (const [key, group] of byChange) {
    const what = key.split("\u0000")[2];
    const names = group.map((d) => d.name.replace(/ · leader$/, ""));
    findings.push({ level: "red", area: "hardware", text: `${group[0].subsystem} · ${names.length > 2 ? `${names.length} devices (${names.join(", ")})` : names.join(" and ")}: ${what}` });
  }
  for (const d of duplicates)
    if (!duplicatesBefore.has(`${d.kind}${d.canId}`))
      findings.push({ level: "red", area: "hardware", text: `CAN ID ${d.canId} is used by ${d.devices.length} ${d.kind} devices (${d.devices.join(", ")}). They conflict if they share a CAN bus.` });
  const shownOnDevices = new Set(devices.flatMap((d) => [...(d.before?.sources ?? []), ...(d.after?.sources ?? [])]));
  for (const c of settings) {
    if (c.category === "simulation") continue;
    const safety = SAFETY_CATEGORIES.has(c.category);
    if (safety && shownOnDevices.has(c.key)) continue; // already a hardware finding
    findings.push({
      level: safety ? "red" : "yellow",
      area: "settings",
      text: `${c.subsystem} · ${c.label}: ${
        c.kind === "added"
          ? `new (${c.after!.display})`
          : c.kind === "removed"
            ? `removed (was ${c.before!.display})`
            : c.rows?.length
              ? c.rows.map((r) => `at ${r.input}${c.after?.tableUnits?.[0] ? ` ${c.after.tableUnits[0]}` : ""}: ${r.before ?? "—"} → ${r.after ?? "—"}`).join(", ")
              : `${c.before!.display} → ${c.after!.display}`
      }${safety ? ` (${CATEGORY_NAMES[c.category].toLowerCase()})` : ""}`,
    });
  }
  // Controls: the team rule is that the same driver inputs give the same outcomes.
  for (const m of machines.machines) {
    if (m.kind === "added" || m.kind === "removed") {
      const driver = m.inputs.filter((i) => i.category === "operator").map((i) => i.after ?? i.before);
      findings.push({
        level: "yellow",
        area: driver.length ? "controls" : "machines",
        text: `${m.name}: machine ${m.kind}${driver.length ? `, driver inputs: ${driver.join("; ")}` : ""}`,
      });
      continue;
    }
    for (const i of m.inputs)
      if (i.category === "operator")
        findings.push({
          level: "yellow",
          area: "controls",
          text: `${m.name}: driver input "${i.after ?? i.before}" ${i.kind === "changed" ? `relabeled from "${i.before}"` : i.kind}`,
        });
    // Plain words: input and state names instead of code keys.
    const inputNames = new Map(m.merged?.inputs.map((i) => [i.key, i.name]));
    const plain = (text?: string) => text?.replace(/[A-Za-z_]\w*/g, (k) => (inputNames.has(k) ? `“${inputNames.get(k)}”` : k)).replace(/&&/g, "and").replace(/\|\|/g, "or").replace(/!(?=“)/g, "not ");
    const state = (id: string) => (id === "*" ? "any state" : m.merged?.states.find((x) => x.id === id)?.name ?? id);
    for (const t of m.transitions)
      if (t.driver)
        findings.push({
          level: "yellow",
          area: "controls",
          text: `${m.name}: ${state(t.from)} → ${state(t.to)} ${t.kind === "changed" ? `now when ${plain(t.after)} (was ${plain(t.before)})` : t.kind === "added" ? `new, when ${plain(t.after)}` : `removed (was when ${plain(t.before)})`}`,
        });
    if (m.kind !== "same" && !m.controls)
      findings.push({ level: "yellow", area: "machines", text: `${m.name}: ${m.kind === "changed" ? `${m.states.length} state and ${m.transitions.length} transition changes` : m.kind}` });
  }
  for (const r of routines.routines) {
    if (r.kind === "same") continue;
    const ok = r.kind === "removed" || r.after?.status === "completed";
    findings.push({
      level: ok ? "green" : "yellow",
      area: "autos",
      text: `${r.name}: ${r.kind}${r.after && r.before ? `, ${r.before.time.toFixed(1)} s → ${r.after.time.toFixed(1)} s` : ""}${ok ? "" : ` (path preview ${r.after?.status ?? "could not run"})`}`,
    });
  }
  // The robot runs MayhemProject.h, generated from the project file, which machines.json is applied
  // to. If a source changed but what it generates did not, the robot won't do what these pages show.
  const changedFile = (path: string) => before.files[path] !== after.files[path];
  const machinesInProject = (snap: Snapshot) => {
    const p = projectFile(snap.files);
    try {
      return JSON.stringify(p ? JSON.parse(snap.files[p]).extensions?.machines ?? null : null);
    } catch {
      return "";
    }
  };
  if (MACHINES_FILE in after.files && changedFile(MACHINES_FILE) && machinesInProject(before) === machinesInProject(after))
    findings.push({ level: "red", area: "generated", text: "tools/mayhem/machines.json changed but the project file's machines did not: the robot still runs the old state machines. Run `mayhem.mjs machine apply`, then tools/mayhem/export.sh." });
  if (GENERATED_FILE in after.files && pa && routines.routines.some((r) => r.kind !== "same") && !changedFile(GENERATED_FILE))
    findings.push({ level: "red", area: "generated", text: `The autos changed in ${pa} but ${GENERATED_FILE.split("/").pop()} did not: the robot still drives the old autos. Run tools/mayhem/export.sh.` });
  else if (GENERATED_FILE in after.files && pa && pb && changedFile(pa) && JSON.stringify(readProject(after.files[pa]).project?.extensions?.machines ?? null) !== JSON.stringify(readProject(before.files[pb]).project?.extensions?.machines ?? null) && !changedFile(GENERATED_FILE))
    findings.push({ level: "red", area: "generated", text: `The state machines changed in ${pa} but ${GENERATED_FILE.split("/").pop()} did not: the robot still runs the old machines. Run tools/mayhem/export.sh.` });
  const level = findings.reduce<Level>((l, f) => worst(l, f.level), "none");
  return {
    format: "mayhem-review",
    version: 1,
    createdAt: new Date().toISOString(),
    before: { rev: before.rev, label: before.label },
    after: { rev: after.rev, label: after.label },
    level,
    findings: findings.sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level)),
    settings,
    devices,
    hardware,
    duplicates,
    machines: machines.machines,
    routines: routines.routines,
    ...(routines.field ? { field: routines.field } : {}),
    errors: [...machines.errors, ...routines.errors],
  };
}

export const LEVEL_TEXT: Record<Level, string> = {
  red: "Safety change: check it carefully",
  yellow: "Behavior changes to review",
  green: "OK: path changes that pass the preview",
  none: "No behavior changes found",
};
