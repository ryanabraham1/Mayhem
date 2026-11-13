import { valueAt, type Recording } from "../core/analysis.ts";

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
