import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import dagre from "@dagrejs/dagre";
import { Circle, Code2, Flag, Navigation, Zap } from "lucide-react";
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

const W = 196,
  H = 78,
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

/**
 * Layered top-to-bottom layout (dagre) with each edge label as an obstacle of its measured size,
 * so labels never overlap each other, states or other wires' labels. Edges that close a cycle
 * (found from the initial state) are laid out reversed, so the flow reads top to bottom from the
 * initial state, and get their own lanes instead of looping under the states. `lift` reserves
 * room above a state for its "from any state" chips. Without wires, states form a grid.
 */
export function layoutGraph(nodes: string[], initial: string, wires: Wire[], labels: Map<string, Box>, lift: (id: string) => number) {
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
  g.setGraph({ rankdir: "TB", nodesep: 36, edgesep: 18, ranksep: 44, marginx: PAD, marginy: PAD });
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
  graph,
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
  const [allWires, setAllWires] = useState(false);
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
    const threshold = Math.max(3, Math.ceil((graph.nodes.length - 1) * 0.6));
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
  const chipCount = (id: string) => globals.groups.filter((g) => g.to === id).length;
  const { positions, geometry, width, height } = useMemo(
    () =>
      layoutGraph(
        wired.nodes.map((n) => n.id),
        graph.initial,
        wires.map((w) => ({ key: w.key, from: w.from, to: w.t.to })),
        labelBoxes,
        (id) => chipCount(id) * CHIP,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wired, wires, labelBoxes, graph.initial, globals],
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
  const scale = box.w ? Math.max(0.8, Math.min(1, (box.w - 16) / width, (box.h - 16) / height)) : 1;
  const ladder = globals.groups.length > 0 && (
    <section className={`mx-any-ladder ${wires.length ? "" : "is-primary"}`} aria-label="Transitions from any state">
      <header>
        <strong>From any state</strong>
        <span>
          {wires.length || allWires
            ? "Checked in this order, before or among each state's own exits."
            : "Every transition here can fire from any other state; the first true one wins."}
        </span>
        <button type="button" className="mx-link" aria-pressed={allWires} onClick={() => setAllWires((v) => !v)}>
          {allWires ? "Hide their wires" : "Show all wires"}
        </button>
      </header>
      <ol>
        {globals.groups.map((g) => (
          <li key={g.key}>
            <button
              type="button"
              className={`mx-any-row ${groupLive(g) ? "is-live" : ""} ${g.transitions.some((t) => t.id === selectedEdge) ? "is-picked" : ""}`}
              title={groupTitle(g)}
              onClick={() => pickGroup(g)}
            >
              <span className="mx-any-target">→ {stateName(g.to)}</span>
              {g.transitions[0].name && <strong>{g.transitions[0].name}</strong>}
              <code>
                <ConditionText text={compactCondition(g.transitions[0].condition, signalLabel)} isKey={isKey} categoryOf={categoryOf} />
              </code>
              {g.missing.length > 0 && <small>{`not from ${g.missing.map(stateName).join(", ")}`}</small>}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
  return (
    <>
    {ladder}
    <div className="mx-graph-scroll" ref={scroller}>
      <div className="mx-graph-sizer" style={{ width: width * scale, height: height * scale }}>
      <div className={`mx-graph ${hovered ? "has-focus" : ""}`} style={{ width, height, transform: `scale(${scale})` }}>
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
            const fromActive = from === active;
            const live = fromActive && evaluate(t.condition, signals);
            const info = labels.get(t.id)!;
            const label = info.label;
            const picked = selectedEdge === t.id && (t.from !== ANY_STATE || from === selected);
            const near = from === focus || t.to === focus;
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
                      <ConditionText text={label} isKey={isKey} categoryOf={categoryOf} />
                    </button>
                  </foreignObject>
                )}
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const p = positions.get(node.id)!;
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
              style={{ left: p.x, top: p.y, width: W, height: H }}
              title={[node.name, node.source, node.description].filter(Boolean).join("\n")}
              onClick={() => select(node.id)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(undefined)}
              onContextMenu={menu && ((e) => menu(e, node.id))}
            >
              {globals.groups
                .filter((g) => g.to === node.id)
                .map((g, i) => (
                  <span
                    key={g.key}
                    className={`mx-any ${groupLive(g) ? "is-live" : ""}`}
                    style={{ top: -11 - i * 20 }}
                    title={groupTitle(g)}
                  >
                    {g.missing.length ? `from any state but ${g.missing.length}` : "from any state"}
                  </span>
                ))}
              <span className="mx-state-kind">
                <Icon size={12} />
                {kind}
              </span>
              <strong>{node.name}</strong>
              <small>
                {machine
                  ? node.source
                    ? shortSource(node.source)
                    : elideMiddle(node.description ?? node.id, 26)
                  : node.kind === "pose"
                    ? "Measured arrival"
                    : node.action || "Done"}
              </small>
            </button>
          );
        })}
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
