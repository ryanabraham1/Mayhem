import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Code2,
  FileUp,
  GitBranch,
  Pause,
  Play,
} from "lucide-react";
import { useLiveRobot } from "./useLiveRobot";
import { StateView } from "./StateView";
import {
  conditionLabel,
  evaluate,
  type Signals,
  type SuiteProject,
} from "./core/model.ts";
import {
  exampleMachine,
  machineGraph,
  observedMachine,
  parseMachineManifest,
  type MachineManifest,
} from "./core/machines.ts";
import type { Recording } from "./core/analysis.ts";
import type { Frame } from "./core/runtime.ts";
import { download } from "./storage";
export function MachinesView({
  project,
  frame,
  selectAuto,
  commit,
  notify,
}: {
  project: SuiteProject;
  frame: Frame;
  selectAuto: (id: string) => void;
  commit: (edit: (p: SuiteProject) => void) => void;
  notify: (m: string) => void;
}) {
  const [host, setHost] = useState("roborio-3256-frc.local");
  const live = useLiveRobot(host);
  const [choice, setChoice] = useState(`auto:${project.routines[0].id}`),
    [selected, setSelected] = useState(project.routines[0].initial),
    [inputs, setInputs] = useState<Signals>({});
  const [recording, setRecording] = useState<Recording | null>(null),
    [cursor, setCursor] = useState(0),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const manifests = useMemo(() => {
    const stored = Array.isArray(project.extensions.machines)
      ? project.extensions.machines
      : [];
    const byId = new Map<string, MachineManifest>();
    for (const value of stored)
      try {
        const m = parseMachineManifest(value);
        byId.set(m.id, m);
      } catch {}
    for (const [name, sample] of Object.entries(live.snapshot.topics))
      if (
        name.startsWith("/Mayhem/Schema/") &&
        typeof sample.value === "string"
      )
        try {
          const m = parseMachineManifest(JSON.parse(sample.value));
          byId.set(m.id, m);
        } catch {}
    if (!byId.size) byId.set(exampleMachine.id, exampleMachine);
    return [...byId.values()];
  }, [project.extensions, live.snapshot.topics]);
  const machine = choice.startsWith("machine:")
    ? manifests.find((m) => m.id === choice.slice(8))
    : undefined;
  const auto =
    project.routines.find((r) => r.id === choice.slice(5)) ??
    project.routines[0];
  const graph = machine ? machineGraph(machine) : auto;
  const topicKey = JSON.stringify(
    machine
      ? [
          ...machine.inputs.map((s) => s.channel ?? s.key),
          machine.stateChannel ?? `/Mayhem/States/${machine.id}/state`,
        ]
      : [],
  );
  useEffect(() => {
    const keys: string[] = JSON.parse(topicKey);
    live.setTopics(
      keys.flatMap((key) => [key, key.startsWith("/") ? key : `/${key}`]),
    );
  }, [topicKey, live.setTopics]);
  const liveActive = live.snapshot.status !== "disconnected" && !recording;
  const liveSignals: Signals = {};
  if (machine && liveActive)
    for (const input of machine.inputs) {
      const topic =
        live.snapshot.topics[input.channel ?? input.key] ??
        live.snapshot.topics[`/${input.channel ?? input.key}`] ??
        live.snapshot.topics[`/${input.key}`] ??
        live.snapshot.topics[
          `/Mayhem/States/${machine.id}/inputs/${input.key}`
        ];
      if (topic && typeof topic.value === input.type)
        liveSignals[input.key] = topic.value;
    }
  const observation =
    machine && recording ? observedMachine(machine, recording, cursor) : null;
  const signals =
    observation?.signals ??
    (machine
      ? liveActive
        ? liveSignals
        : Object.fromEntries(
            machine.inputs.map((s) => [s.key, inputs[s.key] ?? s.initial]),
          )
      : frame.signals);
  const liveState = machine
    ? (live.snapshot.topics[
        machine.stateChannel ?? `/Mayhem/States/${machine.id}/state`
      ]?.value ??
      live.snapshot.topics[
        `/${machine.stateChannel ?? `Mayhem/States/${machine.id}/state`}`
      ]?.value)
    : undefined;
  const active = machine
    ? (observation?.state ??
      (liveActive
        ? typeof liveState === "string"
          ? liveState
          : ""
        : machine.initial))
    : frame.node;
  const node = graph.nodes.find((n) => n.id === selected) ?? graph.nodes[0];
  useEffect(() => {
    const instance = new Worker(new URL("./log.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = instance;
    instance.onmessage = (e) => {
      setBusy(false);
      if (e.data.error) notify(e.data.error);
      else {
        setRecording(e.data.recording);
        setCursor(0);
      }
    };
    instance.onerror = () => {
      setBusy(false);
      notify("State replay reader stopped unexpectedly.");
    };
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, [notify]);
  useEffect(() => {
    if (!playing || !recording) return;
    const timer = setInterval(
      () => setCursor((t) => Math.min(recording.duration, t + 0.04)),
      40,
    );
    return () => clearInterval(timer);
  }, [playing, recording]);
  useEffect(() => {
    if (recording && cursor >= recording.duration) setPlaying(false);
  }, [recording, cursor]);
  const importManifest = async (file?: File) => {
    if (!file) return;
    try {
      const machine = parseMachineManifest(JSON.parse(await file.text()));
      commit((p) => {
        const old = Array.isArray(p.extensions.machines)
          ? p.extensions.machines.filter(
              (m: unknown) =>
                !m ||
                typeof m !== "object" ||
                !("id" in m) ||
                m.id !== machine.id,
            )
          : [];
        p.extensions.machines = [...old, machine];
      });
      setChoice(`machine:${machine.id}`);
      setSelected(machine.initial);
    } catch (e) {
      notify(String(e));
    }
  };
  const importLog = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 250 * 1024 * 1024)
        throw new Error("Current log limit is 250 MB.");
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
    <section className="ms-machines">
      <div className="ms-live-connect">
        <span>
          <i
            className={`ms-dot ${live.snapshot.status === "connected" ? "teal" : ""}`}
          />
          Live robot · read only
        </span>
        <input
          aria-label="Live robot address"
          value={host}
          onChange={(e) => {
            live.disconnect();
            setHost(e.target.value);
          }}
        />
        <button
          className="ms-button"
          onClick={() => {
            setRecording(null);
            setPlaying(false);
            if (live.snapshot.status === "disconnected") live.connect();
            else live.disconnect();
          }}
        >
          {live.snapshot.status === "disconnected" ? "Connect" : "Disconnect"}
        </button>
        <small>{live.snapshot.status}</small>
        {live.snapshot.error && <p role="status">{live.snapshot.error}</p>}
      </div>
      <div className="ms-machines-toolbar">
        <GitBranch size={17} />
        <select
          aria-label="State machine"
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setRecording(null);
            setPlaying(false);
            if (e.target.value.startsWith("auto:")) {
              const id = e.target.value.slice(5);
              selectAuto(id);
              setSelected(project.routines.find((r) => r.id === id)!.initial);
            } else
              setSelected(
                manifests.find((m) => m.id === e.target.value.slice(8))!
                  .initial,
              );
          }}
        >
          <optgroup label="Autonomous routines">
            {project.routines.map((r) => (
              <option value={`auto:${r.id}`} key={r.id}>
                {r.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Robot state machines">
            {manifests.map((m) => (
              <option value={`machine:${m.id}`} key={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        </select>
        <label className="ms-button">
          <FileUp size={14} />
          Import machine
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              void importManifest(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="ms-button"
          onClick={() =>
            download(
              "machine-example.json",
              JSON.stringify(exampleMachine, null, 2),
            )
          }
        >
          <ArrowDownToLine size={14} />
          Example
        </button>
        {machine && (
          <label className="ms-button">
            <FileUp size={14} />
            {busy ? "Reading…" : "Replay a log"}
            <input
              type="file"
              accept=".wpilog,.json"
              disabled={busy}
              onChange={(e) => {
                void importLog(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      <div className="ms-machines-body">
        <StateView
          routine={graph}
          selected={node.id}
          active={active}
          signals={signals}
          select={setSelected}
        />
        <aside className="ms-machine-inspector">
          <span className="ms-eyebrow">
            {machine ? "Robot state machine" : "Autonomous execution"}
          </span>
          <h2>{node.name}</h2>
          {node.description && <p>{node.description}</p>}
          {node.source && (
            <div className="ms-source">
              <Code2 size={14} />
              <code>{node.source}</code>
            </div>
          )}
          <h3>
            {observation
              ? "Recorded inputs"
              : liveActive
                ? "Live inputs"
                : "Inputs & conditions"}
          </h3>
          {(machine?.inputs ?? project.signals).map((s) => (
            <label className="ms-machine-input" key={s.key}>
              <span>
                {s.name}
                <small>{s.key}</small>
              </span>
              {!recording && !liveActive && machine && s.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={signals[s.key] === true}
                  onChange={(e) =>
                    setInputs((v) => ({ ...v, [s.key]: e.target.checked }))
                  }
                />
              ) : (
                <code>{String(signals[s.key] ?? "Not recorded")}</code>
              )}
            </label>
          ))}
          {liveActive && machine && (
            <>
              <h3>Published guard results</h3>
              {Object.entries(live.snapshot.topics)
                .filter(([key]) =>
                  key.startsWith(`/Mayhem/States/${machine.id}/guards/`),
                )
                .map(([key, sample]) => (
                  <div key={key} className="ms-machine-input">
                    <span>{key.split("/guards/")[1]}</span>
                    <code>{String(sample.value)}</code>
                  </div>
                ))}
            </>
          )}
          <h3>Transitions from this state</h3>
          {graph.transitions
            .filter((t) => t.from === node.id)
            .map((t) => (
              <div className="ms-condition" key={t.id}>
                <span
                  className={evaluate(t.condition, signals) ? "ms-good" : ""}
                >
                  {conditionLabel(t.condition)}
                </span>
                <small>→ {graph.nodes.find((n) => n.id === t.to)?.name}</small>
              </div>
            ))}
          <p className="ms-help">
            {machine
              ? recording
                ? "Playback shows recorded states and available inputs. Missing inputs remain unknown."
                : liveActive
                  ? "Read-only live values from the robot. Missing inputs remain unknown."
                  : "The manifest describes your existing C++ logic. Input controls inspect conditions; they do not execute the machine."
              : "This is the same routine used by the field editor. Select a state to inspect its outgoing conditions."}
          </p>
          {!machine && (
            <p className="ms-help">
              Use the autonomous workspace to run and scrub this routine’s
              preview.
            </p>
          )}
          {machine?.id === exampleMachine.id &&
            !Array.isArray(project.extensions.machines) &&
            !liveActive && (
              <p className="ms-help">
                Example machine. Import your own manifest or have an agent add
                it to the project.
              </p>
            )}
        </aside>
      </div>
      {recording && machine && (
        <div className="ms-machine-playback">
          <button
            className="ms-button ms-primary"
            onClick={() => {
              if (cursor >= recording.duration) setCursor(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
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
          <code>
            {cursor.toFixed(2)} s · {active}
          </code>
          <span>
            {observation?.state ? "Recorded state" : "State channel not found"}
          </span>
        </div>
      )}
    </section>
  );
}
