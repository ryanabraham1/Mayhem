import type { Frame } from "./runtime.ts";
import { wrap } from "./runtime.ts";

/** Event markers usually mean a pickup; the intake is the robot's front (+x). */
export const HEADING_LINT_DEGREES = 45;
/** Below this speed the travel direction is meaningless. */
const MIN_SPEED = 0.25;

export interface HeadingLint {
  time: number;
  /** Event trigger key that fired. */
  key: string;
  /** Pose step active when it fired. */
  node: string;
  x: number;
  y: number;
  heading: number;
  /** Direction of travel (radians, field frame). */
  travel: number;
  /** |heading - travel| in degrees. */
  degrees: number;
  message: string;
}

/**
 * Warn when an event marker fires while the robot's front points more than
 * `limit` degrees away from its direction of travel (e.g. hitting a game piece
 * sideways with a front intake). Uses previewed/simulated frames.
 */
export function headingLints(frames: Frame[], limit = HEADING_LINT_DEGREES, nodeName: (id: string) => string = (id) => id): HeadingLint[] {
  const out: HeadingLint[] = [];
  for (const frame of frames)
    for (const event of frame.events) {
      if (event.kind !== "event" || event.time !== frame.time) continue;
      const { vx, vy } = frame.velocity;
      if (Math.hypot(vx, vy) < MIN_SPEED) continue;
      const travel = Math.atan2(vy, vx);
      const degrees = (Math.abs(wrap(frame.pose.heading - travel)) * 180) / Math.PI;
      if (degrees <= limit) continue;
      const key = event.message.replace(/^Event trigger /, "");
      out.push({
        time: frame.time,
        key,
        node: frame.node,
        x: frame.pose.x,
        y: frame.pose.y,
        heading: frame.pose.heading,
        travel,
        degrees,
        message: `${nodeName(frame.node)}: event "${key}" fires with the front ${Math.round(degrees)}° off the direction of travel. Use the Motion heading on this step (or a rotation marker before it) so the intake leads.`,
      });
    }
  return out;
}
