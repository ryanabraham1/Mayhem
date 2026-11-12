/**
 * Turn a freehand stroke drawn on the field into a few path goals.
 *
 * Simplification is ported from BLine-Web's "Add curve" tool
 * (src/core/pathProfile/curveProfile.ts, BSD 3-Clause, Copyright (c) 2025 Edan
 * Liahovetsky and Rebel Robotics (FRC 2638); see THIRD_PARTY_NOTICES.md):
 * Ramer-Douglas-Peucker at 0.18 m, then a 0.35 m minimum spacing, loosening the
 * tolerance by 1.3x per round until at most 18 points remain; endpoints within
 * snap distance of the neighboring goals are dropped. Mayhem adds headings:
 * BLine inserts heading-free translation targets, here the points between become
 * any-heading pass-throughs and the last point faces the direction it was drawn.
 */
import type { Pose } from "./model.ts";

export type Point = { x: number; y: number };
export interface SketchOptions {
  toleranceMeters?: number;
  minSpacingMeters?: number;
  maxPoints?: number;
  /** Drop a stroke end this close to the goal before or after it. */
  snapMeters?: number;
  previous?: Point;
  next?: Point;
  /** Keep the end heading of `previous` instead of facing the drawn direction. */
  keepHeading?: boolean;
}
export interface SketchGoal extends Pose {
  /** Driven through without stopping and without a heading target. */
  pass: boolean;
}

export const SKETCH_DEFAULTS = {
  toleranceMeters: 0.18,
  minSpacingMeters: 0.35,
  maxPoints: 18,
  snapMeters: 0.22,
  /** Spacing of raw stroke samples recorded while drawing. */
  sampleMeters: 0.035,
} as const;
const MIN_SEPARATION = 0.015;
const MAX_ROUNDS = 12;
/** Stroke length behind the last point used for its heading, so a wobble at release doesn't count. */
const END_TANGENT_METERS = 0.5;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Sparse points along a stroke: RDP, then minimum spacing, loosened until few enough. */
export function simplifyStroke(stroke: readonly Point[], options: SketchOptions = {}): Point[] {
  const cleaned: Point[] = [];
  for (const p of stroke)
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && (!cleaned.length || dist(cleaned.at(-1)!, p) >= MIN_SEPARATION))
      cleaned.push({ x: p.x, y: p.y });
  if (cleaned.length <= 2) return cleaned;
  const minSpacing = options.minSpacingMeters ?? SKETCH_DEFAULTS.minSpacingMeters;
  const max = Math.max(2, Math.trunc(options.maxPoints ?? SKETCH_DEFAULTS.maxPoints));
  let tolerance = options.toleranceMeters ?? SKETCH_DEFAULTS.toleranceMeters,
    best = cleaned;
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    best = spaced(rdp(cleaned, tolerance), minSpacing);
    if (best.length <= max) break;
    tolerance *= 1.3;
  }
  return best;
}

export function rdp(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Set([0, points.length - 1]);
  const range = (start: number, end: number) => {
    if (end <= start + 1) return;
    let far = -1,
      farDist = -1;
    for (let i = start + 1; i < end; i++) {
      const d = toSegment(points[i], points[start], points[end]);
      if (d > farDist) [far, farDist] = [i, d];
    }
    if (far < 0 || farDist <= tolerance) return;
    keep.add(far);
    range(start, far);
    range(far, end);
  };
  range(0, points.length - 1);
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

function spaced(points: readonly Point[], minSpacing: number): Point[] {
  if (points.length <= 2 || minSpacing <= 0) return [...points];
  const kept = [points[0]];
  for (let i = 1; i < points.length - 1; i++)
    if (dist(points[i], kept.at(-1)!) >= minSpacing && dist(points[i], points[i + 1]) >= MIN_SEPARATION)
      kept.push(points[i]);
  const end = points.at(-1)!;
  if (dist(kept.at(-1)!, end) < MIN_SEPARATION) kept[kept.length - 1] = end;
  else kept.push(end);
  return kept;
}

function toSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    den = dx * dx + dy * dy;
  if (den <= 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Direction the stroke was drawn in over its last stretch (radians), or undefined if it barely moved. */
function endTangent(stroke: readonly Point[]): number | undefined {
  const end = stroke.at(-1);
  if (!end) return undefined;
  for (let i = stroke.length - 2; i >= 0; i--)
    if (dist(stroke[i], end) >= END_TANGENT_METERS || i === 0) {
      const d = dist(stroke[i], end);
      return d > MIN_SEPARATION ? Math.atan2(end.y - stroke[i].y, end.x - stroke[i].x) : undefined;
    }
  return undefined;
}

/**
 * Goals for a drawn stroke, in driving order. Every point but the last is a
 * pass-through with a free heading (its stored heading is the local direction of
 * travel, used if it is switched to a fixed heading); the last is a pose facing
 * the drawn direction, or keeping `fallbackHeading` with `keepHeading`.
 */
export function sketchGoals(
  stroke: readonly Point[],
  fallbackHeading: number,
  options: SketchOptions = {},
): SketchGoal[] {
  const snap = options.snapMeters ?? SKETCH_DEFAULTS.snapMeters;
  let points = simplifyStroke(stroke, options);
  if (options.previous && points.length && dist(points[0], options.previous) <= snap) points = points.slice(1);
  // A stroke that ends on the next goal joins it, so its last point needs no goal of its own.
  const joinsNext = !!options.next && points.length > 0 && dist(points.at(-1)!, options.next) <= snap;
  if (joinsNext) points = points.slice(0, -1);
  const tangent = options.keepHeading ? undefined : endTangent(stroke);
  return points.map((p, i) => {
    const last = i === points.length - 1;
    const prev = i > 0 ? points[i - 1] : (options.previous ?? p);
    const after = points[i + 1] ?? (joinsNext ? options.next! : p);
    const local = dist(prev, after) > MIN_SEPARATION ? Math.atan2(after.y - prev.y, after.x - prev.x) : fallbackHeading;
    return {
      x: Number(p.x.toFixed(3)),
      y: Number(p.y.toFixed(3)),
      heading: last && !joinsNext ? (tangent ?? fallbackHeading) : local,
      pass: !last || joinsNext,
    };
  });
}
