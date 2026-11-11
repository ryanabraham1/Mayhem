import { parseProject, type SuiteProject } from "./core/model.ts";
import { sampleProject } from "./core/sample.ts";
export const PROJECT_KEY = "mayhem.suite.project.v1";
export const PROJECT_BACKUP_KEY = `${PROJECT_KEY}.backup`;
export const PROJECT_RECOVERY_KEY = `${PROJECT_KEY}.recovery`;
export function loadProject(): { project: SuiteProject; error?: string } {
  try {
    const saved = localStorage.getItem(PROJECT_KEY);
    return {
      project: saved ? parseProject(saved) : structuredClone(sampleProject),
    };
  } catch (e) {
    try {
      const backup = localStorage.getItem(PROJECT_BACKUP_KEY);
      if (backup)
        return {
          project: parseProject(backup),
          error:
            "The latest saved project was damaged. Opened the previous valid backup. The original can be exported from Robot setup.",
        };
    } catch {
      /* Keep the original untouched even when recovery is unavailable. */
    }
    return {
      project: structuredClone(sampleProject),
      error: `Saved project could not be loaded: ${e instanceof Error ? e.message : String(e)}. Import a recovered project to replace it.`,
    };
  }
}
export function saveProject(
  project: SuiteProject,
  expected?: Pick<SuiteProject, "id" | "revision">,
) {
  const existing = localStorage.getItem(PROJECT_KEY);
  if (existing) {
    let valid: SuiteProject | undefined;
    try {
      valid = parseProject(existing);
    } catch {
      localStorage.setItem(PROJECT_RECOVERY_KEY, existing);
    }
    if (valid) {
      if (
        expected &&
        (valid.id !== expected.id || valid.revision !== expected.revision)
      )
        throw new Error(
          "Another window changed this workspace. Export your current project, then reopen the latest version before editing.",
        );
      localStorage.setItem(PROJECT_BACKUP_KEY, existing);
    }
  }
  localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
}
export function recoverySnapshot(): string | null {
  const current = localStorage.getItem(PROJECT_KEY);
  if (current) {
    try {
      parseProject(current);
    } catch {
      return current;
    }
  }
  return (
    localStorage.getItem(PROJECT_RECOVERY_KEY) ??
    localStorage.getItem(PROJECT_BACKUP_KEY)
  );
}
export function download(
  name: string,
  content: BlobPart,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const openLogs = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mayhem-suite", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("logs"))
        request.result.createObjectStore("logs", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("blobs"))
        request.result.createObjectStore("blobs");
      // Version 1 stored originals on the metadata row. Move them without
      // loading every recording into memory when the library opens.
      const tx = request.transaction!;
      const cursor = tx.objectStore("logs").openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const { buffer, ...metadata } = row.value;
        if (Object.prototype.toString.call(buffer) === "[object ArrayBuffer]") {
          tx.objectStore("blobs").put(buffer, metadata.id);
          row.update(metadata);
        }
        row.continue();
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
export interface StoredLog {
  id: string;
  name: string;
  bytes: number;
  added: number;
  nativePath?: string;
  sources?: string[];
  uploadSite?: string;
  upload?: "queued" | "uploaded" | "error";
  attempts?: number;
  retryAt?: number;
  cloudUrl?: string;
  uploadError?: string;
  archived?: boolean;
}
export interface ReceiptOptions {
  queueSite?: string;
  source?: string;
  background?: boolean;
}
export async function storeLog(log: StoredLog, buffer?: ArrayBuffer) {
  const db = await openLogs();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["logs", "blobs"], "readwrite");
      tx.objectStore("logs").put(log);
      if (buffer) tx.objectStore("blobs").put(buffer, log.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function patchLog(
  id: string,
  patch: Partial<Omit<StoredLog, "id">>,
): Promise<StoredLog> {
  const db = await openLogs();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("logs", "readwrite"),
        store = tx.objectStore("logs"),
        request = store.get(id);
      let next: StoredLog;
      request.onsuccess = () => {
        if (!request.result) {
          tx.abort();
          return;
        }
        next = { ...request.result, ...patch, id };
        store.put(next);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(
          new Error("Recording is no longer available. Refresh the library."),
        );
    });
  } finally {
    db.close();
  }
}
export async function readLog(id: string): Promise<ArrayBuffer> {
  const db = await openLogs();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("blobs").objectStore("blobs").get(id);
      request.onsuccess = () =>
        request.result
          ? resolve(request.result)
          : reject(
              new Error(
                "Original recording is unavailable. Reimport the file.",
              ),
            );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function listLogs(): Promise<StoredLog[]> {
  const db = await openLogs();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("logs").objectStore("logs").getAll();
      request.onsuccess = () =>
        resolve(
          request.result.sort(
            (a: StoredLog, b: StoredLog) => b.added - a.added,
          ),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
/** Hide a recording without destroying its original; it can be restored later. */
export async function setLogArchived(id: string, archived: boolean) {
  const db = await openLogs();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("logs", "readwrite"),
        store = tx.objectStore("logs"),
        request = store.get(id);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, archived });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
