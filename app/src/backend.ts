// Talks to the Python solver: a bundled sidecar over stdio inside Tauri, or a WebSocket
// (`mayhem-solver serve --ws 8765`) when running the UI in a plain browser for development.

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: string };
type Listener = (params: any) => void;

export type BackendStatus = "connecting" | "ready" | "down";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class Backend {
  status: BackendStatus = "connecting";
  version = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: BackendStatus) => void>();
  private sendLine: ((line: string) => void) | null = null;
  private queue: string[] = [];
  private buffer = "";

  on(method: string, cb: Listener): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
    return () => this.listeners.get(method)!.delete(cb);
  }

  onStatus(cb: (s: BackendStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(s: BackendStatus) {
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.sendLine && this.status === "ready") this.sendLine(line);
      else this.queue.push(line);
    });
  }

  private handle(msg: Msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ready") {
      this.version = msg.params?.version ?? "";
      this.setStatus("ready");
      const q = this.queue;
      this.queue = [];
      q.forEach((l) => this.sendLine?.(l));
    }
    if (msg.method) this.listeners.get(msg.method)?.forEach((cb) => cb(msg.params));
  }

  private feed(chunk: string) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line));
      } catch {
        /* ignore non-protocol output */
      }
    }
  }

  private failAll(reason: string) {
    this.pending.forEach((p) => p.reject(new Error(reason)));
    this.pending.clear();
    // Their callers were just told these failed; don't send them after reconnecting.
    this.queue = [];
  }

  // True from the start of a connection attempt until that connection closes. React StrictMode
  // mounts effects twice in dev, so this keeps us to a single solver process / socket.
  private live = false;
  // Set by shutdown(); stops the automatic restart when the solver exits.
  private stopped = false;
  private sidecar: { kill(): Promise<void>; closed: Promise<void> } | null = null;

  async connect() {
    if (this.live) return;
    this.live = true;
    this.stopped = false;
    this.setStatus("connecting");
    try {
      await this.doConnect();
    } catch (e) {
      console.error("[solver] failed to start", e);
      this.live = false;
      this.setStatus("down");
      if (!this.stopped) setTimeout(() => this.connect(), 2000);
    }
  }

  private async doConnect() {
    if (isTauri()) await this.connectSidecar();
    else this.connectWs();
  }

  private async connectSidecar() {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.sidecar("binaries/mayhem-solver", ["serve"]);
    cmd.stdout.on("data", (d: string) => this.feed(d.endsWith("\n") ? d : d + "\n"));
    cmd.stderr.on("data", (d: string) => console.debug("[solver]", d));
    let onClosed = () => {};
    const closed = new Promise<void>((resolve) => { onClosed = resolve; });
    cmd.on("close", () => {
      this.live = false;
      this.sendLine = null;
      this.sidecar = null;
      onClosed();
      this.setStatus("down");
      this.failAll("Solver exited");
      if (!this.stopped) setTimeout(() => this.connect(), 1500);
    });
    cmd.on("error", (e) => console.error("[solver]", e));
    const child = await cmd.spawn();
    this.sendLine = (line) => void child.write(line + "\n");
    this.sidecar = { kill: () => child.kill(), closed };
  }

  /**
   * Asks the bundled solver to exit and waits for it, rather than leaving Tauri to kill it on
   * quit. Killing the PyInstaller onefile binary leaves its unpacked temp dir (~170 MB) behind,
   * and on Windows a running mayhem-solver.exe stops the update installer from replacing it.
   * Nothing restarts the solver afterwards until `connect()` is called.
   */
  async shutdown(timeoutMs = 5000) {
    this.stopped = true;
    const sidecar = this.sidecar;
    if (!sidecar) return;
    // Written directly: call() would queue it while the solver is still starting up.
    this.sendLine?.(JSON.stringify({ id: this.nextId++, method: "shutdown", params: {} }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      sidecar.closed.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!exited) await sidecar.kill().catch(() => {});
  }

  private connectWs() {
    const url = (import.meta as any).env?.VITE_SOLVER_WS ?? "ws://127.0.0.1:8765";
    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.sendLine = (line) => ws.send(line);
    };
    ws.onmessage = (e) => this.feed(String(e.data) + "\n");
    ws.onclose = () => {
      this.live = false;
      this.sendLine = null;
      this.setStatus("down");
      this.failAll("Solver disconnected");
      setTimeout(() => this.connect(), 1500);
    };
  }
}

export const backend = new Backend();
