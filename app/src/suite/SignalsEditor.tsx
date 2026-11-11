import { useState } from "react";
import { Plus, ToggleLeft, X } from "lucide-react";
import type { SuiteProject } from "./core/model.ts";
import { Button, IconButton, Panel } from "./ui";

export function SignalsEditor({
  project,
  commit,
}: {
  project: SuiteProject;
  commit: (edit: (draft: SuiteProject) => void) => void;
}) {
  const [key, setKey] = useState(""),
    [name, setName] = useState(""),
    [type, setType] = useState<"boolean" | "number" | "string">("boolean");
  return (
    <Panel title="Robot inputs" icon={ToggleLeft}>
      <p className="mx-help">
        Sensor values and flags the robot reports, like “has game piece” or
        “shooter at speed”. Autonomous branches and state machines decide on
        these.
      </p>
      <div className="mx-signal-table" role="table" aria-label="Robot inputs">
        {project.signals.map((s) => (
          <div key={s.key} role="row">
            <code role="cell">{s.key}</code>
            <span role="cell">{s.name}</span>
            <small role="cell">
              {s.type}
              {s.unit ? ` · ${s.unit}` : ""}
            </small>
            <IconButton
              label={`Remove signal ${s.name}`}
              icon={X}
              onClick={() =>
                commit((p) => {
                  p.signals = p.signals.filter((old) => old.key !== s.key);
                })
              }
            />
          </div>
        ))}
        {!project.signals.length && <p className="mx-help">No inputs declared yet.</p>}
      </div>
      <form
        className="mx-add-signal"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          commit((p) => {
            p.signals.push({
              key: key.trim(),
              name: name.trim() || key.trim(),
              type,
              initial: type === "boolean" ? false : type === "number" ? 0 : "",
            });
          });
          setKey("");
          setName("");
        }}
      >
        <input
          aria-label="New signal key"
          placeholder="Key, e.g. intake.hasPiece"
          required
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <input
          aria-label="New signal name"
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="New signal type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="boolean">True/false</option>
          <option value="number">Number</option>
          <option value="string">Text</option>
        </select>
        <Button type="submit" icon={Plus}>
          Add input
        </Button>
      </form>
    </Panel>
  );
}
