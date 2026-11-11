import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plotSeries } from "./core/plot.ts";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  FileChartColumn,
  FolderOpen,
  Play,
  Pause,
  Archive,
  RotateCcw,
} from "lucide-react";
import {
  analyze,
  valueAt,
  type Recording,
  type Analysis,
  type PowerMapping,
} from "./core/analysis.ts";
import {
  download,
  listLogs,
  readLog,
  storeLog,
  patchLog,
  type StoredLog,
  type ReceiptOptions,
  setLogArchived,
} from "./storage.ts";
import { desktop, nativeRead, invoke } from "./native";
import { PoseReplay } from "./PoseReplay";
import { LogActions, LogTransfer } from "./LogTransfer";
const fmt = (n: number | undefined, unit: string) =>
  n === undefined ? "Unavailable" : `${n.toFixed(2)} ${unit}`;
export function LogsView({
  notify,
  active = true,
}: {
  notify: (message: string) => void;
  active?: boolean;
}) {
  const [logs, setLogs] = useState<StoredLog[]>([]),
    [recording, setRecording] = useState<Recording | null>(null),
    [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showArchived, setShowArchived] = useState(false),
    [currentId, setCurrentId] = useState("");
  useEffect(() => {
    if (!playing || !recording || !active) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(),
        dt = (now - last) / 1000;
      last = now;
      setCursor((t) => Math.min(recording.duration, t + dt));
    }, 40);
    return () => clearInterval(timer);
  }, [playing, recording, active]);
  const [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState(0),
    [channelName, setChannelName] = useState("");
  const worker = useRef<Worker | null>(null),
    sequence = useRef(0);
  const requests = useRef(
    new Map<
      number,
      {
        resolve: (result: { recording: Recording; analysis: Analysis }) => void;
        reject: (error: Error) => void;
      }
    >(),
  );
  useEffect(() => {
    listLogs()
      .then(setLogs)
      .catch((e) => notify(`Log storage unavailable: ${String(e)}`));
    const instance = new Worker(new URL("./log.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = instance;
    instance.onmessage = (event) => {
      const pending = requests.current.get(event.data.id);
      if (!pending) return;
      requests.current.delete(event.data.id);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data);
    };
    instance.onerror = () => {
      for (const pending of requests.current.values())
        pending.reject(new Error("Log worker stopped unexpectedly."));
      requests.current.clear();
    };
    const pendingRequests = requests.current;
    return () => {
      instance.terminate();
      worker.current = null;
      for (const pending of pendingRequests.values())
        pending.reject(new Error("Log workspace closed."));
      pendingRequests.clear();
    };
  }, [notify]);
  useEffect(() => {
    if (recording && cursor >= recording.duration) setPlaying(false);
  }, [cursor, recording]);
  const parse = useCallback(
    (buffer: ArrayBuffer, name: string) =>
      new Promise<{ recording: Recording; analysis: Analysis }>(
        (resolve, reject) => {
          if (!worker.current) {
            reject(new Error("Log worker is not ready."));
            return;
          }
          const id = ++sequence.current;
          requests.current.set(id, { resolve, reject });
          const copy = buffer.slice(0);
          worker.current.postMessage({ buffer: copy, name, id }, [copy]);
        },
      ),
    [],
  );
  const show = useCallback(
    (result: { recording: Recording; analysis: Analysis }) => {
      setRecording(result.recording);
      setAnalysis(result.analysis);
      setCursor(0);
      setPlaying(false);
      setChannelName(
        result.analysis.mapping.voltage ??
          result.recording.channels[0]?.name ??
          "",
      );
    },
    [],
  );
  const received = useCallback(
    async (
      buffer: ArrayBuffer,
      name: string,
      nativePath?: string,
      options: ReceiptOptions = {},
    ) => {
      if (buffer.byteLength > 250 * 1024 * 1024)
        throw new Error("Current import limit is 250 MB per file.");
      const result = await parse(buffer, name);
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const id = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const previous = (await listLogs()).find((l) => l.id === id);
      const savedPath = nativePath
        ? await invoke<string>("archive_log_file", {
            path: nativePath,
            expectedHash: id,
          })
        : previous?.nativePath;
      const log: StoredLog = {
        ...previous,
        id,
        name,
        bytes: buffer.byteLength,
        added: previous?.added ?? Date.now(),
        nativePath: savedPath,
        sources: [
          ...new Set([
            ...(previous?.sources ?? []),
            ...(options.source ? [options.source] : []),
          ]),
        ],
        archived: false,
        uploadSite: options.queueSite ?? previous?.uploadSite,
        upload:
          previous?.upload === "uploaded" &&
          (!options.queueSite || previous.uploadSite === options.queueSite)
            ? "uploaded"
            : options.queueSite
              ? "queued"
              : previous?.upload,
      };
      await storeLog(log, savedPath ? undefined : buffer);
      setLogs((previous) => [log, ...previous.filter((p) => p.id !== id)]);
      if (!options.background) {
        show(result);
        setCurrentId(id);
      }
    },
    [parse, show],
  );
  const updateLog = useCallback(
    async (id: string, patch: Partial<Omit<StoredLog, "id">>) => {
      const log = await patchLog(id, patch);
      setLogs((previous) => previous.map((p) => (p.id === id ? log : p)));
    },
    [],
  );
  const openLog = async (log: StoredLog) => {
    setBusy(true);
    try {
      let buffer: ArrayBuffer;
      try {
        buffer = await readLog(log.id);
      } catch (e) {
        if (!log.nativePath) throw e;
        buffer = await nativeRead(log.nativePath);
      }
      show(await parse(buffer, log.name));
      setCurrentId(log.id);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      await received(await file.arrayBuffer(), file.name);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const importNative = async () => {
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Robot logs", extensions: ["wpilog", "json"] }],
      });
      if (typeof path === "string")
        await received(
          await nativeRead(path),
          path.split(/[\\/]/).at(-1) ?? path,
          path,
        );
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const mapping = (key: keyof PowerMapping, value: string) => {
    if (recording && analysis)
      setAnalysis(
        analyze(recording, { ...analysis.mapping, [key]: value || undefined }),
      );
  };
  const channel = recording?.channels.find((c) => c.name === channelName);
  const series = useMemo(() => plotSeries(channel), [channel]);
  const points = useMemo(
    () =>
      series.samples
        .map(
          (s) =>
            `${20 + (s.time / Math.max(recording?.duration ?? 1, 0.001)) * 760},${145 - ((Number(s.value) - series.min) / Math.max(series.max - series.min, 0.001)) * 120}`,
        )
        .join(" "),
    [series, recording?.duration],
  );
  return (
    <div className="ms-logs-layout">
      <aside className="ms-log-list">
        <div className="ms-panel-heading">
          Recordings <span>{logs.length}</span>
        </div>
        {desktop ? (
          <button
            className="ms-button ms-import"
            disabled={busy}
            onClick={() => {
              void importNative();
            }}
          >
            <FolderOpen size={15} />
            {busy ? "Reading…" : "Import recording"}
          </button>
        ) : (
          <label className={`ms-button ms-import ${busy ? "disabled" : ""}`}>
            <FolderOpen size={15} />
            {busy ? "Reading recording…" : "Import recording"}
            <input
              type="file"
              accept=".wpilog,.json"
              disabled={busy}
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        )}
        <label className="ms-transfer-check">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived recordings
        </label>
        {logs
          .filter((log) => showArchived || !log.archived)
          .map((log) => (
            <div key={log.id} className="ms-log-row">
              <button
                disabled={busy}
                className={`ms-log-item ${currentId === log.id ? "selected" : ""}`}
                onClick={() => {
                  void openLog(log);
                }}
              >
                <FileChartColumn size={17} />
                <span>
                  <strong>{log.name}</strong>
                  <small>
                    {(log.bytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                    {log.upload === "uploaded"
                      ? "uploaded"
                      : log.upload === "queued"
                        ? "upload queued"
                        : log.upload === "error"
                          ? "upload will retry"
                          : "stored locally"}
                  </small>
                </span>
              </button>
              <LogActions log={log} update={updateLog} notify={notify} />
              <button
                className="ms-icon-button"
                aria-label={`${log.archived ? "Restore" : "Archive"} ${log.name}`}
                title={
                  log.archived
                    ? "Restore recording"
                    : "Archive recording (keeps original)"
                }
                onClick={() => {
                  void setLogArchived(log.id, !log.archived)
                    .then(() => listLogs())
                    .then(setLogs)
                    .catch((e) => notify(String(e)));
                }}
              >
                {log.archived ? <RotateCcw size={13} /> : <Archive size={13} />}
              </button>
            </div>
          ))}
      </aside>
      <section className="ms-log-content">
        <LogTransfer
          logs={logs}
          updateLog={updateLog}
          received={received}
          notify={notify}
        />
        {!recording || !analysis ? (
          <div className="ms-empty">
            <FileChartColumn size={36} />
            <h2>Every run has a story.</h2>
            <p>
              Import a WPILOG to inspect signals, locate voltage sag, and
              understand power use.
            </p>
            <span>Analysis runs locally in a background worker.</span>
          </div>
        ) : (
          <>
            <div className="ms-section-title">
              <div>
                <span className="ms-eyebrow">Recorded evidence</span>
                <h2>{recording.name}</h2>
                <p>
                  {recording.duration.toFixed(2)} seconds ·{" "}
                  {recording.channels.length} channels
                </p>
              </div>
              <button
                className="ms-button"
                onClick={async () => {
                  try {
                    const log = logs.find((l) => l.id === currentId);
                    if (!log) return;
                    let buffer: ArrayBuffer;
                    try {
                      buffer = await readLog(log.id);
                    } catch (e) {
                      if (!log.nativePath) throw e;
                      buffer = await nativeRead(log.nativePath);
                    }
                    download(log.name, buffer, "application/octet-stream");
                  } catch (e) {
                    notify(String(e));
                  }
                }}
              >
                Export original
              </button>
              <button
                className="ms-button"
                onClick={() =>
                  download(
                    `${recording.name}.analysis.json`,
                    JSON.stringify(analysis, null, 2),
                  )
                }
              >
                <ArrowDownToLine size={15} />
                Export report
              </button>
            </div>
            <div className="ms-power-stats">
              {[
                ["Minimum voltage", fmt(analysis.power.minVoltage, "V")],
                ["Peak total current", fmt(analysis.power.peakCurrent, "A")],
                [
                  "Energy in overlapping data",
                  fmt(analysis.power.energyWh, "Wh"),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="ms-mappings">
              {(["voltage", "current", "brownout"] as const).map((key) => (
                <label key={key}>
                  {key === "brownout" ? "Brownout flag" : `Total ${key}`}
                  <select
                    value={analysis.mapping[key] ?? ""}
                    onChange={(e) => mapping(key, e.target.value)}
                  >
                    <option value="">Not mapped</option>
                    {recording.channels
                      .filter((c) =>
                        key === "brownout"
                          ? c.type === "boolean"
                          : ["double", "float", "int64", "number"].includes(
                              c.type,
                            ),
                      )
                      .map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="ms-chart-head">
              <button
                className="ms-button ms-primary"
                aria-label={
                  playing ? "Pause log playback" : "Play log playback"
                }
                onClick={() => {
                  if (cursor >= recording.duration) setCursor(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <select
                aria-label="Graph signal"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
              >
                {recording.channels.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
              <code>
                {String(valueAt(channel, cursor) ?? "No sample")} ·{" "}
                {cursor.toFixed(2)} s
              </code>
            </div>
            {series.samples.length ? (
              <svg
                className="ms-chart"
                viewBox="0 0 800 175"
                aria-label="Recorded signal graph"
              >
                <path
                  d="M20,15 V150 H780"
                  stroke="var(--ms-line,#cbd6e2)"
                  fill="none"
                />
                <polyline
                  points={points}
                  fill="none"
                  stroke="var(--ms-blue,#2469e8)"
                  strokeWidth="2"
                />
                <path
                  d={`M${20 + (cursor / Math.max(recording.duration, 0.001)) * 760},15 V150`}
                  stroke="#d98932"
                />
                <text
                  x="25"
                  y="170"
                  fontSize="11"
                  fill="var(--ms-muted,#708198)"
                >
                  0 s
                </text>
                <text
                  x="700"
                  y="170"
                  fontSize="11"
                  fill="var(--ms-muted,#708198)"
                >
                  {recording.duration.toFixed(2)} s
                </text>
              </svg>
            ) : (
              <div className="ms-empty-chart">
                {channel?.samples.length
                  ? "Select a numeric signal to graph."
                  : "This channel has no decoded scalar samples."}
              </div>
            )}
            <input
              className="ms-scrubber"
              aria-label="Recording time"
              type="range"
              min="0"
              max={recording.duration}
              step=".01"
              value={cursor}
              onChange={(e) => {
                setPlaying(false);
                setCursor(Number(e.target.value));
              }}
            />
            <PoseReplay recording={recording} time={cursor} />
            <div className="ms-panel-heading">
              Findings <span>Click to inspect the recorded time</span>
            </div>
            {analysis.findings.length ? (
              analysis.findings.map((f) => (
                <button
                  key={f.id}
                  className="ms-finding"
                  onClick={() => {
                    setPlaying(false);
                    setCursor(f.start);
                    setChannelName(f.channel);
                  }}
                >
                  <AlertTriangle size={18} />
                  <span>
                    <strong>{f.title}</strong>
                    <p>{f.detail}</p>
                    <code>
                      {f.start.toFixed(2)}–{f.end.toFixed(2)} s · {f.channel}
                    </code>
                  </span>
                </button>
              ))
            ) : (
              <div className="ms-coverage">
                <CheckCircle2 size={17} />
                No configured power rules triggered. Check logging coverage
                below.
              </div>
            )}
            <div className="ms-panel-heading">
              Logging coverage & limitations
            </div>
            <div className="ms-coverage-list">
              {[...recording.warnings, ...analysis.coverage].map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
