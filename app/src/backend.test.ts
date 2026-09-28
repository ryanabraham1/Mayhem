import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Backend } from "./backend";

class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(line: string) { this.sent.push(line); }
  /** Server side: open the socket and announce readiness. */
  ready() { this.onopen?.(); this.push({ method: "ready", params: { version: "9.9" } }); }
  push(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  sentMsgs() { return this.sent.map((l) => JSON.parse(l)); }
}

let b: Backend;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  b = new Backend();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Backend", () => {
  it("queues calls until the solver is ready, then sends them in order", async () => {
    void b.connect();
    const p1 = b.call("a");
    const p2 = b.call("b", { x: 1 });
    expect(FakeSocket.last.sent).toEqual([]);
    FakeSocket.last.ready();
    expect(b.status).toBe("ready");
    expect(b.version).toBe("9.9");
    const [m1, m2] = FakeSocket.last.sentMsgs();
    expect([m1.method, m2.method, m2.params]).toEqual(["a", "b", { x: 1 }]);
    FakeSocket.last.push({ id: m2.id, result: 2 });
    FakeSocket.last.push({ id: m1.id, result: null });
    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBe(2);
  });

  it("rejects with the solver's error and routes notifications to listeners", async () => {
    void b.connect();
    FakeSocket.last.ready();
    const seen: unknown[] = [];
    const off = b.on("solveProgress", (p) => seen.push(p));
    const p = b.call("solve");
    FakeSocket.last.push({ id: FakeSocket.last.sentMsgs()[0].id, error: "bad input" });
    await expect(p).rejects.toThrow("bad input");
    FakeSocket.last.push({ method: "solveProgress", params: { i: 1 } });
    off();
    FakeSocket.last.push({ method: "solveProgress", params: { i: 2 } });
    expect(seen).toEqual([{ i: 1 }]);
  });

  it("ignores non-protocol output and split lines", () => {
    void b.connect();
    FakeSocket.last.ready();
    const seen: unknown[] = [];
    b.on("x", (p) => seen.push(p));
    FakeSocket.last.onmessage?.({ data: "warning: something\n{\"method\":\"x\",\"params\":1}" });
    expect(seen).toEqual([1]);
  });

  it("fails pending calls on disconnect and doesn't replay them after reconnecting", async () => {
    void b.connect();
    const lost = b.call("saveTrajectory", { name: "A" });
    FakeSocket.last.onclose?.();
    await expect(lost).rejects.toThrow("Solver disconnected");
    expect(b.status).toBe("down");

    const later = b.call("listFields");
    await vi.advanceTimersByTimeAsync(1500);
    FakeSocket.last.ready();
    expect(FakeSocket.last.sentMsgs().map((m) => m.method)).toEqual(["listFields"]);
    FakeSocket.last.push({ id: FakeSocket.last.sentMsgs()[0].id, result: [] });
    await expect(later).resolves.toEqual([]);
  });
});
