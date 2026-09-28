import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { DEFAULT_FUEL_SIM, simulateFuel, type FuelSim } from "./fuelsim";
import type { FuelSimConfig, Field, RobotConfig, TrajectoryOutput } from "./types";

// One cached run shared by the field and the timeline. Inputs are immutable store objects, so
// reference equality tells us when to re-simulate. A run takes 100-200 ms, so edits (like dragging
// a sim robot's point) re-simulate once they pause, showing the previous run meanwhile.

interface Inputs { field: Field; robot: RobotConfig; out: TrajectoryOutput | null; cfg: FuelSimConfig }
let last: (Inputs & { sim: FuelSim | null }) | null = null;
let wanted: Inputs | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const DEBOUNCE_MS = 150;

const same = (a: Inputs | null, b: Inputs) => !!a && a.field === b.field && a.robot === b.robot && a.out === b.out && a.cfg === b.cfg;

function compute(inp: Inputs, notify = true) {
  last = { ...inp, sim: simulateFuel(inp.field, inp.robot, inp.out, inp.cfg) };
  version++;
  if (notify) listeners.forEach((l) => l());
}

function request(inp: Inputs) {
  if (same(last, inp) || same(wanted, inp)) return;
  wanted = inp;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (wanted) compute(wanted);
    wanted = null;
  }, DEBOUNCE_MS);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => version;

/** The fuel sim for the selected path, or null when it's off (or there's nothing to simulate). */
export function useFuelSim(): FuelSim | null {
  useSyncExternalStore(subscribe, getVersion);
  const on = useStore((s) => s.fuelSimOn && s.view === "paths");
  const field = useStore((s) => s.project?.field);
  const robot = useStore((s) => s.project?.robot);
  const cfg = useStore((s) => s.project?.fuelSim ?? DEFAULT_FUEL_SIM);
  // An out-of-date path isn't drawn, so it doesn't drive through the fuel either.
  const out = useStore((s) => {
    const n = s.selectedTraj;
    return n && !s.stale[n] ? s.trajectories[n]?.output ?? null : null;
  });
  const inp = on && field && robot ? { field, robot, out, cfg } : null;
  // The first run (or switching field) computes right away; later edits are debounced.
  const seen = version;
  if (inp && (!last || last.field !== field)) compute(inp, false); // mid-render: notify after commit
  useEffect(() => {
    if (version !== seen) listeners.forEach((l) => l()); // others rendered before this run existed
    if (inp) request(inp);
  });
  return inp && last ? last.sim : null;
}
