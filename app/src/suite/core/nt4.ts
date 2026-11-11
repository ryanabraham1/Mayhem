/** Read-only NT4 client. Protocol: WPILib ntcore/doc/networktables4.adoc (v2026.2.2).
 * No publish, setproperties, or actuator write operation is implemented. */
export interface TopicValue {
  value: boolean | number | string;
  timestamp: number;
  type: string;
}
export interface LiveSnapshot {
  status: "disconnected" | "connecting" | "connected" | "reconnecting";
  topics: Record<string, TopicValue>;
  error?: string;
}
export function decodeNT4(buffer: ArrayBuffer): unknown[][] {
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer),
    decoder = new TextDecoder();
  let offset = 0;
  const take = (n: number) => {
    if (n < 0 || offset + n > bytes.length)
      throw new Error("Truncated NT4 frame");
    const start = offset;
    offset += n;
    return start;
  };
  const array = (n: number, depth: number): unknown[] => {
    if (n > 100000) throw new Error("NT4 array is too large");
    return Array.from({ length: n }, () => read(depth + 1));
  };
  const string = (n: number) => {
    const at = take(n);
    return decoder.decode(bytes.subarray(at, at + n));
  };
  const read = (depth = 0): unknown => {
    if (depth > 32) throw new Error("NT4 value nesting is too deep");
    const type = bytes[take(1)];
    if (type < 128) return type;
    if (type >= 224) return type - 256;
    if ((type & 0xf0) === 0x90) return array(type & 15, depth);
    if ((type & 0xe0) === 0xa0) return string(type & 31);
    switch (type) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xcc:
        return view.getUint8(take(1));
      case 0xcd:
        return view.getUint16(take(2));
      case 0xce:
        return view.getUint32(take(4));
      case 0xd0:
        return view.getInt8(take(1));
      case 0xd1:
        return view.getInt16(take(2));
      case 0xd2:
        return view.getInt32(take(4));
      case 0xcf:
      case 0xd3: {
        const at = take(8),
          n = type === 0xcf ? view.getBigUint64(at) : view.getBigInt64(at);
        return n >= BigInt(Number.MIN_SAFE_INTEGER) &&
          n <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(n)
          : undefined;
      }
      case 0xca:
        return view.getFloat32(take(4));
      case 0xcb:
        return view.getFloat64(take(8));
      case 0xd9:
        return string(view.getUint8(take(1)));
      case 0xda:
        return string(view.getUint16(take(2)));
      case 0xdb:
        return string(view.getUint32(take(4)));
      case 0xdc:
        return array(view.getUint16(take(2)), depth);
      case 0xdd:
        return array(view.getUint32(take(4)), depth);
      case 0xc4:
      case 0xc5:
      case 0xc6: {
        const n =
          type === 0xc4
            ? view.getUint8(take(1))
            : type === 0xc5
              ? view.getUint16(take(2))
              : view.getUint32(take(4));
        const at = take(n);
        return bytes.subarray(at, at + n);
      }
      default:
        throw new Error(
          `Unsupported NT4 MessagePack type 0x${type.toString(16)}`,
        );
    }
  };
  if (buffer.byteLength > 4 * 1024 * 1024)
    throw new Error("NT4 frame exceeds the current 4 MB limit");
  const messages: unknown[][] = [];
  while (offset < bytes.length) {
    const message = read();
    if (!Array.isArray(message) || message.length !== 4)
      throw new Error("Invalid NT4 message");
    messages.push(message);
  }
  return messages;
}
export function nt4Ping(micros: number): ArrayBuffer {
  const buffer = new ArrayBuffer(13),
    bytes = new Uint8Array(buffer);
  bytes.set([0x94, 0xff, 0, 2, 0xd3]);
  new DataView(buffer).setBigInt64(5, BigInt(Math.round(micros)));
  return buffer;
}
export class NT4Observer {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private announcements = new Map<number, { name: string; type: string }>();
  private values: Record<string, TopicValue> = {};
  private stopped = true;
  private extra: string[] = [];
  private pong = 0;
  private status: LiveSnapshot["status"] = "disconnected";
  private error: string | undefined;
  private host: string;
  private changed: (snapshot: LiveSnapshot) => void;
  constructor(host: string, changed: (snapshot: LiveSnapshot) => void) {
    this.host = host;
    this.changed = changed;
  }
  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  disconnect() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.socket?.close();
    this.socket = null;
    this.values = {};
    this.status = "disconnected";
    this.emit();
  }
  setExtraTopics(topics: string[]) {
    this.extra = [...new Set(topics)];
    if (this.socket?.readyState === 1) {
      this.send("unsubscribe", { subuid: 2 });
      this.subscribeExtras();
    }
  }
  private send(method: string, params: Record<string, unknown>) {
    this.socket?.send(JSON.stringify([{ method, params }]));
  }
  private subscribeExtras() {
    if (this.extra.length)
      this.send("subscribe", {
        subuid: 2,
        topics: this.extra,
        options: { periodic: 0.05, all: false, prefix: false },
      });
  }
  private emit() {
    this.changed({
      status: this.status,
      topics: { ...this.values },
      error: this.error,
    });
  }
  private schedule() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, 50);
  }
  private open() {
    if (this.stopped) return;
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(this.host) || this.host.startsWith("-")) {
      this.error =
        "Use a robot hostname or IP address, optionally with a port.";
      this.status = "disconnected";
      this.emit();
      return;
    }
    this.status = "connecting";
    this.error = undefined;
    this.emit();
    let url: URL;
    try {
      url = new URL(`ws://${this.host}/nt/MayhemObserver`);
      if (!url.port) url.port = "5810";
      this.socket = new WebSocket(url, "networktables.first.wpi.edu");
    } catch {
      this.error =
        "Could not open a robot WebSocket. Use the desktop app when browser network restrictions block robot access.";
      this.status = "disconnected";
      this.emit();
      return;
    }
    const socket = this.socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.announcements.clear();
      this.values = {};
      this.pong = Date.now();
      socket.send(nt4Ping(performance.now() * 1000));
      this.send("subscribe", {
        subuid: 1,
        topics: ["/Mayhem/Schema/", "/Mayhem/States/"],
        options: { periodic: 0.05, all: false, prefix: true },
      });
      this.subscribeExtras();
      this.status = "connected";
      this.emit();
      this.timer = setInterval(() => {
        if (Date.now() - this.pong > 5000) {
          socket.close();
          return;
        }
        if (socket.readyState === 1)
          socket.send(nt4Ping(performance.now() * 1000));
      }, 1000);
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        if (typeof event.data === "string") {
          const messages: unknown = JSON.parse(event.data);
          if (!Array.isArray(messages)) return;
          for (const m of messages) {
            if (!m || typeof m !== "object") continue;
            const message = m as Record<string, any>;
            const p = message.params;
            if (
              message.method === "announce" &&
              p &&
              typeof p.id === "number" &&
              typeof p.name === "string" &&
              typeof p.type === "string"
            )
              this.announcements.set(p.id, { name: p.name, type: p.type });
            if (message.method === "unannounce" && p) {
              const old = this.announcements.get(p.id);
              if (old) delete this.values[old.name];
              this.announcements.delete(p.id);
            }
          }
        } else if (event.data instanceof ArrayBuffer) {
          for (const [id, timestamp, , value] of decodeNT4(event.data)) {
            if (id === -1) {
              this.pong = Date.now();
              continue;
            }
            if (typeof id !== "number" || typeof timestamp !== "number")
              continue;
            const topic = this.announcements.get(id);
            if (
              !topic ||
              !["boolean", "number", "string"].includes(typeof value) ||
              (typeof value === "number" && !Number.isFinite(value))
            )
              continue;
            const prior = this.values[topic.name];
            if (!prior || timestamp >= prior.timestamp)
              this.values[topic.name] = {
                value: value as TopicValue["value"],
                timestamp,
                type: topic.type,
              };
          }
        }
        this.schedule();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.schedule();
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.error =
        "Robot connection failed. Check Ethernet, address, and NetworkTables server availability.";
      this.schedule();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.announcements.clear();
      this.values = {};
      this.status = this.stopped ? "disconnected" : "reconnecting";
      this.emit();
      if (!this.stopped) this.retry = setTimeout(() => this.open(), 2000);
    };
  }
}
