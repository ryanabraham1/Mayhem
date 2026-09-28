import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { DEFAULT_FUEL_SIM, simulateFuel, type FuelSim } from "./fuelsim";
import type { FuelSimJob } from "./fuelsim.worker";
import type { FuelSimConfig, Field, RobotConfig, TrajectoryOutput } from "./types";

// One shared run for the field and the timeline, computed in a Web Worker so the UI never waits on
// it. While a run is in flight, newer requests coalesce into one follow-up run (so dragging a sim
// robot's point updates the fuel as fast as the worker keeps up) and the last result stays shown.
// Inputs are immutable store objects, so reference equality tells us when to re-simulate.

interface Inputs { field: Field; robot: RobotConfig; out: TrajectoryOutput | null; cfg: FuelSimConfig }
let last: (Inputs & { sim: FuelSim | null }) | null = null;
let inflight: (Inputs & { id: number }) | null = null;
let wanted: Inputs | null = null;
let nextId = 1;
let worker: Worker | null | undefined; // undefined = not tried yet, null = unavailable (tests)
const listeners = new Set<() => void>();
let version = 0;

const same = (a: Inputs | null, b: Inputs) => !!a && a.field === b.field && a.robot === b.robot && a.out === b.out && a.cfg === b.cfg;

function finish(inp: Inputs, sim: FuelSim | null) {
  last = { field: inp.field, robot: inp.robot, out: inp.out, cfg: inp.cfg, sim };
  version++;
  listeners.forEach((l) => l());
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === "undefined" ? null : new Worker(new URL("./fuelsim.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; sim: FuelSim | null }>) => {
      if (!inflight || e.data.id !== inflight.id) return;
      const done = inflight;
      inflight = null;
      finish(done, e.data.sim);
      const next = wanted;
      wanted = null;
      if (next && !same(last, next)) start(next);
    };
    worker.onerror = () => {
      // fall back to running on this thread
      worker?.terminate();
      worker = null;
      const retry = inflight;
      inflight = null;
      if (retry) start(retry);
    };
  }
  return worker;
}

function start(inp: Inputs) {
  const w = getWorker();
  if (!w) {
    finish(inp, simulateFuel(inp.field, inp.robot, inp.out, inp.cfg));
    return;
  }
  inflight = { ...inp, id: nextId++ };
  const job: FuelSimJob = { id: inflight.id, field: inp.field, robot: inp.robot, out: inp.out, cfg: inp.cfg };
  w.postMessage(job);
}

function request(inp: Inputs) {
  if (inflight) {
    wanted = same(inflight, inp) ? null : inp;
    return;
  }
  if (!same(last, inp)) start(inp);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => version;

/** The fuel sim for the selected path, or null when it's off (or there's nothing to simulate yet). */
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
  useEffect(() => {
    if (on && field && robot) request({ field, robot, out, cfg });
  }, [on, field, robot, out, cfg]);
  // Keep showing the previous run until the new one lands, as long as it's for this field.
  return on && field && last && last.field === field ? last.sim : null;
}
