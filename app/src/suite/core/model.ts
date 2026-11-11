/** Public, versioned authoring contract. Coordinates: blue-origin meters/radians. */
export type Pose = { x: number; y: number; heading: number };
export type Velocity = { vx: number; vy: number; omega: number };
export type SignalValue = boolean | number | string;
export type Signals = Record<string, SignalValue>;
export type Condition =
  | { kind: "signal"; key: string; op: "eq" | "gt" | "lt"; value: SignalValue }
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "always" };
export interface Constraints {
  maxVelocity: number;
  maxAcceleration: number;
  maxAngularVelocity: number;
  maxAngularAcceleration: number;
  translationKp: number;
  rotationKp: number;
}
export interface Goal extends Pose {
  headingMode?: "fixed" | "pointAt" | "motion" | "free";
  aimX?: number;
  aimY?: number;
  translationTolerance: number;
  rotationTolerance: number;
  velocityTolerance: number;
  settleTime: number;
  /** A nonzero radius hands off while moving; final goals should settle instead. */
  handoffRadius: number;
}
export interface AutoNode {
  id: string;
  name: string;
  kind: "pose" | "action" | "custom" | "finish";
  goal?: Goal;
  action?: string;
  description?: string;
  /** Watchdog only: expiry fails execution, never implies success. */
  timeout: number;
  source?: string;
  constraints?: Partial<Constraints>;
  during?: string[];
}
export function autoStepLabel(node:AutoNode):string {
  if(node.kind==='pose')return node.goal?.headingMode==='free'?'Translation':'Pose';
  return node.kind==='finish'?'Finish':node.kind==='custom'?'Custom':'Action';
}
export interface Transition {
  id: string;
  from: string;
  to: string;
  condition: Condition;
}
export interface AutoRoutine {
  start?: Pose;
  id: string;
  name: string;
  initial: string;
  nodes: AutoNode[];
  transitions: Transition[];
}
export interface SignalDefinition {
  key: string;
  name: string;
  type: "boolean" | "number" | "string";
  initial: SignalValue;
  unit?: string;
}
export interface SuiteProject {
  format: "mayhem-suite";
  version: 1;
  revision: number;
  id: string;
  name: string;
  field: { name: string; width: number; height: number };
  robot: {
    name: string;
    length: number;
    width: number;
    start: Pose;
    constraints: Constraints;
  };
  signals: SignalDefinition[];
  routines: AutoRoutine[];
  /** Vendor/application extensions are preserved by every round trip. */
  extensions: Record<string, unknown>;
}
export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
}
export const DEFAULT_CONSTRAINTS: Constraints = {
  maxVelocity: 3.5,
  maxAcceleration: 3,
  maxAngularVelocity: 5,
  maxAngularAcceleration: 10,
  translationKp: 3.2,
  rotationKp: 4,
};
export const DEFAULT_GOAL: Goal = {
  x: 2,
  y: 2,
  heading: 0,
  translationTolerance: 0.06,
  rotationTolerance: 0.04,
  velocityTolerance: 0.15,
  settleTime: 0.12,
  handoffRadius: 0,
};
export function evaluate(condition: Condition, signals: Signals): boolean {
  const test = (c: Condition): boolean | undefined => {
    if (c.kind === "always") return true;
    if (c.kind === "not") {
      const value = test(c.condition);
      return value === undefined ? undefined : !value;
    }
    if (c.kind === "all" || c.kind === "any") {
      const values = c.conditions.map(test);
      if (c.kind === "all" && values.includes(false)) return false;
      if (c.kind === "any" && values.includes(true)) return true;
      return values.includes(undefined) ? undefined : c.kind === "all";
    }
    if (c.kind !== "signal") return undefined;
    const actual = signals[c.key];
    if (actual === undefined || typeof actual !== typeof c.value)
      return undefined;
    if (
      (typeof actual === "number" && !Number.isFinite(actual)) ||
      (typeof c.value === "number" && !Number.isFinite(c.value))
    )
      return undefined;
    if (c.op === "eq") return actual === c.value;
    return typeof actual === "number" && typeof c.value === "number"
      ? c.op === "gt"
        ? actual > c.value
        : actual < c.value
      : undefined;
  };
  return test(condition) === true;
}

export function conditionLabel(c: Condition): string {
  if (c.kind === "always") return "Always";
  if (c.kind === "signal")
    return `${c.key} ${c.op === "eq" ? "=" : c.op === "gt" ? ">" : "<"} ${String(c.value)}`;
  if (c.kind === "not") return `not (${conditionLabel(c.condition)})`;
  return c.conditions
    .map(conditionLabel)
    .join(c.kind === "all" ? " AND " : " OR ");
}
/** Runtime validation is intentionally independent of any UI or robot framework. */
export function validateProject(input: unknown): Issue[] {
  const issues: Issue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: "error", path, message });
  const record = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (!record(input)) {
    error("", "Project must be an object.");
    return issues;
  }
  if (input.format !== "mayhem-suite" || input.version !== 1)
    error("version", "Expected mayhem-suite version 1.");
  for (const key of ["id", "name"])
    if (typeof input[key] !== "string" || !input[key].trim())
      error(key, "Required nonempty text.");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    error("revision", "Expected a nonnegative integer revision.");
  if (!record(input.extensions))
    error("extensions", "Expected an extension object.");
  for (const key of ["width", "height"])
    if (!finite(input.field?.[key]) || input.field[key] <= 0)
      error(`field.${key}`, "Expected positive field dimensions.");
  if (
    typeof input.field?.name !== "string" ||
    typeof input.robot?.name !== "string"
  )
    error("robot", "Field and robot names must be text.");
  const pose = (p: unknown, path: string) => {
    for (const k of ["x", "y", "heading"])
      if (!record(p) || !finite(p[k]))
        error(`${path}.${k}`, "Expected a finite number.");
  };
  pose(input.robot?.start, "robot.start");
  for (const key of ["length", "width"])
    if (!finite(input.robot?.[key]) || input.robot[key] <= 0)
      error(`robot.${key}`, "Expected positive robot dimensions.");
  for (const key of Object.keys(DEFAULT_CONSTRAINTS))
    if (
      !finite(input.robot?.constraints?.[key]) ||
      input.robot.constraints[key] <= 0
    )
      error(`robot.constraints.${key}`, "Expected a positive finite number.");
  const signals = new Map<string, string>();
  if (!Array.isArray(input.signals))
    error("signals", "Expected a signal array.");
  else
    input.signals.forEach((s: any, i: number) => {
      if (
        !record(s) ||
        typeof s.key !== "string" ||
        !s.key ||
        signals.has(s.key)
      ) {
        error(`signals.${i}`, "Signal keys must be nonempty and unique.");
        return;
      }
      signals.set(s.key, s.type);
      if (
        typeof s.name !== "string" ||
        (s.unit !== undefined && typeof s.unit !== "string")
      )
        error(`signals.${i}`, "Signal labels and units must be text.");
      if (
        !["boolean", "number", "string"].includes(s.type) ||
        typeof s.initial !== s.type ||
        (s.type === "number" && !finite(s.initial))
      )
        error(
          `signals.${i}.initial`,
          "Signal initial value must match its type.",
        );
    });
  const checkCondition = (c: unknown, path: string, depth = 0): void => {
    if (!record(c) || depth > 20) {
      error(path, "Invalid condition or nesting exceeds 20.");
      return;
    }
    if (c.kind === "always") return;
    if (c.kind === "not")
      return checkCondition(c.condition, path + ".condition", depth + 1);
    if (c.kind === "all" || c.kind === "any") {
      if (!Array.isArray(c.conditions) || !c.conditions.length)
        error(path, "Condition group must not be empty.");
      else
        c.conditions.forEach((v: unknown, i: number) =>
          checkCondition(v, `${path}.${i}`, depth + 1),
        );
      return;
    }
    if (c.kind !== "signal" || !signals.has(c.key)) {
      error(path, "Condition must reference a declared signal.");
      return;
    }
    if (
      !["eq", "gt", "lt"].includes(c.op) ||
      typeof c.value !== signals.get(c.key) ||
      (typeof c.value === "number" && !finite(c.value)) ||
      (c.op !== "eq" && typeof c.value !== "number")
    )
      error(path, "Comparison must match the signal type.");
  };
  const routineIds = new Set<string>();
  if (!Array.isArray(input.routines) || !input.routines.length)
    error("routines", "At least one routine is required.");
  else
    input.routines.forEach((r: any, ri: number) => {
      const path = `routines.${ri}`;
      if (
        !record(r) ||
        typeof r.id !== "string" ||
        !r.id ||
        routineIds.has(r.id) ||
        !Array.isArray(r.nodes) ||
        !r.nodes.length ||
        !Array.isArray(r.transitions)
      ) {
        error(path, "Expected a unique routine ID, nodes, and transitions.");
        return;
      }
      routineIds.add(r.id);
      if (r.start !== undefined) pose(r.start, path + ".start");
      if (typeof r.name !== "string" || !r.name.trim())
        error(path + ".name", "Routine name must be text.");
      const nodes = new Set<string>();
      r.nodes.forEach((n: any, ni: number) => {
        const p = `${path}.nodes.${ni}`;
        if (
          !record(n) ||
          typeof n.id !== "string" ||
          !n.id ||
          nodes.has(n.id)
        ) {
          error(p, "Node IDs must be nonempty and unique.");
          return;
        }
        nodes.add(n.id);
        if (
          (n.description !== undefined && typeof n.description !== "string") ||
          (n.source !== undefined && typeof n.source !== "string")
        )
          error(p, "Description and source references must be text.");
        if (
          typeof n.name !== "string" ||
          !["pose", "action", "custom", "finish"].includes(n.kind)
        )
          error(p, "Invalid node name or kind.");
        if (!finite(n.timeout) || n.timeout <= 0)
          error(p + ".timeout", "Expected a positive watchdog timeout.");
        if (
          n.during !== undefined &&
          (!Array.isArray(n.during) ||
            n.during.some((v: unknown) => typeof v !== "string" || !v))
        )
          error(p + ".during", "During actions must be callback IDs.");
        if (n.constraints !== undefined) {
          if (!record(n.constraints))
            error(p + ".constraints", "Expected per-step constraints.");
          else
            for (const [key, value] of Object.entries(n.constraints))
              if (!(key in DEFAULT_CONSTRAINTS) || !finite(value) || value <= 0)
                error(
                  p + ".constraints." + key,
                  "Expected a known positive control constraint.",
                );
        }
        if (n.kind === "pose") {
          pose(n.goal, p + ".goal");
          if (
            n.goal?.headingMode &&
            !["fixed", "pointAt", "motion", "free"].includes(n.goal.headingMode)
          )
            error(p + ".goal.headingMode", "Invalid heading policy.");
          if (
            n.goal?.headingMode === "pointAt" &&
            (!finite(n.goal.aimX) || !finite(n.goal.aimY))
          )
            error(
              p + ".goal",
              "Point-at heading needs a finite aimX and aimY.",
            );
          for (const k of [
            "translationTolerance",
            "rotationTolerance",
            "velocityTolerance",
            "settleTime",
            "handoffRadius",
          ])
            if (
              !finite(n.goal?.[k]) ||
              n.goal[k] < 0 ||
              (k.includes("Tolerance") && n.goal[k] === 0)
            )
              error(
                p + ".goal." + k,
                "Expected a finite, valid goal tolerance.",
              );
          if (
            finite(n.goal?.x) &&
            finite(n.goal?.y) &&
            (n.goal.x < 0 ||
              n.goal.y < 0 ||
              n.goal.x > input.field?.width ||
              n.goal.y > input.field?.height)
          )
            error(p + ".goal", "Goal is outside the field.");
        }
        if (
          (n.kind === "action" || n.kind === "custom") &&
          (typeof n.action !== "string" || !n.action.trim())
        )
          error(
            p + ".action",
            "Provide a registered action or custom callback ID.",
          );
      });
      if (!nodes.has(r.initial))
        error(path + ".initial", "Initial state does not exist.");
      const transitionIds = new Set<string>();
      r.transitions.forEach((t: any, ti: number) => {
        const p = `${path}.transitions.${ti}`;
        if (!record(t)) {
          error(p, "Invalid transition.");
          return;
        }
        if (typeof t.id !== "string" || !t.id || transitionIds.has(t.id))
          error(p + ".id", "Transition IDs must be nonempty and unique.");
        transitionIds.add(t.id);
        if (!nodes.has(t.from) || !nodes.has(t.to))
          error(p, "Transition endpoints must exist.");
        checkCondition(t.condition, p + ".condition");
      });
      const reachable = new Set([r.initial]);
      for (let i = 0; i < r.nodes.length; i++)
        for (const t of r.transitions)
          if (record(t) && reachable.has(t.from)) reachable.add(t.to);
      for (const n of r.nodes.filter(
        (n: unknown) => record(n) && typeof n.id === "string",
      )) {
        if (!reachable.has(n.id))
          issues.push({
            severity: "warning",
            path,
            message: `${n.name}: unreachable state.`,
          });
        if (
          n.kind !== "finish" &&
          !r.transitions.some((t: Transition) => t && t.from === n.id)
        )
          error(path, `${n.name}: needs an outgoing transition.`);
        if (
          n.kind === "finish" &&
          r.transitions.some((t: Transition) => t && t.from === n.id)
        )
          error(
            path,
            `${n.name}: terminal states cannot have outgoing transitions.`,
          );
      }
      if (
        !r.nodes.some(
          (n: AutoNode) => n && n.kind === "finish" && reachable.has(n.id),
        )
      )
        error(path, "No reachable finish state.");
    });
  return issues;
}
export function parseProject(text: string): SuiteProject {
  const value: unknown = JSON.parse(text);
  const errors = validateProject(value).filter((i) => i.severity === "error");
  if (errors.length)
    throw new Error(errors.map((i) => `${i.path}: ${i.message}`).join("\n"));
  return value as SuiteProject;
}
