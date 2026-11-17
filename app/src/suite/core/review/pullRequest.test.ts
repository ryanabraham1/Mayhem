import { describe, expect, it } from "vitest";
import {
  checksState,
  choosePr,
  lookupProblem,
  mergeBlockers,
  mergeMethods,
  mergeNotes,
  mergeSummary,
  prView,
  type PrRepo,
  type PullRequest,
} from "./pullRequest.ts";
import type { Finding } from "./report.ts";

const HEAD = "896f808dcf4d8f4049848edabb78e501a924f8db";
/** Shaped like `gh pr list --json ...` for Team3256/FRC_Offseason_2026 #48. */
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 48,
  title: "Shoot only once lined up; autos arrive facing the hub",
  url: "https://github.com/Team3256/FRC_Offseason_2026/pull/48",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefName: "claude/aim-before-feed",
  headRefOid: HEAD,
  baseRefName: "main",
  mergedAt: null,
  reviewDecision: "",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
  ],
  ...over,
});
const repo: PrRepo = { nameWithOwner: "Team3256/FRC_Offseason_2026", mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "MERGE" };
const methods = mergeMethods(repo);

describe("a branch's pull request", () => {
  it("reads checks: any failure fails, anything unfinished is running", () => {
    expect(checksState(pr().statusCheckRollup)).toMatchObject({ state: "passing", total: 3 });
    expect(checksState([])).toMatchObject({ state: "none" });
    const real = [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" },
    ];
    expect(checksState(real)).toEqual({ state: "failing", failing: ["lint"], pending: ["build"], total: 2 });
    expect(checksState([{ __typename: "StatusContext", context: "deploy", state: "PENDING" }])).toMatchObject({ state: "pending", pending: ["deploy"] });
  });
  it("shows the open PR first, else the newest merged one", () => {
    const merged = pr({ number: 40, state: "MERGED" }), closed = pr({ number: 44, state: "CLOSED" }), open = pr({ number: 41 });
    expect(choosePr([merged, closed, open])?.number).toBe(41);
    expect(choosePr([closed, merged])?.number).toBe(40);
    expect(choosePr([])).toBeUndefined();
  });
  it("uses the repo's preferred merge method first and only allowed ones", () => {
    expect(methods).toEqual(["merge", "squash", "rebase"]);
    expect(mergeMethods({ ...repo, viewerDefaultMergeMethod: "SQUASH" })).toEqual(["squash", "merge", "rebase"]);
    expect(mergeMethods({ ...repo, mergeCommitAllowed: false, viewerDefaultMergeMethod: "MERGE" })).toEqual(["squash", "rebase"]);
  });
  it("can be merged when open, mergeable, checks pass and it is the reviewed commit", () => {
    expect(mergeBlockers(pr(), HEAD, methods)).toEqual([]);
  });
  it("says plainly why it can't be merged", () => {
    expect(mergeBlockers(pr({ state: "MERGED" }), HEAD, methods)).toEqual(["#48 is already merged."]);
    expect(mergeBlockers(pr({ state: "CLOSED" }), HEAD, methods)[0]).toMatch(/closed without merging/);
    expect(mergeBlockers(pr({ isDraft: true }), HEAD, methods)[0]).toMatch(/draft/);
    expect(mergeBlockers(pr(), "0000000", methods)[0]).toMatch(/different version of this branch/);
    expect(mergeBlockers(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), HEAD, methods)).toEqual(["It conflicts with main. Resolve the conflicts first."]);
    expect(mergeBlockers(pr({ mergeable: "UNKNOWN" }), HEAD, methods)[0]).toMatch(/still working out/);
    // PR #48 as it was: lint and labeler failed while the builds still ran.
    const failing = pr({
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "labeler", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" },
      ],
    });
    expect(mergeBlockers(failing, HEAD, methods)).toEqual(["Checks failed: lint, labeler."]);
    expect(mergeBlockers(pr({ statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "QUEUED" }] }), HEAD, methods)).toEqual(["Checks are still running: build."]);
    expect(mergeBlockers(pr({ mergeStateStatus: "BEHIND" }), HEAD, methods)[0]).toMatch(/behind main/);
    expect(mergeBlockers(pr({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), HEAD, methods)).toEqual(["It needs an approving review on GitHub."]);
    expect(mergeBlockers(pr(), HEAD, [])).toEqual(["The repo allows no merge method."]);
  });
  it("explains gh problems without jargon", () => {
    expect(lookupProblem({ kind: "error", missing: true, message: "" })).toMatch(/isn't installed/);
    expect(lookupProblem({ kind: "error", missing: false, message: "To get started with GitHub CLI, please run:  gh auth login" })).toMatch(/isn't signed in/);
    expect(lookupProblem({ kind: "error", missing: false, message: "no git remotes found" })).toMatch(/no GitHub remote/);
    expect(prView({ kind: "found", prs: [], repo }, "claude/x", HEAD)).toMatchObject({ kind: "none", message: expect.stringContaining("claude/x has no pull request") });
    expect(prView({ kind: "found", prs: [pr()], repo }, "claude/aim-before-feed", HEAD)).toMatchObject({ kind: "pr", blockers: [], methods });
  });
  it("restates the merge and surfaces safety findings and the sim proof before confirming", () => {
    expect(mergeSummary(pr(), "merge")).toBe(
      "Merge #48 “Shoot only once lined up; autos arrive facing the hub”: claude/aim-before-feed into main, with a merge commit. GitHub merges commit 896f808 only; if the branch moves first, nothing is merged.",
    );
    const findings: Finding[] = [
      { level: "red", area: "hardware", text: "Shooter motor: neutral mode Brake → Coast (brake/coast)" },
      { level: "yellow", area: "settings", text: "Feed speed 0.5 → 0.6" },
      { level: "green", area: "autos", text: "Auto 2: changed" },
    ];
    const proof = { at: "2026-11-17T00:00:00Z", by: "claude", ran: 12, failed: [], different: [], before: "base" };
    expect(mergeNotes(pr(), findings, proof, "base")).toEqual([
      { tone: "bad", text: "Safety: Shooter motor: neutral mode Brake → Coast (brake/coast)" },
      { tone: "warn", text: "1 other change to review (Summary)." },
      { tone: "good", text: expect.stringMatching(/^Sim proof on 896f808: /) },
    ]);
    expect(mergeNotes(pr(), [], undefined, "base")).toEqual([{ tone: "warn", text: "No sim proof was recorded on 896f808, the commit being merged." }]);
    expect(mergeNotes(pr(), [], { ...proof, failed: ["Tap A"] }, "base")[0].tone).toBe("bad");
    expect(mergeNotes(pr(), [], { ...proof, before: "elsewhere" }, "base")[0].text).toMatch(/not with where it left main/);
  });
});
