import { valueAt, type Recording } from "../core/analysis.ts";
import type { AutoNode } from "../core/model.ts";
import type { Anchor } from "../core/review/tasks.ts";
import type { TaskTarget } from "../ContextMenu";

const cm = (n: number) => Math.round(n * 100) / 100;

/** An auto step as feedback context: the routine, the step and its target. */
export function stepAnchor(routine: string, node: AutoNode, project?: string | null): Anchor {
  const goal = node.goal;
  return {
    routine,
    step: {
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(goal ? { x: cm(goal.x), y: cm(goal.y), heading: Math.round(goal.heading * 1000) / 1000 } : {}),
      ...(node.action ? { action: node.action } : {}),
    },
    ...(goal ? { pose: { x: cm(goal.x), y: cm(goal.y) } } : {}),
    ...(project ? { project } : {}),
  };
}

/** "Make this an agent task" for an auto step. */
export const stepTask = (routine: string, node: AutoNode, project?: string | null): TaskTarget => ({
  title: `${routine} · ${node.name}: `,
  anchor: { ...stepAnchor(routine, node, project) },
  context: "Pinned to this step of the auto. An agent sees the routine, the step and its target.",
});

/** The robot's logged position at `time`, for pinning feedback to a place on the field. */
export function poseAt(recording: Recording, time: number): { x: number; y: number; heading?: number } | undefined {
  const pick = (re: RegExp) => recording.channels.find((c) => !c.name.startsWith("NT:") && re.test(c.name) && c.samples.length);
  const x = pick(/Sim\/RobotPose\/x$/) ?? pick(/RealOutputs\/(?!Vision|ShotCalculator).*Pose\/x$/i) ?? pick(/(?:pose|odometry).*\/x$/i);
  if (!x) return undefined;
  const prefix = x.name.slice(0, -1);
  const channel = (n: string) => recording.channels.find((c) => c.name === prefix + n);
  const xv = valueAt(x, time),
    yv = channel("y") && valueAt(channel("y")!, time);
  if (typeof xv !== "number" || typeof yv !== "number") return undefined;
  const h = channel("heading") && valueAt(channel("heading")!, time);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(xv), y: r(yv), ...(typeof h === "number" ? { heading: r(h) } : {}) };
}

/** Field meters from a click on an SVG drawn with blue-origin x right and y up (flipped). */
export function fieldPoint(svg: SVGSVGElement, clientX: number, clientY: number, fieldWidth: number) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const local = point.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: Math.round(local.x * 100) / 100, y: Math.round((fieldWidth - local.y) * 100) / 100 };
}

/** The commit a log's robot code was built from (the Mayhem/Build stamp the robot logs at boot). */
export function buildOf(recording: Recording): string | undefined {
  const c = recording.channels.find((x) => /(^|\/)Mayhem\/Build$/.test(x.name) && !x.name.startsWith("NT:") && x.samples.length);
  try {
    const sha = JSON.parse(String(c?.samples[0].value)).sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
