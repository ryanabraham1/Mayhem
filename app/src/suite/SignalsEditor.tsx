import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { SuiteProject } from "./core/model.ts";
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
    <div className="ms-settings-card">
      <h3>Inputs & observed signals</h3>
      <p>
        Declare the values the robot reports. Agents can add arbitrary signals
        and custom predicates through this same project document.
      </p>
      <div className="ms-signal-definitions">
        {project.signals.map((s) => (
          <div key={s.key}>
            <code>{s.key}</code>
            <span>{s.name}</span>
            <small>
              {s.type}
              {s.unit ? ` · ${s.unit}` : ""}
            </small>
            <button
              className="ms-icon-button"
              aria-label={`Remove signal ${s.name}`}
              onClick={() =>
                commit((p) => {
                  p.signals = p.signals.filter((old) => old.key !== s.key);
                })
              }
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <form
        className="ms-add-signal"
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
          placeholder="Signal key, e.g. intake.hasPiece"
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
          <option value="boolean">Boolean</option>
          <option value="number">Number</option>
          <option value="string">Text</option>
        </select>
        <button className="ms-button" type="submit">
          <Plus size={13} />
          Add input
        </button>
      </form>
    </div>
  );
}
