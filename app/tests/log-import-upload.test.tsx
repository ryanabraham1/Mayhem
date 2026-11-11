import { webcrypto } from "node:crypto";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyze } from "../src/suite/core/analysis";
import type { StoredLog } from "../src/suite/storage";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/sim/match.wpilog") }));
vi.mock("../src/suite/native", () => ({ desktop: true, invoke: vi.fn(), nativeRead: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) }));
vi.mock("../src/suite/storage", () => ({ listLogs: vi.fn(), storeLog: vi.fn(), patchLog: vi.fn(), readLog: vi.fn(), setLogArchived: vi.fn(), deleteLog: vi.fn() }));
import { invoke } from "../src/suite/native";
import { listLogs, storeLog, patchLog, deleteLog } from "../src/suite/storage";
import { LogLibraryProvider, useLogLibrary } from "../src/suite/logLibrary";
import { SYNC_KEY, deletedSources } from "../src/suite/logSync";
const recording = { name: "match.wpilog", duration: 2, channels: [], warnings: [] };
class ParsedWorker {
  onmessage?: (event: { data: unknown }) => void;
  postMessage({ id }: { id: number }) {
    queueMicrotask(() => this.onmessage?.({ data: { id, recording, analysis: analyze(recording) } }));
  }
  terminate() {}
}
let saved: StoredLog[];
const notify = vi.fn();
const site = "https://team.example";
function setup(config: Record<string, unknown>) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ site, ...config }));
  return renderHook(() => useLogLibrary(), { wrapper: ({ children }: { children: ReactNode }) =>
    <LogLibraryProvider policy={undefined} notify={notify} host="offline-robot.local">{children}</LogLibraryProvider>,
  });
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("Worker", ParsedWorker);
  vi.stubGlobal("crypto", webcrypto);
  saved = [];
  vi.mocked(listLogs).mockImplementation(async () => saved);
  vi.mocked(storeLog).mockImplementation(async log => { saved = [log]; });
  vi.mocked(patchLog).mockImplementation(async (id, patch) => {
    const next = { ...saved.find(l => l.id === id)!, ...patch };
    saved = [next];
    return next;
  });
  vi.mocked(invoke).mockImplementation(async name => {
    if (name === "archive_log_file") return "/archive/match.wpilog" as any;
    if (name === "upload_team_log") return `${site}/logs/match` as any;
    throw new Error(`Unexpected native call: ${name}`);
  });
});
afterEach(() => vi.unstubAllGlobals());
it("queues imports without a token, then uploads when a token is supplied without a robot connection", async () => {
  const view = setup({ autoUpload: true });
  await act(() => view.result.current.importNative());
  expect(saved[0]).toMatchObject({ upload: "queued", uploadSite: site, nativePath: "/archive/match.wpilog" });
  expect(invoke).not.toHaveBeenCalledWith("upload_team_log", expect.anything());
  act(() => view.result.current.sync.setToken("device-token"));
  await waitFor(() => expect(saved[0].upload).toBe("uploaded"));
  expect(invoke).toHaveBeenCalledWith("upload_team_log", expect.objectContaining({ site, token: "device-token", path: "/archive/match.wpilog" }));
  expect(notify).not.toHaveBeenCalled();
});
it("leaves imports local when automatic upload is disabled", async () => {
  const view = setup({ autoUpload: false });
  act(() => view.result.current.sync.setToken("device-token"));
  await act(() => view.result.current.importNative());
  expect(saved[0].upload).toBeUndefined();
  expect(saved[0].uploadSite).toBeUndefined();
  expect(invoke).not.toHaveBeenCalledWith("upload_team_log", expect.anything());
});
it("queues while paused, uploads after resuming, and does not re-upload duplicates", async () => {
  const view = setup({ autoUpload: true, cloudPaused: true });
  act(() => view.result.current.sync.setToken("device-token"));
  await act(() => view.result.current.importNative());
  expect(saved[0].upload).toBe("queued");
  expect(invoke).not.toHaveBeenCalledWith("upload_team_log", expect.anything());
  act(() => view.result.current.sync.update({ cloudPaused: false }));
  await waitFor(() => expect(saved[0].upload).toBe("uploaded"));
  await act(() => view.result.current.importNative());
  expect(saved[0].upload).toBe("uploaded");
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "upload_team_log")).toHaveLength(1);
});
it("queues file-input imports using the latest automatic-upload preference", async () => {
  const view = setup({ autoUpload: false });
  act(() => view.result.current.sync.update({ autoUpload: true }));
  await act(() => view.result.current.importFile({ name: "match.wpilog", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as File));
  expect(saved[0]).toMatchObject({ upload: "queued", uploadSite: site });
});

it("deletes recordings from the library and Mayhem's folder, and remembers robot sources so they aren't re-collected", async () => {
  const view = setup({});
  await waitFor(() => expect(listLogs).toHaveBeenCalled());
  const robot: StoredLog = { id: "r", name: "robot.wpilog", bytes: 1, added: 1, nativePath: "/recordings/r.wpilog", sources: ["roborio:/home/lvuser/a.wpilog:10"] };
  const web: StoredLog = { id: "w", name: "web.wpilog", bytes: 1, added: 2 };
  saved = [robot, web];
  localStorage.setItem("robot-log-mapping:r", "{}");
  vi.mocked(deleteLog).mockImplementation(async (id) => { saved = saved.filter((l) => l.id !== id); });
  vi.mocked(invoke).mockResolvedValue(undefined);
  await act(() => view.result.current.remove([robot, web]));
  expect(deleteLog).toHaveBeenCalledWith("r");
  expect(deleteLog).toHaveBeenCalledWith("w");
  expect(invoke).toHaveBeenCalledWith("delete_library_file", { path: "/recordings/r.wpilog" });
  expect(vi.mocked(invoke).mock.calls.filter(([n]) => n === "delete_library_file")).toHaveLength(1);
  expect(view.result.current.logs).toEqual([]);
  expect(deletedSources().has("roborio:/home/lvuser/a.wpilog:10")).toBe(true);
  expect(localStorage.getItem("robot-log-mapping:r")).toBeNull();
  expect(notify).not.toHaveBeenCalled();
});

it("reports a file that could not be deleted while still removing it from the library", async () => {
  const view = setup({});
  const log: StoredLog = { id: "x", name: "x.wpilog", bytes: 1, added: 1, nativePath: "/elsewhere/x.wpilog" };
  saved = [log];
  vi.mocked(deleteLog).mockImplementation(async () => { saved = []; });
  vi.mocked(invoke).mockRejectedValue("Mayhem only deletes recordings saved in its own library folder.");
  await act(() => view.result.current.remove([log]));
  expect(view.result.current.logs).toEqual([]);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("its file stayed on disk"));
});
