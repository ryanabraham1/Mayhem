import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
vi.mock("../src/suite/native", () => ({
  desktop: true,
  invoke: vi.fn(),
  nativeRead: vi.fn(async () => new Uint8Array([1]).buffer),
}));
import { invoke } from "../src/suite/native";
import { useLogSync, POLL_MS, SYNC_KEY } from "../src/suite/logSync";
import { LogActions } from "../src/suite/logs/LogsPage";
import type { StoredLog } from "../src/suite/storage";

const files = [
  { name: "a.wpilog", path: "/home/lvuser/logs/a.wpilog", size: 10 },
  { name: "b.wpilog", path: "/home/lvuser/logs/b.wpilog", size: 20 },
];
const host = "robot.local";
function setup(logs: StoredLog[] = []) {
  const received = vi.fn(async () => {}),
    notify = vi.fn(),
    updateLog = vi.fn(async () => {});
  const view = renderHook(
    (props: { logs: StoredLog[] }) =>
      useLogSync({ host, logs: props.logs, received, updateLog, notify }),
    { initialProps: { logs } },
  );
  return { view, received, notify, updateLog };
}
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.useRealTimers());

it("keeps polling through library updates and skips robot recordings already saved in prior sessions", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ selected: [files[0].path], autoPull: true }));
  vi.mocked(invoke).mockResolvedValue(files);
  let logs: StoredLog[] = [
    { id: "saved", name: "a.wpilog", bytes: 10, added: 1, sources: [`${host}:${files[0].path}:10`] },
  ];
  const { view, received } = setup(logs);
  for (let i = 0; i < 4; i++) {
    await act(() => vi.advanceTimersByTimeAsync(5000));
    logs = logs.map((log) => ({ ...log, attempts: i }));
    view.rerender({ logs });
  }
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "list_robot_logs")).toHaveLength(1);
  expect(received).not.toHaveBeenCalled();
});

it("continues collecting the remaining selected files after one robot transfer fails", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ selected: files.map((f) => f.path) }));
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "list_robot_logs") return files as any;
    if (args.remote === files[0].path) throw new Error("Recording is still changing");
    return "/saved/b.wpilog" as any;
  });
  const { view, received, notify } = setup();
  await act(() => view.result.current.refresh());
  await act(() => view.result.current.downloadSelected());
  expect(received).toHaveBeenCalledOnce();
  expect((received.mock.calls[0] as unknown[])[1]).toBe("b.wpilog");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("still changing"));
});

it("accepts a custom season log folder and clears selection and polling when it changes", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  localStorage.setItem(SYNC_KEY, JSON.stringify({ selected: [files[0].path], autoPull: true }));
  const { view } = setup();
  act(() => view.result.current.changeDirectory("/U/wpilogs"));
  const saved = JSON.parse(localStorage.getItem(SYNC_KEY)!);
  expect(saved.directory).toBe("/U/wpilogs");
  expect(saved.selected).toEqual([]);
  expect(saved.autoPull).toBe(false);
  await act(() => view.result.current.refresh());
  expect(invoke).toHaveBeenCalledWith("list_robot_logs", expect.objectContaining({ directory: "/U/wpilogs" }));
});

it("opens the selected recording in desktop AdvantageScope without duplicate web viewer links", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(
    <LogActions
      log={{ id: "hash", name: "match.wpilog", bytes: 1, added: 1, nativePath: "/saved/match.wpilog", cloudUrl: "https://team.example/logs?log=hash" }}
      update={vi.fn(async () => {})}
      notify={vi.fn()}
    />,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open match.wpilog in AdvantageScope" })));
  expect(invoke).toHaveBeenCalledWith("open_log_viewer", { path: "/saved/match.wpilog", viewer: null });
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it("automatically imports only after the robot file stops growing across consecutive checks", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ selected: [files[0].path], autoPull: true }));
  let size = 10;
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "list_robot_logs" ? ([{ ...files[0], size }] as any) : ("/saved/a.wpilog" as any),
  );
  const { received } = setup();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(received).not.toHaveBeenCalled();
  size = 20;
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(received).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(received).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("download_robot_log", expect.objectContaining({ expectedSize: 20 }));
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
  expect(received).toHaveBeenCalledOnce();
});

it("collects every new robot log when take-all is on, newest first", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ autoPull: true, collectAll: true }));
  vi.mocked(invoke).mockImplementation(async (name, args) =>
    name === "list_robot_logs" ? (files as any) : (`/saved/${String(args.remote).split("/").pop()}` as any),
  );
  const { received } = setup();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
  expect((received.mock.calls as unknown[][]).map((c) => c[1])).toEqual(["b.wpilog", "a.wpilog"]);
});

it("stays quiet while the robot is unplugged instead of raising an error every poll", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ autoPull: true, collectAll: true }));
  vi.mocked(invoke).mockRejectedValue(new Error("Robot SFTP failed: no route to host"));
  const { view, notify } = setup();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3));
  expect(notify).not.toHaveBeenCalled();
  expect(view.result.current.reach).toBe("unreachable");
  expect(view.result.current.status).toBe("Waiting for the robot");
});

it("collects from a local folder (simulation or USB) without SFTP, keeping the original file", async () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ source: "folder", folder: "/sim/logs", autoPull: true, collectAll: true }));
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "list_local_logs" ? ([{ name: "FRC_sim.wpilog", path: "/sim/logs/FRC_sim.wpilog", size: 30 }] as any) : undefined,
  );
  const { received } = setup();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
  expect(invoke).toHaveBeenCalledWith("list_local_logs", { directory: "/sim/logs" });
  expect(invoke).not.toHaveBeenCalledWith("download_robot_log", expect.anything());
  expect(received).toHaveBeenCalledWith(expect.anything(), "FRC_sim.wpilog", "/sim/logs/FRC_sim.wpilog", expect.objectContaining({ source: "local:/sim/logs/FRC_sim.wpilog:30" }));
});


it("remembers a token by default across restarts without resetting collection preferences", () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ site: "https://team.example", autoPull: true }));
  const first = setup();
  expect(first.view.result.current.config.rememberToken).toBe(true);
  act(() => first.view.result.current.setToken("test-device-token"));
  first.view.unmount();
  const second = setup();
  expect(second.view.result.current.token).toBe("test-device-token");
  expect(second.view.result.current.config.site).toBe("https://team.example");
  expect(second.view.result.current.config.autoPull).toBe(true);
});

it("preserves an explicit session-only choice and removes the previously remembered token", () => {
  const first = setup();
  act(() => first.view.result.current.setToken("test-device-token"));
  act(() => first.view.result.current.setRemember(false));
  expect(first.view.result.current.token).toBe("test-device-token");
  first.view.unmount();
  const second = setup();
  expect(second.view.result.current.config.rememberToken).toBe(false);
  expect(second.view.result.current.token).toBe("");
});

it("saves an existing session token when remembering is enabled", () => {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ rememberToken: false }));
  const first = setup();
  act(() => first.view.result.current.setToken("test-device-token"));
  act(() => first.view.result.current.setRemember(true));
  first.view.unmount();
  const second = setup();
  expect(second.view.result.current.token).toBe("test-device-token");
});

it("reports token save failures instead of silently losing the token", () => {
  const { view, notify } = setup();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    act(() => view.result.current.setToken("test-device-token"));
    expect(view.result.current.token).toBe("test-device-token");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Could not save the upload token"));
  } finally {
    write.mockRestore();
  }
});
