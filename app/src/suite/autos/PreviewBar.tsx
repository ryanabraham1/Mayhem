import { useState } from "react";
import {
  ArrowDownToLine,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { PreviewInputs } from "../PreviewInputs";
import { download } from "../storage";
import type { SuiteState } from "../useSuiteProject";
import type { AutoRoutine } from "../core/model.ts";
import type { TraceEvent } from "../core/runtime.ts";
import { Badge, Dot, IconButton, Toggle } from "../ui";

type MarkerKind = "pose" | "action" | "event" | "finish" | "failure";
const MARKER_COLORS: Record<MarkerKind, string> = {
  pose: "var(--mx-accent, #6d4aff)",
  action: "#e08a00",
  event: "#0e9f8f",
  finish: "#22a35a",
  failure: "#d93a3a",
};
/** Step entries, actions, path event triggers, and failure on the forecast timeline. */
function timelineMarkers(routine: AutoRoutine, events: TraceEvent[]) {
  const markers: { time: number; kind: MarkerKind; label: string; node?: string }[] = [];
  for (const e of events) {
    if (e.kind === "transition") {
      const t = routine.transitions.find((t) => t.id === e.transition);
      const to = routine.nodes.find((n) => n.id === t?.to);
      if (!to) continue;
      const kind: MarkerKind =
        to.kind === "finish" ? "finish" : to.kind === "pose" ? "pose" : "action";
      markers.push({
        time: e.time,
        kind,
        node: to.id,
        label: kind === "action" ? `Action: ${to.name}${to.action ? ` (${to.action})` : ""}` : to.name,
      });
    } else if (e.kind === "event") markers.push({ time: e.time, kind: "event", label: e.message, node: e.node });
    else if (e.kind === "failure") markers.push({ time: e.time, kind: "failure", label: e.message, node: e.node });
  }
  return markers;
}

export function PreviewBar({ s }: { s: SuiteState }) {
  const [open, setOpen] = useState(false);
  const { frame, routine, frames, previewMode, latest } = s;
  const activeNode = routine.nodes.find((n) => n.id === frame.node);
  const waitingAction =
    previewMode === "routine" &&
    activeNode?.action &&
    frame.actions[activeNode.action] !== "succeeded";
  const status =
    frame.status === "failed"
      ? (frame.events.at(-1)?.message ?? "Preview failed")
      : frame.status === "completed"
        ? "Preview completed"
        : waitingAction
          ? `Waiting for ${activeNode!.action} to succeed`
          : previewMode === "routine" && frame.reached
            ? `Waiting for a condition on ${activeNode?.name}`
            : `${s.playing ? "Running" : frame.time > 0 ? "Paused" : "Ready"} · ${activeNode?.name}`;
  const { forecast } = s;
  const runEnd = forecast.frame.time;
  const total = Math.max(0.02, runEnd, latest.time);
  const estimate =
    forecast.status === "completed"
      ? { label: `${runEnd.toFixed(1)} s`, title: `Estimated routine time: ${runEnd.toFixed(2)} s` }
      : forecast.status === "failed"
        ? { label: `fails ${runEnd.toFixed(1)} s`, title: forecast.frame.events.at(-1)?.message ?? "Preview fails" }
        : {
            label: `${runEnd.toFixed(0)}+ s`,
            title: `Still running after ${runEnd.toFixed(0)} s, usually waiting on an input or action. Set them under Inputs & events.`,
          };
  const markers = timelineMarkers(routine, forecast.frame.events);
  const tone =
    frame.status === "failed" ? "bad" : frame.status === "completed" ? "good" : s.playing ? "accent" : "neutral";
  return (
    <section className={`mx-dock ${open ? "is-open" : ""}`} aria-label="Preview">
      <span className="mx-dock-status" role="status">
        <Dot tone={tone} />
        {status}
      </span>
      <div className="mx-dock-bar">
        <IconButton label="Reset preview" icon={RotateCcw} onClick={s.resetPreview} />
        <button
          className="mx-play"
          aria-label={s.playing ? "Pause simulation" : "Play simulation"}
          onClick={s.togglePlay}
        >
          {s.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <code className="mx-clock" title={estimate.title}>
          {frame.time.toFixed(2)}
          <small> / {estimate.label}</small>
        </code>
        <div className="mx-timeline" style={{ position: "relative", flex: 1, minWidth: 80, display: "flex", alignItems: "center" }}>
          <input
            className="mx-range"
            aria-label="Preview time"
            type="range"
            min="0"
            max={total}
            step="0.02"
            value={Math.min(frame.time, total)}
            style={{ width: "100%", margin: 0 }}
            onChange={(e) => s.seek(Number(e.target.value))}
          />
          {markers.map((m, i) => {
            const pct = Math.min(1, Math.max(0, m.time / total));
            return (
              <button
                key={i}
                type="button"
                className="mx-timeline-marker"
                aria-label={`${m.label} at ${m.time.toFixed(2)} s`}
                title={`${m.time.toFixed(2)} s · ${m.label}`}
                onClick={() => {
                  s.seek(m.time);
                  if (m.node) s.setSelected(m.node);
                }}
                style={{
                  position: "absolute",
                  left: `calc(${pct * 100}% + ${(0.5 - pct) * 16}px)`,
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: m.kind === "action" ? 12 : 8,
                  height: m.kind === "action" ? 12 : 8,
                  zIndex: m.kind === "action" || m.kind === "failure" ? 2 : 1,
                  padding: 0,
                  border: "1.5px solid var(--mx-surface, #fff)",
                  borderRadius: m.kind === "event" ? 1 : "50%",
                  rotate: m.kind === "event" ? "45deg" : undefined,
                  background: MARKER_COLORS[m.kind],
                  cursor: "pointer",
                  boxShadow: "0 0 0 0.5px rgba(0,0,0,.15)",
                }}
              />
            );
          })}
        </div>
        <select
          aria-label="Preview mode"
          className="mx-select-compact"
          value={previewMode}
          onChange={(e) => {
            s.setPreviewMode(e.target.value as typeof previewMode);
            s.resetPreview();
            if (e.target.value === "routine") setOpen(true);
          }}
        >
          <option value="path">Path only</option>
          <option value="routine">Full routine</option>
        </select>
        <button
          className="mx-dock-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Inputs & events
          <ChevronUp size={14} />
        </button>
      </div>
      {open && (
        <div className="mx-dock-body">
          <div className="mx-dock-col">
            <h3>Scenario</h3>
            <span className="mx-dock-status">
              <Dot tone={tone} />
              {status}
            </span>
            <p className="mx-help">
              {previewMode === "path"
                ? "Drives every pose on the first branch. Actions and sensor conditions are skipped."
                : "Checks arrival, callback results, transition conditions and watchdogs."}
            </p>
            <Toggle
              label="Freeze drivetrain"
              hint="The robot stays put, so the step must fail its watchdog."
              checked={s.freezeDrive}
              onChange={s.setFreezeDrive}
            />
            <button
              className="mx-link"
              onClick={() =>
                download(
                  `${routine.id}.trace.json`,
                  JSON.stringify(
                    {
                      mode: previewMode,
                      actions: s.actions,
                      routine: routine.id,
                      projectRevision: s.project.revision,
                      signals: s.signals,
                      events: s.latest.events,
                      frames: frames.map(
                        ({ events: _e, controller: _c, ...f }) => f,
                      ),
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              <ArrowDownToLine size={13} /> Export trace JSON
            </button>
          </div>
          {previewMode === "routine" && (
            <div className="mx-dock-col is-wide">
              <h3>Simulated inputs</h3>
              <PreviewInputs
                routine={routine}
                frame={frame}
                definitions={s.project.signals}
                signals={s.signals}
                setSignals={s.setSignals}
                actions={s.actions}
                setActions={s.setActions}
              />
            </div>
          )}
          <div className="mx-dock-col is-wide">
            <h3>
              Events <Badge>{frame.events.length}</Badge>
            </h3>
            <div className="mx-events">
              {frame.events.length === 0 && <p className="mx-help">Press play to run the routine.</p>}
              {frame.events.slice(-40).map((event, i) => (
                <button
                  key={i}
                  onClick={() => {
                    s.setPlaying(false);
                    const index = frames.findIndex((f) => f.time >= event.time);
                    s.setCursor(Math.max(0, index));
                    s.setSelected(event.node);
                  }}
                >
                  <code>{event.time.toFixed(2)}s</code>
                  <Dot tone={event.kind === "failure" ? "bad" : "accent"} />
                  <span>{event.message}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
