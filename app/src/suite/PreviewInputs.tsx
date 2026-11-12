import type { AutoRoutine, SignalDefinition, Signals } from "./core/model";
import { evaluate } from "./core/model";
import { compactCondition } from "./core/edgeLabels";
import type { ActionStatus, Frame } from "./core/runtime";

export function PreviewInputs({
  routine,
  frame,
  definitions,
  signals,
  setSignals,
  actions,
  setActions,
}: {
  routine: AutoRoutine;
  frame: Frame;
  definitions: SignalDefinition[];
  signals: Signals;
  setSignals: (signals: Signals) => void;
  actions: Record<string, ActionStatus>;
  setActions: (actions: Record<string, ActionStatus>) => void;
}) {
  const node = routine.nodes.find((node) => node.id === frame.node)!;
  const callbacks = [
    ...new Set([...(node.during ?? []), ...(node.action ? [node.action] : [])]),
  ];
  return (
    <div className="mx-sim-inputs">
      <div>
        <strong>{node.name}</strong>
        <p className="mx-help">
          Set simulated callback results and sensor inputs. These controls never
          command the robot.
        </p>
      </div>
      {callbacks.map((id) => (
        <label className="mx-field is-inline" key={id}>
          {id}
          <select
            aria-label={`Action ${id}`}
            value={actions[id] ?? "running"}
            onChange={(event) =>
              setActions({
                ...actions,
                [id]: event.target.value as ActionStatus,
              })
            }
          >
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      ))}
      {definitions.map((signal) => (
        <label className="mx-field is-inline" key={signal.key}>
          {signal.name}
          {signal.type === "boolean" ? (
            <input
              type="checkbox"
              checked={signals[signal.key] === true}
              onChange={(event) =>
                setSignals({ ...signals, [signal.key]: event.target.checked })
              }
            />
          ) : (
            <input
              type={signal.type === "number" ? "number" : "text"}
              value={String(signals[signal.key] ?? signal.initial)}
              onChange={(event) => {
                const value =
                  signal.type === "number"
                    ? Number(event.target.value)
                    : event.target.value;
                if (typeof value !== "number" || Number.isFinite(value))
                  setSignals({ ...signals, [signal.key]: value });
              }}
            />
          )}
        </label>
      ))}
      <div className="mx-sim-guards">
        {routine.transitions
          .filter((t) => t.from === node.id)
          .map((t) => (
            <p key={t.id}>
              <span
                className={
                  evaluate(t.condition, signals) ? "is-good" : "is-muted"
                }
              >
                {evaluate(t.condition, signals) ? "✓" : "○"}
              </span>{" "}
              {t.name ?? compactCondition(t.condition)} →{" "}
              {routine.nodes.find((n) => n.id === t.to)?.name}
            </p>
          ))}
      </div>
    </div>
  );
}
