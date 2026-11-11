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
import { Badge, Dot, IconButton, Toggle } from "../ui";

export function PreviewBar({ s }: { s: SuiteState }) {
  const [open, setOpen] = useState(false);
  const { frame, routine, frames, previewMode } = s;
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
        <code className="mx-clock">
          {frame.time.toFixed(2)}
          <small>s</small>
        </code>
        <input
          className="mx-range"
          aria-label="Preview time"
          type="range"
          min="0"
          max={Math.max(1, frames.length - 1)}
          value={s.cursor}
          onChange={(e) => {
            s.setPlaying(false);
            s.setCursor(Math.min(Number(e.target.value), frames.length - 1));
          }}
        />
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
