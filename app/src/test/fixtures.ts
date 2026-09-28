import { newTrajectory, newWaypoint } from "../model";
import type { Project, Trajectory } from "../types";

export function makeProject(extra: Partial<Project> = {}): Project {
  return {
    formatVersion: 1,
    name: "Test",
    robot: {
      mass: 60, moi: 6, bumper: { front: 0.45, back: 0.45, left: 0.45, right: 0.45 },
      modules: [[0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]], wheelRadius: 0.05, wheelCof: 1.2,
      motor: { type: "krakenX60", gearing: 6.75, currentLimit: 80, efficiency: 0.9 },
      batteryVoltage: 11, cogHeight: 0, intake: { side: "front", extension: 0, width: 0, offset: 0 },
    },
    field: {
      id: "test", name: "Test field", length: 16.5, width: 8, symmetry: "rotational", wallMargin: 0,
      obstacles: [], decorations: [], notes: "",
    },
    commands: [],
    deployDir: "",
    poses: [],
    folders: [],
    ...extra,
  };
}

/** A path with pose waypoints at the given (x, y) positions. */
export function makeTraj(name: string, points: [number, number][] = [[1, 1], [3, 1]]): Trajectory {
  return { ...newTrajectory(name), waypoints: points.map(([x, y]) => newWaypoint(x, y)) };
}
