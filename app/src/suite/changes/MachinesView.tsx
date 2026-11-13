import { useState } from "react";
import { GitBranch } from "lucide-react";
import { machineGraph } from "../core/machines.ts";
import type { MachineDiff } from "../core/review/machines.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { StateGraph } from "../states/StateGraph";
import { Badge, EmptyState, type Tone } from "../ui";

const TONE: Record<string, Tone> = { added: "good", removed: "bad", changed: "warn", same: "neutral" };

function ChangeList({ m }: { m: MachineDiff }) {
  const stateName = (id: string) => (id === "*" ? "Any state" : m.merged?.states.find((s) => s.id === id)?.name ?? id);
  return (
    <ul className="mx-change-list">
      {m.states.map((s) => (
        <li key={`s:${s.id}`} className={`is-${s.kind}`}>
          <Badge tone={TONE[s.kind]}>{s.kind}</Badge> State <strong>{s.name}</strong>
          {s.fields.length ? ` (${s.fields.join(", ")})` : ""}
        </li>
      ))}
      {m.transitions.map((t) => (
        <li key={`t:${t.key}`} className={`is-${t.kind}`}>
          <Badge tone={TONE[t.kind]}>{t.kind}</Badge>
          {t.driver && <Badge tone="bad">driver control</Badge>} {stateName(t.from)} → <strong>{stateName(t.to)}</strong>
          <div className="mx-before-after">
            {t.before !== undefined && t.before !== t.after && <s>when {t.before}</s>} {t.after !== undefined && <span>when {t.after}</span>}
            {t.priority && (
              <small>
                {" "}
                · checked {t.priority.after < t.priority.before ? "earlier" : "later"} (#{t.priority.before + 1} → #{t.priority.after + 1})
              </small>
            )}
          </div>
        </li>
      ))}
      {m.inputs.map((i) => (
        <li key={`i:${i.key}`} className={`is-${i.kind}`}>
          <Badge tone={TONE[i.kind]}>{i.kind}</Badge>
          {i.category === "operator" && <Badge tone="bad">driver control</Badge>} Input <strong>{i.after ?? i.before}</strong>
          {i.kind === "changed" && i.before !== i.after && <span className="mx-before-after"> (was “{i.before}”)</span>}
        </li>
      ))}
    </ul>
  );
}

export function MachinesView({ report }: { report: ReviewReport }) {
  const machines = report.machines;
  const [picked, setPicked] = useState(() => (machines.find((m) => m.kind !== "same") ?? machines[0])?.id);
  const [state, setState] = useState("");
  const m = machines.find((x) => x.id === picked);
  if (!machines.length)
    return (
      <EmptyState icon={GitBranch} title="No state machines">
        This repo has no <code>tools/mayhem/machines.json</code> in either version.
      </EmptyState>
    );
  return (
    <div className="mx-machines-diff">
      <nav className="mx-rail" aria-label="Machines">
        {machines.map((x) => (
          <button key={x.id} type="button" className={x.id === picked ? "is-active" : ""} onClick={() => setPicked(x.id)}>
            <span>{x.name}</span>
            {x.kind !== "same" && <Badge tone={x.controls ? "bad" : TONE[x.kind]}>{x.controls ? "controls" : x.kind}</Badge>}
          </button>
        ))}
      </nav>
      {m && (
        <div className="mx-machine-diff-main">
          <div className="mx-legend" aria-label="Legend">
            <span className="is-added">Added</span>
            <span className="is-changed">Changed</span>
            <span className="is-removed">Removed</span>
          </div>
          {m.merged && (
            <div className="mx-diff-graph">
              <StateGraph
                key={m.id}
                graph={machineGraph(m.merged)}
                machine
                inputs={m.merged.inputs}
                signalLabel={(key) => m.merged!.inputs.find((i) => i.key === key)?.name ?? key}
                signals={{}}
                selected={state}
                active=""
                select={setState}
                marks={m.marks}
              />
            </div>
          )}
          {m.kind === "same" ? <p className="mx-help">No changes to this machine.</p> : <ChangeList m={m} />}
        </div>
      )}
    </div>
  );
}
