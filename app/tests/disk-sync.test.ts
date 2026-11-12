import { beforeEach, describe, expect, it } from "vitest";
import { diskDecision, projectDiff, projectKey } from "../src/suite/core/diskSync.ts";
import { parseProject, type SuiteProject } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample";
import { keepCopy, listProjects, projectLink, saveProject, setProjectLink } from "../src/suite/storage.ts";

const load = (): SuiteProject => parseProject(JSON.stringify(sampleProject));
const revised = (p: SuiteProject, revision: number, edit: (p: SuiteProject) => void = () => {}) => {
  const next = { ...structuredClone(p), revision };
  edit(next);
  return next;
};

describe("linked file changes", () => {
  it("ignore formatting and key order, and reloads only real changes", () => {
    const local = load();
    const reordered = parseProject(JSON.stringify(Object.fromEntries(Object.entries(local).reverse()), null, 4));
    expect(projectKey(reordered)).toBe(projectKey(local));
    expect(diskDecision(reordered, local, { conflict: false })).toBe("same");
    const disk = revised(local, local.revision + 1, (p) => (p.name = "Agent"));
    expect(diskDecision(disk, local, { conflict: false, synced: local.revision })).toBe("reload");
    // Already seen: no repeated reloads.
    expect(diskDecision(disk, local, { conflict: false, synced: local.revision, lastDiskKey: projectKey(disk) })).toBe("same");
    // Same revision, different content (e.g. a git checkout): still a change.
    expect(diskDecision(revised(local, local.revision, (p) => (p.name = "B")), local, { conflict: false, synced: local.revision })).toBe("reload");
  });
  it("ask when this copy has edits the file lacks", () => {
    const local = revised(load(), 7, (p) => (p.name = "Mine"));
    const disk = revised(local, 7, (p) => (p.name = "Theirs"));
    expect(diskDecision(disk, local, { conflict: false, synced: 6 })).toBe("conflict");
    expect(diskDecision(disk, local, { conflict: true, synced: 7 })).toBe("conflict");
    // Right after launch: a newer working copy counts as unsaved edits, an older one reloads.
    expect(diskDecision(revised(disk, 5), local, { conflict: false })).toBe("conflict");
    expect(diskDecision(revised(disk, 9), local, { conflict: false })).toBe("reload");
  });
  it("summarize the differences", () => {
    const mine = load();
    const disk = revised(mine, mine.revision + 1, (p) => {
      p.name = "Other";
      p.robot.length += 0.1;
      p.routines[0].name = "Renamed";
      p.extensions.machines = [{ id: "ShotCycle", name: "Shot cycle" }];
    });
    expect(projectDiff(mine, disk)).toEqual([
      `Project name: "${mine.name}" here, "Other" in the file`,
      "Robot setup: changed",
      `Routine ${mine.routines[0].name}: changed`,
      "State machine Shot cycle: only in the file",
    ]);
  });
});

describe("project file links", () => {
  beforeEach(() => localStorage.clear());
  it("remember the file per project and keep copies of local edits", () => {
    expect(projectLink("a")).toBeNull();
    setProjectLink("a", "/robot/robot.mayhem.json");
    setProjectLink("b", "/other.json");
    setProjectLink("b", null);
    expect([projectLink("a"), projectLink("b")]).toEqual(["/robot/robot.mayhem.json", null]);
    const p = load();
    saveProject(p);
    const copy = keepCopy(p, "my edits");
    expect(copy.id).not.toBe(p.id);
    expect(listProjects().map((x) => x.name)).toEqual([p.name, `${p.name} (my edits)`]);
  });
});
