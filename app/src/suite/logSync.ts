import { useCallback, useEffect, useRef, useState } from "react";
import { desktop, invoke, nativeRead, type RemoteLog } from "./native";
import type { ReceiptOptions, StoredLog } from "./storage";

export interface SyncConfig {
  /** Where logs come from: the robot over SFTP, or a local folder (simulation, USB stick). */
  source: "robot" | "folder";
  folder: string;
  directory: string;
  selected: string[];
  /** Poll the robot while Mayhem is open. */
  autoPull: boolean;
  /** Collect every log on the robot that is not already in the library. */
  collectAll: boolean;
  /** Also collect future logs whose name contains `nameContains`. */
  includeNew: boolean;
  nameContains: string;
  autoUpload: boolean;
  site: string;
  viewer: string;
  cloudPaused: boolean;
  rememberToken: boolean;
}
export const SYNC_KEY = "mayhem.log-transfer.v1";
const TOKEN_KEY = "mayhem.upload-token.v1";
export const syncDefaults: SyncConfig = {
  source: "robot",
  folder: "",
  directory: "/home/lvuser/wpilogs",
  selected: [],
  autoPull: false,
  collectAll: false,
  includeNew: false,
  nameContains: "",
  autoUpload: false,
  site: "https://3256tools.vercel.app",
  viewer: "",
  cloudPaused: false,
  rememberToken: false,
};
export function loadSyncConfig(): SyncConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}");
    const result = { ...syncDefaults };
    for (const key of Object.keys(syncDefaults) as (keyof SyncConfig)[]) {
      if (key === "selected") {
        if (
          Array.isArray(saved[key]) &&
          saved[key].every((v: unknown) => typeof v === "string")
        )
          result.selected = saved[key];
      } else if (typeof saved[key] === typeof syncDefaults[key])
        Object.assign(result, { [key]: saved[key] });
    }
    return result;
  } catch {
    return syncDefaults;
  }
}
export const POLL_MS = 15000;
const sourceKey = (origin: string, log: RemoteLog) =>
  `${origin}:${log.path}:${log.size}`;

export type RobotReach = "unknown" | "reachable" | "unreachable";

/**
 * Robot log collection and team upload. Runs at app level so collection
 * continues whichever screen is open.
 */
export function useLogSync({
  host,
  logs,
  received,
  updateLog,
  notify,
}: {
  host: string;
  logs: StoredLog[];
  received: (
    buffer: ArrayBuffer,
    name: string,
    path?: string,
    options?: ReceiptOptions,
  ) => Promise<void>;
  updateLog: (id: string, patch: Partial<Omit<StoredLog, "id">>) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [config, setConfig] = useState(loadSyncConfig);
  const [token, setTokenState] = useState(() => {
    try {
      return loadSyncConfig().rememberToken
        ? (localStorage.getItem(TOKEN_KEY) ?? "")
        : "";
    } catch {
      return "";
    }
  });
  const [remote, setRemote] = useState<RemoteLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");
  const [reach, setReach] = useState<RobotReach>("unknown");
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const observed = useRef(new Map<string, number>());
  const pulled = useRef(new Set<string>());
  const inFlight = useRef(false);
  const uploadInFlight = useRef(false);

  const update = useCallback(
    (change: Partial<SyncConfig>) =>
      setConfig((previous) => {
        const next = { ...previous, ...change };
        try {
          localStorage.setItem(SYNC_KEY, JSON.stringify(next));
          if (change.rememberToken === false) localStorage.removeItem(TOKEN_KEY);
        } catch (e) {
          notify(`Could not save collection preferences: ${String(e)}`);
        }
        return next;
      }),
    [notify],
  );
  const setToken = (value: string) => {
    setTokenState(value);
    try {
      if (config.rememberToken) localStorage.setItem(TOKEN_KEY, value);
    } catch {}
  };
  const setRemember = (remember: boolean) => {
    update({ rememberToken: remember });
    try {
      if (remember) localStorage.setItem(TOKEN_KEY, token);
    } catch {}
  };

  const fromFolder = config.source === "folder";
  const origin = fromFolder ? "local" : host;
  // A different robot or folder invalidates everything observed so far.
  const target = `${origin}|${fromFolder ? config.folder : config.directory}`;
  const previousTarget = useRef(target);
  useEffect(() => {
    if (previousTarget.current === target) return;
    previousTarget.current = target;
    observed.current.clear();
    pulled.current.clear();
    setRemote([]);
    setReach("unknown");
  }, [target]);
  const changeDirectory = (directory: string) =>
    update({ directory, selected: [], autoPull: false });

  const pull = useCallback(
    async (files: RemoteLog[], background = false) => {
      const failures: string[] = [];
      for (const [index, log] of files.entries()) {
        setStatus(`Downloading ${log.name} (${index + 1} of ${files.length})`);
        try {
          const path = fromFolder
            ? log.path
            : await invoke<string>("download_robot_log", {
                host,
                remote: log.path,
                expectedSize: log.size,
              });
          await received(await nativeRead(path), log.name, path, {
            queueSite: config.autoUpload ? config.site : undefined,
            source: sourceKey(origin, log),
            background,
          });
          pulled.current.add(sourceKey(origin, log));
        } catch (e) {
          failures.push(`${log.name}: ${String(e)}`);
        }
      }
      setStatus(
        files.length
          ? `${files.length - failures.length} downloaded${failures.length ? `, ${failures.length} will retry` : ""}`
          : "Up to date",
      );
      if (failures.length && !background)
        notify(failures.slice(0, 3).join("\n"));
    },
    [host, origin, fromFolder, config.autoUpload, config.site, received, notify],
  );

  const refresh = useCallback(
    async (automatic = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        if (fromFolder && !config.folder.trim())
          throw new Error("Choose a folder to collect logs from.");
        const files = fromFolder
          ? await invoke<RemoteLog[]>("list_local_logs", { directory: config.folder })
          : await invoke<RemoteLog[]>("list_robot_logs", {
              host,
              directory: config.directory,
            });
        setRemote(files);
        setReach("reachable");
        setLastChecked(Date.now());
        const stable = new Set(
          files
            .filter(
              (log) =>
                log.size > 0 &&
                observed.current.get(`${origin}:${log.path}`) === log.size,
            )
            .map((log) => log.path),
        );
        observed.current = new Map(
          files.map((log) => [`${origin}:${log.path}`, log.size]),
        );
        if (automatic) {
          const filter = config.nameContains.trim().toLowerCase();
          const wanted = files
            .filter(
              (log) =>
                stable.has(log.path) &&
                (config.collectAll ||
                  config.selected.includes(log.path) ||
                  (config.includeNew &&
                    !!filter &&
                    log.name.toLowerCase().includes(filter))) &&
                !pulled.current.has(sourceKey(origin, log)) &&
                !logs.some((saved) =>
                  saved.sources?.includes(sourceKey(origin, log)),
                ),
            )
            .sort((a, b) => b.name.localeCompare(a.name));
          if (wanted.length) await pull(wanted, true);
          else setStatus("Up to date");
        }
      } catch (e) {
        setReach("unreachable");
        setLastChecked(Date.now());
        // Background polling is expected to fail while the robot is unplugged.
        if (automatic) setStatus(fromFolder ? "Folder not available" : "Waiting for the robot");
        else notify(String(e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [
      host,
      origin,
      fromFolder,
      config.folder,
      config.directory,
      config.selected,
      config.collectAll,
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
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [config.autoPull]);

  const downloadSelected = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await pull(remote.filter((log) => config.selected.includes(log.path)));
    } catch (e) {
      notify(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // Upload queue: one file at a time with exponential retry.
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
      setUploading(true);
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
        setUploading(false);
      }
    };
    void upload();
    const timer = setInterval(() => {
      void upload();
    }, 5000);
    return () => clearInterval(timer);
  }, [logs, token, config.site, config.cloudPaused, updateLog, notify]);

  const queued = logs.filter(
    (l) => l.upload === "queued" || l.upload === "error",
  ).length;
  return {
    host,
    origin,
    fromFolder,
    config,
    update,
    changeDirectory,
    token,
    setToken,
    setRemember,
    remote,
    busy,
    uploading,
    status,
    reach,
    lastChecked,
    queued,
    refresh,
    downloadSelected,
    toggleSelected: (path: string, on: boolean) =>
      update({
        selected: on
          ? [...config.selected, path]
          : config.selected.filter((p) => p !== path),
      }),
  };
}
export type LogSync = ReturnType<typeof useLogSync>;
