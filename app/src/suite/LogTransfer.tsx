import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  RefreshCw,
  UploadCloud,
} from "lucide-react";
import { desktop, invoke, nativeRead, type RemoteLog } from "./native";
import { type StoredLog, type ReceiptOptions } from "./storage";
interface Config {
  host: string;
  directory: string;
  selected: string[];
  autoPull: boolean;
  autoUpload: boolean;
  includeNew: boolean;
  nameContains: string;
  site: string;
  viewer: string;
  cloudPaused: boolean;
}
const defaults: Config = {
  host: "roborio-3256-frc.local",
  directory: "/home/lvuser/wpilogs",
  selected: [],
  autoPull: false,
  autoUpload: false,
  includeNew: false,
  nameContains: "",
  site: "https://3256tools.vercel.app",
  viewer: "",
  cloudPaused: false,
};
function initialConfig(): Config {
  try {
    const saved = JSON.parse(
      localStorage.getItem("mayhem.log-transfer.v1") ?? "{}",
    );
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof Config)[]) {
      if (key === "selected") {
        if (
          Array.isArray(saved[key]) &&
          saved[key].every((v: unknown) => typeof v === "string")
        )
          result.selected = saved[key];
      } else if (typeof saved[key] === typeof defaults[key])
        Object.assign(result, { [key]: saved[key] });
    }
    return result;
  } catch {
    return defaults;
  }
}
export function LogTransfer({
  logs,
  updateLog,
  received,
  notify,
}: {
  logs: StoredLog[];
  updateLog: (
    id: string,
    patch: Partial<Omit<StoredLog, "id">>,
  ) => Promise<void>;
  received: (
    buffer: ArrayBuffer,
    name: string,
    path?: string,
    options?: ReceiptOptions,
  ) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState(initialConfig),
    [token, setToken] = useState(""),
    [remote, setRemote] = useState<RemoteLog[]>([]),
    [busy, setBusy] = useState(false),
    [cloudBusy, setCloudBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState("");
  const pulled = useRef(new Set<string>()),
    inFlight = useRef(false),
    uploadInFlight = useRef(false);
  const update = (change: Partial<Config>) =>
    setConfig((previous) => {
      const next = { ...previous, ...change };
      try {
        localStorage.setItem("mayhem.log-transfer.v1", JSON.stringify(next));
      } catch (e) {
        notify(`Could not save transfer preferences: ${String(e)}`);
      }
      return next;
    });
  const pull = useCallback(
    async (files: RemoteLog[], background = false) => {
      const failures: string[] = [];
      for (const log of files) {
        setTransferStatus(
          `Downloading ${log.name} (${files.indexOf(log) + 1}/${files.length})`,
        );
        try {
          const path = await invoke<string>("download_robot_log", {
            host: config.host,
            remote: log.path,
            expectedSize: log.size,
          });
          await received(await nativeRead(path), log.name, path, {
            queueSite: config.autoUpload ? config.site : undefined,
            source: `${config.host}:${log.path}:${log.size}`,
            background,
          });
          pulled.current.add(`${config.host}:${log.path}:${log.size}`);
        } catch (e) {
          failures.push(`${log.name}: ${String(e)}`);
        }
      }
      setTransferStatus(
        files.length
          ? `${files.length - failures.length} downloaded · ${failures.length} waiting to retry`
          : "No new selected recordings",
      );
      if (failures.length) notify(failures.slice(0, 3).join("\n"));
    },
    [config.host, config.autoUpload, config.site, received, notify],
  );
  const refresh = useCallback(
    async (automatic = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const files = await invoke<RemoteLog[]>("list_robot_logs", {
          host: config.host,
          directory: config.directory,
        });
        setRemote(files);
        if (automatic)
          await pull(
            files.filter(
              (log) =>
                (config.selected.includes(log.path) ||
                  (config.includeNew &&
                    !!config.nameContains.trim() &&
                    log.name
                      .toLowerCase()
                      .includes(config.nameContains.trim().toLowerCase()))) &&
                !pulled.current.has(`${config.host}:${log.path}:${log.size}`) &&
                !logs.some((saved) =>
                  saved.sources?.includes(
                    `${config.host}:${log.path}:${log.size}`,
                  ),
                ),
            ),
            true,
          );
      } catch (e) {
        notify(String(e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [
      config.host,
      config.directory,
      config.selected,
      config.includeNew,
      config.nameContains,
      pull,
      notify,
      logs,
    ],
  );
  const refreshLatest = useRef(refresh);
  refreshLatest.current = refresh;
  useEffect(() => {
    if (!config.autoPull || !desktop) return;
    const timer = setInterval(() => {
      void refreshLatest.current(true);
    }, 15000);
    return () => clearInterval(timer);
  }, [config.autoPull]);
  useEffect(() => {
    if (!desktop || !token.trim() || config.cloudPaused) return;
    const upload = async () => {
      if (uploadInFlight.current) return;
      const log = logs.find(
        (log) =>
          log.nativePath &&
          (!log.uploadSite || log.uploadSite === config.site) &&
          (log.upload === "queued" || log.upload === "error") &&
          (log.retryAt ?? 0) <= Date.now(),
      );
      if (!log) return;
      uploadInFlight.current = true;
      setCloudBusy(true);
      try {
        const cloudUrl = await invoke<string>("upload_team_log", {
          path: log.nativePath,
          site: config.site,
          token,
          name: log.name,
          expectedHash: log.id,
        });
        await updateLog(log.id, {
          upload: "uploaded",
          uploadSite: config.site,
          cloudUrl,
          uploadError: undefined,
          retryAt: undefined,
        });
      } catch (e) {
        const attempts = (log.attempts ?? 0) + 1;
        await updateLog(log.id, {
          upload: "error",
          attempts,
          retryAt:
            Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)),
          uploadError: String(e),
        }).catch((error) => notify(String(error)));
      } finally {
        uploadInFlight.current = false;
        setCloudBusy(false);
      }
    };
    void upload();
    const timer = setInterval(() => {
      void upload();
    }, 5000);
    return () => clearInterval(timer);
  }, [logs, token, config.site, config.cloudPaused, updateLog, notify]);
  return (
    <details className="ms-transfer">
      <summary>Robot collection & cloud sync</summary>
      <div className="ms-transfer-grid">
        <div>
          <label className="ms-label">
            Robot address
            <input
              value={config.host}
              onChange={(e) => {
                pulled.current.clear();
                setRemote([]);
                update({ host: e.target.value, selected: [], autoPull: false });
              }}
            />
          </label>
          <label className="ms-label">
            Log folder
            <input
              list="mayhem-log-directories"
              placeholder="/home/lvuser/wpilogs"
              value={config.directory}
              onChange={(e) => {
                setRemote([]);
                update({
                  directory: e.target.value,
                  selected: [],
                  autoPull: false,
                });
              }}
            />
            <datalist id="mayhem-log-directories">
              <option value="/home/lvuser/wpilogs" />
              <option value="/U/wpilogs" />
              <option value="/home/lvuser/logs" />
              <option value="/u/logs" />
            </datalist>
          </label>
          <button
            className="ms-button"
            disabled={!desktop || busy}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={13} />
            {busy ? "Transferring…" : "List robot logs"}
          </button>
          <div className="ms-remote-list">
            {remote.map((log) => (
              <label key={log.path}>
                <input
                  type="checkbox"
                  checked={config.selected.includes(log.path)}
                  onChange={(e) =>
                    update({
                      selected: e.target.checked
                        ? [...config.selected, log.path]
                        : config.selected.filter((p) => p !== log.path),
                    })
                  }
                />
                <span>
                  {log.name}
                  <small>{(log.size / 1024 / 1024).toFixed(1)} MB</small>
                </span>
              </label>
            ))}
            {!remote.length && (
              <p>
                List the robot’s files, then choose exactly which logs to
                download.
              </p>
            )}
          </div>
          <button
            className="ms-button"
            disabled={!desktop || busy || !config.selected.length}
            onClick={async () => {
              if (inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              try {
                await pull(
                  remote.filter((log) => config.selected.includes(log.path)),
                );
              } catch (e) {
                notify(String(e));
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            <ArrowDownToLine size={13} />
            Download selected ({config.selected.length})
          </button>
          <label className="ms-transfer-check">
            <input
              type="checkbox"
              disabled={!desktop}
              checked={config.autoPull}
              onChange={(e) => update({ autoPull: e.target.checked })}
            />
            Keep selected files synced
          </label>
          {transferStatus && <p role="status">{transferStatus}</p>}
          <label className="ms-transfer-check">
            <input
              type="checkbox"
              disabled={!desktop}
              checked={config.includeNew}
              onChange={(e) => update({ includeNew: e.target.checked })}
            />
            Also collect future matching logs
          </label>
          {config.includeNew && (
            <label className="ms-label">
              Filename contains
              <input
                value={config.nameContains}
                placeholder="e.g. FRC_2026"
                onChange={(e) => update({ nameContains: e.target.value })}
              />
            </label>
          )}
          <p>
            Checks every 15 seconds while Mayhem is open. Robot files are
            preserved. A changing file is retried. Future logs are included only
            when a nonempty filename filter is set and syncing is enabled.
          </p>
        </div>
        <div>
          <label className="ms-label">
            Team website
            <input
              value={config.site}
              onChange={(e) => update({ site: e.target.value })}
            />
          </label>
          <label className="ms-label">
            Device upload token
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Kept in memory for this session"
            />
          </label>
          <label className="ms-transfer-check">
            <input
              type="checkbox"
              disabled={!desktop}
              checked={config.autoUpload}
              onChange={(e) => update({ autoUpload: e.target.checked })}
            />
            Queue newly downloaded logs for upload
          </label>
          <label className="ms-transfer-check">
            <input
              type="checkbox"
              checked={config.cloudPaused}
              onChange={(e) => update({ cloudPaused: e.target.checked })}
            />
            Pause upload queue after the current file
          </label>
          <p>
            Each recording also has its own upload button. Queued uploads
            survive restarts; enter the token again to resume.
          </p>
          <span className="ms-transfer-status">
            <UploadCloud size={15} />
            {cloudBusy
              ? "Uploading to team storage…"
              : `${logs.filter((l) => l.upload === "queued" || l.upload === "error").length} logs queued`}
          </span>
          <label className="ms-label">
            AdvantageScope path (optional)
            <input
              value={config.viewer}
              onChange={(e) => update({ viewer: e.target.value })}
              placeholder="Application path"
            />
          </label>
          <p>
            Opens the selected recording in AdvantageScope. Detects the WPILib
            installation automatically; set a path for another installation.
          </p>
          {!desktop && (
            <p className="ms-native-note">
              Robot collection and external viewers are available in the desktop
              app. Import, playback, and analysis also work in your browser.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}
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
    <div className="ms-log-actions">
      <button
        title="Open in AdvantageScope"
        aria-label={`Open ${log.name} in AdvantageScope`}
        disabled={!desktop || !log.nativePath}
        onClick={() => {
          const viewer = initialConfig().viewer;
          void invoke("open_log_viewer", {
            path: log.nativePath,
            viewer: viewer || null,
          }).catch((e) => notify(String(e)));
        }}
      >
        <ExternalLink size={13} />
      </button>
      <button
        title={
          log.uploadError ??
          (log.upload === "uploaded"
            ? "Uploaded to team website"
            : "Queue cloud upload")
        }
        aria-label={`Upload ${log.name} to team cloud`}
        disabled={
          !desktop ||
          !log.nativePath ||
          log.upload === "uploaded" ||
          log.upload === "queued"
        }
        onClick={() => {
          void update(log.id, {
            upload: "queued",
            uploadSite: initialConfig().site,
            retryAt: 0,
          }).catch((e) => notify(String(e)));
        }}
      >
        {log.upload === "uploaded" ? (
          <Check size={13} />
        ) : (
          <UploadCloud size={13} />
        )}
      </button>
      {log.cloudUrl && (
        <>
        <a
          href={log.cloudUrl}
          target="_blank"
          rel="noreferrer"
          title="View on team website"
        >
          View
        </a>
        <a href={log.cloudUrl.replace(/\/logs(?=\?|$)/, "/logs/advantagescope")} target="_blank" rel="noreferrer" title="Open in AdvantageScope Lite">AdvantageScope</a>
        </>
      )}
    </div>
  );
}
