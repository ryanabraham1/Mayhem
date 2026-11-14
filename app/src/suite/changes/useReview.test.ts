import { describe, expect, it } from "vitest";
import { defaultCompare, type RepoInfo } from "./useReview";

const info = (over: Partial<RepoInfo>): RepoInfo => ({
  root: "/robot",
  branch: "agent/task-1",
  head: "bbb",
  dirty: [],
  revisions: [
    { rev: "main", sha: "old", label: "Robot code", kind: "branch", date: "" },
    { rev: "origin/main", sha: "aaa", label: "Robot code", kind: "remote", date: "" },
  ],
  ...over,
});

describe("what Changes compares when nobody chose", () => {
  it("shows the branch against main when nothing is edited on this computer", () => {
    // origin/main wins over a local main that may be stale.
    expect(defaultCompare(info({}))).toEqual({ before: "origin/main", after: "HEAD" });
    expect(defaultCompare(info({ revisions: [{ rev: "main", sha: "old", label: "", kind: "branch", date: "" }] }))).toEqual({ before: "main", after: "HEAD" });
  });
  it("keeps last commit → this computer when files are edited, on main itself, or without a main", () => {
    expect(defaultCompare(info({ dirty: ["src/main/cpp/Robot.cpp"] }))).toBeUndefined();
    expect(defaultCompare(info({ head: "aaa" }))).toBeUndefined();
    expect(defaultCompare(info({ revisions: [] }))).toBeUndefined();
  });
});
