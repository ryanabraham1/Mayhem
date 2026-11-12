import { canonicalJson } from "./export-cpp.ts";
import type { SuiteProject } from "./model.ts";

/** Comparable text of a project: key order and formatting do not matter. */
export const projectKey = (p: SuiteProject) => canonicalJson(p);

/**
 * What to do with a read of the linked file. `same`: nothing changed since the last read, or the
 * file already matches the working copy. `reload`: adopt it (the working copy has no edits the
 * file lacks). `conflict`: both changed; ask. `synced` is the revision last known to match the
 * file (undefined right after launch, when a newer working copy counts as unsaved edits).
 */
export function diskDecision(
  disk: SuiteProject,
  local: SuiteProject,
  state: { lastDiskKey?: string; synced?: number; conflict: boolean },
): "same" | "reload" | "conflict" {
  const key = projectKey(disk);
  if (key === state.lastDiskKey && !state.conflict) return "same";
  if (key === projectKey(local)) return "same";
  if (state.conflict) return "conflict";
  const unsynced = state.synced === undefined ? local.revision > disk.revision : local.revision !== state.synced;
  return unsynced ? "conflict" : "reload";
}

/** Short, human-readable list of what differs between two versions of a project. */
export function projectDiff(mine: SuiteProject, disk: SuiteProject): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const byId = <T extends { id: string; name?: string }>(label: string, a: T[], b: T[]) => {
    for (const x of a) {
      const y = b.find((v) => v.id === x.id);
      if (!y) out.push(`${label} ${x.name ?? x.id}: only in your copy`);
      else if (!same(x, y)) out.push(`${label} ${x.name ?? x.id}: changed`);
    }
    for (const y of b) if (!a.some((x) => x.id === y.id)) out.push(`${label} ${y.name ?? y.id}: only in the file`);
  };
  if (mine.name !== disk.name) out.push(`Project name: "${mine.name}" here, "${disk.name}" in the file`);
  if (!same(mine.robot, disk.robot)) out.push("Robot setup: changed");
  if (!same(mine.field, disk.field)) out.push("Field: changed");
  byId("Routine", mine.routines, disk.routines);
  const signals = (p: SuiteProject) => p.signals.map((s) => ({ ...s, id: s.key }));
  byId("Input", signals(mine), signals(disk));
  const machines = (p: SuiteProject) =>
    (Array.isArray(p.extensions.machines) ? p.extensions.machines : []).filter(
      (m): m is { id: string; name?: string } => !!m && typeof (m as { id?: unknown }).id === "string",
    );
  byId("State machine", machines(mine), machines(disk));
  const { machines: _a, ...restMine } = mine.extensions;
  const { machines: _b, ...restDisk } = disk.extensions;
  if (!same(restMine, restDisk)) out.push("Other project settings: changed");
  return out;
}
