import { ArrowDown, ArrowRight, Circle } from "lucide-react";
import { ANY_STATE, checkedIn, evaluate, type Signals } from "../core/model.ts";
import type { MachineManifest } from "../core/machines.ts";
import { PlainCondition, plainText, type InputInfo } from "./PlainCondition";

/**
 * A priority-select machine (`selection: "priority"`) as a decision ladder: questions checked
 * from the top every loop, each "yes" pointing at the state it picks, each "no" falling to the
 * next question. The current state and the row deciding it right now are highlighted.
 */
export function PriorityLadder({
  machine,
  signals,
  active,
  selected,
  select,
  info,
  live,
}: {
  machine: MachineManifest;
  signals: Signals;
  active: string;
  selected: string;
  select: (state: string) => void;
  info: InputInfo;
  /** What the highlighted values come from ("simulated", "live", "recorded"). */
  live: string;
}) {
  const stateName = (id: string) => machine.states.find((s) => s.id === id)?.name ?? id;
  const rows = machine.transitions;
  const deciding = rows.findIndex((t) => checkedIn(t, active, true) && evaluate(t.condition, signals));
  const unreached = machine.states.filter((s) => !rows.some((t) => t.to === s.id));
  return (
    <section className="mx-decision" aria-label="Decision ladder">
      <p className="mx-decision-intro">
        Every loop the robot asks these questions from the top. The first <strong>yes</strong> picks the state;
        if that is the state it is already in, it stays there.
        {deciding >= 0 && (
          <span className="mx-decision-now" role="status">
            {" "}
            Now ({live}): question {deciding + 1} → <strong>{stateName(rows[deciding].to)}</strong>
          </span>
        )}
      </p>
      <ol className="mx-decision-rows">
        {rows.map((t, i) => {
          const always = t.condition.kind === "always";
          const only = t.from !== ANY_STATE ? `Only asked in ${stateName(t.from)}.` : "";
          const except = t.except?.length ? `Not asked in ${t.except.map(stateName).join(", ")}.` : "";
          const question = always ? "Otherwise" : plainText(t.condition, info);
          return (
            <li
              key={t.id}
              className={`mx-decision-row ${i === deciding ? "is-deciding" : ""} ${t.to === active ? "is-current" : ""}`}
              aria-current={i === deciding ? "step" : undefined}
            >
              <span className="mx-decision-step">{i + 1}</span>
              <div className="mx-decision-question" title={[question, t.description].filter(Boolean).join("\n")}>
                {always ? <strong>Otherwise</strong> : <PlainCondition condition={t.condition} info={info} />}
                {!always && "?"}
                {(t.description || only || except) && (
                  <small>{[t.description, only, except].filter(Boolean).join(" ")}</small>
                )}
              </div>
              <span className="mx-decision-yes" aria-hidden="true">
                {always ? "" : "yes"}
                <ArrowRight size={15} />
              </span>
              <button
                type="button"
                className={`mx-decision-state ${t.to === selected ? "is-selected" : ""} ${t.to === active ? "is-active" : ""}`}
                onClick={() => select(t.to)}
                aria-label={`${stateName(t.to)}${t.to === active ? " (current state)" : ""}`}
              >
                <Circle size={10} aria-hidden="true" />
                {stateName(t.to)}
              </button>
              {i < rows.length - 1 && (
                <span className="mx-decision-no" aria-hidden="true">
                  <ArrowDown size={13} /> no
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {unreached.length > 0 && (
        <p className="mx-help">
          Not picked by any question: {unreached.map((s) => s.name).join(", ")}.
        </p>
      )}
    </section>
  );
}
