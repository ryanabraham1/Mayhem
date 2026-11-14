import { Check, EyeOff, FlaskConical, GitBranch, RotateCcw } from "lucide-react";
import { proofText, type ProofSummary } from "../core/review/proofs.ts";
import type { Level } from "../core/review/report.ts";
import { useLogLibrary } from "../logLibrary";
import { Badge, timeAgo, type Tone } from "../ui";
import type { BranchReview } from "./reviewList";

export const LEVEL_TONE: Record<Level, Tone> = { red: "bad", yellow: "warn", green: "good", none: "neutral" };
export const LEVEL_WORD: Record<Level, string> = { red: "safety change", yellow: "review", green: "paths only", none: "no robot code" };

/** How a recorded proof reads at a glance: failed, behaves differently, or clean. */
const proofTone = (proof: ProofSummary): Tone => (proof.failed.length ? "bad" : proof.different.length || proof.partial ? "warn" : "good");
const proofWord = (proof: ProofSummary) => (proof.failed.length ? "failed" : proof.different.length ? "differs" : proof.partial ? "partial" : "passed");

/** The sim proof of a commit: the recorded run, or that there is none, with a way to run it. */
export function ProofLine({ proof, base, run }: { proof?: ProofSummary; base?: string; run?: () => void }) {
  if (!proof)
    return (
      <p className="mx-proof is-none">
        <FlaskConical size={14} />
        <span>Sim proof not run on this commit</span>
        {run && (
          <button type="button" className="mx-btn mx-btn-secondary mx-btn-sm" onClick={run}>
            Run sim proof
          </button>
        )}
      </p>
    );
  const names = proof.failed.length ? proof.failed : proof.different;
  // A run against another version says nothing about what differs from this one.
  const elsewhere = base !== undefined && proof.before !== undefined && proof.before !== base;
  return (
    <div className={`mx-proof is-${elsewhere ? "warn" : proofTone(proof)}`}>
      <p>
        <FlaskConical size={14} />
        <strong>Sim proof: {proofText(proof)}</strong>
        {proof.partial && <Badge tone="warn">some scenarios only</Badge>}
        {elsewhere && <Badge tone="warn">compared with {proof.before!.slice(0, 7)}, not this version</Badge>}
        <small>
          run by {proof.by} · {timeAgo(Date.parse(proof.at))}
        </small>
        {run && (
          <button type="button" className="mx-link" onClick={run}>
            {names.length ? "Watch them" : "Run again"}
          </button>
        )}
      </p>
      {names.length > 0 && (
        <ul>
          {names.slice(0, 5).map((n) => (
            <li key={n}>{n}</li>
          ))}
          {names.length > 5 && <li className="is-more">and {names.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

/** Where a change has got to: committed, in main, on the robot, in a log. */
export function DeliveryLane({ branch, main, openRobot, openLogs }: { branch: BranchReview; main: string; openRobot: () => void; openLogs: () => void }) {
  const lib = useLogLibrary();
  const log = branch.log;
  const steps: { done: boolean | undefined; title: string; detail: string; action?: { label: string; run: () => void } }[] = [
    {
      done: true,
      title: `${branch.ahead} commit${branch.ahead === 1 ? "" : "s"}`,
      detail: `${branch.author} · ${timeAgo(Date.parse(branch.date))}`,
    },
    { done: branch.merged, title: branch.merged ? `In ${main}` : `Not in ${main} yet`, detail: branch.merged ? "Merged" : "Waiting for review" },
    {
      done: branch.merged ? branch.onRobot : false,
      title: branch.onRobot ? "On the robot" : "Not on the robot",
      detail: !branch.merged ? "" : branch.robotCheckedAt ? `as of the check ${timeAgo(branch.robotCheckedAt)}` : "The robot has not been checked",
      action: branch.merged && !branch.onRobot ? { label: "Check robot", run: openRobot } : undefined,
    },
    {
      done: !!log,
      title: log ? "In a log" : "No log with it yet",
      detail: log
        ? `${log.name.replace(/\.wpilog$/i, "")} · ${log.summary?.errors ? `${log.summary.errors} red flag${log.summary.errors === 1 ? "" : "s"}` : "no red flags"}${branch.logs > 1 ? ` · ${branch.logs} logs` : ""}`
        : branch.merged
          ? "Logs name the code they ran"
          : "",
      action: log
        ? {
            label: "Open log",
            run: () => {
              void lib.open(log);
              openLogs();
            },
          }
        : undefined,
    },
  ];
  return (
    <ol className="mx-delivery" aria-label="Where this change is now">
      {steps.map((step) => (
        <li key={step.title} className={step.done ? "is-done" : step.done === false ? "is-todo" : "is-unknown"}>
          <i aria-hidden="true">{step.done && <Check size={12} />}</i>
          <strong>{step.title}</strong>
          <small>{step.detail}</small>
          {step.action && (
            <button type="button" className="mx-link" onClick={step.action.run}>
              {step.action.label}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The furthest a merged change has got, for a chip. */
function reachedChip(b: BranchReview, main: string) {
  if (b.log) return <Badge tone="good">in a log</Badge>;
  if (b.onRobot) return <Badge tone="good">on the robot</Badge>;
  return <Badge tone="accent">in {main}</Badge>;
}

/** One branch as a row to click: what it is, how risky, whether it was proven. */
export function BranchRow({
  branch,
  main,
  selected,
  open,
  setAside,
}: {
  branch: BranchReview;
  main: string;
  selected?: boolean;
  open: () => void;
  /** Present when a person can put the branch away (or bring it back). */
  setAside?: (aside: boolean) => void;
}) {
  return (
    <div className={`mx-branch ${selected ? "is-active" : ""} ${branch.merged ? "is-merged" : ""}`}>
      <button type="button" className="mx-branch-main" aria-current={selected ? "true" : undefined} onClick={open}>
        <span className="mx-branch-name">
          <GitBranch size={13} />
          <strong>{branch.name}</strong>
        </span>
        <small>{branch.subject}</small>
        <small className="mx-branch-meta">
          {branch.ahead} commit{branch.ahead === 1 ? "" : "s"} · {branch.author} · {timeAgo(Date.parse(branch.date))}
        </small>
        <span className="mx-branch-chips">
          {branch.merged ? (
            reachedChip(branch, main)
          ) : (
            <>
              {branch.level && <Badge tone={LEVEL_TONE[branch.level]}>{LEVEL_WORD[branch.level]}</Badge>}
              {branch.proof ? <Badge tone={proofTone(branch.proof)}>sim proof {proofWord(branch.proof)}</Badge> : <Badge>no sim proof</Badge>}
            </>
          )}
        </span>
      </button>
      {setAside && (
        <button
          type="button"
          className="mx-branch-aside"
          aria-label={branch.hidden ? `Bring ${branch.name} back to review` : `Set ${branch.name} aside`}
          title={branch.hidden ? "Bring back to review" : "Set aside until it gets a new commit"}
          onClick={() => setAside(!branch.hidden)}
        >
          {branch.hidden ? <RotateCcw size={13} /> : <EyeOff size={13} />}
        </button>
      )}
    </div>
  );
}
