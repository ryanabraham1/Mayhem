import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import dagre from "@dagrejs/dagre";
import { ChevronDown, ChevronRight, Circle, Code2, Flag, Minus, Navigation, Plus, Route, Zap } from "lucide-react";
import {
  ANY_STATE,
  evaluate,
  leavesState,
  type AutoRoutine,
  type Signals,
  type Transition,
} from "../core/model.ts";
import { compactCondition, edgeLabels, elideMiddle } from "../core/edgeLabels.ts";
import "./states.css";
import { categoryLookup, type InputSource } from "../core/inputCategories.ts";
import { ConditionText, glyphText } from "./ConditionText";
import { chainOrder, collapsePaths, type PathRun } from "./autoPaths";
import { useTrackpadZoom } from "../trackpad";
import { PlainCondition, type InputInfo } from "./PlainCondition";

/** State card size; machine cards are compact (the source path is in the inspector). */
const NODE: Box = { w: 196, h: 78 },
  MACHINE_NODE: Box = { w: 164, h: 58 },
  GAP_Y = 46,
  PAD = 28;

/** A code reference as its file name (plus any :line), so the distinctive part stays visible. */
export function shortSource(source: string, max = 26): string {
  const text = source.trim();
  const file = text.includes("/") ? `…/${text.slice(text.lastIndexOf("/") + 1)}` : text;
  return elideMiddle(file.length < text.length && text.length <= max ? text : file, max);
}

interface Box { w: number; h: number }
interface Wire { key: string; from: string; to: string }
/** Where a wire runs (start to arrowhead) and the center of its label. */
interface WireGeometry { points: { x: number; y: number }[]; lx: number; ly: number }
const CHIP = 20;
const LIST_KEY = "mayhem.states.anyList";

/**
 * Layered top-to-bottom layout (dagre) with each edge label as an obstacle of its measured size,
 * so labels never overlap each other, states or other wires' labels. Edges that close a cycle
 * (found from the initial state) are laid out reversed, so the flow reads top to bottom from the
 * initial state, and get their own lanes instead of looping under the states. `lift` reserves
 * room above a state for its "from any state" chips. Without wires, states form a grid.
 */
export function layoutGraph(
  nodes: string[],
  initial: string,
  wires: Wire[],
  labels: Map<string, Box>,
  lift: (id: string) => number,
  { w: W, h: H }: Box = { w: NODE.w, h: NODE.h },
) {
  const positions = new Map<string, { x: number; y: number }>();
  const geometry = new Map<string, WireGeometry>();
  if (!wires.length) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const rowHeight = H + GAP_Y + Math.max(0, ...nodes.map(lift));
    nodes.forEach((id, i) =>
      positions.set(id, { x: PAD + (i % perRow) * (W + GAP_Y * 2), y: PAD + Math.floor(i / perRow) * rowHeight + lift(id) }),
    );
    const rows = Math.ceil(nodes.length / perRow);
    return { positions, geometry, width: PAD * 2 + Math.min(perRow, nodes.length) * (W + GAP_Y * 2) - GAP_Y * 2, height: PAD * 2 + rows * rowHeight };
  }
  // Back edges: a depth-first search from the initial state (then any unvisited state).
  const out = new Map<string, string[]>();
  for (const w of wires) if (w.from !== w.to) out.set(w.from, [...(out.get(w.from) ?? []), w.to]);
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) back.add(`${id}>${next}`);
      else if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  if (nodes.includes(initial)) visit(initial);
  for (const id of nodes) if (!state.has(id)) visit(id);

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 28, edgesep: 10, ranksep: 36, marginx: PAD, marginy: PAD });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of nodes) g.setNode(id, { width: W, height: H + lift(id) });
  for (const w of wires) {
    const label = labels.get(w.key) ?? { w: 80, h: 22 };
    const reversed = back.has(`${w.from}>${w.to}`);
    g.setEdge(reversed ? w.to : w.from, reversed ? w.from : w.to, { width: label.w + 8, height: label.h + 8, labelpos: "c" }, w.key);
  }
  dagre.layout(g);
  for (const id of nodes) {
    const n = g.node(id);
    positions.set(id, { x: n.x - W / 2, y: n.y - (H + lift(id)) / 2 + lift(id) });
  }
  for (const w of wires) {
    const reversed = back.has(`${w.from}>${w.to}`);
    const e = g.edge({ v: reversed ? w.to : w.from, w: reversed ? w.from : w.to, name: w.key });
    const points = [...(e.points ?? [])];
    if (reversed) points.reverse();
    geometry.set(w.key, { points, lx: e.x ?? points[0].x, ly: e.y ?? points[0].y });
  }
  const size = g.graph();
  return { positions, geometry, width: Math.ceil(size.width ?? 0), height: Math.ceil(size.height ?? 0) };
}

/**
 * A single chain of steps laid out to fill the view: rows of cards that snake left to right,
 * then right to left, choosing the row length that shows the whole chain largest.
 */
export function layoutChain(order: string[], wires: Wire[], view: Box, { w: W, h: H }: Box = NODE) {
  const GX = 56, GY = 52;
  const fitScale = (perRow: number) => {
    const rows = Math.ceil(order.length / perRow);
    const width = PAD * 2 + perRow * (W + GX) - GX, height = PAD * 2 + rows * (H + GY) - GY;
    return { width, height, scale: Math.min(1, view.w / width, view.h / height) };
  };
  let perRow = 1;
  for (let n = 1; n <= order.length; n++) if (fitScale(n).scale > fitScale(perRow).scale + 1e-9) perRow = n;
  const { width, height } = fitScale(perRow);
  const positions = new Map<string, { x: number; y: number }>();
  order.forEach((id, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    positions.set(id, { x: PAD + (row % 2 ? perRow - 1 - col : col) * (W + GX), y: PAD + row * (H + GY) });
  });
  const geometry = new Map<string, WireGeometry>();
  for (const w of wires) {
    const a = positions.get(w.from), b = positions.get(w.to);
    if (!a || !b) continue;
    let points;
    if (a.y === b.y) {
      const right = b.x > a.x;
      points = [
        { x: right ? a.x + W : a.x, y: a.y + H / 2 },
        { x: right ? b.x : b.x + W, y: b.y + H / 2 },
      ];
    } else points = [{ x: a.x + W / 2, y: a.y + H }, { x: b.x + W / 2, y: b.y }];
    geometry.set(w.key, { points, lx: (points[0].x + points[1].x) / 2, ly: (points[0].y + points[1].y) / 2 });
  }
  return { positions, geometry, width, height };
}

/** A smooth path through the layout's points (Catmull-Rom as cubic Béziers). */
function smoothPath(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] ?? p2;
    d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  return d;
}

export function StateGraph({
  graph: source,
  signalLabel = (key: string) => key,
  signals,
  selected,
  active,
  select,
  menu,
  machine = false,
  selectedEdge,
  selectEdge,
  inputs = [],
}: {
  /** The machine's inputs (or project signals), for category glyphs on conditions. */
  inputs?: InputSource[];
  signalLabel?: (key: string) => string;
  machine?: boolean;
  /** Highlighted transition, e.g. the one picked in the inspector. */
  selectedEdge?: string;
  /** Click on an edge label. */
  selectEdge?: (id: string) => void;
  /** Right-click on a state. */
  menu?: (event: MouseEvent, id: string) => void;
  graph: AutoRoutine;
  signals: Signals;
  selected: string;
  active: string;
  select: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // Autonomous routines: runs of pass-through poses show as one "Drive path" card (view only).
  const [expanded, setExpanded] = useState(new Set<string>());
  useEffect(() => setExpanded(new Set()), [source.id]);
  const paths = useMemo(() => (machine ? undefined : collapsePaths(source, expanded)), [machine, source, expanded]);
  const graph = paths?.graph ?? source;
  const runOf = (id: string) => paths?.runOf.get(id);
  const shown = (id: string) => runOf(id) ?? id;
  const [allWires, setAllWires] = useState(false);
  // The "from any state" list starts as a one-line bar (the graph gets the room); remembered.
  const [listOpen, setListOpenState] = useState(() => {
    try {
      return localStorage.getItem(LIST_KEY) === "open";
    } catch {
      return false;
    }
  });
  const setListOpen = (open: boolean) => {
    setListOpenState(open);
    try {
      localStorage.setItem(LIST_KEY, open ? "open" : "closed");
    } catch {
      /* a convenience only */
    }
  };
  // Zoom: "fit" frames the whole graph (the default after loading a machine), or a fixed scale.
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  useEffect(() => setZoom("fit"), [graph.id]);
  useEffect(() => setAllWires(false), [graph.id]);
  // Transitions that leave (almost) every state for the same target on the same condition
  // (or are declared `from: "*"`) form one "from any state" group: a chip on the target and a
  // row in the priority list instead of a wire from each state.
  const globals = useMemo(() => {
    const condition = (t: Transition) => compactCondition(t.condition, signalLabel);
    const sources = new Map<string, Set<string>>();
    for (const t of graph.transitions) {
      const key = t.from === ANY_STATE ? `*\u0000${t.id}` : `${t.to}\u0000${condition(t)}`;
      const from = t.from === ANY_STATE ? graph.nodes.map((n) => n.id).filter((id) => leavesState(t, id)) : [t.from];
      const set = sources.get(key) ?? new Set<string>();
      for (const id of from) set.add(id);
      sources.set(key, set);
    }
    // Only near-universal targets (every other state, or all but one) collapse; explicit edges from
    // most states stay wires so each state's own buttons can be followed.
    const threshold = Math.max(3, graph.nodes.length - 2);
    const ids = new Set<string>();
    const groups: AnyStateGroup[] = [];
    const byKey = new Map<string, AnyStateGroup>();
    for (const t of graph.transitions) {
      const key = t.from === ANY_STATE ? `*\u0000${t.id}` : `${t.to}\u0000${condition(t)}`;
      const from = sources.get(key)!;
      if (t.from !== ANY_STATE && from.size < threshold) continue;
      ids.add(t.id);
      const group = byKey.get(key);
      if (group) {
        group.transitions.push(t);
        continue;
      }
      const created: AnyStateGroup = {
        key,
        to: t.to,
        transitions: [t],
        sources: from,
        missing: graph.nodes.map((n) => n.id).filter((id) => id !== t.to && !from.has(id)),
        label: t.name ?? condition(t),
      };
      byKey.set(key, created);
      groups.push(created);
    }
    // Priority order: the order the groups' transitions are checked in, by majority over the
    // states they all leave (declaration order is per state; a generator may list per source).
    const position = graph.nodes.map((n) => {
      const order = new Map<string, number>();
      graph.transitions.filter((t) => leavesState(t, n.id)).forEach((t, i) => {
        const g = groups.find((g) => g.transitions.includes(t));
        if (g && !order.has(g.key)) order.set(g.key, i);
      });
      return order;
    });
    const before = (a: AnyStateGroup, b: AnyStateGroup) =>
      position.reduce((vote, order) => {
        const x = order.get(a.key), y = order.get(b.key);
        return x === undefined || y === undefined ? vote : vote + Math.sign(x - y);
      }, 0);
    groups.sort(before);
    return { ids, groups };
  }, [graph, signalLabel]);
  const categoryOf = useMemo(() => categoryLookup(inputs), [inputs]);
  const plainInfo: InputInfo = {
    name: (key) => inputs.find((i) => i.key === key)?.name ?? (key === "stateTime" ? "time in this state" : key),
    unit: (key) => (key === "stateTime" ? "s" : undefined),
    category: categoryOf,
  };
  const isKey = useMemo(() => {
    const keys = new Set([...inputs.map((i) => i.key), "stateTime"]);
    return (k: string) => keys.has(k);
  }, [inputs]);
  // The transition's name, else its condition; only a very long condition is shortened (to the
  // terms that tell it apart from its siblings). The full condition is on hover and in the inspector.
  const labels = useMemo(
    () => edgeLabels(graph.transitions, 96, (id) => graph.nodes.find((n) => n.id === id)?.name ?? id, signalLabel),
    [graph, signalLabel],
  );
  // Every wire to draw; `from: "*"` transitions are drawn once per state they leave.
  const wires = useMemo(() => {
    const out: { key: string; t: Transition; from: string }[] = [];
    for (const t of graph.transitions) {
      if (globals.ids.has(t.id) && !allWires) continue;
      if (t.from !== ANY_STATE) out.push({ key: t.id, t, from: t.from });
      else for (const n of graph.nodes) if (leavesState(t, n.id)) out.push({ key: `${t.id}@${n.id}`, t, from: n.id });
    }
    return out;
  }, [graph, globals, allWires]);
  // With nothing left to wire (a priority supervisor), lay states out in priority order.
  const wired = useMemo(() => {
    const rank = (id: string) => {
      const i = globals.groups.findIndex((g) => g.to === id);
      return i < 0 ? globals.groups.length : i;
    };
    const nodes = wires.length ? graph.nodes : [...graph.nodes].sort((a, b) => rank(a.id) - rank(b.id));
    return { ...graph, nodes, transitions: wires.map((w) => ({ ...w.t, id: w.key, from: w.from })) };
  }, [graph, globals, wires]);
  const stateName = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;
  const exceptText = (g: AnyStateGroup) => (g.missing.length ? ` except ${g.missing.map(stateName).join(", ")}` : "");
  const groupTitle = (g: AnyStateGroup) => {
    const t = g.transitions[0];
    return [
      `${stateName(g.to)}: from any state${exceptText(g)}`,
      t.name,
      glyphText(compactCondition(t.condition, signalLabel), isKey, categoryOf),
      t.description,
    ].filter(Boolean).join("\n");
  };
  // Pick a group's transition in the inspector: the one leaving the selected state if any.
  const pickGroup = (g: AnyStateGroup) => {
    const here = g.transitions.find((t) => leavesState(t, selected));
    const t = here ?? g.transitions[0];
    if (!here) select(t.from === ANY_STATE ? [...g.sources][0] : t.from);
    selectEdge?.(t.id);
  };
  const groupLive = (g: AnyStateGroup) => g.transitions.some((t) => leavesState(t, active) && evaluate(t.condition, signals));
  // Label boxes are measured (hidden copies below) and fed to the layout as obstacles.
  const measurer = useRef<HTMLDivElement>(null);
  const [labelBoxes, setLabelBoxes] = useState(new Map<string, Box>());
  const labelKey = wires.map((w) => `${w.key}\u0000${labels.get(w.t.id)?.label}`).join("\u0001");
  useLayoutEffect(() => {
    const next = new Map<string, Box>();
    for (const el of measurer.current?.querySelectorAll<HTMLElement>("[data-wire]") ?? []) {
      const text = el.textContent ?? "";
      // Without layout (tests), estimate from the text.
      next.set(el.dataset.wire!, el.offsetWidth
        ? { w: Math.ceil(el.offsetWidth) + 1, h: Math.ceil(el.offsetHeight) + 1 }
        : { w: Math.min(180, text.length * 7 + 18), h: 18 * Math.ceil((text.length * 7 + 18) / 180) + 4 });
    }
    setLabelBoxes((old) =>
      old.size === next.size && [...next].every(([k, b]) => old.get(k)?.w === b.w && old.get(k)?.h === b.h) ? old : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelKey]);
  const nodeSize = machine ? MACHINE_NODE : NODE;
  const chipCount = (id: string) => (globals.groups.some((g) => g.to === id) ? 1 : 0);
  // A routine that is one chain (after collapsing paths) snakes to fill the view.
  const chain = useMemo(() => (machine ? undefined : chainOrder(graph)), [machine, graph]);
  const view = chain ? { w: Math.max(200, (box.w || 1200) - 16), h: Math.max(200, (box.h || 700) - 16) } : undefined;
  const { positions, geometry, width, height } = useMemo(
    () =>
      chain
        ? layoutChain(chain, wires.map((w) => ({ key: w.key, from: w.from, to: w.t.to })), view!, nodeSize)
        : layoutGraph(
            wired.nodes.map((n) => n.id),
            graph.initial,
            wires.map((w) => ({ key: w.key, from: w.from, to: w.t.to })),
            labelBoxes,
            (id) => chipCount(id) * CHIP,
            nodeSize,
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wired, wires, labelBoxes, graph.initial, globals, chain, view?.w, view?.h],
  );
  // Hovering or selecting a state highlights its wires and dims the rest.
  const [hovered, setHovered] = useState<string>();
  useEffect(() => setHovered(undefined), [graph.id]);
  const focus = hovered ?? selected;
  // Only hovering dims the other wires; the selection (always set) just strengthens its own.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Shrink large machines to fit, but never below a readable size; scroll beyond that.
  const fit = box.w ? Math.max(0.45, Math.min(1, (box.w - 16) / width, (box.h - 16) / height)) : 1;
  const scale = zoom === "fit" ? fit : zoom;
  const clampZoom = (z: number) => Math.min(2.5, Math.max(0.3, z));

  // Pinch / Cmd+wheel zooms around the cursor: remember the graph point under it, then scroll so
  // it stays put after the new scale renders. A plain two-finger scroll pans (native scrolling).
  const graphEl = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ gx: number; gy: number; cx: number; cy: number } | null>(null);
  // Several wheel events can arrive before a render: zoom from the latest target, and measure
  // the anchor against the scale that is actually on screen.
  const rendered = useRef(scale);
  const target = useRef(scale);
  const zoomAround = (factor: number, cx: number, cy: number) => {
    const rect = graphEl.current?.getBoundingClientRect();
    if (!rect) return;
    const next = clampZoom(target.current * factor);
    if (next === target.current) return;
    anchor.current = { gx: (cx - rect.left) / rendered.current, gy: (cy - rect.top) / rendered.current, cx, cy };
    target.current = next;
    setZoom(next);
  };
  useTrackpadZoom(scroller, { zoomAt: zoomAround });
  // The − / + buttons zoom around the middle of the view.
  const step = (factor: number) => {
    const r = scroller.current?.getBoundingClientRect();
    if (r) zoomAround(factor, r.left + r.width / 2, r.top + r.height / 2);
  };
  useLayoutEffect(() => {
    rendered.current = scale;
    target.current = scale;
    const a = anchor.current, el = scroller.current, rect = graphEl.current?.getBoundingClientRect();
    anchor.current = null;
    if (!a || !el || !rect) return;
    el.scrollLeft += rect.left + a.gx * scale - a.cx;
    el.scrollTop += rect.top + a.gy * scale - a.cy;
  }, [scale]);
  const ladder = globals.groups.length > 0 && (
    <section
      className={`mx-any-ladder ${wires.length ? "" : "is-primary"} ${listOpen ? "" : "is-collapsed"}`}
      aria-label="Transitions from any state"
    >
      <header>
        <button type="button" className="mx-any-toggle" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
          {listOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <strong>
            {globals.groups.length} transition{globals.groups.length === 1 ? "" : "s"} from any state
          </strong>
        </button>
        <span>
          {wires.length || allWires
            ? "Checked in this order, before or among each state's own exits."
            : "Every transition here can fire from any other state; the first true one wins."}
        </span>
        <button type="button" className="mx-link" aria-pressed={allWires} onClick={() => setAllWires((v) => !v)}>
          {allWires ? "Hide their wires" : "Show all wires"}
        </button>
      </header>
      {listOpen && (
      <ol>
        {globals.groups.map((g) => (
          <li key={g.key}>
            <button
              type="button"
              className={`mx-any-row ${groupLive(g) ? "is-live" : ""} ${g.transitions.some((t) => t.id === selectedEdge) ? "is-picked" : ""}`}
              onClick={() => pickGroup(g)}
            >
              <span className="mx-any-target">→ {stateName(g.to)}</span>
              {g.transitions[0].name && <strong>{g.transitions[0].name}</strong>}
              <span className="mx-any-condition">
                <PlainCondition condition={g.transitions[0].condition} info={plainInfo} />
              </span>
              {g.missing.length > 0 && <small>{`not from ${g.missing.map(stateName).join(", ")}`}</small>}
            </button>
          </li>
        ))}
      </ol>
      )}
    </section>
  );
  return (
    <>
    {ladder}
    <div className="mx-graph-frame">
    <div className="mx-graph-zoom" role="group" aria-label="Zoom">
      {expanded.size > 0 && (
        <button type="button" onClick={() => setExpanded(new Set())} title="Show each pass-through path as one card again">
          Collapse paths
        </button>
      )}
      <button type="button" aria-label="Zoom out" onClick={() => step(1 / 1.2)}>
        <Minus size={14} />
      </button>
      <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")} title="Fit the whole graph">
        {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
      </button>
      <button type="button" aria-label="Zoom in" onClick={() => step(1.2)}>
        <Plus size={14} />
      </button>
    </div>
    <div className="mx-graph-scroll" ref={scroller}>
      <div
        className="mx-graph-sizer"
        style={{
          width: width * scale,
          height: height * scale,
          // Zoomed in or out by hand: room around the graph, so zooming can keep the point under
          // the cursor still and the graph can be panned past its edges.
          ...(zoom === "fit" ? {} : { padding: `${Math.round(box.h / 2)}px ${Math.round(box.w / 2)}px`, margin: 0, boxSizing: "content-box" as const }),
        }}
      >
      <div ref={graphEl} className={`mx-graph ${hovered ? "has-focus" : ""}`} style={{ width, height, transform: `scale(${scale})` }}>
        <div className="mx-edge-measure" ref={measurer} aria-hidden="true">
          {wires.map((w) => {
            const label = labels.get(w.t.id)?.label;
            return label ? (
              <span key={w.key} data-wire={w.key} className={`mx-edge-label ${w.t.name ? "is-named" : ""}`}>
                <ConditionText text={label} isKey={isKey} categoryOf={categoryOf} />
              </span>
            ) : null;
          })}
        </div>
        <svg width={width} height={height} aria-label="State transitions" className="mx-graph-wires">
          <defs>
            <marker id="mx-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--mx-wire)" />
            </marker>
            <marker id="mx-arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--mx-accent)" />
            </marker>
          </defs>
          {wires.map(({ key, t, from }) => {
            const geo = geometry.get(key);
            if (!geo) return null;
            const fromActive = from === shown(active);
            const live = fromActive && evaluate(t.condition, signals);
            const info = labels.get(t.id)!;
            const label = info.label;
            const picked = selectedEdge === t.id && (t.from !== ANY_STATE || from === selected);
            const near = from === shown(focus) || t.to === shown(focus);
            const box = labelBoxes.get(key);
            const title = [t.name, glyphText(compactCondition(t.condition, signalLabel), isKey, categoryOf), t.description]
              .filter(Boolean)
              .join("\n");
            return (
              <g
                key={key}
                className={`mx-edge ${live ? "is-live" : ""} ${fromActive ? "is-from-active" : ""} ${picked ? "is-picked" : ""} ${near ? "is-near" : "is-far"}`}
              >
                <path d={smoothPath(geo.points)} fill="none" markerEnd={`url(#${live ? "mx-arrow-live" : "mx-arrow"})`}>
                  <title>{title}</title>
                </path>
                {label && box && (
                  <foreignObject x={geo.lx - box.w / 2} y={geo.ly - box.h / 2} width={box.w} height={box.h}>
                    <button
                      type="button"
                      className={`mx-edge-label ${t.name ? "is-named" : ""}`}
                      title={title}
                      aria-label={`Transition ${label}: ${info.condition}`}
                      onClick={() => {
                        select(from);
                        selectEdge?.(t.id);
                      }}
                    >
                      {/* A name is prose: don't mark words in it that happen to be input keys. */}
                      {t.name && !label.includes(" · ") ? label : <ConditionText text={label} isKey={isKey} categoryOf={categoryOf} />}
                    </button>
                  </foreignObject>
                )}
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const p = positions.get(node.id)!;
          const run = paths?.runs.get(node.id);
          if (run) return <PathCard key={node.id} run={run} p={p} size={nodeSize}
            selected={shown(selected) === node.id} active={shown(active) === node.id}
            hover={setHovered}
            open={() => {
              setExpanded((old) => new Set(old).add(node.id));
              select(run.nodes[0].id);
            }} />;
          const Icon = machine
            ? Circle
            : node.kind === "pose" ? Navigation : node.kind === "finish" ? Flag : node.kind === "custom" ? Code2 : Zap;
          const kind = machine
            ? graph.initial === node.id
              ? "Initial state"
              : "State"
            : node.kind === "pose" ? "Drive to pose" : node.kind === "finish" ? "Finish" : node.kind === "custom" ? "Custom C++" : "Robot action";
          return (
            <button
              key={node.id}
              aria-current={active === node.id ? "step" : undefined}
              className={`mx-state is-${machine ? "machine" : node.kind} ${selected === node.id ? "is-selected" : ""} ${active === node.id ? "is-active" : ""} ${graph.initial === node.id ? "is-initial" : ""}`}
              style={{ left: p.x, top: p.y, width: nodeSize.w, height: nodeSize.h }}
              title={[node.name, node.source, node.description].filter(Boolean).join("\n")}
              onClick={() => select(node.id)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(undefined)}
              onContextMenu={menu && ((e) => menu(e, node.id))}
            >
              {(() => {
                // One tag per state, however many "from any state" transitions lead to it.
                const into = globals.groups.filter((g) => g.to === node.id);
                if (!into.length) return null;
                const names = into.map((g) => g.transitions[0].name).filter(Boolean) as string[];
                const short = names.length === into.length && names.join(", ").length <= 22 ? ` · ${names.join(", ")}` : into.length > 1 ? ` ×${into.length}` : "";
                return (
                  <span
                    className={`mx-any ${into.some(groupLive) ? "is-live" : ""}`}
                    style={{ top: -11 }}
                    title={into.map(groupTitle).join("\n\n")}
                  >
                    {into.length === 1 && into[0].missing.length ? `from any state but ${into[0].missing.length}` : "from any state"}
                    {short}
                  </span>
                );
              })()}
              {/* Machine cards stay compact: the name, plus "Initial state" on the first one; the
                  source file is in the tooltip and the inspector. */}
              {(!machine || graph.initial === node.id) && (
                <span className="mx-state-kind">
                  <Icon size={12} />
                  {kind}
                </span>
              )}
              <strong>{node.name}</strong>
              {!machine && <small>{stepNote(node)}</small>}
            </button>
          );
        })}
      </div>
      </div>
    </div>
    </div>
    </>
  );
}

/** Transitions to one target that leave every state (or nearly every state) on one condition. */
interface AnyStateGroup {
  key: string;
  to: string;
  /** One for `from: "*"`, else one per source state, in declaration (priority) order. */
  transitions: Transition[];
  sources: Set<string>;
  /** States other than the target that this group does not leave. */
  missing: string[];
  label: string;
}

/** What a step does, under its name: an event it fires, a stop, an action, or arrival. */
function stepNote(n: AutoRoutine["nodes"][number]) {
  if (n.kind !== "pose") return n.action || "Done";
  const events = (n.goal?.markers ?? []).flatMap((m) => (m.kind === "event" && m.key ? [m.key.split(".").pop()] : []));
  if (events.length) return `Event: ${events.join(", ")}${n.goal?.stop ? " · stops" : ""}`;
  return n.goal?.stop ? "Stops here" : "Measured arrival";
}

/**
 * A run of pass-through poses as one card: how many points, how far, the time span when the
 * step names carry it ("… @ 0.63s"), and a small trace of the path. Click to expand.
 */
function PathCard({ run, p, size, selected, active, open, hover }: {
  run: PathRun;
  p: { x: number; y: number };
  size: { w: number; h: number };
  selected: boolean;
  active: boolean;
  open: () => void;
  hover: (id?: string) => void;
}) {
  const goals = run.nodes.map((n) => n.goal!);
  const xs = goals.map((g) => g.x), ys = goals.map((g) => g.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const T = 40;
  // Field y points up; the thumbnail draws it up too.
  const trace = goals.map((g) => `${2 + ((g.x - x0) / span) * T},${2 + T - ((g.y - y0) / span) * T}`).join(" ");
  const time = (name: string) => /@\s*([\d.]+)\s*s/.exec(name)?.[1];
  const [t0, t1] = [time(run.nodes[0].name), time(run.nodes[run.nodes.length - 1].name)];
  return (
    <button
      className={`mx-state is-pose is-path ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
      aria-current={active ? "step" : undefined}
      style={{ left: p.x, top: p.y, width: size.w, height: size.h }}
      title={`${run.nodes[0].name} → ${run.nodes[run.nodes.length - 1].name}\nClick to show each point.`}
      aria-label={`Drive path, ${run.nodes.length} points. Click to show each point.`}
      onClick={open}
      onMouseEnter={() => hover(run.id)}
      onMouseLeave={() => hover(undefined)}
    >
      <span className="mx-state-kind">
        <Route size={12} />
        Drive path
      </span>
      <strong>
        {run.nodes.length} points · {run.length.toFixed(1)} m
      </strong>
      <small>{t0 && t1 ? `${t0} s → ${t1} s` : "Pass-through points"}</small>
      <svg className="mx-path-trace" width={T + 4} height={T + 4} aria-hidden="true">
        <polyline points={trace} fill="none" />
      </svg>
    </button>
  );
}
