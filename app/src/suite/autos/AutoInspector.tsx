import type { ReactNode } from "react";
import { Check, Circle, Copy, Plus, Trash2, X } from "lucide-react";
import {
  DEFAULT_GOAL,
  PATH_DEFAULTS,
  autoStepLabel,
  conditionLabel,
  evaluate,
  type AutoNode,
  type Goal,
  type PathMarker,
} from "../core/model.ts";
import { isIntermediate } from "../core/runtime.ts";
import { ConditionEditor } from "../ConditionEditor";
import type { SuiteState } from "../useSuiteProject";
import { Button, Field, IconButton, NumberField, Toggle, deg, rad } from "../ui";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-insp-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function StartInspector({ s, close }: { s: SuiteState; close: () => void }) {
  const pose = s.routine.start ?? s.project.robot.start;
  const change = (p: typeof pose) =>
    s.editRoutine((r) => {
      r.start = p;
    });
  return (
    <>
      <div className="mx-insp-head">
        <div>
          <span className="mx-kind is-start">Start</span>
          <h2>Starting pose</h2>
        </div>
        <IconButton label="Close inspector" icon={X} onClick={close} />
      </div>
      <Section title="Where the robot begins">
        <div className="mx-pair">
          <NumberField label="Starting X" value={pose.x} unit="m" change={(x) => change({ ...pose, x })} />
          <NumberField label="Starting Y" value={pose.y} unit="m" change={(y) => change({ ...pose, y })} />
        </div>
        <NumberField
          label="Starting heading"
          value={deg(pose.heading)}
          min={-3600}
          step={5}
          unit="°"
          change={(v) => change({ ...pose, heading: rad(v) })}
        />
        <p className="mx-help">
          Drag the green robot or its heading knob on the field. Each routine
          can start somewhere different.
        </p>
        <Button
          size="sm"
          disabled={!s.routine.start}
          onClick={() =>
            s.editRoutine((r) => {
              delete r.start;
            })
          }
        >
          Use robot default
        </Button>
      </Section>
    </>
  );
}

function MarkerSection({ goal, setGoal }: { goal: Goal; setGoal: (patch: Partial<Goal>) => void }) {
  const markers = goal.markers ?? [];
  const update = (i: number, patch: Partial<PathMarker>) =>
    setGoal({
      markers: markers
        .map((m, j) => (j === i ? ({ ...m, ...patch } as PathMarker) : m))
        .sort((a, b) => a.t - b.t),
    });
  const add = (marker: PathMarker) =>
    setGoal({ markers: [...markers, marker].sort((a, b) => a.t - b.t) });
  return (
    <Section title="On the way here">
      <p className="mx-help">
        Rotation targets and event triggers sit on the segment leading into this step, placed by progress (0 = previous step, 1 = this step). They do not bend the route.
      </p>
      {markers.map((m, i) => (
        <div
          className="mx-marker"
          key={i}
          style={{ borderTop: "1px solid var(--mx-line, rgba(127,127,127,.25))", paddingTop: 8, marginTop: 8 }}
        >
          <div className="mx-pair">
            <NumberField
              label={m.kind === "rotation" ? "Rotation at progress" : "Event at progress"}
              value={m.t}
              step={0.05}
              change={(t) => update(i, { t: Math.min(1, t) })}
            />
            {m.kind === "rotation" ? (
              <NumberField
                label="Heading"
                value={deg(m.heading)}
                min={-3600}
                unit="°"
                step={5}
                change={(v) => update(i, { heading: rad(v) })}
              />
            ) : (
              <Field label="Event key">
                <input
                  className="mx-mono-input"
                  key={i + m.key}
                  defaultValue={m.key}
                  onBlur={(e) => {
                    const key = e.target.value.trim();
                    if (key && key !== m.key) update(i, { key });
                  }}
                />
              </Field>
            )}
          </div>
          <div className="mx-marker-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            {m.kind === "rotation" && (
              <Toggle
                label="Smooth"
                checked={m.profiled ?? true}
                onChange={(profiled) => update(i, { profiled })}
              />
            )}
            <IconButton
              label={`Remove ${m.kind === "rotation" ? "rotation target" : "event trigger"}`}
              icon={Trash2}
              onClick={() => setGoal({ markers: markers.filter((_, j) => j !== i) })}
            />
          </div>
        </div>
      ))}
      <div className="mx-pair">
        <Button size="sm" icon={Plus} onClick={() => add({ kind: "rotation", t: 0.5, heading: goal.heading, profiled: true })}>
          Rotation target
        </Button>
        <Button size="sm" icon={Plus} onClick={() => add({ kind: "event", t: 0.5, key: "robot.event" })}>
          Event trigger
        </Button>
      </div>
    </Section>
  );
}

export function AutoInspector({ s, close }: { s: SuiteState; close: () => void }) {
  if (s.selected === "@start") return <StartInspector s={s} close={close} />;
  const { node, routine, project } = s;
  const goal = node.goal;
  const setGoal = (patch: Partial<Goal>) =>
    s.editNode((n) => {
      n.goal = { ...n.goal!, ...patch };
    });
  const outgoing = routine.transitions.filter((t) => t.from === node.id);
  const kindClass =
    node.kind === "pose" ? (goal?.headingMode === "free" ? "is-translation" : "is-pose") : `is-${node.kind}`;
  return (
    <>
      <div className="mx-insp-head">
        <div>
          <span className={`mx-kind ${kindClass}`}>{autoStepLabel(node)}</span>
          <input
            className="mx-insp-name"
            aria-label="State name"
            key={node.id + node.name}
            defaultValue={node.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== node.name)
                s.editNode((n) => {
                  n.name = name;
                });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
        <div className="mx-insp-actions">
          {node.kind === "pose" && (
            <IconButton
              label="Duplicate selected goal"
              icon={Copy}
              onClick={() => s.addGoal("select", undefined, node.id)}
            />
          )}
          {node.kind !== "finish" && (
            <IconButton label="Delete selected state" icon={Trash2} onClick={() => s.removeNode()} />
          )}
          <IconButton label="Close inspector" icon={X} onClick={close} />
        </div>
      </div>

      {node.kind !== "finish" && (
        <Section title="Behavior">
          <Field label="Step type">
            <select
              aria-label="Behavior type"
              value={node.kind}
              onChange={(e) =>
                s.editNode((n) => {
                  n.kind = e.target.value as AutoNode["kind"];
                  if (n.kind === "pose") n.goal ??= { ...DEFAULT_GOAL };
                  else n.action ||= "robot.action";
                })
              }
            >
              <option value="pose">Drive to a pose</option>
              <option value="action">Run a robot action</option>
              <option value="custom">Call custom C++</option>
            </select>
          </Field>
          {(node.kind === "action" || node.kind === "custom") && (
            <Field label="Callback ID" hint="Implemented in your robot code and registered with the runner.">
              <input
                className="mx-mono-input"
                key={node.id + node.action}
                defaultValue={node.action}
                onBlur={(e) => {
                  if (e.target.value !== node.action)
                    s.editNode((n) => {
                      n.action = e.target.value;
                    });
                }}
              />
            </Field>
          )}
        </Section>
      )}

      {node.kind === "pose" && goal && (
        <>
          <Section title="Target">
            <div className="mx-pair">
              <NumberField label="X position" value={goal.x} unit="m" change={(x) => setGoal({ x })} />
              <NumberField label="Y position" value={goal.y} unit="m" change={(y) => setGoal({ y })} />
            </div>
            <Field label="Heading">
              <select
                aria-label="Heading policy"
                value={goal.headingMode ?? "fixed"}
                onChange={(e) => {
                  const headingMode = e.target.value as Goal["headingMode"];
                  setGoal(
                    headingMode === "pointAt"
                      ? { headingMode, aimX: goal.aimX ?? 4.6, aimY: goal.aimY ?? 4 }
                      : { headingMode },
                  );
                }}
              >
                <option value="fixed">Hold a fixed heading</option>
                <option value="free">Any heading (translation only)</option>
                <option value="pointAt">Aim at a field point</option>
                <option value="motion">Face the direction of travel</option>
              </select>
            </Field>
            {(goal.headingMode ?? "fixed") === "fixed" && (
              <NumberField
                label="Heading angle"
                value={deg(goal.heading)}
                min={-3600}
                unit="°"
                step={5}
                change={(v) => setGoal({ heading: rad(v) })}
              />
            )}
            {goal.headingMode === "pointAt" && (
              <div className="mx-pair">
                <NumberField label="Aim X" value={goal.aimX ?? 0} unit="m" change={(aimX) => setGoal({ aimX })} />
                <NumberField label="Aim Y" value={goal.aimY ?? 0} unit="m" change={(aimY) => setGoal({ aimY })} />
              </div>
            )}
          </Section>
          <Section title="Path">
            <p className="mx-help">
              {isIntermediate(routine, node)
                ? "Pass-through anchor: the robot drives through without slowing and hands off to the next step inside the handoff circle."
                : "End of path: the robot slows to this pose and finishes once position and heading are within tolerance."}
            </p>
            <Toggle
              label="Stop here"
              checked={!!goal.stop}
              onChange={(stop) => setGoal({ stop })}
              hint="End the path at this step even if the next step is another pose. A step with a conditional exit always ends the path."
            />
            <div className="mx-pair">
              <NumberField
                label="Handoff radius"
                value={goal.handoffRadius}
                unit="m"
                step={0.05}
                change={(v) => setGoal({ handoffRadius: v })}
              />
              <NumberField
                label="Max speed"
                value={node.constraints?.maxVelocity ?? project.robot.constraints.maxVelocity}
                min={0.01}
                unit="m/s"
                change={(v) =>
                  s.editNode((n) => {
                    n.constraints = { ...n.constraints, maxVelocity: v };
                  })
                }
              />
            </div>
            <p className="mx-help">
              Handoff radius 0 uses the robot default ({project.robot.constraints.handoffRadius ?? PATH_DEFAULTS.handoffRadius} m). Max speed applies to the segment leading into this step.
            </p>
            <Toggle
              label="Hand off by progress"
              checked={goal.projectedHandoff ?? false}
              onChange={(projectedHandoff) => setGoal({ projectedHandoff })}
              hint="Off (BLine default): the robot must enter the handoff circle, so it really drives through this point. On: also move on once it is past 1 − radius ÷ segment length, which cuts corners."
            />
            {(goal.headingMode ?? "fixed") === "fixed" && (
              <Toggle
                label="Smooth rotation"
                checked={goal.profiled ?? true}
                onChange={(profiled) => setGoal({ profiled })}
                hint="Blend toward this heading by path progress. Off turns to it immediately."
              />
            )}
          </Section>
          <Section title="Arrival">
            <div className="mx-pair">
              <NumberField
                label="Position tolerance"
                value={goal.translationTolerance}
                min={0.001}
                unit="m"
                step={0.01}
                change={(v) => setGoal({ translationTolerance: v })}
              />
              <NumberField
                label="Heading tolerance"
                value={deg(goal.rotationTolerance)}
                min={0.01}
                unit="°"
                step={0.5}
                change={(v) => setGoal({ rotationTolerance: rad(v) })}
              />
            </div>
            <NumberField label="Settle time" value={goal.settleTime} unit="s" change={(v) => setGoal({ settleTime: v })} />
            <p className="mx-help">
              Used only when the path ends here. Settle time 0 finishes as soon as both tolerances are met; above 0 the robot must also be nearly still for that long.
            </p>
          </Section>
          <MarkerSection goal={goal} setGoal={setGoal} />
        </>
      )}

      {node.kind !== "finish" && (
        <Section title="Safety">
          <NumberField
            label="Failure watchdog"
            value={node.timeout}
            min={0.02}
            unit="s"
            step={1}
            change={(v) =>
              s.editNode((n) => {
                n.timeout = v;
              })
            }
          />
          <p className="mx-help">If this step runs longer, the routine fails. It never counts as success.</p>
        </Section>
      )}

      {node.kind !== "finish" && (
        <Section title="Run alongside">
          <Field label="Concurrent callbacks" hint="Comma separated. Robot code runs these while this step is active.">
            <input
              className="mx-mono-input"
              key={node.id + (node.during ?? []).join(",")}
              defaultValue={(node.during ?? []).join(", ")}
              placeholder="intake.run, shooter.spinUp"
              onBlur={(e) => {
                const during = e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean);
                if (JSON.stringify(during) !== JSON.stringify(node.during ?? []))
                  s.editNode((n) => {
                    n.during = during;
                  });
              }}
            />
          </Field>
        </Section>
      )}

      <Section title={node.kind === "finish" ? "End of routine" : "Continue when"}>
        {node.kind === "finish" && <p className="mx-help">Reaching this step completes the routine.</p>}
        {node.kind === "pose" && outgoing.length > 0 && (
          <p className="mx-help">Arrival is checked first, then these conditions in order.</p>
        )}
        {outgoing.map((t) => {
          const ok = evaluate(t.condition, s.frame.signals);
          return (
            <details className="mx-transition" key={t.id}>
              <summary>
                {ok ? <Check size={14} className="is-good" /> : <Circle size={13} />}
                <code>{conditionLabel(t.condition)}</code>
                <span className="mx-transition-to">→ {routine.nodes.find((n) => n.id === t.to)?.name}</span>
              </summary>
              <div className="mx-transition-body">
                <Field label="Next step">
                  <select
                    aria-label="Transition destination"
                    value={t.to}
                    onChange={(e) =>
                      s.editRoutine((r) => {
                        r.transitions.find((edge) => edge.id === t.id)!.to = e.target.value;
                      })
                    }
                  >
                    {routine.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <ConditionEditor
                  condition={t.condition}
                  signals={project.signals}
                  change={(condition) =>
                    s.editRoutine((r) => {
                      r.transitions.find((edge) => edge.id === t.id)!.condition = condition;
                    })
                  }
                />
                {outgoing.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    onClick={() =>
                      s.editRoutine((r) => {
                        r.transitions = r.transitions.filter((edge) => edge.id !== t.id);
                      })
                    }
                  >
                    Remove branch
                  </Button>
                )}
              </div>
            </details>
          );
        })}
        {node.kind !== "finish" && (
          <Button
            size="sm"
            icon={Plus}
            onClick={() =>
              s.editRoutine((r) => {
                r.transitions.push({
                  id: `branch-${crypto.randomUUID().slice(0, 8)}`,
                  from: node.id,
                  to: r.nodes.find((n) => n.id !== node.id)!.id,
                  condition: project.signals.length
                    ? {
                        kind: "signal",
                        key: project.signals[0].key,
                        op: "eq",
                        value: project.signals[0].initial,
                      }
                    : { kind: "always" },
                });
              })
            }
          >
            Add branch
          </Button>
        )}
      </Section>
    </>
  );
}
