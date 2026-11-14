import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpCircle,
  ChevronsUpDown,
  GitCompare,
  GitBranch,
  LayoutDashboard,
  Moon,
  Navigation,
  Settings,
  Sun,
  TriangleAlert,
  X,
  Cpu,
} from "lucide-react";
import { useSuiteProject, type SuiteState } from "./useSuiteProject";
import { RobotProvider, useRobot } from "./robot";
import { samePath, useRepoProject, useRobotRepo } from "./robotRepo";
import { LogLibraryProvider, useLogLibrary } from "./logLibrary";
import { ProjectPicker } from "./ProjectPicker";
import { AutosPage } from "./autos/AutosPage";
import { StatesPage } from "./states/StatesPage";
import { LogsPage } from "./logs/LogsPage";
import { RobotPage, setRobotTab } from "./robot/RobotPage";
import { ReviewProvider, useReviews } from "./changes/reviewList";
import { ChangesPage } from "./changes/ChangesPage";
import { OverviewPage } from "./overview/OverviewPage";
import { SettingsPage, type ThemeChoice } from "./settings/SettingsPage";
import { desktop } from "./native";
import { ContextMenuHost } from "./ContextMenu";
import { installUpdate, startUpdateChecks, useUpdater } from "../updater";
import "./suite.css";
import appPackage from "../../package.json";

const LegacyApp = lazy(() => import("../App"));
let updateChecksStarted = false;

export type Page =
  | "overview"
  | "changes"
  | "autos"
  | "states"
  | "logs"
  | "robot"
  | "settings";
const navigation = [
  { id: "overview", name: "Overview", icon: LayoutDashboard },
  { id: "changes", name: "Changes", icon: GitCompare },
  { id: "autos", name: "Autonomous", icon: Navigation },
  { id: "states", name: "State machines", icon: GitBranch },
  { id: "logs", name: "Logs", icon: Activity },
  { id: "robot", name: "Robot", icon: Cpu },
] as const;
const PAGE_KEY = "mayhem.page.v1";
const THEME_KEY = "mayhem.theme";

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(key) as T | null;
    if (saved && allowed.includes(saved)) return saved;
  } catch {}
  return fallback;
}
function systemDark() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function UpdateNotice() {
  const u = useUpdater();
  if (!u.version || u.phase === "idle" || u.dismissed) return null;
  const working = u.phase === "downloading" || u.phase === "restarting";
  return (
    <div className="mx-update" role="status">
      <ArrowUpCircle size={16} />
      <span>
        <strong>Mayhem {u.version}</strong>
        <small>
          {u.phase === "downloading"
            ? "Downloading…"
            : u.phase === "restarting"
              ? "Restarting…"
              : u.phase === "error"
                ? "Update failed. Try again."
                : "Ready to install"}
        </small>
      </span>
      {!working && (
        <button className="mx-btn mx-btn-primary mx-btn-sm" onClick={() => void installUpdate()}>
          Install
        </button>
      )}
    </div>
  );
}

/** Branches waiting for review, on the Changes tab. */
function WaitingCount() {
  const n = useReviews().toReview.length;
  return n ? <i className="mx-nav-count" aria-label={`${n} to review`}>{n}</i> : null;
}

function SidebarRobot({ go }: { go: () => void }) {
  const robot = useRobot();
  const { sync } = useLogLibrary();
  const status = robot.live.snapshot.status;
  const tone = status === "connected" ? "good" : status === "disconnected" ? "neutral" : "warn";
  return (
    <button className="mx-side-robot" onClick={go} title="Robot connection and log collection">
      <i className={`mx-dot is-${tone}`} />
      <span>
        <strong>Team {robot.config.team}</strong>
        <small>
          {status === "connected" ? "Live" : status === "disconnected" ? "Offline" : "Connecting"}
          {sync.config.autoPull && " · collecting logs"}
          {sync.uploading && " · uploading"}
        </small>
      </span>
    </button>
  );
}

function Shell({
  s,
  theme,
  setTheme,
  dark,
}: {
  s: SuiteState;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  dark: boolean;
}) {
  const [page, setPageState] = useState<Page>(() =>
    load<Page>(PAGE_KEY, ["overview", "changes", "autos", "states", "logs", "robot", "settings"], "overview"),
  );
  const [projectPicker, setProjectPicker] = useState(false);
  const [legacy, setLegacy] = useState(false);
  // Picking the robot code folder shows that robot: its own project file (autos, state machines)
  // opens and stays linked. A folder already chosen at launch is left to the Overview's prompt.
  const [repo] = useRobotRepo();
  const repoProject = useRepoProject(repo);
  const shownRepo = useRef(repo);
  const openProjectFile = useRef(s.openProjectFile);
  openProjectFile.current = s.openProjectFile;
  const projectPath = useRef(s.projectPath);
  projectPath.current = s.projectPath;
  useEffect(() => {
    if (!repoProject || shownRepo.current === repo) return;
    shownRepo.current = repo;
    if (!samePath(projectPath.current, repoProject)) void openProjectFile.current(repoProject);
  }, [repo, repoProject]);
  const setPage = (p: Page) => {
    setPageState(p);
    if (p !== "autos") s.setPlaying(false);
    try {
      localStorage.setItem(PAGE_KEY, p);
    } catch {}
  };

  if (legacy)
    return (
      <Suspense fallback={<div className="mx-loading">Opening the classic planner…</div>}>
        <div className="mx-legacy-return">
          <button onClick={() => setLegacy(false)}>← Back to Mayhem</button>
        </div>
        <LegacyApp />
      </Suspense>
    );

  return (
    <div className="mx-app" data-page={page}>
      <ContextMenuHost />
      {projectPicker && (
        <ProjectPicker
          project={s.project}
          path={s.projectPath}
          activate={s.switchProject}
          rename={(name) =>
            !!s.commit((p) => {
              p.name = name;
            })
          }
          open={() => {
            if (desktop) void s.openNativeProject();
            else document.getElementById("mx-project-import")?.click();
          }}
          close={() => setProjectPicker(false)}
          notify={s.notify}
        />
      )}
      <input
        id="mx-project-import"
        type="file"
        accept=".json"
        hidden
        aria-label="Import project file"
        onChange={(event) => {
          void s.importProject(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <header className="mx-top">
        <div className="mx-brand">
          <span className="mx-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M4 18 L9 7 L12 13 L15 7 L20 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="mx-brand-text">
            <strong>Mayhem</strong>
          </span>
        </div>
        <button
          className="mx-project-switch"
          aria-label="Switch project"
          aria-haspopup="dialog"
          title="Switch or manage projects"
          onClick={() => setProjectPicker(true)}
        >
          <span className="mx-project-text">
            <strong>{s.project.name}</strong>
          </span>
          <ChevronsUpDown size={14} />
        </button>
        {s.projectPath && (
          <span
            className={`mx-disk-status ${s.diskError || s.diskConflict ? "is-bad" : ""}`}
            role="status"
            title={`Watching ${s.projectPath}`}
          >
            {s.diskError
              ? "File invalid · showing last good version"
              : s.diskConflict
                ? "File changed · see below"
                : s.reloadedAt
                  ? `Reloaded from disk · ${s.reloadedAt.toLocaleTimeString()}`
                  : "Watching file"}
          </span>
        )}
        <nav className="mx-nav" aria-label="Suite tools">
          {navigation.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-label={name}
              title={name}
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "is-active" : ""}
              onClick={() => setPage(id)}
            >
              <Icon size={16} />
              <span>{name}</span>
              {id === "changes" && <WaitingCount />}
            </button>
          ))}
        </nav>
        <div className="mx-top-right">
          <UpdateNotice />
          <SidebarRobot go={() => setPage("robot")} />
          <button
            className={`mx-icon-btn ${page === "settings" ? "is-active" : ""}`}
            aria-label="Settings"
            aria-current={page === "settings" ? "page" : undefined}
            title="Settings"
            onClick={() => setPage("settings")}
          >
            <Settings size={16} />
          </button>
          <button
            className="mx-icon-btn"
            aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
            title={`Switch to ${dark ? "light" : "dark"} mode`}
            onClick={() => setTheme(dark ? "light" : "dark")}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>
      <main className="mx-main">
        {page === "overview" && <OverviewPage s={s} go={setPage} />}
        {page === "autos" && <AutosPage s={s} />}
        {page === "states" && <StatesPage key={s.project.id} s={s} openAutos={() => setPage("autos")} />}
        {page === "logs" && <LogsPage notify={s.notify} openRobot={() => { setRobotTab("logs"); setPage("robot"); }} />}
        {page === "robot" && <RobotPage s={s} openChanges={() => setPage("changes")} />}
        {page === "changes" && <ChangesPage notify={s.notify} go={setPage} />}
        {page === "settings" && (
          <SettingsPage
            theme={theme}
            setTheme={setTheme}
            openLegacy={() => setLegacy(true)}
            notify={s.notify}
            s={s}
            version={appPackage.version}
          />
        )}
        {s.diskConflict && <DiskConflict s={s} />}
        {s.diskError && !s.diskConflict && (
          <div className="mx-banner is-bad" role="alert">
            <TriangleAlert size={16} />
            <span>
              The project file can't be loaded ({s.diskError}). Showing the last good version; it reloads
              when the file is fixed.
            </span>
          </div>
        )}
      </main>
      {s.notice && (
        <div className="mx-toast" role="status">
          <TriangleAlert size={16} />
          <span>{s.notice}</span>
          <button aria-label="Dismiss message" onClick={s.clearNotice}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

/** The linked file changed while this copy has edits it lacks: ask, never discard either. */
function DiskConflict({ s }: { s: SuiteState }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="mx-banner is-bad mx-disk-conflict" role="alert">
      <TriangleAlert size={16} />
      <div>
        <p>
          {s.diskChanges.length
            ? "The project file changed on disk while you had edits here. Nothing is saved to it until you choose."
            : "Your latest edits could not be saved to the project file. Nothing is lost; choose what to keep."}
        </p>
        {details && (
          <ul aria-label="Differences from the file">
            {s.diskChanges.length ? s.diskChanges.map((c) => <li key={c}>{c}</li>) : <li>Checking the file…</li>}
          </ul>
        )}
        <div className="mx-banner-actions">
          <button type="button" onClick={s.takeDiskVersion} disabled={!s.diskChanges.length}>
            Load file version
          </button>
          <button type="button" onClick={() => void s.keepMyVersion()}>
            Keep mine
          </button>
          <button type="button" className="mx-link" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            {details ? "Hide changes" : "Show changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WithLogs({ s, children }: { s: SuiteState; children: ReactNode }) {
  const robot = useRobot();
  return (
    <LogLibraryProvider policy={s.project.extensions.logRules} notify={s.notify} host={robot.host}>
      {children}
    </LogLibraryProvider>
  );
}

export default function SuiteApp() {
  const s = useSuiteProject();
  const [theme, setThemeState] = useState<ThemeChoice>(() =>
    load<ThemeChoice>(THEME_KEY, ["light", "dark", "system"], "light"),
  );
  const [systemIsDark, setSystemIsDark] = useState(systemDark);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const listener = () => setSystemIsDark(query.matches);
    query.addEventListener?.("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemIsDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const setTheme = (t: ThemeChoice) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {}
  };
  useEffect(() => {
    if (updateChecksStarted) return;
    updateChecksStarted = true;
    startUpdateChecks();
  }, []);
  return (
    <RobotProvider>
      <WithLogs s={s}>
        <ReviewProvider>
          <Shell s={s} theme={theme} setTheme={setTheme} dark={dark} />
        </ReviewProvider>
      </WithLogs>
    </RobotProvider>
  );
}
