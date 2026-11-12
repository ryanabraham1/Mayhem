import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
  GAP_X = 150,
  GAP_Y = 46,
  PAD = 28,
  BAND_GAP = 84;

/** A code reference as its file name (plus any :line), so the distinctive part stays visible. */
export function shortSource(source: string, max = 26): string {
  const text = source.trim();
  const file = text.includes("/") ? `…/${text.slice(text.lastIndexOf("/") + 1)}` : text;
  return elideMiddle(file.length < text.length && text.length <= max ? text : file, max);
}

/** Longest-path layering from the initial state, ignoring edges that close cycles. */
function layout(graph: AutoRoutine, available: number, availableHeight: number) {
  const out = new Map<string, string[]>();
  for (const t of graph.transitions)
    if (t.from !== t.to) out.set(t.from, [...(out.get(t.from) ?? []), t.to]);
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
  visit(graph.initial);
  for (const n of graph.nodes) if (!state.has(n.id)) visit(n.id);
  const depth = new Map<string, number>([[graph.initial, 0]]);
  for (let pass = 0; pass < graph.nodes.length; pass++)
    for (const t of graph.transitions) {
      const from = depth.get(t.from);
      if (from === undefined || t.from === t.to || back.has(`${t.from}>${t.to}`)) continue;
      if ((depth.get(t.to) ?? -1) < from + 1) depth.set(t.to, from + 1);
    }
  // States not reached from the initial one: start each source (no forward incoming edge) at
  // column 0 and relax again, so separate clusters lay out side by side instead of stacking.
  if (depth.size < graph.nodes.length) {
    const hasIncoming = new Set(
      graph.transitions.filter((t) => t.from !== t.to && !back.has(`${t.from}>${t.to}`)).map((t) => t.to),
    );
    for (const n of graph.nodes) if (!depth.has(n.id) && !hasIncoming.has(n.id)) depth.set(n.id, 0);
    for (let pass = 0; pass < graph.nodes.length; pass++)
      for (const t of graph.transitions) {
        const from = depth.get(t.from);
        if (from === undefined || t.from === t.to || back.has(`${t.from}>${t.to}`)) continue;
        if ((depth.get(t.to) ?? -1) < from + 1) depth.set(t.to, from + 1);
      }
  }
  // Anything still unplaced (pure cycles) fills a compact grid after the last column.
  const maxDepth = Math.max(0, ...depth.values());
  const rest = graph.nodes.filter((n) => !depth.has(n.id));
  const perColumn = Math.max(2, Math.ceil(Math.sqrt(rest.length)));
  rest.forEach((n, i) => depth.set(n.id, maxDepth + 1 + Math.floor(i / perColumn)));
  const byDepth = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id)!;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n.id]);
  }
  // A layer taller than the view splits into side-by-side sub-columns.
  const maxRows = Math.max(2, Math.floor((availableHeight - PAD * 2 - 60 + GAP_Y) / (H + GAP_Y)));
  const columns = new Map<number, string[]>();
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ids = byDepth.get(d)!;
    for (let i = 0; i < ids.length; i += maxRows) columns.set(columns.size, ids.slice(i, i + maxRows));
  }
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const columnCount = columns.size;
  // Wrap columns into bands when the machine is wider than the view.
  const perBand = Math.max(1, Math.min(columnCount, Math.floor((available - PAD * 2 + GAP_X) / (W + GAP_X))));
  const bandHeight = tallest * (H + GAP_Y) - GAP_Y + BAND_GAP;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of columns) {
    const offset = ((tallest - ids.length) * (H + GAP_Y)) / 2;
    const band = Math.floor(d / perBand),
      column = d % perBand;
    ids.forEach((id, i) =>
      positions.set(id, {
        x: PAD + column * (W + GAP_X),
        y: PAD + band * bandHeight + offset + i * (H + GAP_Y),
      }),
    );
  }
  const bands = Math.ceil(columnCount / perBand);
  const width = PAD * 2 + perBand * (W + GAP_X) - GAP_X;
  const height = PAD * 2 + bands * bandHeight - BAND_GAP + 60;
  return { positions, width, height };
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
  // Glyphs take room: keep labels a little shorter than the two-line box allows.
  const labels = useMemo(
    () => edgeLabels(graph.transitions, 32, (id) => graph.nodes.find((n) => n.id === id)?.name ?? id, signalLabel),
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
  const { positions, width, height } = useMemo(() => layout(wired, box.w || 1200, box.h || 700), [wired, box.w, box.h]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Shrink large machines to fit, but never below a readable size; scroll beyond that.
  const scale = box.w ? Math.max(0.7, Math.min(1, (box.w - 16) / width, (box.h - 16) / height)) : 1;
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
      <div className="mx-graph" style={{ width, height, transform: `scale(${scale})` }}>
        <svg width={width} height={height} aria-label="State transitions" className="mx-graph-wires">
          <defs>
            <marker id="mx-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--mx-wire)" />
            </marker>
            <marker id="mx-arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--mx-accent)" />
            </marker>
          </defs>
          {wires.map(({ key, t, from }, index) => {
            const a = positions.get(from),
              b = positions.get(t.to);
            if (!a || !b) return null;
            const sameBand = Math.abs(a.y - b.y) < H * 2 + GAP_Y * 2 && b.y + H > a.y - GAP_Y && a.y + H > b.y - GAP_Y;
            const forward = b.x > a.x && sameBand;
            const down = b.y > a.y + H + GAP_Y && !sameBand;
            let d: string, lx: number, ly: number;
            if (down) {
              // Wraps to the next band: leave from the bottom, enter from the top.
              const x1 = a.x + W / 2,
                y1 = a.y + H,
                x2 = b.x + W / 2,
                y2 = b.y - 2,
                mid = (y1 + y2) / 2;
              d = `M${x1},${y1} C${x1},${mid + 30} ${x2},${mid - 30} ${x2},${y2}`;
              lx = (x1 + x2) / 2;
              ly = mid;
            } else if (forward) {
              const x1 = a.x + W,
                y1 = a.y + H / 2,
                x2 = b.x - 2,
                y2 = b.y + H / 2,
                mid = (x1 + x2) / 2;
              d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
              lx = mid;
              ly = (y1 + y2) / 2;
            } else {
              // Back or same-column edge: loop underneath both states.
              const drop = Math.max(a.y, b.y) + H + 26 + (index % 3) * 10;
              const x1 = a.x + W / 2 + 18,
                x2 = b.x + W / 2 - 18;
              d = `M${x1},${a.y + H} C${x1},${drop} ${x2},${drop} ${x2},${b.y + H + 2}`;
              lx = (x1 + x2) / 2;
              ly = drop - 6;
            }
            const fromActive = from === active;
            const live = fromActive && evaluate(t.condition, signals);
            const info = labels.get(t.id)!;
            const label = info.label;
            const picked = selectedEdge === t.id;
            return (
              <g key={key} className={`mx-edge ${live ? "is-live" : ""} ${fromActive ? "is-from-active" : ""} ${picked ? "is-picked" : ""}`}>
                <path d={d} fill="none" markerEnd={`url(#${live ? "mx-arrow-live" : "mx-arrow"})`}>
                  <title>{[t.name, glyphText(info.condition, isKey, categoryOf), t.description].filter(Boolean).join("\n")}</title>
                </path>
                {label && (
                  <foreignObject x={lx - 75} y={ly - 18} width="150" height="36">
                    <div className="mx-edge-slot">
                    <button
                      type="button"
                      className={`mx-edge-label ${t.name ? "is-named" : ""}`}
                      title={[t.name, glyphText(info.condition, isKey, categoryOf), t.description].filter(Boolean).join("\n")}
                      aria-label={`Transition ${label}: ${info.condition}`}
                      onClick={() => {
                        select(from);
                        selectEdge?.(t.id);
                      }}
                    >
                      <ConditionText text={label} isKey={isKey} categoryOf={categoryOf} />
                    </button>
                    </div>
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
                    {g.missing.length ? `from any state but ${g.missing.length}` : "from any state"} ·{" "}
                    <ConditionText text={elideMiddle(g.label, 18)} isKey={isKey} categoryOf={categoryOf} />
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
