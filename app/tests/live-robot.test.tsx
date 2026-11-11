import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const clients = vi.hoisted(() => [] as any[]);
vi.mock("../src/suite/core/nt4.ts", () => ({
  NT4Observer: class {
    disconnect = vi.fn();
    setExtraTopics = vi.fn();
    constructor(
      public host: string,
      public emit: (snapshot: any) => void,
    ) {
      clients.push(this);
    }
    connect() {
      this.emit({
        status: "connected",
        topics: {
          "/Robot/state": { value: this.host, timestamp: 0, type: "string" },
        },
      });
    }
  },
}));
import { useLiveRobot } from "../src/suite/useLiveRobot";
beforeEach(() => {
  clients.length = 0;
});
it("clears observations on address changes and ignores late events from the old connection", () => {
  const view = renderHook(({ host }) => useLiveRobot(host), {
    initialProps: { host: "robot-a.local" },
  });
  act(() => view.result.current.connect());
  expect(view.result.current.snapshot.status).toBe("connected");
  view.rerender({ host: "robot-b.local" });
  expect(clients[0].disconnect).toHaveBeenCalled();
  expect(view.result.current.snapshot).toEqual({
    status: "disconnected",
    topics: {},
  });
  act(() => clients[0].emit({ status: "connected", topics: { stale: true } }));
  expect(view.result.current.snapshot.topics).toEqual({});
  act(() => view.result.current.connect());
  expect(clients[1].host).toBe("robot-b.local");
  expect(view.result.current.snapshot.topics["/Robot/state"].value).toBe(
    "robot-b.local",
  );
  view.unmount();
  expect(clients[1].disconnect).toHaveBeenCalled();
});
