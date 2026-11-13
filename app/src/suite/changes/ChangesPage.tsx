import { useState } from "react";
import {
  ArrowRight,
  Cpu,
  FileSearch,
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
import { Badge, Button, EmptyState, FileButton, PageHeader, Segmented, type Tone } from "../ui";
import { AutosView } from "./AutosView";
import { ControlsView } from "./ControlsView";
import { EditSetting, type EditTarget } from "./EditSetting";
import { HardwareView } from "./HardwareView";
import { MachinesView } from "./MachinesView";
import { SettingsView } from "./SettingsView";
import { useReview, type Review } from "./useReview";
import "./changes.css";

type Tab = "summary" | Area;
const TABS: { value: Tab; label: string; icon: typeof Cpu }[] = [
  { value: "summary", label: "Summary", icon: LayoutList },
  { value: "controls", label: "Controls", icon: Gamepad2 },
  { value: "machines", label: "State machines", icon: GitBranch },
  { value: "settings", label: "Values", icon: SlidersHorizontal },
  { value: "hardware", label: "Hardware", icon: Cpu },
  { value: "autos", label: "Autos", icon: Navigation },
];
const LEVEL_TONE: Record<Level, Tone> = { red: "bad", yellow: "warn", green: "good", none: "neutral" };

function RevisionPicker({ review, side }: { review: Review; side: "before" | "after" }) {
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
          This computer (not committed){info?.dirty.length ? ` · ${info.dirty.length} files edited` : ""}
        </option>
        <option value="HEAD">Last commit{info ? ` on ${info.branch}` : ""}</option>
        {!known && <option value={value}>{value}</option>}
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
  ];
  return (
    <div className="mx-review-summary">
      <div className="mx-area-cards">
        {areas.map(({ area, title, icon: Icon, empty }) => {
          const n = count(area);
          const level = report.findings.filter((f) => f.area === area).reduce<Level>((l, f) => (f.level === "red" || l === "red" ? "red" : f.level === "yellow" || l === "yellow" ? "yellow" : "green"), n ? "green" : "none");
          return (
            <button key={area} type="button" className={`mx-area-card is-${level}`} onClick={() => go(area)}>
              <Icon size={18} />
              <strong>{title}</strong>
              <span>{n ? `${n} change${n === 1 ? "" : "s"}` : empty}</span>
            </button>
          );
        })}
      </div>
      {report.findings.length > 0 && (
        <ul className="mx-findings">
          {report.findings.map((f, i) => (
            <li key={i} className={`is-${f.level}`}>
              <Badge tone={LEVEL_TONE[f.level]}>{f.level === "red" ? "safety" : f.level === "yellow" ? "review" : "ok"}</Badge>
              <button type="button" className="mx-link" onClick={() => go(f.area)}>
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

export function ChangesPage({ notify }: { notify: (message: string) => void }) {
  const review = useReview();
  const [tab, setTab] = useState<Tab>("summary");
  const [editing, setEditing] = useState<EditTarget>();
  const { report } = review;

  const chooseRepo = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "Choose the robot code folder (a git repository)" });
    if (typeof picked === "string") review.setRepo(picked);
  };
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
      {desktop && review.repo && !review.imported && (
        <div className="mx-rev-bar">
          <RevisionPicker review={review} side="before" />
          <ArrowRight size={16} aria-hidden="true" />
          <RevisionPicker review={review} side="after" />
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
      {!report ? (
        <EmptyState icon={GitCompare} title={desktop ? "Choose the robot code folder" : "Open a review file"}
          action={desktop ? <Button variant="primary" icon={FolderGit2} onClick={() => void chooseRepo()}>Choose robot code folder</Button> : undefined}>
          {desktop
            ? "Pick the robot repository (for example FRC_Offseason_2026). Mayhem compares two versions of it and shows what changes on the robot."
            : "In the browser, open a review made with: node scripts/mayhem.mjs review <robot repo> [before] [after] --json > review.json"}
        </EmptyState>
      ) : (
        <>
          <div className={`mx-risk is-${report.level}`} role="status">
            {report.level === "red" ? <ShieldAlert size={22} /> : <ShieldCheck size={22} />}
            <div>
              <strong>{LEVEL_TEXT[report.level]}</strong>
              <span>
                {report.before.label} → {report.after.label}
              </span>
            </div>
          </div>
          <Segmented
            label="Review sections"
            value={tab}
            onChange={setTab}
            options={TABS.map((t) => {
              const n = t.value === "summary" ? 0 : report.findings.filter((f) => f.area === t.value).length;
              return { value: t.value, icon: t.icon, label: n ? `${t.label} · ${n}` : t.label };
            })}
          />
          <div className="mx-review-body">
            {tab === "summary" && <Summary report={report} go={setTab} />}
            {tab === "controls" && <ControlsView report={report} />}
            {tab === "machines" && <MachinesView report={report} />}
            {tab === "settings" && <SettingsView report={report} review={review} editSetting={setEditing} />}
            {tab === "hardware" && <HardwareView report={report} review={review} editSetting={setEditing} />}
            {tab === "autos" && <AutosView report={report} />}
          </div>
        </>
      )}
      {editing && <EditSetting review={review} target={editing} close={() => setEditing(undefined)} />}
    </div>
  );
}
