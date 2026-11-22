/**
 * A picture of an auto for an agent (or a person) to look at: the field with the planned path
 * (preview) and, from a log, the path the robot really drove; every stop goal with its tolerance;
 * motion problems marked and zoomed in; speed and distance-to-goal over time. Drawn into a plain
 * RGBA buffer and encoded as PNG with no dependencies (pass a zlib deflate).
 */
import type { MotionIssue } from "./autoMotion.ts";
import type { AutoRoutine, SuiteProject } from "./model.ts";
import { isIntermediate } from "./runtime.ts";
import { seasonOf } from "./seasons.ts";

export interface PlotPose { time: number; x: number; y: number; heading?: number; speed?: number; error?: number; goal?: string }
export interface PlotInput {
  project: SuiteProject;
  routine: AutoRoutine;
  /** The robot runner's controller on an ideal drive (seconds from the routine start). */
  planned: PlotPose[];
  /** The editor preview, drawn faintly when it differs. */
  editor?: PlotPose[];
  /** What the robot did, from a log (seconds from the routine start). */
  actual?: PlotPose[];
  issues: (MotionIssue & { source: "preview" | "log" })[];
  title: string;
}

type RGB = [number, number, number];
const C = {
  bg: [255, 255, 255] as RGB, field: [248, 247, 252] as RGB, grid: [228, 225, 238] as RGB, border: [120, 113, 140] as RGB,
  obstacle: [214, 211, 224] as RGB, planned: [124, 58, 237] as RGB, editor: [196, 181, 253] as RGB, actual: [234, 88, 12] as RGB, goal: [30, 27, 45] as RGB,
  pass: [150, 145, 165] as RGB, issue: [220, 38, 38] as RGB, issueBg: [254, 226, 226] as RGB, text: [30, 27, 45] as RGB, muted: [110, 104, 128] as RGB,
};

// 5×7 bitmap font: each glyph is 7 rows of 5 bits.
const FONT: Record<string, number[]> = {
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8], ":": [0, 12, 12, 0, 12, 12, 0], "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [0, 1, 2, 4, 8, 16, 0], "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], "%": [24, 25, 2, 4, 8, 19, 3],
  "!": [4, 4, 4, 4, 4, 0, 4], "#": [10, 10, 31, 10, 31, 10, 10], ">": [8, 4, 2, 1, 2, 4, 8], "<": [2, 4, 8, 16, 8, 4, 2],
  "+": [0, 4, 4, 31, 4, 4, 0], "=": [0, 0, 31, 0, 31, 0, 0], "°": [12, 18, 18, 12, 0, 0, 0], "_": [0, 0, 0, 0, 0, 0, 31],
  "'": [4, 4, 8, 0, 0, 0, 0], "?": [14, 17, 1, 2, 4, 0, 4], "&": [12, 18, 20, 8, 21, 18, 13], "·": [0, 0, 0, 12, 12, 0, 0],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

class Canvas {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }
  /** Drawing is limited to this rectangle (x0, y0, x1, y1) when set. */
  clip: [number, number, number, number] | undefined;
  blend(x: number, y: number, c: RGB, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    if (this.clip && (x < this.clip[0] || y < this.clip[1] || x >= this.clip[2] || y >= this.clip[3])) return;
    const i = (y * this.width + x) * 4, d = this.data;
    d[i] = d[i] + (c[0] - d[i]) * a; d[i + 1] = d[i + 1] + (c[1] - d[i + 1]) * a; d[i + 2] = d[i + 2] + (c[2] - d[i + 2]) * a; d[i + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1) {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.height, Math.ceil(y + h)); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(this.width, Math.ceil(x + w)); i++) this.blend(i, j, c, a);
  }
  disc(cx: number, cy: number, r: number, c: RGB, a = 1) {
    for (let j = Math.floor(cy - r - 1); j <= Math.ceil(cy + r + 1); j++)
      for (let i = Math.floor(cx - r - 1); i <= Math.ceil(cx + r + 1); i++) {
        const d = Math.hypot(i - cx, j - cy);
        if (d <= r + 0.5) this.blend(i, j, c, a * Math.min(1, r + 0.5 - d));
      }
  }
  ring(cx: number, cy: number, r: number, w: number, c: RGB, a = 1) {
    for (let j = Math.floor(cy - r - w); j <= Math.ceil(cy + r + w); j++)
      for (let i = Math.floor(cx - r - w); i <= Math.ceil(cx + r + w); i++) {
        const d = Math.abs(Math.hypot(i - cx, j - cy) - r);
        if (d <= w / 2 + 0.5) this.blend(i, j, c, a * Math.min(1, w / 2 + 0.5 - d));
      }
  }
  line(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1) {
    // Stamp pixels within w/2 of the segment (antialiased edge).
    const minX = Math.floor(Math.min(x0, x1) - w), maxX = Math.ceil(Math.max(x0, x1) + w);
    const minY = Math.floor(Math.min(y0, y1) - w), maxY = Math.ceil(Math.max(y0, y1) + w);
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    for (let j = Math.max(0, minY); j <= Math.min(this.height - 1, maxY); j++)
      for (let i = Math.max(0, minX); i <= Math.min(this.width - 1, maxX); i++) {
        const t = len2 ? Math.max(0, Math.min(1, ((i - x0) * dx + (j - y0) * dy) / len2)) : 0;
        const d = Math.hypot(i - (x0 + t * dx), j - (y0 + t * dy));
        if (d <= w / 2 + 0.5) this.blend(i, j, c, a * Math.min(1, w / 2 + 0.5 - d));
      }
  }
  polygon(points: [number, number][], c: RGB, a = 1) {
    if (points.length < 3) return;
    const ys = points.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(this.height - 1, Math.ceil(Math.max(...ys))); y++) {
      const xs: number[] = [];
      for (let k = 0; k < points.length; k++) {
        const [ax, ay] = points[k], [bx, by] = points[(k + 1) % points.length];
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.blend(x, y, c, a);
    }
  }
  text(x: number, y: number, s: string, c: RGB, scale = 2) {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT[ch === "²" ? "2" : ch === "→" ? ">" : ch === "×" ? "X" : "?"];
      for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] & (16 >> b)) this.rect(cx + b * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
    return cx - x;
  }
  static textWidth(s: string, scale = 2) { return [...s].length * 6 * scale; }
  /** PNG bytes; `deflate` is zlib's deflateSync (node:zlib) or any zlib-format compressor. */
  png(deflate: (data: Uint8Array) => Uint8Array): Uint8Array {
    const raw = new Uint8Array((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 4 + 1)] = 0;
      raw.set(this.data.subarray(y * this.width * 4, (y + 1) * this.width * 4), y * (this.width * 4 + 1) + 1);
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
      dv.setUint32(0, body.length);
      for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
      out.set(body, 8);
      dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
      return out;
    };
    const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
    hv.setUint32(0, this.width); hv.setUint32(4, this.height); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflate(raw)), chunk("IEND", new Uint8Array())];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = "   " + word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
const stopNumber = (routine: AutoRoutine, id: string) => {
  const k = routine.nodes.filter((n) => n.kind === "pose" && n.goal && !isIntermediate(routine, n)).findIndex((n) => n.id === id);
  return k < 0 ? undefined : k + 1;
};
const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

/** Draw the plot. Returns PNG bytes. */
export function plotAuto(input: PlotInput, deflate: (data: Uint8Array) => Uint8Array): Uint8Array {
  const { project, routine, planned, actual, issues } = input;
  const W = 1600, pad = 20;
  const fw = project.field.width, fh = project.field.height;
  const routineStart = routine.start ?? project.robot.start;
  const goalOf = (id: string) => routine.nodes.find((n) => n.id === id)?.goal;
  // Field view: the part of the field the auto uses (1 m around it), as large as fits.
  const pts = [...planned, ...(actual ?? []), routineStart, ...routine.nodes.flatMap((n) => (n.goal ? [n.goal] : []))].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const x0 = Math.max(0, Math.min(...pts.map((p) => p.x)) - 1), x1 = Math.min(fw, Math.max(...pts.map((p) => p.x)) + 1);
  const y0 = Math.max(0, Math.min(...pts.map((p) => p.y)) - 1), y1 = Math.min(fh, Math.max(...pts.map((p) => p.y)) + 1);
  const scale = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), 760 / Math.max(1, y1 - y0));
  const fieldTop = 84, fieldW = (x1 - x0) * scale, fieldH = (y1 - y0) * scale, fieldLeft = pad + (W - 2 * pad - fieldW) / 2;
  const insetIssues = issues.filter((i) => i.kind === "overshoot" || i.kind === "heading-overshoot").slice(0, 4);
  const insetSize = 360, insetTop = fieldTop + fieldH + 58;
  const chartTop = insetTop + (insetIssues.length ? insetSize + 50 : 0);
  const listed = issues.slice(0, 8).map((issue, k) => wrapText(`!${k + 1} ${issue.source.toUpperCase()} #${stopNumber(routine, issue.step) ?? "?"} ${issue.message}`, 125));
  const chartH = 230, H = Math.ceil(chartTop + 2 * (chartH + 50) + 10 + 26 * listed.flat().length + 20);
  const c = new Canvas(W, H);
  c.rect(0, 0, W, H, C.bg);

  // Title and legend.
  c.text(pad, 14, input.title.length > 85 ? input.title.slice(0, 82) + "..." : input.title, C.text, 3);
  let lx = pad;
  const legend = (color: RGB, label: string) => { c.line(lx, 56, lx + 28, 56, 4, color); lx += 36; lx += c.text(lx, 49, label, C.muted, 2) + 28; };
  legend(C.planned, "Planned (robot's follower)");
  if (input.editor?.length) legend(C.editor, "Editor preview");
  if (actual?.length) legend(C.actual, "Actual (log)");
  c.ring(lx + 8, 56, 8, 3, C.issue); lx += 24; lx += c.text(lx, 49, "Problem", C.muted, 2) + 28;
  c.ring(lx + 6, 56, 6, 2, C.goal); lx += 20; lx += c.text(lx, 49, "Stop goal #", C.muted, 2) + 28;
  c.disc(lx + 4, 56, 3, C.pass); lx += 14; lx += c.text(lx, 49, "Pass-through", C.muted, 2) + 28;
  c.text(lx, 49, "Ticks: front", C.muted, 2);

  // Field.
  const fx = (x: number) => fieldLeft + (x - x0) * scale, fy = (y: number) => fieldTop + fieldH - (y - y0) * scale;
  c.clip = [fieldLeft, fieldTop, fieldLeft + fieldW, fieldTop + fieldH];
  c.rect(fieldLeft, fieldTop, fieldW, fieldH, C.field);
  for (let m = Math.ceil(x0); m <= x1; m++) c.line(fx(m), fieldTop, fx(m), fieldTop + fieldH, 1, C.grid);
  for (let m = Math.ceil(y0); m <= y1; m++) c.line(fieldLeft, fy(m), fieldLeft + fieldW, fy(m), 1, C.grid);
  const season = seasonOf(project.field);
  for (const o of season.field.obstacles ?? [])
    if (o.enabled !== false && o.points?.length >= 3) c.polygon(o.points.map(([x, y]) => [fx(x), fy(y)] as [number, number]), C.obstacle);
  // Field walls where they are in view.
  c.line(fx(0), fy(0), fx(fw), fy(0), 3, C.border); c.line(fx(0), fy(fh), fx(fw), fy(fh), 3, C.border);
  c.line(fx(0), fy(0), fx(0), fy(fh), 3, C.border); c.line(fx(fw), fy(0), fx(fw), fy(fh), 3, C.border);
  c.clip = undefined;
  c.text(fieldLeft, fieldTop + fieldH + 6, `${fmt(x1 - x0, 1)} X ${fmt(y1 - y0, 1)} M OF THE FIELD · GRID 1 M`, C.muted, 2);

  const drawPath = (pts: PlotPose[], tx: (x: number) => number, ty: (y: number) => number, color: RGB, w: number, ticks: number) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1) continue; // gaps and resets
      c.line(tx(a.x), ty(a.y), tx(b.x), ty(b.y), w, color);
    }
    // Heading ticks: the robot's front every `ticks` seconds.
    let next = -Infinity;
    for (const p of pts) {
      if (p.time < next || p.heading === undefined) continue;
      next = p.time + ticks;
      const L = 14;
      c.line(tx(p.x), ty(p.y), tx(p.x) + Math.cos(p.heading) * L, ty(p.y) - Math.sin(p.heading) * L, 2, color, 0.7);
    }
  };
  const poses = routine.nodes.filter((n) => n.kind === "pose" && n.goal);
  const stopIds = poses.filter((n) => !isIntermediate(routine, n)).map((n) => n.id);
  const index = new Map(stopIds.map((id, k) => [id, k + 1]));
  // Labels nudged sideways off the ones already placed (stops that share a spot).
  const placed: [number, number, number][] = [];
  const label = (x: number, y: number, text: string, color: RGB) => {
    const w = Canvas.textWidth(text);
    while (placed.some(([px, py, pw]) => Math.abs(py - y) < 16 && x < px + pw + 6 && x + w + 6 > px)) x += 10;
    placed.push([x, y, w]);
    c.text(x, y, text, color, 2);
  };
  c.clip = [fieldLeft, fieldTop, fieldLeft + fieldW, fieldTop + fieldH];
  if (input.editor?.length) drawPath(input.editor.map(({ heading, ...p }) => p), fx, fy, C.editor, 2, 0.5);
  drawPath(planned, fx, fy, C.planned, 3, 0.5);
  if (actual?.length) drawPath(actual, fx, fy, C.actual, 3, 0.5);
  for (const n of poses) {
    const g = n.goal!;
    if (index.has(n.id)) {
      c.ring(fx(g.x), fy(g.y), Math.max(5, g.translationTolerance * scale), 2, C.goal);
      c.line(fx(g.x), fy(g.y), fx(g.x) + Math.cos(g.heading) * 18, fy(g.y) - Math.sin(g.heading) * 18, 2, C.goal);
    } else c.disc(fx(g.x), fy(g.y), 3, C.pass);
  }
  c.ring(fx(routineStart.x), fy(routineStart.y), 9, 3, C.goal);
  c.clip = undefined;
  label(fx(routineStart.x) - 24, fy(routineStart.y) + 14, "START", C.goal);
  for (const id of stopIds) { const g = goalOf(id)!; label(fx(g.x) + 10, fy(g.y) - 24, String(index.get(id)), C.goal); }
  issues.forEach((issue, k) => {
    const g = goalOf(issue.step);
    if (!g) return;
    c.ring(fx(g.x), fy(g.y), 18, 3, C.issue);
    label(fx(g.x) + 20, fy(g.y) + 8, `!${k + 1}`, C.issue);
  });

  // Zoomed insets around each overshoot: the few centimeters a field view hides.
  insetIssues.forEach((issue, k) => {
    const g = goalOf(issue.step)!;
    const ox = pad + k * (insetSize + 22), oy = insetTop;
    const half = issue.kind === "overshoot" ? Math.max(0.15, Math.min(1, issue.amount * 4)) : 0.4;
    const s = insetSize / (2 * half);
    const tx = (x: number) => ox + (x - g.x + half) * s, ty = (y: number) => oy + insetSize - (y - g.y + half) * s;
    c.clip = [ox, oy, ox + insetSize, oy + insetSize];
    c.rect(ox, oy, insetSize, insetSize, C.field);
    for (let m = Math.ceil((g.x - half) * 10); m <= Math.floor((g.x + half) * 10); m++) c.line(tx(m / 10), oy, tx(m / 10), oy + insetSize, 1, C.grid);
    for (let m = Math.ceil((g.y - half) * 10); m <= Math.floor((g.y + half) * 10); m++) c.line(ox, ty(m / 10), ox + insetSize, ty(m / 10), 1, C.grid);
    // This step and the end of the one before it, from each run.
    const leg = (pts: PlotPose[] | undefined) => {
      const all = pts ?? [];
      const first = all.findIndex((p) => p.goal === issue.step);
      if (first < 0) return [];
      let last = first;
      while (last + 1 < all.length && all[last + 1].goal === issue.step) last++;
      return all.slice(Math.max(0, first - 25), last + 1);
    };
    drawPath(leg(planned), tx, ty, C.planned, 3, 0.1);
    if (issue.source === "log") drawPath(leg(actual), tx, ty, C.actual, 3, 0.1);
    c.ring(tx(g.x), ty(g.y), Math.max(4, g.translationTolerance * s), 2, C.goal);
    c.disc(tx(g.x), ty(g.y), 3, C.goal);
    c.line(tx(g.x), ty(g.y), tx(g.x) + Math.cos(g.heading) * 30, ty(g.y) - Math.sin(g.heading) * 30, 2, C.goal);
    c.clip = undefined;
    for (const [a, b] of [[ox, oy], [ox + insetSize, oy], [ox + insetSize, oy + insetSize], [ox, oy + insetSize]].map((p, i, all) => [p, all[(i + 1) % 4]]))
      c.line(a[0], a[1], b[0], b[1], 2, C.issue);
    c.text(ox, oy - 22, `!${issues.indexOf(issue) + 1} #${index.get(issue.step) ?? "?"} ${issue.kind === "overshoot" ? `${fmt(issue.amount * 100, 1)} CM PAST` : `${fmt(issue.amount, 1)}° SWING`}, +${fmt(issue.timeLost)} S`, C.issue, 2);
    c.text(ox + 6, oy + insetSize - 20, `${fmt(2 * half, 2)} M ACROSS · GRID 10 CM`, C.muted, 2);
  });

  // Charts over time: speed, then distance to the active goal.
  const tMax = Math.max(1, ...planned.map((p) => p.time), ...(actual ?? []).map((p) => p.time), ...(input.editor ?? []).map((p) => p.time));
  const chart = (top: number, label: string, unit: string, pick: (p: PlotPose) => number | undefined) => {
    const left = pad + 70, w = W - left - pad, h = chartH;
    const vals = [...planned, ...(actual ?? [])].map(pick).filter((v): v is number => v !== undefined && Number.isFinite(v));
    const vMax = Math.max(0.1, ...vals) * 1.1;
    const X = (t: number) => left + (t / tMax) * w, Y = (v: number) => top + h - (Math.min(v, vMax) / vMax) * h;
    c.text(pad, top - 26, label, C.text, 2);
    c.rect(left, top, w, h, C.field);
    for (const issue of issues) c.rect(X(issue.time), top, Math.max(2, X(issue.end) - X(issue.time)), h, C.issueBg);
    // Step boundaries (stop steps), numbered like the field.
    let last = "";
    for (const p of actual?.some((q) => q.goal) ? actual : planned) {
      if (!p.goal || p.goal === last) continue;
      last = p.goal;
      if (!index.has(p.goal)) continue;
      c.line(X(p.time), top, X(p.time), top + h, 1, C.grid);
      c.text(X(p.time) + 3, top + 4, String(index.get(p.goal) ?? ""), C.muted, 2);
    }
    for (let k = 0; k <= 4; k++) {
      const v = (vMax / 4) * k;
      c.line(left, Y(v), left + w, Y(v), 1, C.grid);
      const t = fmt(v, vMax < 2 ? 2 : 1);
      c.text(left - 10 - Canvas.textWidth(t), Y(v) - 7, t, C.muted, 2);
    }
    for (let s = 0; s <= tMax; s += tMax > 12 ? 2 : 1) c.text(X(s) - 6, top + h + 8, String(s), C.muted, 2);
    const series = (pts: PlotPose[], color: RGB) => {
      let prev: [number, number] | undefined;
      for (const p of pts) {
        const v = pick(p);
        if (v === undefined || !Number.isFinite(v)) { prev = undefined; continue; }
        const q: [number, number] = [X(p.time), Y(v)];
        if (prev) c.line(prev[0], prev[1], q[0], q[1], 2, color);
        prev = q;
      }
    };
    if (input.editor) series(input.editor, C.editor);
    series(planned, C.planned);
    if (actual) series(actual, C.actual);
    for (const issue of issues) c.text(X(issue.time) + 2, top + h - 20, `!${issues.indexOf(issue) + 1}`, C.issue, 2);
    c.text(W - pad - Canvas.textWidth(`TIME (S) · ${unit}`), top - 26, `TIME (S) · ${unit}`, C.muted, 2);
  };
  chart(chartTop, "SPEED", "M/S", (p) => p.speed);
  chart(chartTop + chartH + 50, "DISTANCE TO ACTIVE GOAL", "M", (p) => p.error);

  // Problem list.
  let y = chartTop + 2 * (chartH + 50) + 10;
  listed.forEach((lines, k) => {
    for (const line of lines) { c.text(pad, y, line, issues[k].severity === "warning" ? C.issue : C.muted, 2); y += 26; }
  });
  return c.png(deflate);
}
