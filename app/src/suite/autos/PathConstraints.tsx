import { useEffect, useRef, useState } from "react";
import { RotateCcw, WandSparkles, X } from "lucide-react";
import { isIntermediate } from "../core/runtime.ts";
import {
  constraintSignature,
  type GeneratedResult,
} from "../core/pathing/constraintGeneration.ts";
import {
  resolveConstraints,
  resolveNodeConstraints,
  type Constraints,
  type ResolvedConstraints,
} from "../core/model.ts";
import type { SuiteState } from "../useSuiteProject";
import {
  Button,
  Field,
  IconButton,
  NumberField,
  Segmented,
} from "../ui";

const motionFields = [
  { key: "maxVelocity", label: "Max speed", unit: "m/s", group: "Translation" },
  {
    key: "maxAcceleration",
    label: "Max acceleration",
    unit: "m/s²",
    group: "Translation",
  },
  {
    key: "maxAngularVelocity",
    label: "Max turn speed",
    unit: "rad/s",
    group: "Rotation",
  },
  {
    key: "maxAngularAcceleration",
    label: "Max turn acceleration",
    unit: "rad/s²",
    group: "Rotation",
  },
  {
    key: "handoffRadius",
    label: "Default handoff radius",
    unit: "m",
    group: "Corners",
  },
  {
    key: "minVelocity",
    label: "Minimum speed",
    unit: "m/s",
    group: "More limits",
  },
] as const;
type MotionKey = (typeof motionFields)[number]["key"];
export function withoutMotionOverrides(
  value: Partial<Constraints> | undefined,
) {
  const next = { ...value };
  for (const f of motionFields) delete next[f.key];
  return Object.keys(next).length ? next : undefined;
}

export function ConstraintFields({
  inherited,
  overrides,
  change,
  source,
}: {
  inherited: ResolvedConstraints;
  overrides?: Partial<Constraints>;
  change: (key: MotionKey, value: number | undefined) => void;
  source: string;
}) {
  const fields = (group: string) =>
    motionFields
      .filter((f) => f.group === group)
      .map((f) => {
        const value = overrides?.[f.key] ?? inherited[f.key];
        const custom = overrides?.[f.key] !== undefined;
        return (
          <div className="mx-limit-field" key={f.key}>
            <NumberField
              label={f.label}
              value={value}
              unit={f.unit}
              min={f.key === "minVelocity" ? 0 : 0.001}
              step={0.1}
              change={(v) => change(f.key, v)}
            />
            <div className="mx-limit-source">
              <span>{custom ? "Custom" : `From ${source}`}</span>
              {custom && (
                <IconButton
                  label={`Reset ${f.label.toLowerCase()}`}
                  icon={RotateCcw}
                  onClick={() => change(f.key, undefined)}
                />
              )}
            </div>
          </div>
        );
      });
  return (
    <>
      {["Translation", "Rotation", "Corners"].map((group) => (
        <section className="mx-insp-section" key={group}>
          <h3>{group}</h3>
          <div className={group === "Corners" ? "" : "mx-pair"}>
            {fields(group)}
          </div>
          {group === "Corners" && (
            <p className="mx-help">
              How close to a pass-through point before turning toward the next
              one.
            </p>
          )}
        </section>
      ))}
      <details className="mx-advanced-disclosure">
        <summary>More limits</summary>
        <div className="mx-disclosure-body">
          {fields("More limits")}
          <p className="mx-help">
            Leave minimum speed at 0 to stop at the end of the path.
          </p>
        </div>
      </details>
    </>
  );
}

export function PathConstraints({
  s,
  close,
}: {
  s: SuiteState;
  close: () => void;
}) {
  const [scope, setScope] = useState<"map" | "path" | "range">("map");
  const [busy, setBusy] = useState(false);
  const [selectedLimit, setSelectedLimit] = useState<"speed" | "radius">(
    "speed",
  );
  const [limitNode, setLimitNode] = useState(s.selected);
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef(s);
  latest.current = s;
  useEffect(() => () => workerRef.current?.terminate(), []);
  const [from, setFrom] = useState(0);
  const poses = s.routine.nodes.filter((n) => n.kind === "pose");
  const [through, setThrough] = useState(Math.max(0, poses.length - 1));
  const [draft, setDraft] = useState<Partial<Constraints>>({});
  const robot = resolveConstraints(s.project.robot.constraints);
  const path = resolveConstraints(
    s.project.robot.constraints,
    s.routine.constraints,
  );
  const patch = (
    value: Partial<Constraints> | undefined,
    key: MotionKey,
    next: number | undefined,
  ) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else result[key] = next;
    return result;
  };
  const overrides = poses.filter((n) =>
    motionFields.some((f) => n.constraints?.[f.key] !== undefined),
  );
  const selected = poses.find((n) => n.id === limitNode) ?? poses[0];
  const selectedValues = resolveNodeConstraints(s.project, s.routine, selected);
  const manual =
    selectedLimit === "speed"
      ? selected?.constraints?.maxVelocity !== undefined
      : !!selected?.goal?.handoffRadius ||
        selected?.constraints?.handoffRadius !== undefined;
  const selectedValue =
    selectedLimit === "speed"
      ? selectedValues.maxVelocity
      : selected?.goal?.handoffRadius || selectedValues.handoffRadius;
  const generated = s.routine.constraintGeneration;
  const stale =
    !!generated &&
    generated.signature !== constraintSignature(s.project, s.routine);
  const setManual = (value: number) =>
    s.editNode((n) => {
      if (selectedLimit === "speed")
        n.constraints = { ...n.constraints, maxVelocity: value };
      else n.goal = { ...n.goal!, handoffRadius: value };
    }, selected!.id);
  const auto = () =>
    s.editNode((n) => {
      if (selectedLimit === "speed") {
        const next = { ...n.constraints };
        delete next.maxVelocity;
        n.constraints = next;
      } else {
        n.goal = { ...n.goal!, handoffRadius: 0 };
        const next = { ...n.constraints };
        delete next.handoffRadius;
        n.constraints = next;
      }
    }, selected!.id);
  const generate = () => {
    workerRef.current?.terminate();
    const snapshot = s.project;
    const id = s.routine.id;
    const worker = new Worker(
      new URL("../core/pathing/constraintGeneration.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    setBusy(true);
    const finish = () => {
      worker.terminate();
      workerRef.current = null;
      setBusy(false);
    };
    worker.onerror = () => {
      finish();
      latest.current.notify("Constraint generation failed. Try again.");
    };
    worker.onmessage = (
      event: MessageEvent<{ result?: GeneratedResult; error?: string }>,
    ) => {
      finish();
      const state = latest.current;
      if (state.project !== snapshot) {
        state.notify(
          "The path changed. Generate constraints again for the updated path.",
        );
        return;
      }
      if (event.data.error || !event.data.result) {
        state.notify(event.data.error ?? "Constraint generation failed.");
        return;
      }
      const result = event.data.result;
      state.commit((project) => {
        const routine = project.routines.find((r) => r.id === id)!;
        routine.constraintGeneration = {
          signature: result.signature,
          status: result.status,
        };
        if (result.status !== "unsolvable")
          for (const n of routine.nodes) {
            const limit = result.limits.find((l) => l.id === n.id);
            if (limit) {
              const { id: _, ...values } = limit;
              n.generatedConstraints = values;
            }
          }
      });
      state.notify(
        result.status === "valid"
          ? "Generated speed limits and handoff radii."
          : result.status === "best-effort"
            ? "Generated best-effort limits. Review the path preview."
            : "Could not find working limits. Adjust manual values or poses and generate again.",
      );
    };
    worker.postMessage({ project: s.project, routine: s.routine });
  };
  return (
    <>
      <div className="mx-insp-head">
        <div>
          <span className="mx-kind">Path</span>
          <h2>Constraints</h2>
        </div>
        <IconButton label="Close constraints" icon={X} onClick={close} />
      </div>
      <p className="mx-help">Set how fast this path moves and turns.</p>
      <Segmented
        label="Constraint scope"
        value={scope}
        onChange={setScope}
        options={[
          { value: "map", label: "Map" },
          { value: "path", label: "Path limits" },
          { value: "range", label: "Range" },
        ]}
      />
      {scope === "map" ? (
        <>
          <div className="mx-generation-bar">
            <span
              className={`mx-badge ${busy || stale || generated?.status !== "valid" ? "is-warn" : "is-good"}`}
              role="status"
            >
              {busy
                ? "Generating…"
                : !generated
                  ? "Ready to generate"
                  : stale
                    ? "Path changed"
                    : generated.status === "valid"
                      ? "Up to date"
                      : generated.status === "best-effort"
                        ? "Review limits"
                        : "Adjust manual limits"}
            </span>
            <Button
              size="sm"
              icon={WandSparkles}
              disabled={busy || !poses.length}
              onClick={generate}
            >
              Generate
            </Button>
            <IconButton
              label="Clear generated constraints"
              icon={RotateCcw}
              disabled={busy || !generated}
              onClick={() =>
                s.editRoutine((r) => {
                  delete r.constraintGeneration;
                  for (const n of r.nodes) delete n.generatedConstraints;
                })
              }
            />
          </div>
          <p className="mx-help">
            Generate speed limits and corner radii together, then click a block
            to tune it.
          </p>
          <div className="mx-constraint-legend">
            <span className="is-auto">Auto</span>
            <span>Manual</span>
          </div>
          <div
            className="mx-constraint-map"
            role="group"
            aria-label="Path constraint map"
          >
            <div className="mx-constraint-map-head">
              <span>Speed</span>
              <span>Handoff</span>
            </div>
            {poses.map((n, i) => {
              const k = resolveNodeConstraints(s.project, s.routine, n);
              const radius = n.goal!.handoffRadius || k.handoffRadius;
              const intermediate = isIntermediate(s.routine, n);
              const cell = (
                kind: "speed" | "radius",
                value: number,
                pinned: boolean,
              ) => (
                <button
                  key={kind}
                  disabled={kind === "radius" && !intermediate}
                  className={`mx-constraint-cell is-${kind} ${pinned ? "is-manual" : "is-auto"} ${selected?.id === n.id && selectedLimit === kind ? "is-selected" : ""}`}
                  aria-label={`${kind === "speed" ? "Speed limit" : "Handoff radius"} ${i + 1}: ${n.name}`}
                  aria-pressed={selected?.id === n.id && selectedLimit === kind}
                  onClick={() => {
                    setLimitNode(n.id);
                    setSelectedLimit(kind);
                    s.setSelected(n.id);
                  }}
                >
                  <span>
                    {kind === "radius" && !intermediate
                      ? "Stop"
                      : `${Number(value.toFixed(2))} ${kind === "speed" ? "m/s" : "m"}`}
                  </span>
                  <small>
                    {i + 1}. {n.name}
                  </small>
                </button>
              );
              return (
                <div className="mx-constraint-map-row" key={n.id}>
                  {cell(
                    "speed",
                    k.maxVelocity,
                    n.constraints?.maxVelocity !== undefined,
                  )}
                  {cell(
                    "radius",
                    radius,
                    !!n.goal!.handoffRadius ||
                      n.constraints?.handoffRadius !== undefined,
                  )}
                </div>
              );
            })}
          </div>
          {selected && (
            <section className="mx-insp-section">
              <h3>
                {selectedLimit === "speed" ? "Speed limit" : "Handoff radius"}
              </h3>
              <p className="mx-help">{selected.name}</p>
              <Segmented
                label="Constraint value mode"
                value={manual ? "manual" : "auto"}
                onChange={(mode) =>
                  mode === "auto" ? auto() : setManual(selectedValue)
                }
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "manual", label: "Manual" },
                ]}
              />
              {manual ? (
                <NumberField
                  label={
                    selectedLimit === "speed"
                      ? "Segment speed limit"
                      : "Corner handoff radius"
                  }
                  value={selectedValue}
                  min={0.001}
                  unit={selectedLimit === "speed" ? "m/s" : "m"}
                  change={setManual}
                />
              ) : (
                <p className="mx-help">
                  {generated
                    ? "Generated value. Switch to Manual to pin your own value."
                    : "Using path defaults. Press Generate to calculate this value."}
                </p>
              )}
              {selectedLimit === "radius" && (
                <Segmented
                  label="Handoff mode"
                  value={
                    selected.goal?.projectedHandoff ? "progress" : "radius"
                  }
                  onChange={(mode) =>
                    s.editNode((n) => {
                      n.goal = {
                        ...n.goal!,
                        projectedHandoff: mode === "progress",
                      };
                    }, selected.id)
                  }
                  options={[
                    { value: "radius", label: "Radius" },
                    { value: "progress", label: "Progress" },
                  ]}
                />
              )}
            </section>
          )}
        </>
      ) : scope === "path" ? (
        <>
          <ConstraintFields
            inherited={robot}
            overrides={s.routine.constraints}
            source="robot"
            change={(key, value) =>
              s.editRoutine((r) => {
                r.constraints = patch(r.constraints, key, value);
              })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            icon={RotateCcw}
            disabled={
              !motionFields.some(
                (f) => s.routine.constraints?.[f.key] !== undefined,
              )
            }
            onClick={() =>
              s.editRoutine((r) => {
                r.constraints = withoutMotionOverrides(r.constraints);
              })
            }
          >
            Use robot defaults
          </Button>
          {overrides.length > 0 && (
            <section className="mx-insp-section">
              <h3>
                Segment overrides{" "}
                <span className="mx-badge">{overrides.length}</span>
              </h3>
              <p className="mx-help">These steps have their own limits.</p>
              {overrides.map((n) => (
                <button
                  className="mx-constraint-step"
                  key={n.id}
                  onClick={() => s.setSelected(n.id)}
                >
                  <span>{n.name}</span>
                  <small>
                    {
                      Object.keys(n.constraints ?? {}).filter((k) =>
                        motionFields.some((f) => f.key === k),
                      ).length
                    }{" "}
                    custom
                  </small>
                </button>
              ))}
            </section>
          )}
        </>
      ) : poses.length ? (
        <>
          <section className="mx-insp-section">
            <h3>Apply to segments</h3>
            <Field label="From step">
              <select
                aria-label="From step"
                value={Math.min(from, poses.length - 1)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setFrom(v);
                  setThrough(Math.max(v, through));
                }}
              >
                {poses.map((n, i) => (
                  <option key={n.id} value={i}>
                    {i + 1}. {n.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Through step">
              <select
                aria-label="Through step"
                value={Math.min(through, poses.length - 1)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setThrough(v);
                  setFrom(Math.min(from, v));
                }}
              >
                {poses.map((n, i) => (
                  <option key={n.id} value={i}>
                    {i + 1}. {n.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="mx-help">
              A step’s limits apply while driving toward it. Change only the
              limits you want to override.
            </p>
          </section>
          <ConstraintFields
            inherited={path}
            overrides={draft}
            source="path"
            change={(key, value) =>
              setDraft((current) => patch(current, key, value))
            }
          />
          <Button
            variant="primary"
            disabled={!Object.keys(draft).length}
            onClick={() => {
              const ids = new Set(
                poses.slice(from, through + 1).map((n) => n.id),
              );
              s.editRoutine((r) => {
                for (const n of r.nodes)
                  if (ids.has(n.id))
                    n.constraints = { ...n.constraints, ...draft };
              });
              s.notify(
                `Updated limits for ${ids.size} ${ids.size === 1 ? "segment" : "segments"}.`,
              );
            }}
          >
            Apply range limits
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const ids = new Set(
                poses.slice(from, through + 1).map((n) => n.id),
              );
              s.editRoutine((r) => {
                for (const n of r.nodes)
                  if (ids.has(n.id))
                    n.constraints = withoutMotionOverrides(n.constraints);
              });
              setDraft({});
            }}
          >
            Use path limits for range
          </Button>
        </>
      ) : (
        <p className="mx-help">
          Add a pose to set limits for individual segments.
        </p>
      )}
    </>
  );
}
