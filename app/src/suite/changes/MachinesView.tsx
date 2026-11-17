import { useState } from "react";
import { FlaskConical, GitBranch } from "lucide-react";
import { machineGraph } from "../core/machines.ts";
import type { MachineDiff } from "../core/review/machines.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { StateGraph } from "../states/StateGraph";
import { machineDifferences } from "../core/review/scenarios.ts";
import type { SimProof } from "../core/review/simproof.ts";
import { Badge, Button, EmptyState, type Tone } from "../ui";

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

/** What the sim proof saw this machine do differently, scenario by scenario. */
function Behavior({ m, proof, running, run, open }: { m: MachineDiff; proof?: SimProof; running?: boolean; run?: () => void; open: (scenario: string) => void }) {
  if (!proof)
    return (
      <div className="mx-machine-behavior">
        <strong>Behavior</strong>
        <p className="mx-help">
          {m.kind === "same" ? "This machine's graph didn't change, but other code can still change what it does." : "The graph above is what the code says."} Run the sim proof to see what
          the machine actually does differently, button by button and auto by auto.
        </p>
        {run && (
          <Button size="sm" icon={FlaskConical} disabled={running} onClick={run}>
            {running ? "Running…" : "Run sim proof"}
          </Button>
        )}
      </div>
    );
  const found = machineDifferences(proof.results, m.name);
  return (
    <div className="mx-machine-behavior">
      <strong>Behavior in the sim proof</strong>
      {found.length ? (
        <ul>
          {found.map((d) => (
            <li key={`${d.scenario.id}:${d.text}`}>
              <button type="button" className="mx-link" onClick={() => open(d.scenario.id)}>
                {d.scenario.name.replace(/^Auto: /, "Auto ")}
              </button>
              <span>{d.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mx-help">
          Same in all {proof.results.length} scenarios: every button, every auto and the team's scenarios move {m.name} through the same states at the same times as before.
        </p>
      )}
    </div>
  );
}

export function MachinesView({
  report,
  proof,
  running,
  run,
  openScenario,
}: {
  report: ReviewReport;
  proof?: SimProof;
  running?: boolean;
  run?: () => void;
  openScenario: (id: string) => void;
}) {
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
            {x.kind !== "same" ? (
              <Badge tone={x.controls ? "bad" : TONE[x.kind]}>{x.controls ? "controls" : x.kind}</Badge>
            ) : proof && machineDifferences(proof.results, x.name).length ? (
              <Badge tone="warn">acts differently</Badge>
            ) : null}
          </button>
        ))}
      </nav>
      {m && (
        <div className="mx-machine-diff-main">
          <Behavior m={m} proof={proof} running={running} run={run} open={openScenario} />
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
          {m.kind === "same" ? <p className="mx-help">No changes to this machine's graph.</p> : <ChangeList m={m} />}
        </div>
      )}
    </div>
  );
}
