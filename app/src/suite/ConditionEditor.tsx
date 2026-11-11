import { Plus, X } from "lucide-react";
import type { Condition, SignalDefinition } from "./core/model.ts";
const defaultCondition = (signals: SignalDefinition[]): Condition =>
  signals.length
    ? {
        kind: "signal",
        key: signals[0].key,
        op: "eq",
        value: signals[0].initial,
      }
    : { kind: "always" };
export function ConditionEditor({
  condition,
  signals,
  change,
  depth = 0,
}: {
  condition: Condition;
  signals: SignalDefinition[];
  change: (c: Condition) => void;
  depth?: number;
}) {
  return (
    <div className="ms-condition-editor">
      <select
        aria-label="Condition type"
        value={condition.kind}
        onChange={(e) => {
          const kind = e.target.value;
          change(
            kind === "always"
              ? { kind }
              : kind === "signal"
                ? defaultCondition(signals)
                : kind === "not"
                  ? { kind, condition: defaultCondition(signals) }
                  : {
                      kind: kind as "all" | "any",
                      conditions: [defaultCondition(signals)],
                    },
          );
        }}
      >
        <option value="always">Always (after arrival for pose goals)</option>
        <option value="signal" disabled={!signals.length}>
          Signal comparison
        </option>
        {depth < 6 && (
          <>
            <option value="all">All conditions</option>
            <option value="any">Any condition</option>
            <option value="not">Not</option>
          </>
        )}
      </select>
      {condition.kind === "signal" && (
        <>
          <select
            aria-label="Condition signal"
            value={condition.key}
            onChange={(e) => {
              const s = signals.find((s) => s.key === e.target.value)!;
              change({ ...condition, key: s.key, op: "eq", value: s.initial });
            }}
          >
            {signals.map((s) => (
              <option value={s.key} key={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="ms-condition-comparison">
            <select
              aria-label="Comparison operator"
              value={condition.op}
              onChange={(e) =>
                change({
                  ...condition,
                  op: e.target.value as "eq" | "gt" | "lt",
                })
              }
            >
              <option value="eq">equals</option>
              {typeof condition.value === "number" && (
                <>
                  <option value="gt">greater than</option>
                  <option value="lt">less than</option>
                </>
              )}
            </select>
            {typeof condition.value === "boolean" ? (
              <select
                aria-label="Comparison value"
                value={String(condition.value)}
                onChange={(e) =>
                  change({ ...condition, value: e.target.value === "true" })
                }
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                aria-label="Comparison value"
                type={typeof condition.value === "number" ? "number" : "text"}
                value={String(condition.value)}
                onChange={(e) => {
                  const value =
                    typeof condition.value === "number"
                      ? Number(e.target.value)
                      : e.target.value;
                  if (typeof value !== "number" || Number.isFinite(value))
                    change({ ...condition, value });
                }}
              />
            )}
          </div>
        </>
      )}
      {condition.kind === "not" && (
        <ConditionEditor
          condition={condition.condition}
          signals={signals}
          depth={depth + 1}
          change={(c) => change({ kind: "not", condition: c })}
        />
      )}
      {(condition.kind === "all" || condition.kind === "any") && (
        <div className="ms-condition-children">
          {condition.conditions.map((c, i) => (
            <div key={i}>
              <ConditionEditor
                condition={c}
                signals={signals}
                depth={depth + 1}
                change={(next) =>
                  change({
                    ...condition,
                    conditions: condition.conditions.map((old, index) =>
                      index === i ? next : old,
                    ),
                  })
                }
              />
              {condition.conditions.length > 1 && (
                <button
                  aria-label="Remove nested condition"
                  onClick={() =>
                    change({
                      ...condition,
                      conditions: condition.conditions.filter(
                        (_, index) => i !== index,
                      ),
                    })
                  }
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          <button
            className="ms-button"
            onClick={() =>
              change({
                ...condition,
                conditions: [
                  ...condition.conditions,
                  defaultCondition(signals),
                ],
              })
            }
          >
            <Plus size={12} />
            Condition
          </button>
        </div>
      )}
    </div>
  );
}
