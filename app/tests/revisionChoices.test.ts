import { describe, expect, it } from "vitest";
import { ago, describeRevision, revisionSections, SHOWN } from "../src/suite/changes/revisionChoices";
import type { RepoInfo, Revision } from "../src/suite/changes/useReview";

const day = (n: number) => new Date(Date.UTC(2026, 10, 16) - n * 86400e3).toISOString();
const rev = (rev: string, kind: Revision["kind"], sha: string, d: number, label = `${rev} work`): Revision => ({ rev, kind, sha, date: day(d), label });
const info: RepoInfo = {
  root: "/r",
  branch: "main",
  head: "m1",
  dirty: ["a.cpp"],
  revisions: [
    rev("main", "branch", "m1", 0),
    rev("origin/main", "remote", "m1", 0),
    rev("origin", "remote", "m1", 0),
    rev("defense", "branch", "d1", 2),
    rev("origin/defense", "remote", "d2", 1),
    rev("slide-pid", "branch", "s1", 3),
    rev("origin/slide-pid", "remote", "s1", 3),
    rev("origin/trench", "remote", "t1", 4),
    ...Array.from({ length: 12 }, (_, i) => rev(`origin/codex/path-previews/pr-${i}`, "remote", `p${i}`, 10 + i)),
    rev("m1", "commit", "m1", 0, "Drop project log rules"),
  ],
};

describe("version picker list", () => {
  const sections = revisionSections(info, "", new Set());
  const branches = sections.find((s) => s.title === "Branches")!;
  it("starts with this computer, the last commit and main", () => {
    expect(sections[0].choices.map((c) => c.title)).toEqual(["This computer (not committed)", "Last commit on main", "main"]);
    expect(sections[0].choices[0].detail).toBe("1 file edited");
  });
  it("lists each branch once, newest first, saying where it lives", () => {
    const names = branches.choices.filter((c) => !c.child).map((c) => c.title);
    expect(names.slice(0, 3)).toEqual(["defense", "slide-pid", "trench"]);
    expect(names).not.toContain("main"); // suggested above
    expect(names).not.toContain("origin");
    expect(branches.choices.find((c) => c.title === "trench")).toMatchObject({ value: "origin/trench", notes: ["only on GitHub"] });
    expect(branches.choices.find((c) => c.title === "slide-pid")!.notes).toEqual([]);
  });
  it("offers GitHub's copy under a branch whose copies differ", () => {
    const i = branches.choices.findIndex((c) => c.title === "defense");
    expect(branches.choices[i].notes).toEqual(["GitHub has newer commits"]);
    expect(branches.choices[i + 1]).toMatchObject({ value: "origin/defense", child: true });
  });
  it("shows the newest branches until asked for more, and everything when searching", () => {
    expect(branches.choices.filter((c) => !c.child)).toHaveLength(SHOWN);
    expect(branches.hidden).toBe(15 - SHOWN);
    expect(revisionSections(info, "", new Set(["Branches"])).find((s) => s.title === "Branches")!.hidden).toBe(0);
    const found = revisionSections(info, "pr-11", new Set());
    expect(found.find((s) => s.title === "Branches")!.choices.map((c) => c.title)).toEqual(["codex/path-previews/pr-11"]);
  });
  it("searches subjects and lets any commit be typed in", () => {
    expect(revisionSections(info, "log rules", new Set()).flatMap((s) => s.choices.map((c) => c.value))).toContain("m1");
    const typed = revisionSections(info, "HEAD~3", new Set());
    expect(typed.at(-1)!.choices[0]).toMatchObject({ value: "HEAD~3" });
  });
  it("describes the chosen version and its age", () => {
    expect(describeRevision(info, "origin/trench")).toMatchObject({ title: "trench", detail: "origin/trench work" });
    expect(ago(day(2), Date.UTC(2026, 10, 16))).toBe("2 d ago");
    expect(ago(new Date(Date.UTC(2026, 10, 16) - 3 * 3600e3).toISOString(), Date.UTC(2026, 10, 16))).toBe("3 h ago");
  });
});
