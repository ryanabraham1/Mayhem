import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Cpu,
  FileCode2,
  FileSearch,
  FlaskConical,
  FolderGit2,
  Gamepad2,
  GitBranch,
  GitCompare,
  LayoutList,
  Navigation,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { LEVEL_TEXT, WORKTREE, type Area, type Level, type ReviewReport } from "../core/review/report.ts";
import { desktop } from "../native";
import { chooseRepo as pickRepo, useAuthor } from "../robotRepo";
import { setRobotTab } from "../robot/RobotPage";
import { summarizeProof } from "../core/review/simproof.ts";
import { Badge, Button, EmptyState, FileButton, PageHeader, Segmented, type Tone } from "../ui";
import { AutosView } from "./AutosView";
import { ControlsView } from "./ControlsView";
import { EditSetting, type EditTarget } from "./EditSetting";
import { HardwareView } from "./HardwareView";
import { MachinesView } from "./MachinesView";
import { SettingsView } from "./SettingsView";
import { SimProofView } from "./SimProofView";
import { CommitsPanel } from "./CommitsPanel";
import { BranchRow, DeliveryLane, ProofLine } from "./ReviewParts";
import { useCommitProof, useReviews } from "./reviewList";
import { useReview, type Review } from "./useReview";
import "./changes.css";

type Tab = "summary" | Exclude<Area, "generated" | "code"> | "sim";
const TABS: { value: Tab; label: string; icon: typeof Cpu }[] = [
  { value: "summary", label: "Summary", icon: LayoutList },
  { value: "controls", label: "Controls", icon: Gamepad2 },
  { value: "machines", label: "State machines", icon: GitBranch },
  { value: "settings", label: "Values", icon: SlidersHorizontal },
  { value: "hardware", label: "Hardware", icon: Cpu },
  { value: "autos", label: "Autos", icon: Navigation },
  { value: "sim", label: "Sim proof", icon: FlaskConical },
];
const LEVEL_TONE: Record<Level, Tone> = { red: "bad", yellow: "warn", green: "good", none: "neutral" };

function RevisionPicker({ review, side, named }: { review: Review; side: "before" | "after"; named?: string }) {
  const value = side === "before" ? review.before : review.after;
  const set = side === "before" ? review.setBefore : review.setAfter;
  const info = review.info;
  const group = (kind: string) => info?.revisions.filter((r) => r.kind === kind) ?? [];
  const known = value === WORKTREE || value === "HEAD" || info?.revisions.some((r) => r.rev === value);
  return (
    <label className="mx-rev-picker">
      <span>{side === "before" ? "Before" : "After"}</span>
      <select value={value} onChange={(e) => set(e.target.value)} aria-label={`${side === "before" ? "Before" : "After"} version`}>
        <option value={WORKTREE}>
          This computer (not committed){info?.dirty.length ? ` · ${info.dirty.length} file${info.dirty.length === 1 ? "" : "s"} edited` : ""}
        </option>
        <option value="HEAD">Last commit{info ? ` on ${info.branch}` : ""}</option>
        {!known && <option value={value}>{named ?? (/^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value)}</option>}
        {(["branch", "remote", "tag", "commit"] as const).map((kind) =>
          group(kind).length ? (
            <optgroup key={kind} label={{ branch: "Branches", remote: "Branches on GitHub", tag: "Tags", commit: "Recent commits" }[kind]}>
              {group(kind).map((r) => (
                <option key={`${kind}:${r.rev}`} value={r.rev}>
                  {kind === "commit" ? `${r.sha.slice(0, 7)} ${r.label}` : `${r.rev} · ${r.label}`}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </label>
  );
}

function Summary({ report, go }: { report: ReviewReport; go: (tab: Tab) => void }) {
  const count = (area: Area) => report.findings.filter((f) => f.area === area).length;
  const areas: { area: Area; title: string; icon: typeof Cpu; empty: string }[] = [
    { area: "controls", title: "Driver controls", icon: Gamepad2, empty: "Same buttons, same outcomes" },
    { area: "machines", title: "State machines", icon: GitBranch, empty: "No changes" },
    { area: "settings", title: "Values", icon: SlidersHorizontal, empty: "No changes" },
    { area: "hardware", title: "Hardware", icon: Cpu, empty: "No changes" },
    { area: "autos", title: "Autos", icon: Navigation, empty: "No path changes" },
    { area: "generated", title: "Generated robot code", icon: RefreshCw, empty: "Up to date" },
    // Code the review can't read; older review files don't know whether any changed.
    { area: "code", title: "Other code", icon: FileCode2, empty: report.otherCode ? "Nothing else changed" : "Not checked" },
  ];
  // Where a finding is looked at: its own tab, the sim proof for code only a run can show.
  const tabFor = (area: Area): Tab => (area === "generated" ? "summary" : area === "code" ? "sim" : area);
  return (
    <div className="mx-review-summary">
      <div className="mx-area-cards">
        {areas.map(({ area, title, icon: Icon, empty }) => {
          const n = count(area);
          const level = report.findings.filter((f) => f.area === area).reduce<Level>((l, f) => (f.level === "red" || l === "red" ? "red" : f.level === "yellow" || l === "yellow" ? "yellow" : "green"), n ? "green" : "none");
          return (
            <button key={area} type="button" className={`mx-area-card is-${level}`} onClick={() => go(tabFor(area))}>
              <Icon size={18} />
              <strong>{title}</strong>
              <span>{area === "code" && report.otherCode?.length ? `${report.otherCode.length} file${report.otherCode.length === 1 ? "" : "s"} changed` : n ? `${n} change${n === 1 ? "" : "s"}` : empty}</span>
            </button>
          );
        })}
      </div>
      {report.findings.length > 0 && (
        <ul className="mx-findings">
          {report.findings.map((f, i) => (
            <li key={i} className={`is-${f.level}`}>
              <Badge tone={LEVEL_TONE[f.level]}>{f.level === "red" ? "safety" : f.level === "yellow" ? "review" : "ok"}</Badge>
              <button type="button" className="mx-link" onClick={() => go(tabFor(f.area))}>
                {f.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      {report.errors.map((e) => (
        <p key={e} className="mx-help is-bad">
          {e}
        </p>
      ))}
    </div>
  );
}

export function ChangesPage({ notify, go }: { notify: (message: string) => void; go: (page: "robot" | "logs") => void }) {
  const review = useReview();
  const reviews = useReviews();
  const [author] = useAuthor();
  const [tab, setTab] = useState<Tab>("summary");
  const [editing, setEditing] = useState<EditTarget>();
  const { report } = review;

  // A proof that ran on a commit is kept on that commit, so whoever reviews it next sees this
  // run's result.
  const kept = useRef<unknown>(undefined);
  const { proof, revs } = review.sim;
  useEffect(() => {
    if (!proof || !revs || kept.current === proof || revs.after === WORKTREE) return;
    kept.current = proof;
    const summary = { ...summarizeProof(proof, { by: author || "someone", before: revs.before === WORKTREE ? undefined : revs.before }), at: new Date().toISOString() };
    void reviews.saveProof(revs.after, summary).catch((e) => notify(`The sim proof ran, but its result could not be kept on the commit: ${String(e)}`));
  }, [proof, revs, author, reviews, notify]);

  // The two versions on screen, and the branch they are when they are one.
  const beforeSha = review.snapshots?.before.rev;
  const afterSha = review.snapshots && review.after !== WORKTREE ? review.snapshots.after.rev : undefined;
  const everyBranch = [...reviews.toReview, ...reviews.merged, ...reviews.others];
  const branch = everyBranch.find((b) => b.sha === afterSha && b.base === beforeSha);
  const recorded = useCommitProof(afterSha, beforeSha === WORKTREE ? undefined : beforeSha);
  // People say "main", whether it was read from this computer or from GitHub.
  const mainName = "main";
  const show = (b: { base: string; sha: string }) => {
    review.setImported(undefined);
    review.setBefore(b.base);
    review.setAfter(b.sha);
    setTab("summary");
  };
  const runProof = () => {
    setTab("sim");
    void review.sim.start();
  };
  const named = (sha: string) => {
    const tip = everyBranch.find((b) => b.sha === sha);
    const left = everyBranch.find((b) => b.base === sha);
    return tip ? tip.name : left ? `where ${left.name} left ${mainName}` : undefined;
  };

  const chooseRepo = () => pickRepo(review.setRepo);
  const importReport = async (file?: File) => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      if (value?.format !== "mayhem-review") throw new Error("Not a Mayhem review file (node scripts/mayhem.mjs review <repo> --json).");
      review.setImported(value);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const repoName = review.info?.root.split("/").pop() ?? review.repo.split("/").pop();
  return (
    <div className="mx-page-scroll mx-changes">
      <PageHeader
        title="Changes"
        subtitle="What a code change does to the robot: controls, state machines, values, hardware and autos, read straight from the code."
        actions={
          <>
            {desktop ? (
              <Button icon={FolderGit2} onClick={() => void chooseRepo()}>
                {review.repo ? repoName : "Choose robot code folder"}
              </Button>
            ) : null}
            <FileButton accept=".json" icon={FileSearch} onFile={(f) => void importReport(f)}>
              Open review file
            </FileButton>
          </>
        }
      />
      <div className={desktop && review.repo ? "mx-changes-layout" : undefined}>
        {desktop && review.repo && (
          <aside className="mx-branches" aria-label="Branches">
            <section aria-label="To review">
              <header>
                <strong>To review</strong>
                <Badge tone={reviews.toReview.length ? "warn" : "neutral"}>{reviews.toReview.length}</Badge>
                <button type="button" className="mx-icon-btn" aria-label="Look for new commits" title="Look for new commits" disabled={reviews.loading} onClick={() => void reviews.reload()}>
                  <RefreshCw size={14} />
                </button>
              </header>
              {reviews.toReview.map((b) => (
                <BranchRow key={b.name} branch={b} main={mainName} selected={branch?.name === b.name} open={() => show(b)} setAside={(aside) => reviews.setAside(b, aside)} />
              ))}
              {!reviews.toReview.length && (
                <p className="mx-help">{reviews.main ? `Nothing is waiting. A branch shows up here when it has commits ${mainName} doesn't.` : "This folder has no main branch to review against."}</p>
              )}
              {reviews.error && <p className="mx-help is-bad">{reviews.error}</p>}
            </section>
            {reviews.merged.length > 0 && (
              <section aria-label="Merged">
                <header>
                  <strong>Merged</strong>
                  <Badge>{reviews.merged.length}</Badge>
                </header>
                {reviews.merged.map((b) => (
                  <BranchRow key={b.name} branch={b} main={mainName} selected={branch?.name === b.name} open={() => show(b)} />
                ))}
              </section>
            )}
            {reviews.others.length > 0 && (
              <details>
                <summary>
                  Older or set aside <Badge>{reviews.others.length}</Badge>
                </summary>
                {reviews.others.map((b) => (
                  <BranchRow key={b.name} branch={b} main={mainName} selected={branch?.name === b.name} open={() => show(b)} setAside={b.hidden ? (aside) => reviews.setAside(b, aside) : undefined} />
                ))}
              </details>
            )}
          </aside>
        )}
        <div className="mx-changes-body">
          {desktop && review.repo && !review.imported && (
            <div className="mx-rev-bar">
              <RevisionPicker review={review} side="before" named={named(review.before)} />
              <ArrowRight size={16} aria-hidden="true" />
              <RevisionPicker review={review} side="after" named={named(review.after)} />
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void review.reload()} disabled={review.loading}>
                {review.loading ? "Reading…" : "Reload"}
              </Button>
            </div>
          )}
          {review.imported && (
            <p className="mx-help">
              Showing a saved review: {review.imported.before.label} → {review.imported.after.label}.{" "}
              {desktop && review.repo && (
                <button type="button" className="mx-link" onClick={() => review.setImported(undefined)}>
                  Back to the live repo
                </button>
              )}
            </p>
          )}
          {review.error && <p className="mx-help is-bad">{review.error}</p>}
          {!report && review.repo && !review.error && desktop ? (
            <p className="mx-help" role="status">
              Reading the robot code…
            </p>
          ) : !report ? (
            <EmptyState icon={GitCompare} title={desktop ? "Choose the robot code folder" : "Open a review file"}
              action={desktop ? <Button variant="primary" icon={FolderGit2} onClick={() => void chooseRepo()}>Choose robot code folder</Button> : undefined}>
              {desktop
                ? "Pick the robot repository (for example FRC_Offseason_2026). Mayhem compares two versions of it and shows what changes on the robot."
                : "In the browser, open a review made with: node scripts/mayhem.mjs review <robot repo> [before] [after] --json > review.json"}
            </EmptyState>
          ) : (
            <>
              <div className="mx-tab-row">
              <Segmented
                label="Review sections"
                value={tab}
                onChange={setTab}
                options={TABS.map((t) => {
                  const n =
                    t.value === "summary"
                      ? 0
                      : t.value === "sim"
                        ? (review.sim.proof?.results.filter((r) => r.failed || r.differences.length).length ?? 0)
                        : report.findings.filter((f) => f.area === t.value).length;
                  return { value: t.value, icon: t.icon, label: n ? `${t.label} · ${n}` : t.label };
                })}
              />
                <span className={`mx-risk-chip is-${report.level}`} role="status" title={`${report.before.label} → ${report.after.label}`}>
                  {report.level === "red" ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                  {LEVEL_TEXT[report.level]}
                </span>
              </div>
              <div className="mx-review-body">
                {tab === "summary" && (
                  <>
                    {branch && (
                      <DeliveryLane
                        branch={branch}
                        main={mainName}
                        openRobot={() => {
                          setRobotTab("now");
                          go("robot");
                        }}
                        openLogs={() => go("logs")}
                      />
                    )}
                    {afterSha && !review.imported && <ProofLine proof={recorded} base={beforeSha === WORKTREE ? undefined : beforeSha} run={desktop ? runProof : undefined} />}
                    <Summary report={report} go={setTab} />
                    <CommitsPanel review={review} />
                  </>
                )}
                {tab === "controls" && <ControlsView report={report} />}
                {tab === "machines" && <MachinesView report={report} />}
                {tab === "settings" && <SettingsView report={report} review={review} editSetting={setEditing} />}
                {tab === "hardware" && <HardwareView report={report} review={review} editSetting={setEditing} />}
                {tab === "autos" && <AutosView report={report} />}
                {tab === "sim" && <SimProofView report={report} review={review} />}
              </div>
            </>
          )}
        </div>
      </div>
      {editing && <EditSetting review={review} target={editing} close={() => setEditing(undefined)} />}
    </div>
  );
}
