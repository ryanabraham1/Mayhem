import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, ExternalLink, GitMerge, GitPullRequest, LoaderCircle, ShieldAlert, TriangleAlert, X } from "lucide-react";
import {
  mergeNotes,
  checkWarning,
  mergeSummary,
  METHOD_NAMES,
  prView,
  type MergeMethod,
  type PrLookup,
  type PrView,
  type PullRequest,
} from "../core/review/pullRequest.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { desktop, invoke } from "../native";
import { Badge, Button } from "../ui";
import { useCommitProof, type BranchReview } from "./reviewList";

/** review_update_main's answer (github.rs `MainUpdate`). */
interface MainUpdate {
  status: "updated" | "blocked" | "kept";
  message: string;
  edits: string[];
}

const openUrl = (url: string) => {
  if (desktop) void import("@tauri-apps/plugin-shell").then((m) => m.open(url));
  else window.open(url, "_blank", "noopener");
};

/** The branch's PR as gh reports it, looked up again whenever the branch or its tip changes. */
function usePullRequest(repo: string, branch: BranchReview) {
  const [lookup, setLookup] = useState<{ key: string; value: PrLookup }>();
  const [loading, setLoading] = useState(false);
  const key = `${repo}\n${branch.name}\n${branch.sha}`;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await invoke<PrLookup | null>("review_pr", { repo, branch: branch.name });
      // Anything else is a shell that doesn't know the command: say so instead of failing the page.
      const known = value && (value.kind === "error" || (value.kind === "found" && Array.isArray(value.prs) && value.repo));
      setLookup({ key, value: known ? value : { kind: "error", missing: false, message: "this version of the desktop shell can't look up pull requests" } });
    } catch (e) {
      setLookup({ key, value: { kind: "error", missing: false, message: String(e) } });
    } finally {
      setLoading(false);
    }
  }, [repo, branch.name, key]);
  useEffect(() => {
    void load();
  }, [load]);
  const view: PrView | undefined = lookup?.key === key ? prView(lookup.value, branch.name, branch.sha) : undefined;
  return { view, loading, reload: load };
}

function ChecksBadge({ view }: { view: Extract<PrView, { kind: "pr" }> }) {
  const { checks } = view;
  if (checks.state === "none") return <Badge>no checks</Badge>;
  if (checks.state === "passing") return <Badge tone="good">checks pass</Badge>;
  if (checks.state === "pending") return <Badge tone="warn">checks running · {checks.pending.length}</Badge>;
  return <Badge tone="bad">checks failed · {checks.failing.length}</Badge>;
}

function stateBadge(pr: PullRequest) {
  if (pr.state === "MERGED") return <Badge tone="accent">merged</Badge>;
  if (pr.state === "CLOSED") return <Badge>closed</Badge>;
  if (pr.isDraft) return <Badge>draft</Badge>;
  if (pr.mergeable === "CONFLICTING") return <Badge tone="bad">conflicts</Badge>;
  if (pr.mergeable === "UNKNOWN") return <Badge>checking mergeability</Badge>;
  return <Badge tone="good">mergeable</Badge>;
}

/**
 * The reviewed branch's pull request: state, checks and a Merge button. Merging is a confirmed step
 * that restates what is merged into what, the review's safety findings and the head commit's sim
 * proof. Afterwards it offers to bring this computer's checkout to the new main.
 */
export function PullRequestPanel({
  repo,
  branch,
  report,
  checkout,
  merged,
}: {
  repo: string;
  branch: BranchReview;
  report: ReviewReport;
  /** The branch this computer has checked out. */
  checkout?: string;
  /** Refresh the branch list and the review. */
  merged: () => Promise<void> | void;
}) {
  const { view, loading, reload } = usePullRequest(repo, branch);
  const pr = view?.kind === "pr" ? view.pr : undefined;
  const proof = useCommitProof(pr?.headRefOid, branch.base);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ number: number; base: string }>();
  const [update, setUpdate] = useState<MainUpdate>();
  const [updating, setUpdating] = useState(false);

  const updateMain = async (keepEdits: boolean) => {
    setUpdating(true);
    try {
      setUpdate(await invoke<MainUpdate>("review_update_main", { repo, keepEdits }));
    } catch (e) {
      setUpdate({ status: "blocked", message: String(e), edits: [] });
    } finally {
      setUpdating(false);
      await merged();
    }
  };

  if (!view)
    return (
      <p className="mx-pr is-quiet" role="status">
        <LoaderCircle size={14} className="mx-spin" /> Looking for a pull request on GitHub…
      </p>
    );
  if (view.kind !== "pr")
    return (
      <p className={`mx-pr is-quiet${view.kind === "error" ? " is-bad" : ""}`}>
        <GitPullRequest size={14} />
        <span>{view.message}</span>
        <button type="button" className="mx-link" disabled={loading} onClick={() => void reload()}>
          Look again
        </button>
      </p>
    );
  const { blockers } = view;
  return (
    <section className="mx-pr" aria-label="Pull request">
      <header>
        <GitPullRequest size={16} />
        <strong>
          #{view.pr.number} {view.pr.title}
        </strong>
        <button type="button" className="mx-link" onClick={() => openUrl(view.pr.url)} title={view.pr.url}>
          GitHub <ExternalLink size={12} />
        </button>
      </header>
      <div className="mx-pr-status">
        {stateBadge(view.pr)}
        {view.pr.state === "OPEN" && <ChecksBadge view={view} />}
        <small>
          {view.pr.headRefName} → {view.pr.baseRefName}
        </small>
        <span className="mx-pr-actions">
          <button type="button" className="mx-link" disabled={loading} onClick={() => void reload()}>
            {loading ? "Looking…" : "Refresh"}
          </button>
          {view.pr.state === "OPEN" && (
            <Button size="sm" variant="primary" icon={GitMerge} disabled={blockers.length > 0 || loading} onClick={() => setConfirming(true)}>
              Merge…
            </Button>
          )}
        </span>
      </div>
      {view.pr.state === "OPEN" && blockers.length > 0 && (
        <ul className="mx-pr-blockers" aria-label="Why it can't be merged">
          {blockers.map((b) => (
            <li key={b}>
              <CircleX size={13} /> {b}
            </li>
          ))}
        </ul>
      )}
      {view.pr.state === "OPEN" && blockers.length === 0 && checkWarning(view.checks) && (
        <ul className="mx-pr-blockers is-warn" aria-label="Checks">
          <li>
            <TriangleAlert size={13} /> {checkWarning(view.checks)} You can still merge.
          </li>
        </ul>
      )}
      {done && (
        <div className="mx-callout is-good" role="status">
          <CircleCheck size={16} />
          <div>
            <p>
              Merged #{done.number} into {done.base} on GitHub.
              {checkout === done.base ? ` This computer is on ${done.base}; pull to get the merge.` : ` This computer has ${checkout ?? "another branch"} checked out.`}
            </p>
            {!update && (
              <p className="mx-pr-actions">
                <Button size="sm" disabled={updating} onClick={() => void updateMain(false)}>
                  {checkout === done.base ? `Pull ${done.base}` : `Switch to ${done.base} and pull`}
                </Button>
                <small>Uncommitted edits (like robot.mayhem.json) stay as they are; git stops rather than overwrite them.</small>
              </p>
            )}
          </div>
        </div>
      )}
      {update && (
        <div className={`mx-callout is-${update.status === "updated" ? "good" : "warn"}`} role="status">
          {update.status === "updated" ? <CircleCheck size={16} /> : <TriangleAlert size={16} />}
          <div>
            <p>{update.message}</p>
            {update.status === "blocked" && update.edits.length > 0 && (
              <p className="mx-pr-actions">
                <Button size="sm" disabled={updating} onClick={() => void updateMain(true)}>
                  Set my edits aside, pull, put them back
                </Button>
                <small>
                  Uses git stash for {update.edits.join(", ")}. If {view.pr.baseRefName} changed the same files, your edits stay in the stash instead of being overwritten.
                </small>
              </p>
            )}
          </div>
        </div>
      )}
      {confirming && (
        <ConfirmMerge
          view={view}
          report={report}
          notes={mergeNotes(view.pr, report.findings, proof, branch.base)}
          close={() => setConfirming(false)}
          merge={async (method) => {
            await invoke<string>("review_pr_merge", { repo, number: view.pr.number, method, head: view.pr.headRefOid });
            setConfirming(false);
            setDone({ number: view.pr.number, base: view.pr.baseRefName });
            setUpdate(undefined);
            await merged();
            await reload();
          }}
        />
      )}
    </section>
  );
}

function ConfirmMerge({
  view,
  report,
  notes,
  close,
  merge,
}: {
  view: Extract<PrView, { kind: "pr" }>;
  report: ReviewReport;
  notes: ReturnType<typeof mergeNotes>;
  close: () => void;
  merge: (method: MergeMethod) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [method, setMethod] = useState<MergeMethod>(view.methods[0]);
  const [merging, setMerging] = useState(false);
  const [failure, setFailure] = useState<string>();
  const safety = report.findings.some((f) => f.level === "red");
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);
  const go = async () => {
    setMerging(true);
    setFailure(undefined);
    try {
      await merge(method);
    } catch (e) {
      setFailure(`Not merged: ${String(e)}`);
    } finally {
      setMerging(false);
    }
  };
  return (
    <dialog ref={dialog} className="mx-dialog mx-merge-dialog" aria-label="Merge pull request" onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>
            Merge #{view.pr.number} into {view.pr.baseRefName}?
          </h2>
          <p>{view.repo.nameWithOwner}</p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <p>{mergeSummary(view.pr, method)}</p>
      {view.methods.length > 1 && (
        <label className="mx-edit-value">
          <span>How</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)}>
            {view.methods.map((m, i) => (
              <option key={m} value={m}>
                {METHOD_NAMES[m]}
                {i === 0 ? " (this repo's usual)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {notes.map((n) => (
        <div key={n.text} className={`mx-callout is-${n.tone}`}>
          {n.tone === "bad" ? <ShieldAlert size={16} /> : n.tone === "warn" ? <TriangleAlert size={16} /> : <CircleCheck size={16} />}
          <span>{n.text}</span>
        </div>
      ))}
      {safety && (
        <label className="mx-merge-ack">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          I've looked at the safety changes above and want them on {view.pr.baseRefName}.
        </label>
      )}
      {failure && <p className="mx-help is-bad">{failure}</p>}
      <div className="mx-dialog-actions">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" icon={GitMerge} disabled={merging || (safety && !checked)} onClick={() => void go()}>
          {merging ? "Merging…" : `Merge into ${view.pr.baseRefName}`}
        </Button>
      </div>
    </dialog>
  );
}
