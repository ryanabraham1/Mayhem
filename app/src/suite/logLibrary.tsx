import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  analyze,
  type Analysis,
  type PowerMapping,
  type Recording,
} from "./core/analysis.ts";
import {
  listLogs,
  patchLog,
  readLog,
  setLogArchived,
  storeLog,
  type LogSummary,
  type ReceiptOptions,
  type StoredLog,
} from "./storage";
import { invoke, nativeRead } from "./native";
import { loadSyncConfig, useLogSync } from "./logSync";

export const MAX_LOG_BYTES = 250 * 1024 * 1024;
type Parsed = { recording: Recording; analysis: Analysis };

export function summarize({ recording, analysis }: Parsed): LogSummary {
  return {
    duration: recording.duration,
    channels: recording.channels.length,
    errors: analysis.findings.filter((f) => f.severity === "error").length,
    warnings: analysis.findings.filter((f) => f.severity === "warning").length,
    minVoltage: analysis.power.minVoltage,
    peakCurrent: analysis.power.peakCurrent,
  };
}

function useLogLibraryState({
  policy,
  notify,
  host,
}: {
  policy: unknown;
  notify: (message: string) => void;
  host: string;
}) {
  const [logs, setLogs] = useState<StoredLog[]>([]);
  const [current, setCurrent] = useState<(Parsed & { id: string }) | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const requests = useRef(
    new Map<
      number,
      { resolve: (result: Parsed) => void; reject: (error: Error) => void }
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
        pending.reject(new Error("The log reader stopped unexpectedly."));
      requests.current.clear();
    };
    const pendingRequests = requests.current;
    return () => {
      instance.terminate();
      worker.current = null;
      for (const pending of pendingRequests.values())
        pending.reject(new Error("Log library closed."));
      pendingRequests.clear();
    };
  }, [notify]);

  const parse = useCallback(
    (buffer: ArrayBuffer, name: string) =>
      new Promise<Parsed>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error("The log reader is not ready yet."));
          return;
        }
        const id = ++sequence.current;
        requests.current.set(id, { resolve, reject });
        const copy = buffer.slice(0);
        worker.current.postMessage({ buffer: copy, name, id, policy }, [copy]);
      }),
    [policy],
  );

  const received = useCallback(
    async (
      buffer: ArrayBuffer,
      name: string,
      nativePath?: string,
      options: ReceiptOptions = {},
    ) => {
      if (buffer.byteLength > MAX_LOG_BYTES)
        throw new Error("Logs larger than 250 MB can't be imported yet.");
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
        summary: summarize(result),
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
      if (!options.background) setCurrent({ ...result, id });
    },
    [parse],
  );

  const updateLog = useCallback(
    async (id: string, patch: Partial<Omit<StoredLog, "id">>) => {
      const log = await patchLog(id, patch);
      setLogs((previous) => previous.map((p) => (p.id === id ? log : p)));
    },
    [],
  );

  const bytesOf = async (log: StoredLog) => {
    try {
      return await readLog(log.id);
    } catch (e) {
      if (!log.nativePath) throw e;
      return nativeRead(log.nativePath);
    }
  };

  const open = async (log: StoredLog) => {
    setBusy(true);
    try {
      const result = await parse(await bytesOf(log), log.name);
      setCurrent({ ...result, id: log.id });
      const summary = summarize(result);
      if (JSON.stringify(summary) !== JSON.stringify(log.summary))
        await updateLog(log.id, { summary }).catch(() => {});
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
      const config = loadSyncConfig();
      await received(await file.arrayBuffer(), file.name, undefined, {
        queueSite: config.autoUpload ? config.site : undefined,
      });
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
      if (typeof path === "string") {
        const config = loadSyncConfig();
        await received(
          await nativeRead(path),
          path.split(/[\\/]/).at(-1) ?? path,
          path,
          { queueSite: config.autoUpload ? config.site : undefined },
        );
      }
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remap = (mapping: PowerMapping) =>
    setCurrent((c) =>
      c ? { ...c, analysis: analyze(c.recording, mapping, policy) } : c,
    );

  const archive = async (log: StoredLog, archived: boolean) => {
    try {
      await setLogArchived(log.id, archived);
      setLogs(await listLogs());
    } catch (e) {
      notify(String(e));
    }
  };

  const sync = useLogSync({ host, logs, received, updateLog, notify });

  return {
    logs,
    current,
    busy,
    open,
    importFile,
    importNative,
    received,
    updateLog,
    bytesOf,
    remap,
    archive,
    close: () => setCurrent(null),
    sync,
  };
}
export type LogLibrary = ReturnType<typeof useLogLibraryState>;
const LogContext = createContext<LogLibrary | null>(null);
export function LogLibraryProvider({
  children,
  ...props
}: {
  children: ReactNode;
  policy: unknown;
  notify: (message: string) => void;
  host: string;
}) {
  const value = useLogLibraryState(props);
  return <LogContext.Provider value={value}>{children}</LogContext.Provider>;
}
export function useLogLibrary() {
  const value = useContext(LogContext);
  if (!value)
    throw new Error("useLogLibrary must be used inside LogLibraryProvider.");
  return value;
}
