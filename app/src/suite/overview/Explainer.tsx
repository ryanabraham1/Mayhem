import { useEffect, useMemo, useState } from "react";
import { BookOpen, Cpu, FolderGit2, Gamepad2, History, Pencil, Radio } from "lucide-react";
import { parseMachineSpecs } from "../core/review/machines.ts";
import { readDevices } from "../core/review/hardware.ts";
import { EXPLAINER_FILE, MACHINES_FILE, settingsOf, WORKTREE, type Snapshot } from "../core/review/report.ts";
import { parseExplainer, robotParts, serializeExplainer, type ExplainerFile } from "../core/review/explainer.ts";
import { RobotDiagram } from "../changes/HardwareView";
import { desktop, invoke } from "../native";
import { useRobot } from "../robot";
import { chooseRepo, useRobotRepo } from "../robotRepo";
import { Badge, Button, EmptyState, Panel } from "../ui";
import "../changes/changes.css";
import "./explainer.css";

const MODULE = /^Drivetrain · /;
const groupOf = (d: { subsystem: string; name: string }) => {
  const corner = ["Front left", "Front right", "Back left", "Back right"].find((m) => d.subsystem === "Drivetrain" && d.name.startsWith(m));
  return corner ? `Drivetrain · ${corner}` : d.subsystem;
};

/** How the robot works: a clickable robot map with each part explained. */
export function Explainer() {
  const [repo, setRepo] = useRobotRepo();
  const robot = useRobot();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState("");
  const [history, setHistory] = useState<{ sha: string; subject: string; body: string }[]>([]);
  const [editing, setEditing] = useState<string>();

  const load = async () => {
    if (!desktop || !repo) return;
    try {
      setSnapshot(await invoke<Snapshot>("review_snapshot", { repo, rev: WORKTREE }));
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void load();
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!snapshot) return undefined;
    const settings = settingsOf(snapshot);
    const devices = readDevices(settings);
    const machines = parseMachineSpecs(snapshot.files[MACHINES_FILE]).machines;
    const explainer = parseExplainer(snapshot.files[EXPLAINER_FILE]);
    return { devices, explainer, machines, parts: robotParts(devices, settings, machines, explainer) };
  }, [snapshot]);

  const partName = MODULE.test(picked) ? "Drivetrain" : picked;
  const part = data?.parts.find((p) => p.name === partName) ?? data?.parts[0];
  useEffect(() => {
    if (!desktop || !repo || !part?.paths.length) return setHistory([]);
    invoke<{ sha: string; subject: string; body: string }[]>("review_history", { repo, paths: part.paths, limit: 6 })
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [repo, part?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live state of this part's machines, from the robot when connected.
  const topics = useMemo(() => part?.machines.flatMap((m) => [`/Mayhem/States/${m.id}/state`, ...(m.stateChannel ? [`/AdvantageKit${m.stateChannel}`] : [])]) ?? [], [part]);
  useEffect(() => robot.live.setTopics(topics), [topics, robot.live]);
  const live = (id: string, channel?: string) => {
    const t = robot.live.snapshot.topics[`/Mayhem/States/${id}/state`] ?? (channel ? robot.live.snapshot.topics[`/AdvantageKit${channel}`] : undefined);
    return t ? String(t.value) : undefined;
  };

  const saveExplainer = async (next: ExplainerFile) => {
    if (!snapshot) return;
    await invoke("review_write_file", { repo, path: EXPLAINER_FILE, expected: snapshot.files[EXPLAINER_FILE] ?? "", text: serializeExplainer(next) });
    await load();
  };

  if (!desktop)
    return (
      <Panel title="How the robot works" icon={BookOpen}>
        <p className="mx-help">The robot explainer reads the robot code; open it in the desktop app.</p>
      </Panel>
    );
  if (!repo)
    return (
      <Panel title="How the robot works" icon={BookOpen}>
        <EmptyState icon={FolderGit2} title="Choose the robot code folder" action={<Button icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>Choose robot code folder</Button>}>
          The explainer shows every part of the robot, what it does, its buttons and its recent changes.
        </EmptyState>
      </Panel>
    );
  if (!data) return <Panel title="How the robot works" icon={BookOpen}>{error ? <p className="mx-help is-bad">{error}</p> : <p className="mx-help">Reading the robot code…</p>}</Panel>;

  return (
    <section className="mx-explainer" aria-label="How the robot works">
      <Panel title="How the robot works" icon={BookOpen}>
        <p className="mx-help">Click a part of the robot to see what it does, how the driver controls it, what it's doing right now, and what changed in it recently.</p>
        <div className="mx-explainer-grid">
          <RobotDiagram devices={data.devices} changes={new Map()} selected={picked || (part ? data.devices.filter((d) => d.subsystem === part.name).map(groupOf)[0] ?? "" : "")} select={setPicked} />
          {part && (
            <div className="mx-part" aria-label={`${part.name} explained`}>
              <h3>{part.name}</h3>
              {editing !== undefined ? (
                <div className="mx-part-edit">
                  <textarea rows={4} value={editing} onChange={(e) => setEditing(e.target.value)} aria-label={`What ${part.name} does`} placeholder="In plain words: what this part does in a match." />
                  <div className="mx-now-actions">
                    <Button size="sm" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void saveExplainer({ ...data.explainer, parts: { ...data.explainer.parts, [part.name]: editing.trim() } }).then(() => setEditing(undefined))}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mx-part-about">
                  {part.about ?? <span className="mx-muted">Nobody has described this part yet.</span>}{" "}
                  <button type="button" className="mx-link" onClick={() => setEditing(part.about ?? "")}>
                    <Pencil size={12} /> {part.about ? "Edit" : "Describe it"}
                  </button>
                </p>
              )}
              {part.machines.map((m) => (
                <div key={m.id} className="mx-part-machine">
                  <strong>{m.name}</strong>
                  {live(m.id, m.stateChannel) ? (
                    <Badge tone="good">
                      <Radio size={11} /> now: {m.states.find((s) => s.id === live(m.id, m.stateChannel))?.name ?? live(m.id, m.stateChannel)}
                    </Badge>
                  ) : null}
                  <ul>
                    {m.states.map((s) => (
                      <li key={s.id}>
                        <b>{s.name}</b>
                        {s.description ? `: ${s.description}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {part.controls.length > 0 && (
                <>
                  <h4>
                    <Gamepad2 size={14} /> Driver controls
                  </h4>
                  <ul className="mx-part-list">
                    {part.controls.map((c) => (
                      <li key={c.input}>{c.input}</li>
                    ))}
                  </ul>
                </>
              )}
              <h4>
                <Cpu size={14} /> Devices
              </h4>
              <ul className="mx-part-list">
                {part.devices.map((d) => (
                  <li key={d.key}>
                    {d.name} <small className="mx-muted">· {d.kind} · CAN {d.fields["CAN ID"] ?? "?"}{d.fields["Brake / coast when idle"] ? ` · ${d.fields["Brake / coast when idle"]}` : ""}{d.fields["Stator current limit"] ? ` · ${d.fields["Stator current limit"]}` : ""}</small>
                  </li>
                ))}
              </ul>
              <h4>
                <History size={14} /> Recent changes
              </h4>
              {history.length ? (
                <ul className="mx-part-list">
                  {history.map((c) => (
                    <li key={c.sha}>
                      <code>{c.sha.slice(0, 7)}</code> {c.subject} <small className="mx-muted">· {c.body}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mx-help">No commits found for its code.</p>
              )}
            </div>
          )}
        </div>
      </Panel>
    </section>
  );
}
