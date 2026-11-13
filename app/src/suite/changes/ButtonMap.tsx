import type { MachineManifest } from "../core/machines.ts";
import type { Outcome, Track } from "../core/review/scenarios.ts";
import type { ScenarioResult } from "../core/review/simproof.ts";
import { Badge } from "../ui";

/** The probe presses at 1 s; a hold lasts 2 s. Lanes show 0.5 s before the press to the end. */
const PRESS = 1;
const FROM = 0.5;

/** Driver input names start with the button: "A held (shoot)", "Left trigger held (outtake)". */
const SPOKEN: [RegExp, string][] = [
  [/^left trigger/i, "LT"],
  [/^right trigger/i, "RT"],
  [/^left bumper/i, "LB"],
  [/^right bumper/i, "RB"],
  [/^(d-?pad|pov) up/i, "Up"],
  [/^(d-?pad|pov) down/i, "Down"],
  [/^(d-?pad|pov) left/i, "Left"],
  [/^(d-?pad|pov) right/i, "Right"],
  [/^([ABXY])\b/, "$1"],
];
function purposes(machines: MachineManifest[]) {
  const out = new Map<string, string[]>();
  for (const m of machines)
    for (const i of m.inputs)
      if (i.category === "operator")
        for (const [re, button] of SPOKEN) {
          const hit = re.exec(i.name);
          if (!hit) continue;
          const key = button.replace("$1", hit[1] ?? "");
          const what = /\(([^)]+)\)/.exec(i.name)?.[1] ?? i.name;
          out.set(key, [...new Set([...(out.get(key) ?? []), what])]);
          break;
        }
  return out;
}

const FACE: Record<string, string> = { A: "is-a", B: "is-b", X: "is-x", Y: "is-y" };
const IDLE = /^(OFF|STOWED|PARKED|IDLE|NORMAL|NONE|DISABLED)$/i;
const PALETTE = ["#6a3df0", "#0e9670", "#d97706", "#d33452", "#2f80ed", "#9b51e0", "#0f9db5", "#c2410c"];
const colorOf = (value: string) => (IDLE.test(value) ? "" : PALETTE[[...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length]);

function Lane({ track, end, label, faded, nameOf, press }: { track?: Track; end: number; label: string; faded?: boolean; nameOf: (v: string) => string; press: number }) {
  const span = end - FROM;
  const pct = (t: number) => `${((Math.min(end, Math.max(FROM, t)) - FROM) / span) * 100}%`;
  return (
    <div className={`mx-lane ${faded ? "is-before" : ""}`}>
      <small>{label}</small>
      <div className="mx-lane-bar">
        <i className="mx-lane-press" style={{ left: pct(PRESS), width: `calc(${pct(PRESS + press)} - ${pct(PRESS)})` }} aria-hidden="true" />
        {(track?.changes ?? []).map((c, i, all) => {
          const stop = all[i + 1]?.time ?? end;
          if (stop <= FROM) return null;
          const color = colorOf(c.value);
          return (
            <span
              key={i}
              className={color ? "" : "is-idle"}
              style={{ left: pct(c.time), width: `calc(${pct(stop)} - ${pct(c.time)})`, ...(color ? { background: color } : {}) }}
              title={`${nameOf(c.value)} from ${c.time.toFixed(2)} s`}
            >
              {nameOf(c.value)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** One kind of press (tap or hold) for one button: a lane per machine it affects. */
function Press({ result, kind, names, nameOf }: { result?: ScenarioResult; kind: "tap" | "hold"; names: string[]; nameOf: (v: string) => string }) {
  if (!result) return null;
  const end = Math.max(result.before?.duration ?? 0, result.after?.duration ?? 0, 3.5);
  const changed = result.differences.length > 0;
  const track = (o: Outcome | undefined, name: string) => o?.tracks.find((t) => t.name === name);
  return (
    <div className={`mx-press ${changed ? "is-changed" : ""}`}>
      <div className="mx-press-head">
        <strong>{kind === "tap" ? "Tap" : "Hold 2 s"}</strong>
        {changed ? <Badge tone="bad">changed</Badge> : result.before ? <Badge tone="good">same</Badge> : null}
      </div>
      <div className="mx-press-lanes">
        {names.map((name) => (
          <div key={name} className="mx-lane-group">
            <span className="mx-lane-name">{name}</span>
            {changed && result.before && <Lane track={track(result.before, name)} end={end} label="Before" faded nameOf={nameOf} press={kind === "tap" ? 0.06 : 2} />}
            <Lane track={track(result.after, name)} end={end} label={changed && result.before ? "After" : ""} nameOf={nameOf} press={kind === "tap" ? 0.06 : 2} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every controller button as pictures: what each part of the robot does over time when it is tapped or held. */
export function ButtonMap({ results, machines }: { results: ScenarioResult[]; machines: MachineManifest[] }) {
  const stateNames = new Map(machines.flatMap((m) => m.states.map((s) => [s.id, s.name] as const)));
  const nameOf = (v: string) => stateNames.get(v) ?? v.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const what = purposes(machines);
  const buttons = [...new Set(results.map((r) => r.scenario.id.replace(/^(tap|hold)-/, "")))];
  const rows = buttons.map((button) => {
    const tap = results.find((r) => r.scenario.id === `tap-${button}`);
    const hold = results.find((r) => r.scenario.id === `hold-${button}`);
    // Machines that do something after the press, in either version (not the auto's own state).
    const names = [
      ...new Set(
        [tap, hold].flatMap((r) =>
          [r?.before, r?.after].flatMap((o) => o?.tracks.filter((t) => !/^Auto|^Autonomous$/.test(t.name) && t.changes.some((c) => c.time >= PRESS - 0.05)).map((t) => t.name) ?? []),
        ),
      ),
    ];
    const changed = [tap, hold].some((r) => r?.differences.length);
    return { button, tap, hold, names, changed, failed: [tap, hold].some((r) => r?.error) };
  });
  const active = rows.filter((r) => r.names.length || r.changed || r.failed).sort((a, b) => Number(b.changed) - Number(a.changed));
  const idle = rows.filter((r) => !active.includes(r));
  return (
    <div className="mx-press-map">
      {active.map((r) => (
        <section key={r.button} className={`mx-button-card ${r.changed ? "is-changed" : ""}`}>
          <header>
            <span className={`mx-pad-button ${FACE[r.button] ?? ""}`}>{r.button}</span>
            <div>
              <strong>{what.get(r.button)?.join(" · ") ?? "Not listed as a driver input"}</strong>
              {r.changed && <small className="mx-loud-text">Does something different than before</small>}
              {r.failed && <small className="mx-loud-text">The simulation stopped early</small>}
            </div>
          </header>
          <div className="mx-press-pair">
            <Press result={r.tap} kind="tap" names={r.names} nameOf={nameOf} />
            <Press result={r.hold} kind="hold" names={r.names} nameOf={nameOf} />
          </div>
        </section>
      ))}
      {idle.length > 0 && (
        <p className="mx-help">
          No effect when pressed: {idle.map((r) => <span key={r.button} className="mx-pad-button is-small">{r.button}</span>)}
        </p>
      )}
      <p className="mx-help">Shaded: when the button is down. Gray: idle (off, stowed, parked). Hover a bar for the exact time.</p>
    </div>
  );
}
