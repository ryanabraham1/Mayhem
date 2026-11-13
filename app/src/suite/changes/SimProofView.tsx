import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, FlaskConical, Pause, Play, TriangleAlert } from "lucide-react";
import { FieldArt } from "../../components/FieldArt";
import type { Field as FieldModel } from "../../types";
import field from "../core/rebuilt-2026.json";
import type { ReviewReport } from "../core/review/report.ts";
import type { Outcome, Track } from "../core/review/scenarios.ts";
import { parseMachineSpecs } from "../core/review/machines.ts";
import { MACHINES_FILE } from "../core/review/report.ts";
import { ButtonMap } from "./ButtonMap";
import type { ScenarioResult, SimProof } from "../core/review/simproof.ts";
import { desktop } from "../native";
import { Badge, Button, EmptyState, Segmented } from "../ui";
import type { Review } from "./useReview";

const COLORS = ["#6a3df0", "#0e9670", "#b86e00", "#d33452", "#2f80ed", "#8e44ad", "#16a085", "#c0392b"];
const color = (value: string) => COLORS[[...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];

/** One row of colored segments per value over the scenario's time. */
function Timeline({ track, duration, time }: { track?: Track; duration: number; time: number }) {
  if (!track) return <div className="mx-timeline is-empty">not logged</div>;
  return (
    <div className="mx-timeline">
      {track.changes.map((c, i) => {
        const end = track.changes[i + 1]?.time ?? duration;
        return (
          <span
            key={i}
            style={{ left: `${(Math.max(0, c.time) / duration) * 100}%`, width: `${(Math.max(0, end - Math.max(0, c.time)) / duration) * 100}%`, background: color(c.value) }}
            title={`${c.value} from ${c.time.toFixed(2)} s`}
          >
            {c.value}
          </span>
        );
      })}
      <i style={{ left: `${(time / duration) * 100}%` }} />
    </div>
  );
}

const poseAt = (o: Outcome | undefined, t: number) => o?.poses.reduce<Outcome["poses"][number] | undefined>((best, p) => (p.time <= t + 1e-6 ? p : best), o.poses[0]);

/** Before and after robots on the field, with a shared clock, and each machine's states below. */
export function Replay({ result, onTime }: { result: ScenarioResult; onTime?: (t: number) => void }) {
  const duration = Math.max(result.before?.duration ?? 0, result.after?.duration ?? 0, 0.1);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((t) => {
        const next = t + (now - last) / 1000;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      last = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, duration]);
  useEffect(() => onTime?.(time), [time, onTime]);
  const names = [...new Set([...(result.before?.tracks ?? []), ...(result.after?.tracks ?? [])].map((t) => t.name))];
  const hasPath = !!(result.before?.poses.length || result.after?.poses.length);
  const robot = (o: Outcome | undefined, className: string) => {
    const p = poseAt(o, time);
    return p ? (
      <g className={`mx-overlay-robot ${className}`} transform={`translate(${p.x},${field.width - p.y}) rotate(${(-p.heading * 180) / Math.PI})`}>
        <rect x="-.42" y="-.42" width=".84" height=".84" rx=".06" />
        <path d="M-.12,-.17 L.15,0 L-.12,.17" fill="none" />
      </g>
    ) : null;
  };
  const line = (o?: Outcome) => o?.poses.map((p) => `${p.x.toFixed(3)},${(field.width - p.y).toFixed(3)}`).join(" ");
  return (
    <div className="mx-replay-proof">
      {hasPath && (
        <svg className="mx-replay-field mx-auto-overlay" viewBox={`-.3 -.3 ${field.length + 0.6} ${field.width + 0.6}`} aria-label="Before and after replay">
          <g aria-hidden="true" transform={`translate(0 ${field.width}) scale(1 -1)`}>
            <FieldArt field={field as FieldModel} hideFuel />
          </g>
          {result.before && <polyline className="is-before" points={line(result.before)} />}
          {result.after && <polyline className="is-after" points={line(result.after)} />}
          {robot(result.before, "is-before")}
          {robot(result.after, "is-after")}
        </svg>
      )}
      <div className="mx-replay-controls">
        <Button size="sm" icon={playing ? Pause : Play} onClick={() => (time >= duration ? (setTime(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? "Pause" : "Play"}
        </Button>
        <input type="range" min={0} max={duration} step={0.02} value={time} onChange={(e) => (setPlaying(false), setTime(Number(e.target.value)))} aria-label="Replay time" />
        <span className="mx-mono">{time.toFixed(2)} s</span>
      </div>
      <div className="mx-timelines">
        {names.map((name) => (
          <div key={name} className="mx-timeline-row">
            <strong>{name}</strong>
            {result.before && (
              <>
                <small>Before</small>
                <Timeline track={result.before.tracks.find((t) => t.name === name)} duration={duration} time={time} />
              </>
            )}
            <small>After</small>
            <Timeline track={result.after?.tracks.find((t) => t.name === name)} duration={duration} time={time} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Status({ r }: { r: ScenarioResult }) {
  if (r.failed) return <Badge tone="bad">{r.error ? "crashed" : "fails"}</Badge>;
  if (r.differences.length) return <Badge tone="warn">behaves differently</Badge>;
  return <Badge tone="good">same</Badge>;
}

export function SimProofView({ report, review }: { report: ReviewReport; review: Review }) {
  const proof: SimProof | undefined = review.sim.proof;
  const [group, setGroup] = useState<"custom" | "auto" | "button">("auto");
  const [picked, setPicked] = useState<string>();
  const results = useMemo(() => proof?.results.filter((r) => r.scenario.group === group) ?? [], [proof, group]);
  const selected = results.find((r) => r.scenario.id === picked) ?? results.find((r) => r.failed || r.differences.length) ?? results[0];
  const staticAutos = new Map(report.routines.map((r) => [r.id, r.kind]));
  const running = review.sim.progress !== undefined;
  const machines = useMemo(() => parseMachineSpecs(review.snapshots?.after.files[MACHINES_FILE]).machines, [review.snapshots]);

  return (
    <div className="mx-simproof">
      <div className="mx-panel mx-sim-head">
        <div>
          <strong>Sim proof</strong>
          <p className="mx-help">
            Builds both versions with the robot's own simulation and runs every auto, every controller button (tapped and held) and the team's scenarios in{" "}
            <code>tools/mayhem/scenarios.json</code>. About a minute per version the first time; repeat runs are cached.
          </p>
        </div>
        {desktop ? (
          <Button variant="primary" icon={FlaskConical} disabled={running || !review.snapshots} onClick={() => void review.sim.start()}>
            {running ? "Running…" : proof ? "Run again" : "Run sim proof"}
          </Button>
        ) : (
          <span className="mx-help">Runs in the desktop app (or <code>mayhem.mjs sim</code>).</span>
        )}
      </div>
      {review.sim.progress && (
        <div className="mx-progress" role="status">
          <span>{review.sim.progress.text}</span>
          <progress max={review.sim.progress.total || 1} value={review.sim.progress.done} />
        </div>
      )}
      {review.sim.error && (
        <div className="mx-callout is-bad" role="alert">
          <TriangleAlert size={16} />
          <pre>{review.sim.error}</pre>
        </div>
      )}
      {review.sim.errors.map((e) => (
        <p key={e} className="mx-help is-bad">
          {e}
        </p>
      ))}
      {!proof && !running && !review.sim.error && (
        <EmptyState icon={FlaskConical} title="Not run yet">
          Run the sim proof to see whether every auto still finishes, every button still does the same thing, and the team's scenarios pass.
        </EmptyState>
      )}
      {proof && (
        <>
          <div className={`mx-risk ${proof.passed ? (proof.changed ? "is-yellow" : "is-green") : "is-red"}`}>
            {proof.passed ? <CircleCheck size={22} /> : <CircleX size={22} />}
            <div>
              <strong>
                {proof.passed ? "Every scenario passes" : `${proof.results.filter((r) => r.failed).length} scenario(s) fail`}
                {proof.changed ? ` · ${proof.changed} behave differently` : review.before ? " · same behavior as before" : ""}
              </strong>
              <span>
                {proof.results.length} scenarios on {report.after.label}
              </span>
            </div>
          </div>
          <Segmented
            label="Scenario groups"
            value={group}
            onChange={(g) => {
              setGroup(g);
              setPicked(undefined);
            }}
            options={(["auto", "button", "custom"] as const).map((g) => {
              const list = proof.results.filter((r) => r.scenario.group === g);
              const bad = list.filter((r) => r.failed || r.differences.length).length;
              return { value: g, label: `${{ auto: "Autos", button: "Buttons", custom: "Team scenarios" }[g]} (${bad ? `${bad} of ` : ""}${list.length})` };
            })}
          />
          {group === "button" ? (
            <ButtonMap results={results} machines={machines} />
          ) : results.length === 0 ? (
            <EmptyState icon={FlaskConical} title={group === "custom" ? "No team scenarios yet" : "No autos"}>
              {group === "custom" ? 'Add scenarios to tools/mayhem/scenarios.json, e.g. { "scenarios": [{ "name": "Hold A shoots", "steps": ["teleop", "wait 0.5", "hold A 2"], "expect": ["Shooter mode is SHOOTING by 1.5 s"] }] }' : "No routines in the project file."}
            </EmptyState>
          ) : (
            <div className="mx-autos-diff">
              <nav className="mx-rail" aria-label="Scenarios">
                {results.map((r) => (
                  <button key={r.scenario.id} type="button" className={r === selected ? "is-active" : ""} onClick={() => setPicked(r.scenario.id)}>
                    <span>{r.scenario.name.replace(/^Auto: /, "")}</span>
                    <Status r={r} />
                  </button>
                ))}
              </nav>
              {selected && (
                <div className="mx-autos-main">
                  {selected.scenario.routine && staticAutos.get(selected.scenario.routine) === "changed" && !selected.differences.length && selected.before && (
                    <div className="mx-callout is-warn">
                      <TriangleAlert size={16} />
                      <span>
                        The project file changes this auto, but the robot drives it exactly as before. The generated robot code (MayhemProject.h) was probably not
                        regenerated: run <code>tools/mayhem/export.sh</code>.
                      </span>
                    </div>
                  )}
                  {selected.checks.length > 0 && (
                    <ul className="mx-change-list">
                      {selected.checks.map((c) => (
                        <li key={c.text} className={c.pass ? "" : "is-removed"}>
                          <Badge tone={c.pass ? "good" : "bad"}>{c.pass ? "pass" : "fail"}</Badge> {c.text} <span className="mx-before-after">· {c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.differences.length > 0 && (
                    <ul className="mx-change-list">
                      {selected.differences.map((d) => (
                        <li key={d} className="is-changed">
                          <Badge tone="warn">different</Badge> {d}
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.error && <pre className="mx-help is-bad">{selected.error}</pre>}
                  {selected.after?.physics?.hits?.length ? (
                    <p className="mx-help is-bad">Collisions: {selected.after.physics.hits.join("; ")}</p>
                  ) : null}
                  {(selected.before || selected.after) && <Replay key={selected.scenario.id} result={selected} />}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
