// Runs the fuel sim off the UI thread; see useFuelSim.ts.
import { simulateFuel } from "./fuelsim";
import type { FuelSimConfig, Field, RobotConfig, TrajectoryOutput } from "./types";

export interface FuelSimJob { id: number; field: Field; robot: RobotConfig; out: TrajectoryOutput | null; cfg: FuelSimConfig }

const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent<FuelSimJob>) => {
  const { id, field, robot, out, cfg } = e.data;
  const sim = simulateFuel(field, robot, out, cfg);
  ctx.postMessage({ id, sim }, sim ? [sim.pos.buffer, sim.takenAt.buffer] : []);
};
