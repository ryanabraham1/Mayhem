import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  BatteryCharging,
  ClipboardCopy,
  Check,
  CheckCircle2,
  CloudDownload,
  ExternalLink,
  FileChartColumn,
  FolderOpen,
  FolderSearch,
  Map as MapIcon,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Stethoscope,
  Trash2,
  UploadCloud,
  Waves,
} from "lucide-react";
import { currentBreakdown, isDeviceCurrentSignal, parsePowerMapping, type Finding } from "../core/analysis.ts";
import { PoseReplay } from "../PoseReplay";
import { FeedbackButton } from "../tasks/feedback";
import { buildOf, poseAt } from "../tasks/anchors";
import { desktop, invoke } from "../native";
import { download, type StoredLog } from "../storage";
import { useLogLibrary } from "../logLibrary";
import { loadSyncConfig, type LogSync, type TeamLog } from "../logSync";
import { copyText, openContextMenu } from "../ContextMenu";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Segmented,
  Stat,
  formatBytes,
  timeAgo,
} from "../ui";
import { FindingTimeline, SignalChart } from "./SignalChart";

type Tab = "health" | "power" | "signals" | "field";
const numeric = ["double", "float", "int64", "number"];

export function LogActions({
  log,
  update,
  notify,
}: {
  log: StoredLog;
  update: (id: string, patch: Partial<Omit<StoredLog, "id">>) => Promise<void>;
  notify: (message: string) => void;
}) {
  return (
    <>
      <Button
        icon={ExternalLink}
        title={
          !desktop
            ? "Use the Mayhem desktop app to launch AdvantageScope"
            : !log.nativePath
              ? "Import this recording from a file in the desktop app first"
              : "Open in AdvantageScope"
        }
        aria-label={`Open ${log.name} in AdvantageScope`}
        disabled={!desktop || !log.nativePath}
        onClick={() => openInViewer(log, notify)}
      >
        AdvantageScope
      </Button>
      <Button
        icon={log.upload === "uploaded" ? Check : UploadCloud}
        title={log.uploadError ?? (log.upload === "uploaded" ? "Uploaded to team storage" : "Queue upload to team storage")}
        aria-label={`Upload ${log.name} to team cloud`}
        disabled={!desktop || !log.nativePath || log.upload === "uploaded" || log.upload === "queued"}
        onClick={() => queueUpload(log, update, notify)}
      >
        {log.upload === "uploaded" ? "Uploaded" : log.upload === "queued" ? "Queued" : "Upload"}
      </Button>
      <IconButton
        label={`${revealLabel} (${log.name})`}
        title={
          !desktop
            ? "Use the Mayhem desktop app to find the saved file"
            : !log.nativePath
              ? "This recording was imported in the browser and has no file on disk"
              : `${revealLabel}: ${log.nativePath}`
        }
        icon={FolderSearch}
        disabled={!desktop || !log.nativePath}
        onClick={() => revealInFolder(log, notify)}
      />
    </>
  );
}

/** "Show in Finder" on macOS, "Show in Explorer" on Windows. */
export const revealLabel =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
    ? "Show in Finder"
    : typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent)
      ? "Show in Explorer"
      : "Show in folder";
/** Ask before permanently deleting recordings from this computer. */
export function confirmDelete(targets: StoredLog[]) {
  if (!targets.length) return false;
  const what = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} recordings`;
  return window.confirm(
    `Delete ${what} from this computer?\n\nThis permanently removes ${targets.length === 1 ? "it" : "them"} from Mayhem's library and deletes Mayhem's saved ${targets.length === 1 ? "copy" : "copies"}. Copies in the team cloud, on the robot or in a folder you imported from are not affected.`,
  );
}
const revealInFolder = (log: StoredLog, notify: (m: string) => void) => {
  if (!log.nativePath) return;
  void invoke("reveal_log_file", { path: log.nativePath }).catch((e) => notify(String(e)));
};
const openInViewer = (log: StoredLog, notify: (m: string) => void) => {
  void invoke("open_log_viewer", {
    path: log.nativePath,
    viewer: loadSyncConfig().viewer || null,
  }).catch((e) => notify(String(e)));
};
const queueUpload = (
  log: StoredLog,
  update: (id: string, patch: Partial<Omit<StoredLog, "id">>) => Promise<void>,
  notify: (m: string) => void,
) => {
  void update(log.id, {
    upload: "queued",
    uploadSite: loadSyncConfig().site,
    retryAt: 0,
  }).catch((e) => notify(String(e)));
};

function LogRow({
  log,
  active,
  open,
  busy,
  menu,
}: {
  log: StoredLog;
  active: boolean;
  open: () => void;
  busy: boolean;
  menu: (e: MouseEvent) => void;
}) {
  const sum = log.summary;
  return (
    <button className={`mx-log ${active ? "is-active" : ""}`} disabled={busy} onClick={open} onContextMenu={menu}>
      <span className="mx-log-top">
        <strong>{log.name.replace(/\.wpilog$/i, "")}</strong>
        {sum ? (
          sum.errors ? (
            <Badge tone="bad">{sum.errors}</Badge>
          ) : sum.warnings ? (
            <Badge tone="warn">{sum.warnings}</Badge>
          ) : (
            <Badge tone="good">ok</Badge>
          )
        ) : null}
      </span>
      <small>
        {timeAgo(log.added)} · {formatBytes(log.bytes)}
        {sum && ` · ${sum.duration.toFixed(0)} s`}
        {log.upload === "uploaded" ? " · uploaded" : log.upload === "queued" ? " · upload queued" : log.upload === "error" ? " · upload retrying" : ""}
      </small>
    </button>
  );
}

/** The team website's shared recordings, each downloadable into the local library. */
export function TeamCloud({
  sync,
  logs,
  query,
  open,
  openRobot,
}: {
  sync: LogSync;
  logs: StoredLog[];
  query: string;
  open: (log: StoredLog) => void;
  openRobot: () => void;
}) {
  const { cloud, token, refreshCloud } = sync;
  useEffect(() => {
    if (desktop && token.trim() && !cloud.loaded && !cloud.loading) void refreshCloud();
  }, [token, cloud.loaded, cloud.loading, refreshCloud]);
  const filter = query.trim().toLowerCase();
  const shown = cloud.logs.filter((l) => l.name.toLowerCase().includes(filter));
  const row = (l: TeamLog) => {
    const local = logs.find((saved) => saved.id === l.sha256);
    const saving = sync.saving.includes(l.sha256);
    const uploaded = Date.parse(l.uploaded);
    return (
      <div key={l.sha256} className="mx-cloud-log">
        <span>
          <strong title={l.name}>{l.name.replace(/\.wpilog$/i, "")}</strong>
          <small>
            {Number.isFinite(uploaded) ? timeAgo(uploaded) : "uploaded"} · {formatBytes(l.size)}
            {l.device && ` · ${l.device}`}
          </small>
        </span>
        {local ? (
          <Button size="sm" variant="ghost" icon={Check} aria-label={`Open ${l.name} from the library`} title="Already in your library. Open it." onClick={() => open(local)}>
            Open
          </Button>
        ) : (
          <IconButton
            label={saving ? `Downloading ${l.name}` : `Download ${l.name} to the library`}
            icon={saving ? RefreshCw : CloudDownload}
            className={saving ? "is-spinning" : ""}
            disabled={saving}
            onClick={() => void sync.saveFromCloud(l)}
          />
        )}
      </div>
    );
  };
  return (
    <section aria-label="Team cloud">
      <div className="mx-rail-head is-steps">
        <h2>Team cloud</h2>
        {cloud.loaded && <span className="mx-rail-sub">{cloud.logs.length}{cloud.next ? "+" : ""}</span>}
        <IconButton
          label="Refresh team cloud"
          icon={RefreshCw}
          className={cloud.loading ? "is-spinning" : ""}
          disabled={!desktop || !token.trim() || cloud.loading}
          onClick={() => void refreshCloud()}
        />
      </div>
      {!desktop ? (
        <p className="mx-rail-note">Open the Mayhem desktop app to browse and download team recordings.</p>
      ) : !token.trim() ? (
        <p className="mx-rail-note">
          Add a device token from the team site&apos;s Connect Mayhem to see shared recordings.{" "}
          <button className="mx-link" onClick={openRobot}>Add token</button>
        </p>
      ) : cloud.error ? (
        <p className="mx-rail-note" role="alert">{cloud.error}</p>
      ) : (
        <div className="mx-log-list">
          {shown.map(row)}
          {cloud.loaded && !shown.length && (
            <p className="mx-rail-note">{cloud.logs.length ? "No team recordings match." : "No recordings in the team cloud yet."}</p>
          )}
          {!cloud.loaded && <p className="mx-rail-note">Loading team recordings…</p>}
          {cloud.next && (
            <Button size="sm" variant="ghost" disabled={cloud.loading} onClick={() => void refreshCloud(true)}>
              {cloud.loading ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function LogsPage({ notify, openRobot }: { notify: (m: string) => void; openRobot: () => void }) {
  const lib = useLogLibrary();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<Tab>("health");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [channelQuery, setChannelQuery] = useState("");
  const current = lib.current;
  const recording = current?.recording;
  const analysis = current?.analysis;
  const log = lib.logs.find((l) => l.id === current?.id);

  useEffect(() => {
    setCursor(0);
    setPlaying(false);
    setChannelName(current?.analysis.mapping.voltage ?? current?.recording.channels[0]?.name ?? "");
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing || !recording) return;
    let last = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      setCursor((t) => Math.min(recording.duration, t + elapsed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, recording]);
  useEffect(() => {
    if (recording && cursor >= recording.duration) setPlaying(false);
  }, [cursor, recording]);

  const visible = lib.logs.filter(
    (l) => (showArchived || !l.archived) && l.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const channels = recording?.channels ?? [];
  const channel = channels.find((c) => c.name === channelName) ?? (analysis?.estimatedCurrent?.name === channelName ? analysis.estimatedCurrent : undefined);
  const voltage = channels.find((c) => c.name === analysis?.mapping.voltage);
  const totalCurrent = analysis?.estimatedCurrent ?? channels.find((c) => c.name === analysis?.mapping.current);
  const breakdown = useMemo(
    () => (recording ? currentBreakdown(recording, analysis?.mapping.current, 24, analysis?.mapping.deviceCurrents) : []),
    [recording, analysis?.mapping.current, analysis?.mapping.deviceCurrents],
  );
  const [mappingText, setMappingText] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState("");
  const defaultMapping = analysis
    ? { ...analysis.mapping, deviceCurrents: analysis.mapping.deviceCurrents ?? channels.filter((c) => c.name !== analysis.mapping.current && isDeviceCurrentSignal(c.name)).map((c) => c.name) }
    : {};
  useEffect(() => { setMappingText(null); setMappingError(""); }, [current?.id]);
  const errors = analysis?.findings.filter((f) => f.severity === "error") ?? [];
  const warnings = analysis?.findings.filter((f) => f.severity === "warning") ?? [];
  const seek = (t: number, finding?: Finding) => {
    setPlaying(false);
    setCursor(t);
    if (finding) {
      setChannelName(finding.channel);
      setTab("signals");
    }
  };
  const sync = lib.sync;

  const importButton = desktop ? (
    <Button variant="primary" icon={FolderOpen} disabled={lib.busy} onClick={() => void lib.importNative()}>
      {lib.busy ? "Reading…" : "Import log"}
    </Button>
  ) : (
    <label className={`mx-btn mx-btn-primary mx-btn-md ${lib.busy ? "is-disabled" : ""}`}>
      <FolderOpen size={16} />
      {lib.busy ? "Reading…" : "Import log"}
      <input
        type="file"
        accept=".wpilog,.json"
        hidden
        aria-label="Import recording"
        disabled={lib.busy}
        onChange={(e) => {
          void lib.importFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div className="mx-logs">
      <PageHeader
        title="Logs"
        subtitle="Every recording is checked for red flags and power problems as soon as it arrives."
        actions={
          <>
            <button className="mx-sync-pill" onClick={openRobot}>
              <i className={`mx-dot is-${sync.config.autoPull ? (sync.reach === "reachable" ? "good" : "warn") : "neutral"}`} />
              {sync.config.autoPull
                ? sync.reach === "reachable"
                  ? `Collecting from robot · ${sync.status || "checking"}`
                  : "Auto-collect on · waiting for robot"
                : "Auto-collect off"}
            </button>
            {importButton}
          </>
        }
      />
      <div className="mx-logs-grid">
        <aside className="mx-rail" aria-label="Recordings">
          <div className="mx-rail-head">
            <h2>Library</h2>
            <span className="mx-rail-sub">{lib.logs.filter((l) => !l.archived).length}</span>
          </div>
          <label className="mx-search">
            <Search size={14} />
            <input placeholder="Filter recordings" aria-label="Filter recordings" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="mx-log-list">
            {visible.map((l) => (
              <LogRow
                key={l.id}
                log={l}
                active={l.id === current?.id}
                busy={lib.busy}
                open={() => void lib.open(l)}
                menu={(e) =>
                  openContextMenu(
                    e,
                    [
                      l.id !== current?.id && { label: "Open report", icon: FileChartColumn, onSelect: () => void lib.open(l) },
                      {
                        label: "Open in AdvantageScope",
                        icon: ExternalLink,
                        disabled: !desktop || !l.nativePath,
                        onSelect: () => openInViewer(l, notify),
                      },
                      {
                        label: l.upload === "uploaded" ? "Uploaded" : l.upload === "queued" ? "Upload queued" : "Upload to team storage",
                        icon: l.upload === "uploaded" ? Check : UploadCloud,
                        disabled: !desktop || !l.nativePath || l.upload === "uploaded" || l.upload === "queued",
                        onSelect: () => queueUpload(l, lib.updateLog, notify),
                      },
                      {
                        label: "Export original",
                        icon: ArrowDownToLine,
                        onSelect: async () => {
                          try {
                            download(l.name, await lib.bytesOf(l), "application/octet-stream");
                          } catch (err) {
                            notify(String(err));
                          }
                        },
                      },
                      "separator",
                      { label: "Copy name", icon: ClipboardCopy, onSelect: () => void copyText(l.name) },
                      desktop && l.nativePath && { label: revealLabel, icon: FolderSearch, onSelect: () => revealInFolder(l, notify) },
                      l.nativePath && { label: "Copy file path", onSelect: () => void copyText(l.nativePath!) },
                      "separator",
                      {
                        label: l.archived ? "Restore" : "Archive",
                        icon: l.archived ? RotateCcw : Archive,
                        onSelect: () => void lib.archive(l, !l.archived),
                      },
                      {
                        label: "Delete…",
                        icon: Trash2,
                        danger: true,
                        onSelect: () => {
                          if (confirmDelete([l])) void lib.remove([l]);
                        },
                      },
                    ],
                    l.name.replace(/\.wpilog$/i, ""),
                    {
                      title: `${l.name.replace(/\.wpilog$/i, "")}: `,
                      anchor: { log: l.name, ...(l.nativePath ? { logPath: l.nativePath } : {}) },
                      context: "Pinned to this log. An agent can open it with the log tools.",
                    },
                  )
                }
              />
            ))}
            {!visible.length && (
              <p className="mx-rail-note">
                {lib.logs.length ? "No recordings match." : "No recordings yet. Import a .wpilog or turn on robot collection."}
              </p>
            )}
          </div>
          <label className="mx-check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          {showArchived && lib.logs.some((l) => l.archived) && (
            <Button
              size="sm"
              variant="danger"
              icon={Trash2}
              onClick={() => {
                const archived = lib.logs.filter((l) => l.archived);
                if (confirmDelete(archived)) void lib.remove(archived);
              }}
            >
              Delete archived ({lib.logs.filter((l) => l.archived).length})
            </Button>
          )}
          <TeamCloud sync={sync} logs={lib.logs} query={query} open={(l) => void lib.open(l)} openRobot={openRobot} />
        </aside>

        <section className="mx-report">
          {!recording || !analysis || !current ? (
            <EmptyState
              icon={FileChartColumn}
              title={lib.logs.length ? "Pick a recording" : "Bring in your first log"}
              action={
                <div className="mx-empty-actions">
                  {importButton}
                  <Button onClick={openRobot}>Set up robot collection</Button>
                </div>
              }
            >
              Plug into the robot over Ethernet and Mayhem pulls new WPILOG files automatically, checks them
              for brownouts, faults, disconnects and loop overruns, and can upload them to team storage.
            </EmptyState>
          ) : (
            <>
              <header className="mx-report-head">
                <div>
                  <h2>{recording.name}</h2>
                  <p>
                    {recording.duration.toFixed(1)} s · {recording.channels.length} signals
                    {log && ` · imported ${timeAgo(log.added)}`}
                  </p>
                </div>
                <div className="mx-page-actions">
                  {log && <LogActions log={log} update={lib.updateLog} notify={notify} />}
                  <IconButton
                    label="Export original"
                    icon={ArrowDownToLine}
                    onClick={async () => {
                      try {
                        if (log) download(log.name, await lib.bytesOf(log), "application/octet-stream");
                      } catch (e) {
                        notify(String(e));
                      }
                    }}
                  />
                  <IconButton
                    label="Export report"
                    icon={FileChartColumn}
                    onClick={() => download(`${recording.name}.analysis.json`, JSON.stringify(analysis, null, 2))}
                  />
                  {log && (
                    <IconButton
                      label={`${log.archived ? "Restore" : "Archive"} ${log.name}`}
                      icon={log.archived ? RotateCcw : Archive}
                      onClick={() => void lib.archive(log, !log.archived)}
                    />
                  )}
                  {log && (
                    <IconButton
                      label={`Delete ${log.name}`}
                      title="Delete from this computer"
                      icon={Trash2}
                      onClick={() => {
                        if (confirmDelete([log])) void lib.remove([log]);
                      }}
                    />
                  )}
                </div>
              </header>

              <div className={`mx-verdict is-${errors.length ? "bad" : warnings.length ? "warn" : "good"}`}>
                {errors.length ? <AlertOctagon size={20} /> : warnings.length ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
                <div>
                  <strong>
                    {errors.length
                      ? `${errors.length} red ${errors.length === 1 ? "flag" : "flags"}${warnings.length ? `, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}` : ""}`
                      : warnings.length
                        ? `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"} to review`
                        : "No red flags found"}
                  </strong>
                  <span>
                    Min battery {analysis.power.minVoltage?.toFixed(2) ?? "—"} V · {analysis.power.currentSource === "estimated" ? "estimated peak draw" : "peak draw"}{" "}
                    {analysis.power.peakCurrent?.toFixed(0) ?? "—"} A
                  </span>
                </div>
                <div className="mx-verdict-time">
                  <button
                    className="mx-play is-small"
                    aria-label={playing ? "Pause log playback" : "Play log playback"}
                    onClick={() => {
                      if (cursor >= recording.duration) setCursor(0);
                      setPlaying((p) => !p);
                    }}
                  >
                    {playing ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <code className="mx-clock">
                    {cursor.toFixed(1)}
                    <small>s</small>
                  </code>
                  <FeedbackButton
                    label="Comment here"
                    draft={() => ({
                      context: "Pinned to this moment of the log, so an agent can look at exactly what happened.",
                      anchor: { log: log?.name ?? recording.name, ...(log?.nativePath ? { logPath: log.nativePath } : {}), time: Math.round(cursor * 100) / 100, ...(poseAt(recording, cursor) ? { pose: poseAt(recording, cursor) } : {}), ...(buildOf(recording) ? { revision: buildOf(recording) } : {}) },
                    })}
                  />
                </div>
              </div>
              <FindingTimeline findings={analysis.findings} duration={recording.duration} cursor={cursor} seek={seek} />

              <Segmented<Tab>
                label="Report section"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "health", label: "Health", icon: Stethoscope },
                  { value: "power", label: "Power", icon: BatteryCharging },
                  { value: "signals", label: "Signals", icon: Waves },
                  { value: "field", label: "Field", icon: MapIcon },
                ]}
              />

              {tab === "health" && (
                <div className="mx-report-body">
                  {analysis.findings.length ? (
                    <div className="mx-findings">
                      {[...errors, ...warnings].map((f) => (
                        <button key={f.id} className={`mx-finding is-${f.severity}`} onClick={() => seek(f.start, f)}>
                          {f.severity === "error" ? <AlertOctagon size={17} /> : <AlertTriangle size={17} />}
                          <span>
                            <strong>{f.title}</strong>
                            <p>{f.detail}</p>
                            <code>
                              {f.start.toFixed(2)}–{f.end.toFixed(2)} s · {f.channel}
                            </code>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mx-ok-line">
                      <CheckCircle2 size={16} /> No rule triggered. Check what the log could and couldn't cover below.
                    </p>
                  )}
                  <h3 className="mx-subhead">Coverage and limits</h3>
                  <ul className="mx-coverage">
                    {[...recording.warnings, ...analysis.coverage].map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {tab === "power" && (
                <div className="mx-report-body">
                  <div className="mx-stats">
                    <Stat
                      label="Lowest battery"
                      value={analysis.power.minVoltage?.toFixed(2) ?? "—"}
                      unit="V"
                      tone={analysis.power.minVoltage === undefined ? undefined : analysis.power.minVoltage < 7 ? "bad" : analysis.power.minVoltage < 9 ? "warn" : "good"}
                    />
                    <Stat label={analysis.power.currentSource === "estimated" ? "Estimated peak draw" : "Peak total draw"} value={analysis.power.peakCurrent?.toFixed(0) ?? "—"} unit="A" />
                    <Stat label={analysis.power.currentSource === "estimated" ? "Estimated average power" : "Average power"} value={analysis.power.averagePower?.toFixed(0) ?? "—"} unit="W" />
                    <Stat label={analysis.power.currentSource === "estimated" ? "Estimated energy used" : "Energy used"} value={analysis.power.energyWh?.toFixed(2) ?? "—"} unit="Wh" />
                  </div>
                  {voltage ? (
                    <SignalChart
                      label="Battery voltage graph"
                      channel={voltage}
                      overlay={totalCurrent}
                      duration={recording.duration}
                      cursor={cursor}
                      seek={seek}
                      unit="V"
                      threshold={{ value: 6.8, label: "brownout 6.8 V" }}
                      findings={analysis.findings.filter((f) => f.channel === voltage.name || f.channel === analysis.mapping.brownout)}
                    />
                  ) : (
                    <p className="mx-help">Map a battery voltage signal below to graph voltage sag.</p>
                  )}
                  {analysis.power.currentSource === "estimated" && <p className="mx-help">Estimated from {analysis.power.currentChannels?.length} logged supply/branch current signals. Unlogged loads are omitted; duplicate device sources must be excluded in the mapping.</p>}
                  <h3 className="mx-subhead">Biggest current draws</h3>
                  {breakdown.length ? (
                    <div className="mx-bars">
                      {breakdown.map((b) => (
                        <button
                          key={b.channel}
                          className="mx-bar"
                          onClick={() => {
                            setChannelName(b.channel);
                            setTab("signals");
                          }}
                        >
                          <span className="mx-bar-name">{b.channel}</span>
                          <span className="mx-bar-track">
                            <i style={{ width: `${(b.mAh / (breakdown[0].mAh || 1)) * 100}%` }} />
                          </span>
                          <code>{b.mAh.toFixed(0)} mAh</code>
                          <code className="is-muted">peak {b.peak.toFixed(0)} A</code>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mx-help">
                      No per-device current signals found. Log supply current for each motor controller (or the PDH
                      channels) to see which mechanisms drain the battery.
                    </p>
                  )}
                  <h3 className="mx-subhead">Signal mapping</h3>
                  <p className="mx-help">Automatic detection uses signal names. Define an explicit mapping to override it; numbers alone do not identify electrical current.</p>
                  <details>
                    <summary>Agent / custom signal mapping</summary>
                    <p className="mx-help">Download the signal catalog for an agent, then paste its mapping object here. Use volts for voltage and amperes for currents. deviceCurrents lists exactly which supply-current signals appear above; an empty list disables the ranking. Changes are saved for this log on this computer.</p>
                    <button className="mx-btn mx-btn-md" onClick={() => download("robot-log-signals.json", JSON.stringify({
                      instructions: "Edit mapping only, then paste it into Signal mapping. Use exact channel names; voltage is V, currents are A. deviceCurrents is authoritative: list supply/PDH branch currents only, not stator currents or the total. [] disables device ranking. Avoid listing duplicate sources for the same device.",
                      mapping: defaultMapping,
                      channels: channels.map((c) => ({ name: c.name, type: c.type })),
                    }, null, 2))}>Download signal catalog</button>
                    <textarea aria-label="Signal mapping JSON" rows={12} value={mappingText ?? JSON.stringify(defaultMapping, null, 2)} onChange={(e) => setMappingText(e.target.value)} />
                    {mappingError && <p role="alert">{mappingError}</p>}
                    <button className="mx-btn mx-btn-md" onClick={() => {
                      try {
                        lib.remap(parsePowerMapping(JSON.parse(mappingText ?? JSON.stringify(defaultMapping)), channels));
                        setMappingError("");
                        setMappingText(null);
                      } catch (e) { setMappingError(e instanceof Error ? e.message : String(e)); }
                    }}>Apply mapping</button>
                    <button className="mx-btn mx-btn-md" onClick={() => { lib.resetMapping(); setMappingText(null); setMappingError(""); }}>Reset to automatic detection</button>
                  </details>
                  <div className="mx-mapping">
                    {(["voltage", "current", "brownout"] as const).map((key) => (
                      <Field key={key} label={key === "brownout" ? "Brownout flag" : key === "voltage" ? "Battery voltage" : "Total current"}>
                        <select
                          value={analysis.mapping[key] ?? ""}
                          onChange={(e) => lib.remap({ ...analysis.mapping, [key]: e.target.value || undefined })}
                        >
                          <option value="">Not mapped</option>
                          {channels
                            .filter((c) => (key === "brownout" ? c.type === "boolean" : numeric.includes(c.type)))
                            .map((c) => (
                              <option key={c.name}>{c.name}</option>
                            ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                </div>
              )}

              {tab === "signals" && (
                <div className="mx-report-body mx-signals">
                  <div className="mx-signal-picker">
                    <label className="mx-search">
                      <Search size={14} />
                      <input placeholder="Find a signal" aria-label="Find a signal" value={channelQuery} onChange={(e) => setChannelQuery(e.target.value)} />
                    </label>
                    <div className="mx-signal-list">
                      {channels
                        .filter((c) => c.name.toLowerCase().includes(channelQuery.trim().toLowerCase()))
                        .slice(0, 400)
                        .map((c) => (
                          <button key={c.name} className={c.name === channelName ? "is-active" : ""} onClick={() => setChannelName(c.name)}>
                            <span>{c.name}</span>
                            <small>{c.type}</small>
                          </button>
                        ))}
                    </div>
                  </div>
                  <div className="mx-signal-view">
                    <select aria-label="Graph signal" className="mx-visually-hidden" value={channelName} onChange={(e) => setChannelName(e.target.value)}>
                      {channels.map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                    </select>
                    <h3 className="mx-subhead">{channelName || "Choose a signal"}</h3>
                    <SignalChart
                      channel={channel}
                      duration={recording.duration}
                      cursor={cursor}
                      seek={seek}
                      findings={analysis.findings.filter((f) => f.channel === channelName)}
                    />
                  </div>
                </div>
              )}

              {tab === "field" && (
                <div className="mx-report-body">
                  <PoseReplay recording={recording} time={cursor} />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
