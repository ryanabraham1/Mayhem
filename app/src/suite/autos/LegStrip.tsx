import type { Leg } from "../core/legs.ts";
import { speedColor } from "../FieldView";

/** Pick one leg of the routine to edit on its own; the rest of the route is ghosted. */
export function LegStrip({
  legs,
  focused,
  focus,
  speeds,
}: {
  legs: Leg[];
  focused: string | null;
  focus: (id: string | null) => void;
  /** Average previewed speed per leg id, as a fraction of max speed. */
  speeds: Map<string, number>;
}) {
  return (
    <div className="mx-legs" role="toolbar" aria-label="Route legs">
      <span className="mx-legs-title">Legs</span>
      <button
        className={`mx-chip-toggle ${focused === null ? "is-on" : ""}`}
        aria-pressed={focused === null}
        onClick={() => focus(null)}
      >
        All
      </button>
      {legs.map((leg, i) => {
        const speed = speeds.get(leg.id);
        return (
          <button
            key={leg.id}
            className={`mx-chip-toggle ${focused === leg.id ? "is-on" : ""}`}
            aria-pressed={focused === leg.id}
            title={`${leg.nodeIds.length} ${leg.nodeIds.length === 1 ? "goal" : "goals"}, ending at ${leg.name}`}
            onClick={() => focus(focused === leg.id ? null : leg.id)}
          >
            <span
              className="mx-leg-dot"
              style={{ background: speed === undefined ? "var(--mx-path)" : speedColor(speed) }}
            />
            <span className="mx-leg-num">{i + 1}</span>
            {leg.name.length > 22 ? `${leg.name.slice(0, 21)}…` : leg.name}
          </button>
        );
      })}
    </div>
  );
}
