import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewReport } from "../core/review/report.ts";
import type { BranchReview } from "./reviewList";

const HEAD = "896f808dcf4d8f4049848edabb78e501a924f8db";
const calls: { name: string; args: Record<string, unknown> }[] = [];
let answers: Record<string, unknown> = {};
vi.mock("../native", () => ({
  desktop: true,
  invoke: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  }),
}));
vi.mock("./reviewList", () => ({ useCommitProof: () => undefined }));
const { PullRequestPanel } = await import("./PullRequestPanel");

const branch = { name: "claude/aim-before-feed", sha: HEAD, base: "base", rev: "origin/claude/aim-before-feed", ahead: 3, subject: "", author: "", date: "", merged: false, hidden: false, recent: true, logs: 0 } as BranchReview;
const report = { findings: [{ level: "red", area: "hardware", text: "Shooter motor: neutral mode Brake → Coast" }] } as unknown as ReviewReport;
const pr = (over = {}) => ({
  number: 48, title: "Shoot only once lined up", url: "https://github.com/Team3256/FRC_Offseason_2026/pull/48", state: "OPEN", isDraft: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: branch.name, headRefOid: HEAD, baseRefName: "main", mergedAt: null, reviewDecision: "",
  statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }], ...over,
});
const repoSettings = { nameWithOwner: "Team3256/FRC_Offseason_2026", mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: "MERGE" };
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};

beforeEach(() => {
  calls.length = 0;
  answers = { review_pr: { kind: "found", prs: [pr()], repo: repoSettings } };
});

describe("merging the reviewed branch's PR", () => {
  it("merges only after confirming, at the reviewed commit, with the repo's usual method", async () => {
    const merged = vi.fn();
    answers.review_pr_merge = "Merged #48.";
    render(<PullRequestPanel repo="/robot" branch={branch} report={report} checkout="main" merged={merged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Merge…/ }));
    expect(calls.some((c) => c.name === "review_pr_merge")).toBe(false);
    expect(screen.getByText(/claude\/aim-before-feed into main, with a merge commit/)).toBeTruthy();
    expect(screen.getByText(/Safety: Shooter motor/)).toBeTruthy();
    expect(screen.getByText(/No sim proof was recorded on 896f808/)).toBeTruthy();
    // A safety change has to be acknowledged first.
    const confirm = screen.getByRole("button", { name: "Merge into main" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await screen.findByText(/Merged #48 into main on GitHub/);
    expect(calls.find((c) => c.name === "review_pr_merge")?.args).toEqual({ repo: "/robot", number: 48, method: "merge", head: HEAD });
    expect(merged).toHaveBeenCalled();
    // Offered, not done: pulling main is its own click.
    expect(calls.some((c) => c.name === "review_update_main")).toBe(false);
    answers.review_update_main = { status: "blocked", message: "Nothing was changed: your local changes would be overwritten", edits: ["robot.mayhem.json"] };
    fireEvent.click(screen.getByRole("button", { name: "Pull main" }));
    await screen.findByText(/Nothing was changed/);
    expect(calls.find((c) => c.name === "review_update_main")?.args).toEqual({ repo: "/robot", keepEdits: false });
    answers.review_update_main = { status: "updated", message: "On main and up to date. Your uncommitted edits were put back.", edits: ["robot.mayhem.json"] };
    fireEvent.click(screen.getByRole("button", { name: /Set my edits aside/ }));
    await screen.findByText(/were put back/);
    expect(calls.filter((c) => c.name === "review_update_main").pop()?.args).toEqual({ repo: "/robot", keepEdits: true });
  });
  it("has no Merge button that works when checks fail, and says why", async () => {
    answers.review_pr = { kind: "found", prs: [pr({ statusCheckRollup: [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" }] })], repo: repoSettings };
    render(<PullRequestPanel repo="/robot" branch={branch} report={report} merged={() => {}} />);
    expect(await screen.findByText(/Checks failed: lint/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Merge…/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows a failed merge without claiming success", async () => {
    answers.review_pr_merge = new Error("Head branch was modified. Review and try the merge again.");
    render(<PullRequestPanel repo="/robot" branch={branch} report={{ findings: [] } as unknown as ReviewReport} merged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Merge…/ }));
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));
    expect(await screen.findByText(/Not merged: .*Head branch was modified/)).toBeTruthy();
    expect(screen.queryByText(/Merged #48/)).toBeNull();
  });
  it("says so plainly without gh, a PR, or when already merged", async () => {
    answers.review_pr = { kind: "error", missing: true, message: "gh not found" };
    const { unmount } = render(<PullRequestPanel repo="/robot" branch={branch} report={report} merged={() => {}} />);
    expect(await screen.findByText(/GitHub CLI \(gh\) isn't installed/)).toBeTruthy();
    unmount();
    answers.review_pr = { kind: "found", prs: [], repo: repoSettings };
    const second = render(<PullRequestPanel repo="/robot" branch={branch} report={report} merged={() => {}} />);
    expect(await screen.findByText(/has no pull request on GitHub/)).toBeTruthy();
    second.unmount();
    answers.review_pr = { kind: "found", prs: [pr({ state: "MERGED" })], repo: repoSettings };
    render(<PullRequestPanel repo="/robot" branch={branch} report={report} merged={() => {}} />);
    expect(await screen.findByText("merged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Merge…/ })).toBeNull();
  });
});
