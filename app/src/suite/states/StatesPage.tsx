import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Circle,
  ClipboardCopy,
  Pencil,
  RotateCcw,
  Code2,
  FileUp,
  GitBranch,
  Navigation,
  Pause,
  Play,
  Radio,
} from "lucide-react";
import { copyText, openContextMenu } from "../ContextMenu";
import { evaluate, type Signals } from "../core/model.ts";
import { edgeLabels } from "../core/edgeLabels.ts";
import {
  INPUT_CATEGORIES,
  INPUT_CATEGORY_ORDER,
  categoryLookup,
  conditionKeys,
  transitionCause,
  type TransitionCause,
} from "../core/inputCategories.ts";
import { CategoryLegend, ConditionText, glyphText } from "./ConditionText";
import {
  exampleMachine,
  machineGraph,
  observedMachine,
  parseMachineManifest,
  type MachineManifest,
} from "../core/machines.ts";
import type { Recording } from "../core/analysis.ts";
import { download } from "../storage";
import { useRobot } from "../robot";
import type { SuiteState } from "../useSuiteProject";
import {
  Badge,
  Button,
  Dot,
  EmptyState,
  FileButton,
  PageHeader,
  Segmented,
} from "../ui";
import { StateGraph } from "./StateGraph";

type Source = "simulate" | "live" | "replay";

export function StatesPage({ s, openAutos }: { s: SuiteState; openAutos: () => void }) {
  const { project, notify } = s;
  const robot = useRobot();
  const live = robot.live;
  const [choice, setChoice] = useState(`auto:${s.routine.id}`);
  const [selected, setSelected] = useState(s.routine.initial);
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [manualInputs, setManualInputs] = useState<Signals>({});
  const [simState, setSimState] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("simulate");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);

  const manifests = useMemo(() => {
    const stored = Array.isArray(project.extensions.machines) ? project.extensions.machines : [];
    const byId = new Map<string, MachineManifest>();
    for (const value of stored)
      try {
        const m = parseMachineManifest(value);
        byId.set(m.id, m);
      } catch {}
    for (const [name, sample] of Object.entries(live.snapshot.topics))
      if (name.startsWith("/Mayhem/Schema/") && typeof sample.value === "string")
        try {
          const m = parseMachineManifest(JSON.parse(sample.value));
          byId.set(m.id, m);
        } catch {}
    return [...byId.values()];
  }, [project.extensions, live.snapshot.topics]);
  const showExample = manifests.length === 0;
  const allMachines = showExample ? [exampleMachine] : manifests;

  const machine = choice.startsWith("machine:")
    ? allMachines.find((m) => m.id === choice.slice(8))
    : undefined;
  const auto = project.routines.find((r) => r.id === choice.slice(5)) ?? s.routine;
  const graph = machine ? machineGraph(machine) : auto;
  // Edges use input keys, as robot code does; the Inputs list maps keys to names.
  const edgeInfo = useMemo(() => edgeLabels(graph.transitions), [graph.transitions]);
  const stateTopic = machine ? (machine.stateChannel ?? `/Mayhem/States/${machine.id}/state`) : "";

  const topicKey = JSON.stringify(
    machine ? [...machine.inputs.map((i) => i.channel ?? i.key), stateTopic] : [],
  );
  useEffect(() => {
    const keys: string[] = JSON.parse(topicKey);
    live.setTopics(
      keys.flatMap((key) => {
        const slashed = key.startsWith("/") ? key : `/${key}`;
        return [key, slashed, `/AdvantageKit${slashed}`];
      }),
    );
  }, [topicKey, live.setTopics]);

  useEffect(() => {
    const instance = new Worker(new URL("../log.worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    instance.onmessage = (e) => {
      setBusy(false);
      if (e.data.error) notify(e.data.error);
      else {
        setRecording(e.data.recording);
        setCursor(0);
        setSource("replay");
      }
    };
    instance.onerror = () => {
      setBusy(false);
      notify("The log reader stopped unexpectedly.");
    };
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, [notify]);
  useEffect(() => {
    if (!playing || !recording) return;
    const timer = setInterval(() => setCursor((t) => Math.min(recording.duration, t + 0.04)), 40);
    return () => clearInterval(timer);
  }, [playing, recording]);
  useEffect(() => {
    if (recording && cursor >= recording.duration) setPlaying(false);
  }, [recording, cursor]);

  const connected = live.snapshot.status === "connected";
  const liveActive = source === "live" && live.snapshot.status !== "disconnected";
  // Robot code may publish a logged key directly, with a leading slash, or under AdvantageKit's NT prefix.
  const liveValue = (key: string) => {
    const slashed = key.startsWith("/") ? key : `/${key}`;
    return (
      live.snapshot.topics[key]?.value ??
      live.snapshot.topics[slashed]?.value ??
      live.snapshot.topics[`/AdvantageKit${slashed}`]?.value
    );
  };

  const inputs = machine?.inputs ?? project.signals;
  let signals: Signals;
  let active: string;
  const observation = machine && recording && source === "replay" ? observedMachine(machine, recording, cursor) : null;
  if (!machine) {
    signals = { ...s.frame.signals, ...s.signals };
    active = s.frame.node;
  } else if (observation) {
    signals = observation.signals;
    active = observation.state ?? "";
  } else if (liveActive) {
    signals = {};
    for (const input of machine.inputs) {
      const v =
        liveValue(input.channel ?? input.key) ?? liveValue(`/Mayhem/States/${machine.id}/inputs/${input.key}`);
      if (typeof v === input.type) signals[input.key] = v as boolean | number | string;
    }
    const state = liveValue(stateTopic);
    active = typeof state === "string" ? state : "";
  } else {
    signals = Object.fromEntries(machine.inputs.map((i) => [i.key, manualInputs[i.key] ?? i.initial]));
    active = simState ?? machine.initial;
  }
  const node = graph.nodes.find((n) => n.id === selected) ?? graph.nodes[0];
  const editable = source === "simulate";
  const categoryOf = useMemo(() => categoryLookup(inputs), [inputs]);
  const inputKeys = useMemo(() => new Set([...inputs.map((i) => i.key), "stateTime"]), [inputs]);
  const isKey = (k: string) => inputKeys.has(k);
  const usedCategories = useMemo(() => {
    const used = new Set(inputs.map((i) => categoryOf(i.key)));
    if (graph.transitions.some((t) => conditionKeys(t.condition).includes("stateTime"))) used.add("timer");
    return INPUT_CATEGORY_ORDER.filter((c) => used.has(c));
  }, [inputs, categoryOf, graph.transitions]);
  // Why the active state last changed: the edge taken and the inputs that changed for it.
  const previous = useRef<{ graph: string; active: string; signals: Signals } | null>(null);
  const [cause, setCause] = useState<(TransitionCause & { from: string; to: string }) | null>(null);
  const graphKey = machine ? `machine:${machine.id}` : `auto:${graph.id}`;
  useEffect(() => {
    const prior = previous.current;
    previous.current = { graph: graphKey, active, signals };
    if (!prior || prior.graph !== graphKey) {
      setCause(null);
      return;
    }
    if (!active || !prior.active || prior.active === active) return;
    const found = transitionCause(graph.transitions, prior.active, active, prior.signals, signals);
    setCause(found ? { ...found, from: prior.active, to: active } : null);
  }); // runs after every render; compares with the previous render's state and inputs
  const stateName = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;
  /** Follow true transitions from a state, like the robot would on its next loops. */
  const settle = (from: string, values: Signals) => {
    let state = from;
    for (let hop = 0; hop < 12; hop++) {
      const edge = graph.transitions.find((t) => t.from === state && evaluate(t.condition, values));
      if (!edge || edge.to === state) break;
      state = edge.to;
    }
    return state;
  };
  const setInput = (key: string, value: boolean | number | string) => {
    if (machine) {
      const next = { ...signals, [key]: value };
      setManualInputs((v) => ({ ...v, [key]: value }));
      const state = settle(active || machine.initial, next);
      setSimState(state);
      setSelected(state);
    } else s.setSignals({ ...s.signals, [key]: value });
  };

  const pick = (value: string) => {
    setChoice(value);
    setSimState(null);
    setManualInputs({});
    setRecording(null);
    setPlaying(false);
    if (source === "replay") setSource("simulate");
    if (value.startsWith("auto:")) {
      const id = value.slice(5);
      s.selectRoutine(id);
      setSelected(project.routines.find((r) => r.id === id)!.initial);
    } else setSelected(allMachines.find((m) => m.id === value.slice(8))!.initial);
  };

  const importManifest = async (file?: File) => {
    if (!file) return;
    try {
      const m = parseMachineManifest(JSON.parse(await file.text()));
      s.commit((p) => {
        const old = Array.isArray(p.extensions.machines)
          ? p.extensions.machines.filter(
              (x: unknown) => !x || typeof x !== "object" || !("id" in x) || x.id !== m.id,
            )
          : [];
        p.extensions.machines = [...old, m];
      });
      setChoice(`machine:${m.id}`);
      setSelected(m.initial);
    } catch (e) {
      notify(String(e));
    }
  };
  const importLog = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 250 * 1024 * 1024) throw new Error("Logs larger than 250 MB can't be replayed yet.");
      setBusy(true);
      setPlaying(false);
      const buffer = await file.arrayBuffer();
      worker.current?.postMessage({ buffer, name: file.name, id: 1 }, [buffer]);
    } catch (e) {
      setBusy(false);
      notify(String(e));
    }
  };

  return (
    <div className="mx-states">
      <PageHeader
        title="State machines"
        subtitle="See how states connect, which inputs drive each transition, and what the robot is doing right now."
        actions={
          <>
            <FileButton accept=".json" icon={FileUp} onFile={(f) => void importManifest(f)}>
              Import machine
            </FileButton>
            <Button
              icon={ArrowDownToLine}
              onClick={() => download("machine-example.json", JSON.stringify(exampleMachine, null, 2))}
            >
              Example manifest
            </Button>
          </>
        }
      />
      <div className="mx-states-grid">
        <nav className="mx-rail" aria-label="Machines">
          <div className="mx-rail-head">
            <h2>Autonomous routines</h2>
          </div>
          <div className="mx-machine-list">
            {project.routines.map((r) => (
              <button
                key={r.id}
                className={choice === `auto:${r.id}` ? "is-active" : ""}
                onClick={() => pick(`auto:${r.id}`)}
              >
                <Navigation size={14} />
                <span>{r.name}</span>
                <small>{r.nodes.length}</small>
              </button>
            ))}
          </div>
          <div className="mx-rail-head is-steps">
            <h2>Robot state machines</h2>
          </div>
          <div className="mx-machine-list">
            {allMachines.map((m) => (
              <button
                key={m.id}
                className={choice === `machine:${m.id}` ? "is-active" : ""}
                onClick={() => pick(`machine:${m.id}`)}
              >
                <GitBranch size={14} />
                <span>{m.name}</span>
                {showExample ? <Badge>example</Badge> : <small>{m.states.length}</small>}
              </button>
            ))}
          </div>
          <p className="mx-rail-note">
            Robot code publishes its machines under <code>/Mayhem/Schema</code>, or an agent adds a
            manifest to the project.
          </p>
        </nav>

        <section className="mx-stage" aria-label="State graph">
          <div className="mx-stage-bar">
            {machine ? (
              <Segmented<Source>
                label="Data source"
                value={source}
                onChange={(v) => {
                  if (v === "live" && live.snapshot.status === "disconnected") live.connect();
                  if (v !== "replay") setPlaying(false);
                  setSource(v);
                }}
                options={[
                  { value: "simulate", label: "Simulate" },
                  { value: "live", label: "Live robot", icon: Radio },
                  ...(recording ? [{ value: "replay" as const, label: "Log replay" }] : []),
                ]}
              />
            ) : (
              <span className="mx-stage-note">
                <Dot tone={s.playing ? "accent" : "neutral"} />
                Mirrors the autonomous preview
                <button className="mx-link" onClick={openAutos}>
                  Open in Autos
                </button>
              </span>
            )}
            <span className="mx-stage-spacer" />
            {machine && source === "simulate" && (
              <>
                <span className="mx-stage-meta">Toggle inputs to step the machine</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSimState(null);
                    setManualInputs({});
                  }}
                >
                  Reset
                </Button>
              </>
            )}
            {machine && (
              <FileButton accept=".wpilog,.json" icon={FileUp} disabled={busy} onFile={(f) => void importLog(f)}>
                {busy ? "Reading…" : "Replay a log"}
              </FileButton>
            )}
            {source === "live" && machine && (
              <Badge tone={connected ? "good" : "warn"}>
                {connected ? `Live · ${robot.host}` : live.snapshot.status === "disconnected" ? "Offline" : "Connecting…"}
              </Badge>
            )}
          </div>
          <div className="mx-graph-meta">
            <CategoryLegend categories={usedCategories} />
            {cause && (
              <p className="mx-cause" role="status" title={glyphText(edgeInfo.get(cause.transition.id)?.condition ?? "", isKey, categoryOf)}>
                {stateName(cause.from)} → {stateName(cause.to)} because{" "}
                {cause.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && ", "}
                    <ConditionText text={k} isKey={isKey} categoryOf={categoryOf} />
                  </span>
                ))}
              </p>
            )}
          </div>
          <StateGraph
            inputs={inputs}
            graph={graph}
            machine={!!machine}
            signals={signals}
            selected={node.id}
            active={active}
            select={(id) => {
              setSelected(id);
              setSelectedEdge(undefined);
            }}
            selectedEdge={selectedEdge}
            selectEdge={setSelectedEdge}
            menu={(e, id) => {
              setSelected(id);
              const target = graph.nodes.find((n) => n.id === id);
              openContextMenu(
                e,
                [
                  machine && source === "simulate" && {
                    label: "Simulate from this state",
                    icon: Play,
                    disabled: active === id,
                    onSelect: () => setSimState(id),
                  },
                  machine && source === "simulate" && simState !== null && {
                    label: "Reset simulation",
                    icon: RotateCcw,
                    onSelect: () => {
                      setSimState(null);
                      setManualInputs({});
                    },
                  },
                  !machine && {
                    label: "Edit step in Autos",
                    icon: Pencil,
                    onSelect: () => {
                      s.setSelected(id);
                      openAutos();
                    },
                  },
                  "separator",
                  { label: "Copy name", icon: ClipboardCopy, onSelect: () => void copyText(target?.name ?? id) },
                  { label: "Copy ID", onSelect: () => void copyText(id) },
                ],
                target?.name,
              );
            }}
          />
          {source === "replay" && recording && machine && (
            <div className="mx-dock-bar is-standalone">
              <button
                className="mx-play"
                aria-label={playing ? "Pause replay" : "Play replay"}
                onClick={() => {
                  if (cursor >= recording.duration) setCursor(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <code className="mx-clock">
                {cursor.toFixed(2)}
                <small>s</small>
              </code>
              <input
                className="mx-range"
                aria-label="State recording time"
                type="range"
                min="0"
                max={recording.duration}
                step=".01"
                value={cursor}
                onChange={(e) => {
                  setPlaying(false);
                  setCursor(Number(e.target.value));
                }}
              />
              <span className="mx-dock-status">
                {observation?.state
                  ? `State: ${observation.state}`
                  : recording.channels.some(
                        (c) => c.name.replace(/^\//, "") === stateTopic.replace(/^\//, ""),
                      )
                    ? "No state recorded yet at this time"
                    : `${stateTopic} isn't in this log`}
              </span>
            </div>
          )}
        </section>

        <aside className="mx-inspector" aria-label="State details">
          <div className="mx-insp-head">
            <div>
              <span className={`mx-kind is-${node.kind}`}>
                {machine ? "Robot state" : "Autonomous step"}
                {node.id === active && " · active"}
              </span>
              <h2>{node.name}</h2>
            </div>
          </div>
          {node.description && <p className="mx-help">{node.description}</p>}
          {machine && source === "simulate" && node.id !== active && (
            <Button size="sm" onClick={() => setSimState(node.id)}>
              Simulate from this state
            </Button>
          )}
          {node.source && (
            <div className="mx-source">
              <Code2 size={14} />
              <code>{node.source}</code>
            </div>
          )}
          <section className="mx-insp-section">
            <h3>
              Inputs
              <Badge tone={source === "live" ? "good" : source === "replay" ? "accent" : "neutral"}>
                {source === "live" && machine ? "live" : source === "replay" && machine ? "recorded" : machine ? "simulated" : "preview"}
              </Badge>
            </h3>
            {inputs.length === 0 && <p className="mx-help">This machine declares no inputs.</p>}
            <div className="mx-inputs">
              {INPUT_CATEGORY_ORDER.flatMap((category) => {
                const group = inputs.filter((input) => categoryOf(input.key) === category);
                if (!group.length) return [];
                return [
                  <h4 key={`h-${category}`} className={`mx-input-group mx-term is-${category}`} title={INPUT_CATEGORIES[category].description}>
                    <span className={`mx-term-badge is-${category}`} aria-hidden="true">
                      {INPUT_CATEGORIES[category].letter}
                    </span>
                    {INPUT_CATEGORIES[category].label}
                  </h4>,
                  ...group.map((input) => {
                const value = signals[input.key];
                return (
                  <div className="mx-input-row" key={input.key}>
                    <span>
                      {input.name}
                      <code>{input.key}</code>
                      {input.derivedFrom?.length ? (
                        <small className="mx-derived">
                          from{" "}
                          <ConditionText text={input.derivedFrom.join(", ")} isKey={isKey} categoryOf={categoryOf} />
                        </small>
                      ) : null}
                    </span>
                    {editable && input.type === "boolean" ? (
                      <button
                        role="switch"
                        aria-checked={value === true}
                        aria-label={input.name}
                        className={`mx-bool ${value === true ? "is-on" : ""}`}
                        onClick={() => setInput(input.key, value !== true)}
                      >
                        {value === true ? "true" : "false"}
                      </button>
                    ) : editable && input.type === "number" ? (
                      <input
                        type="number"
                        aria-label={input.name}
                        className="mx-input-num"
                        value={typeof value === "number" ? value : Number(input.initial)}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setInput(input.key, v);
                        }}
                      />
                    ) : (
                      <code className={`mx-value ${value === true ? "is-on" : value === undefined ? "is-unknown" : ""}`}>
                        {value === undefined ? "unknown" : String(value)}
                      </code>
                    )}
                  </div>
                );
                  }),
                ];
              })}
            </div>
          </section>
          {liveActive && machine && (
            <section className="mx-insp-section">
              <h3>Published guard results</h3>
              {Object.entries(live.snapshot.topics)
                .filter(([key]) => key.startsWith(`/Mayhem/States/${machine.id}/guards/`))
                .map(([key, sample]) => (
                  <div key={key} className="mx-input-row">
                    <span>{key.split("/guards/")[1]}</span>
                    <code className="mx-value">{String(sample.value)}</code>
                  </div>
                ))}
            </section>
          )}
          <section className="mx-insp-section">
            <h3>Leaves this state when</h3>
            {graph.transitions
              .filter((t) => t.from === node.id)
              .map((t) => {
                const ok = evaluate(t.condition, signals);
                const info = edgeInfo.get(t.id)!;
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedEdge === t.id}
                    className={`mx-guard mx-guard-edge ${ok ? "is-true" : ""} ${selectedEdge === t.id ? "is-picked" : ""}`}
                    onClick={() => setSelectedEdge(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedEdge(t.id);
                      }
                    }}
                  >
                    <span className="mx-guard-priority" title="Priority: checked in this order">{info.priority}</span>
                    {ok ? <Check size={14} /> : <Circle size={13} />}
                    <span className="mx-guard-main">
                      {t.name && <strong>{t.name}</strong>}
                      <code className="mx-guard-condition">
                        <ConditionText text={info.condition} isKey={isKey} categoryOf={categoryOf} />
                      </code>
                      {t.description && <small>{t.description}</small>}
                    </span>
                    <button
                      type="button"
                      className="mx-link mx-guard-target"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(t.to);
                        setSelectedEdge(undefined);
                      }}
                    >
                      → {graph.nodes.find((n) => n.id === t.to)?.name}
                    </button>
                  </div>
                );
              })}
            {!graph.transitions.some((t) => t.from === node.id) && (
              <p className="mx-help">Terminal state. Nothing leaves it.</p>
            )}
            {graph.transitions.filter((t) => t.from === node.id).length > 1 && (
              <p className="mx-help">Checked in order; the first true condition wins.</p>
            )}
          </section>
          {!machine && (
            <p className="mx-help">
              Toggle inputs here to see which branch the autonomous routine takes, then press Preview in
              Autos to drive it.
            </p>
          )}
          {source === "live" && live.snapshot.error && <p className="mx-help is-bad">{live.snapshot.error}</p>}
        </aside>
      </div>
      {graph.nodes.length === 0 && <EmptyState icon={GitBranch} title="No states" />}
    </div>
  );
}
