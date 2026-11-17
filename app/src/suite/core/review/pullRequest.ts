// The GitHub pull request of a reviewed branch, as `gh` reports it, and whether it can be merged
// from the Changes page. Pure: the desktop shell runs gh (github.rs), this decides what it means.
import { proofText, type ProofSummary } from "./proofs.ts";
import type { Finding } from "./report.ts";

/** One check as `gh pr ... --json statusCheckRollup` lists it (a check run or a commit status). */
export interface PrCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergedAt: string | null;
  reviewDecision: string;
  statusCheckRollup: PrCheck[] | null;
}
/** `gh repo view --json ...`: which merge methods the repo allows and which one the viewer uses. */
export interface PrRepo {
  nameWithOwner: string;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  viewerDefaultMergeMethod: string;
}
export type MergeMethod = "merge" | "squash" | "rebase";
export const METHOD_NAMES: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** What the desktop shell found (github.rs `PrLookup`). */
export type PrLookup =
  | { kind: "found"; prs: PullRequest[]; repo: PrRepo }
  | { kind: "error"; missing: boolean; message: string };

export type ChecksState = { state: "passing" | "failing" | "pending" | "none"; failing: string[]; pending: string[]; total: number };

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/** All of a PR's checks in one state: any failure fails, then anything still running is pending. */
export function checksState(checks: PrCheck[] | null | undefined): ChecksState {
  const failing: string[] = [], pending: string[] = [];
  for (const c of checks ?? []) {
    const name = c.name || c.context || "a check";
    if (c.__typename === "StatusContext" || (c.state && !c.status)) {
      const s = (c.state ?? "").toUpperCase();
      if (s === "FAILURE" || s === "ERROR") failing.push(name);
      else if (s !== "SUCCESS") pending.push(name);
      continue;
    }
    if ((c.status ?? "").toUpperCase() !== "COMPLETED") pending.push(name);
    else if (FAILED.has((c.conclusion ?? "").toUpperCase())) failing.push(name);
  }
  const total = checks?.length ?? 0;
  return { state: failing.length ? "failing" : pending.length ? "pending" : total ? "passing" : "none", failing, pending, total };
}

/** The PR to show for a branch: an open one, else the newest merged one, else the newest closed one. */
export function choosePr(prs: PullRequest[]): PullRequest | undefined {
  const by = (state: PullRequest["state"]) => prs.filter((p) => p.state === state).sort((a, b) => b.number - a.number)[0];
  return by("OPEN") ?? by("MERGED") ?? by("CLOSED");
}

/** The methods the repo allows, its preferred one first (the viewer's default, else a merge commit). */
export function mergeMethods(repo: PrRepo): MergeMethod[] {
  const allowed = (["merge", "squash", "rebase"] as MergeMethod[]).filter((m) =>
    m === "merge" ? repo.mergeCommitAllowed : m === "squash" ? repo.squashMergeAllowed : repo.rebaseMergeAllowed,
  );
  const preferred = repo.viewerDefaultMergeMethod?.toLowerCase() as MergeMethod;
  return allowed.includes(preferred) ? [preferred, ...allowed.filter((m) => m !== preferred)] : allowed;
}

const listed = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

/**
 * Why this PR can't be merged from here, in plain words; empty when it can. `reviewed` is the
 * commit the page reviewed (the branch tip it shows).
 */
export function mergeBlockers(pr: PullRequest, reviewed: string | undefined, methods: MergeMethod[]): string[] {
  if (pr.state === "MERGED") return [`#${pr.number} is already merged.`];
  if (pr.state === "CLOSED") return [`#${pr.number} was closed without merging. Reopen it on GitHub to merge it.`];
  const why: string[] = [];
  if (pr.isDraft) why.push("It is a draft. Mark it ready for review on GitHub first.");
  if (reviewed && pr.headRefOid !== reviewed)
    why.push("GitHub has a different version of this branch than the one reviewed here. Look for new commits, review that, then merge.");
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") why.push(`It conflicts with ${pr.baseRefName}. Resolve the conflicts first.`);
  else if (pr.mergeable === "UNKNOWN") why.push("GitHub is still working out whether it can be merged. Try again in a moment.");
  // Failed or running checks are a warning (checkWarning), not a block: GitHub decides whether they
  // are required, and says so with BLOCKED.
  const checks = checksState(pr.statusCheckRollup);
  if (pr.mergeStateStatus === "BEHIND") why.push(`It is behind ${pr.baseRefName}, and the repo requires it to be up to date. Update the branch first.`);
  if (pr.mergeStateStatus === "BLOCKED") {
    if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") why.push("It needs an approving review on GitHub.");
    else if (checks.failing.length || checks.pending.length)
      why.push(`The repo's branch rules require checks to pass before merging. ${checkWarning(checks)}`);
    else why.push("The repo's branch rules block merging it right now.");
  }
  if (!methods.length) why.push("The repo allows no merge method.");
  return why;
}

/** gh's error, said plainly: not installed, not signed in, or what it said. */
export function lookupProblem(lookup: Extract<PrLookup, { kind: "error" }>): string {
  if (lookup.missing) return "The GitHub CLI (gh) isn't installed, so Mayhem can't see pull requests. Install it (brew install gh), run gh auth login, then look again.";
  const m = lookup.message;
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(m)) return "The GitHub CLI isn't signed in. Run gh auth login in a terminal, then look again.";
  if (/no git remotes|not a git repository|none of the git remotes/i.test(m)) return "This folder has no GitHub remote, so it has no pull requests.";
  return `Could not read pull requests from GitHub: ${m}`;
}

/** The PR panel's state for a reviewed branch. */
export type PrView =
  | { kind: "error"; message: string }
  | { kind: "none"; message: string }
  | { kind: "pr"; pr: PullRequest; repo: PrRepo; methods: MergeMethod[]; checks: ChecksState; blockers: string[] };

export function prView(lookup: PrLookup, branch: string, reviewed: string | undefined): PrView {
  if (lookup.kind === "error") return { kind: "error", message: lookupProblem(lookup) };
  const pr = choosePr(lookup.prs);
  if (!pr) return { kind: "none", message: `${branch} has no pull request on GitHub. Open one there (or with gh pr create) to merge it from here.` };
  const methods = mergeMethods(lookup.repo);
  return { kind: "pr", pr, repo: lookup.repo, methods, checks: checksState(pr.statusCheckRollup), blockers: mergeBlockers(pr, reviewed, methods) };
}

/** Failed or still-running checks, said plainly; undefined when they all pass (or there are none). */
export function checkWarning(checks: ChecksState): string | undefined {
  if (checks.failing.length) return `Checks failed: ${listed(checks.failing)}.`;
  if (checks.pending.length) return `Checks are still running: ${listed(checks.pending)}.`;
}

/** What the confirm step restates before merging. */
export function mergeSummary(pr: PullRequest, method: MergeMethod): string {
  const how = method === "merge" ? "with a merge commit" : method === "squash" ? "as one squashed commit" : "by rebasing its commits";
  return `Merge #${pr.number} “${pr.title}”: ${pr.headRefName} into ${pr.baseRefName}, ${how}. GitHub merges commit ${pr.headRefOid.slice(0, 7)} only; if the branch moves first, nothing is merged.`;
}

/** One line of the confirm step: what a person should know before merging. */
export interface MergeNote {
  tone: "bad" | "warn" | "good";
  text: string;
}
/**
 * What the confirm step surfaces: the review's safety (red) findings, other findings to look at,
 * and whether a sim proof was recorded on the PR's head commit against where it left main.
 */
export function mergeNotes(pr: PullRequest, findings: Finding[], proof: ProofSummary | undefined, base: string | undefined): MergeNote[] {
  const notes: MergeNote[] = findings.filter((f) => f.level === "red").map((f) => ({ tone: "bad", text: `Safety: ${f.text}` }));
  const checks = checksState(pr.statusCheckRollup);
  const warning = checkWarning(checks);
  if (warning) notes.unshift({ tone: checks.failing.length ? "bad" : "warn", text: `${warning} Merging now puts this on ${pr.baseRefName} anyway.` });
  const review = findings.filter((f) => f.level === "yellow").length;
  if (review) notes.push({ tone: "warn", text: `${review} other change${review === 1 ? "" : "s"} to review (Summary).` });
  const head = pr.headRefOid.slice(0, 7);
  if (!proof) notes.push({ tone: "warn", text: `No sim proof was recorded on ${head}, the commit being merged.` });
  else if (base !== undefined && proof.before !== undefined && proof.before !== base)
    notes.push({ tone: "warn", text: `The sim proof on ${head} compared it with ${proof.before.slice(0, 7)}, not with where it left ${pr.baseRefName}.` });
  else notes.push({ tone: proof.failed.length ? "bad" : proof.different.length || proof.partial ? "warn" : "good", text: `Sim proof on ${head}: ${proofText(proof)}${proof.partial ? " (some scenarios only)" : ""}.` });
  return notes;
}
