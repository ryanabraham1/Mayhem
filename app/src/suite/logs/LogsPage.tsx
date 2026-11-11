import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  BatteryCharging,
  Check,
  CheckCircle2,
  ExternalLink,
  FileChartColumn,
  FolderOpen,
  Map as MapIcon,
  Pause,
  Play,
  RotateCcw,
  Search,
  Stethoscope,
  UploadCloud,
  Waves,
} from "lucide-react";
import { currentBreakdown, type Finding } from "../core/analysis.ts";
import { PoseReplay } from "../PoseReplay";
import { desktop, invoke } from "../native";
import { download, type StoredLog } from "../storage";
import { useLogLibrary } from "../logLibrary";
import { loadSyncConfig } from "../logSync";
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
        onClick={() => {
          void invoke("open_log_viewer", {
            path: log.nativePath,
            viewer: loadSyncConfig().viewer || null,
          }).catch((e) => notify(String(e)));
        }}
      >
        AdvantageScope
      </Button>
      <Button
        icon={log.upload === "uploaded" ? Check : UploadCloud}
        title={log.uploadError ?? (log.upload === "uploaded" ? "Uploaded to team storage" : "Queue upload to team storage")}
        aria-label={`Upload ${log.name} to team cloud`}
        disabled={!desktop || !log.nativePath || log.upload === "uploaded" || log.upload === "queued"}
        onClick={() => {
          void update(log.id, {
            upload: "queued",
            uploadSite: loadSyncConfig().site,
            retryAt: 0,
          }).catch((e) => notify(String(e)));
        }}
      >
        {log.upload === "uploaded" ? "Uploaded" : log.upload === "queued" ? "Queued" : "Upload"}
      </Button>
    </>
  );
}

function LogRow({ log, active, open, busy }: { log: StoredLog; active: boolean; open: () => void; busy: boolean }) {
  const sum = log.summary;
  return (
    <button className={`mx-log ${active ? "is-active" : ""}`} disabled={busy} onClick={open}>
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
    const timer = setInterval(() => {
      const now = performance.now();
      setCursor((t) => Math.min(recording.duration, t + (now - last) / 1000));
      last = now;
    }, 40);
    return () => clearInterval(timer);
  }, [playing, recording]);
  useEffect(() => {
    if (recording && cursor >= recording.duration) setPlaying(false);
  }, [cursor, recording]);

  const visible = lib.logs.filter(
    (l) => (showArchived || !l.archived) && l.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const channels = recording?.channels ?? [];
  const channel = channels.find((c) => c.name === channelName);
  const voltage = channels.find((c) => c.name === analysis?.mapping.voltage);
  const totalCurrent = channels.find((c) => c.name === analysis?.mapping.current);
  const breakdown = useMemo(
    () => (recording ? currentBreakdown(recording, analysis?.mapping.current) : []),
    [recording, analysis?.mapping.current],
  );
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
              <LogRow key={l.id} log={l} active={l.id === current?.id} busy={lib.busy} open={() => void lib.open(l)} />
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
                    Min battery {analysis.power.minVoltage?.toFixed(2) ?? "—"} V · peak draw{" "}
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
                    <Stat label="Peak total draw" value={analysis.power.peakCurrent?.toFixed(0) ?? "—"} unit="A" />
                    <Stat label="Average power" value={analysis.power.averagePower?.toFixed(0) ?? "—"} unit="W" />
                    <Stat label="Energy used" value={analysis.power.energyWh?.toFixed(2) ?? "—"} unit="Wh" />
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
                            <i style={{ width: `${(b.mAh / breakdown[0].mAh) * 100}%` }} />
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
