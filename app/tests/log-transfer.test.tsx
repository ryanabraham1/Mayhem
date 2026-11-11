import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
vi.mock("../src/suite/native", () => ({
  desktop: true,
  invoke: vi.fn(),
  nativeRead: vi.fn(async () => new Uint8Array([1]).buffer),
}));
import { invoke } from "../src/suite/native";
import { LogTransfer } from "../src/suite/LogTransfer";
import type { StoredLog } from "../src/suite/storage";
const files = [
  { name: "a.wpilog", path: "/home/lvuser/logs/a.wpilog", size: 10 },
  { name: "b.wpilog", path: "/home/lvuser/logs/b.wpilog", size: 20 },
];
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.useRealTimers());
it("keeps polling through library updates and skips robot recordings already saved in prior sessions", async () => {
  localStorage.setItem(
    "mayhem.log-transfer.v1",
    JSON.stringify({
      host: "robot.local",
      selected: [files[0].path],
      autoPull: true,
    }),
  );
  vi.mocked(invoke).mockResolvedValue(files);
  const received = vi.fn(async () => {}),
    notify = vi.fn(),
    updateLog = vi.fn(async () => {});
  let logs: StoredLog[] = [
    {
      id: "saved",
      name: "a.wpilog",
      bytes: 10,
      added: 1,
      sources: [`robot.local:${files[0].path}:10`],
    },
  ];
  const view = render(
    <LogTransfer {...{ logs, received, notify, updateLog }} />,
  );
  fireEvent.click(screen.getByText("Robot collection & cloud sync"));
  for (let i = 0; i < 4; i++) {
    await act(() => vi.advanceTimersByTimeAsync(5000));
    logs = logs.map((log) => ({ ...log, attempts: i }));
    view.rerender(<LogTransfer {...{ logs, received, notify, updateLog }} />);
  }
  expect(
    vi.mocked(invoke).mock.calls.filter(([name]) => name === "list_robot_logs"),
  ).toHaveLength(1);
  expect(received).not.toHaveBeenCalled();
});
it("continues collecting the remaining selected files after one robot transfer fails", async () => {
  localStorage.setItem(
    "mayhem.log-transfer.v1",
    JSON.stringify({ host: "robot.local", selected: files.map((f) => f.path) }),
  );
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "list_robot_logs") return files as any;
    if (args.remote === files[0].path)
      throw new Error("Recording is still changing");
    return "/saved/b.wpilog" as any;
  });
  const received = vi.fn(async () => {}),
    notify = vi.fn();
  render(
    <LogTransfer
      logs={[]}
      received={received}
      notify={notify}
      updateLog={vi.fn(async () => {})}
    />,
  );
  fireEvent.click(screen.getByText("Robot collection & cloud sync"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "List robot logs" })),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Download selected (2)" }),
    ),
  );
  expect(received).toHaveBeenCalledOnce();
  expect(received.mock.calls[0][1]).toBe("b.wpilog");
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("still changing"),
  );
});
it("accepts a custom season log folder and clears selection and polling when it changes", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  localStorage.setItem("mayhem.log-transfer.v1", JSON.stringify({selected:[files[0].path],autoPull:true}));
  render(<LogTransfer logs={[]} received={vi.fn(async()=>{})} notify={vi.fn()} updateLog={vi.fn(async()=>{})} />);
  fireEvent.click(screen.getByText("Robot collection & cloud sync"));
  fireEvent.change(screen.getByLabelText("Log folder"), {target:{value:"/U/wpilogs"}});
  const saved=JSON.parse(localStorage.getItem("mayhem.log-transfer.v1")!);
  expect(saved.directory).toBe("/U/wpilogs");
  expect(saved.selected).toEqual([]);
  expect(saved.autoPull).toBe(false);
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"List robot logs"})));
  expect(invoke).toHaveBeenCalledWith("list_robot_logs", expect.objectContaining({directory:"/U/wpilogs"}));
});
