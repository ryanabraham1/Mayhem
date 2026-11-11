import { beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { sampleProject } from "../src/suite/core/sample";
import {
  PROJECT_KEY,
  PROJECT_BACKUP_KEY,
  PROJECT_RECOVERY_KEY,
  loadProject,
  saveProject,
  recoverySnapshot,
  storeLog,
  listLogs,
  readLog,
  setLogArchived,
  patchLog,
} from "../src/suite/storage";
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
});
it("recovers the previous valid project without destroying the damaged original", () => {
  saveProject(sampleProject);
  saveProject({ ...sampleProject, revision: 1 }, sampleProject);
  localStorage.setItem(PROJECT_KEY, "{ damaged");
  expect(loadProject().project.revision).toBe(0);
  expect(loadProject().error).toContain("backup");
  expect(recoverySnapshot()).toBe("{ damaged");
  saveProject({ ...sampleProject, revision: 2 });
  expect(localStorage.getItem(PROJECT_RECOVERY_KEY)).toBe("{ damaged");
  expect(JSON.parse(localStorage.getItem(PROJECT_BACKUP_KEY)!).revision).toBe(
    0,
  );
});
it("rejects a stale editor before replacing another window’s save", () => {
  saveProject({ ...sampleProject, revision: 4 });
  expect(() =>
    saveProject({ ...sampleProject, revision: 2 }, sampleProject),
  ).toThrow(/Another window/);
  expect(loadProject().project.revision).toBe(4);
});
it("updates log metadata without replacing originals and archives reversibly", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const log = { id: "test", name: "run.wpilog", bytes: 3, added: 1 };
  await storeLog(log, bytes);
  await storeLog({ ...log, upload: "queued" });
  expect(new Uint8Array(await readLog(log.id))).toEqual(new Uint8Array(bytes));
  await setLogArchived(log.id, true);
  await patchLog(log.id, {
    upload: "uploaded",
    cloudUrl: "https://example.test/logs",
  });
  expect((await listLogs())[0].archived).toBe(true);
  await setLogArchived(log.id, false);
  expect((await listLogs())[0].archived).toBe(false);
});
it("migrates version-one recording buffers without losing metadata", async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("mayhem-suite", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("logs", { keyPath: "id" }).put({
        id: "v1",
        name: "old.wpilog",
        added: 1,
        bytes: 2,
        buffer: new Uint8Array([7, 8]).buffer,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const logs = await listLogs();
  expect(logs[0].name).toBe("old.wpilog");
  expect("buffer" in logs[0]).toBe(false);
  expect(new Uint8Array(await readLog("v1"))).toEqual(new Uint8Array([7, 8]));
});
