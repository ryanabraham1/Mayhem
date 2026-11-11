// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { decodeNT4, NT4Observer, nt4Ping } from "../src/suite/core/nt4.ts";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("decodes multiple MessagePack values and round-trips timestamp probes", () => {
  expect(decodeNT4(nt4Ping(123456))).toEqual([[-1, 0, 2, 123456]]);
  const first = new Uint8Array([0x94, 1, 10, 0, 0xc3]);
  const text = new TextEncoder().encode("Holding");
  const second = new Uint8Array([0x94, 2, 11, 4, 0xa0 + text.length, ...text]);
  const both = new Uint8Array([...first, ...second]);
  expect(decodeNT4(both.buffer)).toEqual([
    [1, 10, 0, true],
    [2, 11, 4, "Holding"],
  ]);
  expect(() => decodeNT4(both.buffer.slice(0, -1))).toThrow(/Truncated/);
});
it("keeps the greatest timestamp, removes unannounced values, and sends no publish operations", () => {
  vi.useFakeTimers();
  const sockets: any[] = [];
  class Socket {
    readyState = 1;
    binaryType = "";
    onopen = () => {};
    onclose = () => {};
    onerror = () => {};
    onmessage = (_e: any) => {};
    sent: any[] = [];
    constructor(
      public url: URL,
      public protocol: string,
    ) {
      sockets.push(this);
    }
    send(value: any) {
      this.sent.push(value);
    }
    close() {
      this.readyState = 3;
      this.onclose();
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const snapshots: any[] = [];
  const observer = new NT4Observer("127.0.0.1:5815", (s) => snapshots.push(s));
  observer.connect();
  const socket = sockets[0];
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify([
      {
        method: "announce",
        params: { id: 1, name: "/Mayhem/States/Test/state", type: "string" },
      },
    ]),
  });
  const message = (time: number, value: string) =>
    new Uint8Array([
      0x94,
      1,
      time,
      4,
      0xa0 + value.length,
      ...new TextEncoder().encode(value),
    ]).buffer;
  socket.onmessage({ data: message(20, "Holding") });
  socket.onmessage({ data: message(10, "Idle") });
  vi.advanceTimersByTime(60);
  expect(snapshots.at(-1).topics["/Mayhem/States/Test/state"].value).toBe(
    "Holding",
  );
  const control = socket.sent
    .filter((s: any) => typeof s === "string")
    .flatMap((s: string) => JSON.parse(s));
  expect(
    control.every((m: any) => ["subscribe", "unsubscribe"].includes(m.method)),
  ).toBe(true);
  socket.onmessage({
    data: JSON.stringify([{ method: "unannounce", params: { id: 1 } }]),
  });
  vi.advanceTimersByTime(60);
  expect(snapshots.at(-1).topics).toEqual({});
  observer.disconnect();
});
