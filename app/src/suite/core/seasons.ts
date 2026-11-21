import rebuilt from "./rebuilt-2026.json" with { type: "json" };
import reefscape from "./reefscape-2025.json" with { type: "json" };
import type { FieldDrawing } from "../FieldArt";
import type { SuiteProject } from "./model.ts";

/** A field obstacle autos are checked against (core/<game>-<year>.json). */
export interface SeasonObstacle {
  id: string;
  name: string;
  points: number[][];
  enabled: boolean;
}

/** One FRC game: its field drawing, obstacles and auto period. */
export interface Season {
  year: number;
  /** The project's field name for this game, e.g. "2026 REBUILT". */
  name: string;
  /** Field size (length along x, width along y) and what's painted on it. */
  field: FieldDrawing & { obstacles: SeasonObstacle[] };
  /** Length of the autonomous period, in seconds. */
  autoSeconds: number;
  /** AdvantageScope field asset folder for the 3D replay. */
  advantageScopeField: RegExp;
  /** Game piece names in that field model. */
  gamePiece: RegExp;
  /** The robot sim logs every game piece (Sim/Fuel), so the field model's own pieces are hidden. */
  simLogsPieces: boolean;
}

export const SEASONS: readonly Season[] = [
  {
    year: 2026,
    name: rebuilt.name,
    field: rebuilt as Season["field"],
    autoSeconds: 20,
    advantageScopeField: /2026FRCField/,
    gamePiece: /fuel/i,
    simLogsPieces: true,
  },
  {
    year: 2025,
    name: reefscape.name,
    field: reefscape as Season["field"],
    autoSeconds: 15,
    advantageScopeField: /2025FRCField/,
    gamePiece: /algae|coral/i,
    simLogsPieces: false,
  },
];

export const DEFAULT_SEASON = SEASONS[0];

/** The project's field for a game. */
export const seasonProjectField = (s: Season) => ({ name: s.name, width: s.field.length, height: s.field.width });

/** True when a project field is this game's field (same size, within 5 cm). */
export const fieldMatches = (s: Season, field: { width: number; height: number }) =>
  Math.abs(field.width - s.field.length) <= 0.05 && Math.abs(field.height - s.field.width) <= 0.05;

/**
 * The game a project's field is for: by year in the name, then by size. A custom-size field
 * keeps the newest game's drawing and auto period.
 */
export function seasonOf(field?: { name?: string; width?: number; height?: number }): Season {
  if (!field) return DEFAULT_SEASON;
  const named = SEASONS.find((s) => field.name?.includes(String(s.year)));
  if (named) return named;
  if (typeof field.width === "number" && typeof field.height === "number") {
    const sized = SEASONS.find((s) => fieldMatches(s, { width: field.width!, height: field.height! }));
    if (sized) return sized;
  }
  return DEFAULT_SEASON;
}

const clampInto = (p: { x: number; y: number }, w: number, h: number) => {
  p.x = Math.min(Math.max(p.x, 0), w);
  p.y = Math.min(Math.max(p.y, 0), h);
};

/**
 * Switch a project to a game: its field size and name. Autos keep their goals; any that would
 * land off the new field are pulled onto its edge so the project stays valid.
 */
export function applySeason(project: SuiteProject, season: Season): void {
  project.field = seasonProjectField(season);
  const { width: w, height: h } = project.field;
  clampInto(project.robot.start, w, h);
  for (const r of project.routines) {
    if (r.start) clampInto(r.start, w, h);
    for (const n of r.nodes) if (n.goal) clampInto(n.goal, w, h);
  }
}
