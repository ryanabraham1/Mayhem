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
  /**
   * Every file that ends up on the robot (`isRobotCode`), path → content id (git blob id). The
   * review reads only `files`; this tells it that code it cannot read changed. Absent in snapshots
   * from older tools.
   */
  code?: Record<string, string>;
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

/** Written by the robot build with what was deployed; never part of a change. */
export const BUILD_STAMP = "src/main/deploy/mayhem-build.json";
/** Files that end up on the robot or decide what is built into it. */
export const isRobotCode = (path: string) =>
  (path.startsWith("src/main/") && path !== BUILD_STAMP) || /^vendordeps\/[^/]+\.json$/.test(path) || path === "build.gradle";

export function projectFile(files: Record<string, string>): string | undefined {
  if ("robot.mayhem.json" in files) return "robot.mayhem.json";
  return Object.keys(files).filter((p) => /^[^/]+\.mayhem\.json$/.test(p)).sort()[0];
}

export type Level = "red" | "yellow" | "green" | "none";
export type Area = "controls" | "machines" | "settings" | "hardware" | "autos" | "generated" | "code";

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
  /**
   * Robot code that changed where the review can't show what it does (logic in .cpp files, vendored
   * libraries, deploy files). Absent when a snapshot came without content ids.
   */
  otherCode?: CodeChange[];
  /** Team sim proof scenarios (tools/mayhem/scenarios.json) that changed, by name. */
  scenarios?: ScenarioChange[];
  field?: SuiteProject["field"];
  errors: string[];
}

export interface CodeChange {
  path: string;
  kind: "added" | "removed" | "changed";
}
export interface ScenarioChange {
  name: string;
  kind: "added" | "removed" | "changed";
  /** Fewer or different checks: the proof this scenario gives is not the one it gave before. */
  weaker: boolean;
}

/**
 * Robot code that differs between two snapshots and that no other part of the review explains:
 * a constants header counts only when none of its values changed (so its logic did), and the
 * generated header only when nothing it is generated from changed (so it was edited by hand).
 */
export function otherCodeChanges(before: Snapshot, after: Snapshot, settings: SettingChange[], regenerated: boolean): CodeChange[] | undefined {
  if (!before.code || !after.code) return undefined;
  const explained = new Set(settings.flatMap((c) => [c.before?.origin.file, c.after?.origin.file]));
  if (regenerated) explained.add(GENERATED_FILE);
  const out: CodeChange[] = [];
  for (const path of [...new Set([...Object.keys(before.code), ...Object.keys(after.code)])].sort()) {
    const a = before.code[path],
      b = after.code[path];
    if (a === b || explained.has(path)) continue;
    out.push({ path, kind: a === undefined ? "added" : b === undefined ? "removed" : "changed" });
  }
  return out;
}

/** Which team scenarios differ, and whether a changed one checks less than it did. */
export function scenarioChanges(before: string | undefined, after: string | undefined): ScenarioChange[] {
  if (before === after) return [];
  const read = (text: string | undefined) => {
    const byName = new Map<string, { steps: string; expect: string[] }>();
    try {
      for (const s of (text ? JSON.parse(text).scenarios : []) ?? [])
        if (typeof s?.name === "string") byName.set(s.name, { steps: JSON.stringify(s.steps ?? []), expect: (s.expect ?? []).map(String) });
    } catch {
      // An unreadable file is reported by the sim proof; here it reads as no scenarios.
    }
    return byName;
  };
  const a = read(before),
    b = read(after);
  const out: ScenarioChange[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])]) {
    const x = a.get(name),
      y = b.get(name);
    if (!x) out.push({ name, kind: "added", weaker: false });
    else if (!y) out.push({ name, kind: "removed", weaker: true });
    else if (x.steps !== y.steps || x.expect.join("\n") !== y.expect.join("\n"))
      out.push({ name, kind: "changed", weaker: x.steps !== y.steps || x.expect.some((line) => !y.expect.includes(line)) });
  }
  return out;
}

const fileName = (path: string) => path.split("/").pop()!;
const listed = (names: string[], most = 3) => (names.length > most ? `${names.slice(0, most).join(", ")} and ${names.length - most} more` : names.join(", "));

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
  // Code the review can't read: say that it changed, so "no behavior changes" is never claimed
  // about logic nobody looked at. The sim proof is how a person checks it.
  const regenerated = changedFile(MACHINES_FILE) || pa !== pb || (!!pa && changedFile(pa));
  const otherCode = otherCodeChanges(before, after, settings, regenerated);
  if (otherCode?.length)
    findings.push({
      level: "yellow",
      area: "code",
      text: `Other robot code changed: ${listed(otherCode.map((c) => fileName(c.path)))}. Mayhem can't show what ${otherCode.length === 1 ? "it does" : "these do"}; check with the sim proof.`,
    });
  // A sim proof is only as good as its scenarios: a change that removes or loosens one says so.
  const scenarios = scenarioChanges(before.files[SCENARIOS_FILE], after.files[SCENARIOS_FILE]);
  const weaker = scenarios.filter((c) => c.weaker);
  if (weaker.length)
    findings.push({
      level: "yellow",
      area: "code",
      text: `Sim proof scenarios ${weaker.every((c) => c.kind === "removed") ? "removed" : "changed"}: ${listed(weaker.map((c) => `“${c.name}”`))}. They no longer check what they did before.`,
    });
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
    ...(otherCode ? { otherCode } : {}),
    ...(scenarios.length ? { scenarios } : {}),
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
