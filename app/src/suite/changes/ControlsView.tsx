import { Gamepad2, ShieldAlert } from "lucide-react";
import { formatCondition } from "../core/authoring.ts";
import type { MachineDiff } from "../core/review/machines.ts";
import type { ReviewReport } from "../core/review/report.ts";
import { Badge, EmptyState, type Tone } from "../ui";

const TONE: Record<string, Tone> = { added: "good", removed: "bad", changed: "warn" };

/** Every driver input of every machine, with the transitions it takes part in (before and after). */
function buttonMap(m: MachineDiff) {
  if (!m.merged) return [];
  const names = new Map(m.merged.inputs.map((i) => [i.key, i.name]));
  const plain = (text: string) =>
    text
      .replace(/[A-Za-z_]\w*/g, (k) => (names.has(k) ? `“${names.get(k)}”` : k))
      .replace(/&&/g, "and")
      .replace(/\|\|/g, "or")
      .replace(/!(?=[“(])/g, "not ");
  const stateName = (id: string) => (id === "*" ? "any state" : m.merged!.states.find((s) => s.id === id)?.name ?? id);
  return m.merged.inputs
    .filter((i) => i.category === "operator")
    .map((input) => {
      const inputChange = m.inputs.find((c) => c.key === input.key);
      const uses = m.merged!.transitions
        .filter((t) => JSON.stringify(t.condition).includes(`"key":"${input.key}"`))
        .map((t) => {
          const mark = m.marks.edges[t.id];
          const change = m.transitions.find((c) => c.kind === mark && c.from === t.from && c.to === t.to);
          return {
            id: t.id,
            mark,
            text: `From ${stateName(t.from)} → ${stateName(t.to)} when ${plain(formatCondition(t.condition))}`,
            before: mark === "changed" && change?.before ? plain(change.before) : undefined,
          };
        });
      return { input, inputChange, uses, changed: !!inputChange || uses.some((u) => u.mark) };
    });
}

export function ControlsView({ report }: { report: ReviewReport }) {
  const maps = report.machines.map((m) => ({ m, rows: buttonMap(m) })).filter((x) => x.rows.length);
  const changed = maps.some((x) => x.rows.some((r) => r.changed));
  if (!maps.length)
    return (
      <EmptyState icon={Gamepad2} title="No driver inputs declared">
        Driver buttons appear here when a machine in <code>tools/mayhem/machines.json</code> lists them as <code>operator</code> inputs.
      </EmptyState>
    );
  return (
    <div className="mx-controls-view">
      {changed ? (
        <div className="mx-callout is-bad mx-loud" role="alert">
          <ShieldAlert size={18} />
          <span>
            <strong>Driver controls changed.</strong> Team rule: the same driver inputs must give the same outcomes. Check every
            highlighted row with the drive team before this goes on the robot.
          </span>
        </div>
      ) : (
        <p className="mx-help">No driver-control changes in the state machines.</p>
      )}
      {maps.map(({ m, rows }) => (
        <section key={m.id} className="mx-panel is-flush">
          <header className="mx-panel-head">
            <h2>{m.name}</h2>
          </header>
          <table className="mx-review-table mx-button-map">
            <thead>
              <tr>
                <th>Driver input</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ input, inputChange, uses, changed }) => (
                <tr key={input.key} className={changed ? "is-changed" : ""}>
                  <th scope="row">
                    {input.name}
                    {inputChange && <Badge tone={TONE[inputChange.kind]}>{inputChange.kind}</Badge>}
                    {inputChange?.kind === "changed" && <small>was “{inputChange.before}”</small>}
                  </th>
                  <td>
                    <ul className="mx-change-list">
                      {uses.map((u) => (
                        <li key={u.id} className={u.mark ? `is-${u.mark}` : ""}>
                          {u.mark && <Badge tone={TONE[u.mark]}>{u.mark}</Badge>} {u.text}
                          {u.before && <div className="mx-before-after"><s>was: when {u.before}</s></div>}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <p className="mx-help">
        From the state machines in <code>tools/mayhem/machines.json</code>. Pressing every button in simulation and comparing what the
        robot does comes with sim proof.
      </p>
    </div>
  );
}
