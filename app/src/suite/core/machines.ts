import type {
  AutoRoutine,
  Condition,
  SignalDefinition,
  Signals,
  Transition,
} from "./model.ts";
import { valueAt, type Recording } from "./analysis.ts";
import { ANY_STATE, inputSourceProblem } from "./model.ts";
export interface MachineManifest {
  format: "mayhem-machine";
  version: 1;
  id: string;
  name: string;
  initial: string;
  states: { id: string; name: string; description?: string; source?: string }[];
  /**
   * Optional `name` (edge label) and `description` (hover/inspector) on each transition.
   * `from: "*"` leaves every state except its target and any `except` states, at its
   * position in priority order.
   */
  transitions: Transition[];
  /** Each input may carry `category` and `derivedFrom` (see SignalDefinition). */
  inputs: (SignalDefinition & { channel?: string })[];
  stateChannel?: string;
  /**
   * "priority": a supervisor whose rows (usually `from: "*"`) are checked top to bottom every
   * tick; the first true row picks the state, and if that is the current state the machine stays
   * (no re-entry, no lower row fires). A last row with `{ "kind": "always" }` is the "otherwise".
   */
  selection?: "priority";
}
export function parseMachineManifest(value: unknown): MachineManifest {
  const record = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0;
  if (
    !record(value) ||
    value.format !== "mayhem-machine" ||
    value.version !== 1 ||
    !text(value.id) ||
    !text(value.name) ||
    !Array.isArray(value.states) ||
    !value.states.length ||
    !Array.isArray(value.transitions) ||
    !Array.isArray(value.inputs)
  )
    throw new Error(
      "Expected a mayhem-machine v1 manifest with states, transitions, and inputs.",
    );
  const states = new Set<string>(),
    inputs = new Map<string, string>(),
    edges = new Set<string>();
  if (value.stateChannel !== undefined && !text(value.stateChannel))
    throw new Error("State channel must be nonempty text.");
  if (value.selection !== undefined && value.selection !== "priority")
    throw new Error('Machine selection must be "priority" or absent.');
  for (const s of value.states) {
    if (!record(s) || !text(s.id) || !text(s.name) || states.has(s.id))
      throw new Error("Machine state IDs must be unique.");
    states.add(s.id);
    if (
      (s.source !== undefined && typeof s.source !== "string") ||
      (s.description !== undefined && typeof s.description !== "string")
    )
      throw new Error("State descriptions and source references must be text.");
  }
  if (!states.has(value.initial))
    throw new Error("Machine initial state is missing.");
  for (const s of value.inputs) {
    if (
      !record(s) ||
      !text(s.key) ||
      !text(s.name) ||
      inputs.has(s.key) ||
      !["boolean", "number", "string"].includes(s.type) ||
      typeof s.initial !== s.type ||
      (typeof s.initial === "number" && !Number.isFinite(s.initial)) ||
      (s.channel !== undefined && !text(s.channel))
    )
      throw new Error("Invalid machine input.");
    inputs.set(s.key, s.type);
  }
  for (const s of value.inputs) {
    const problem = inputSourceProblem(s, new Set(inputs.keys()));
    if (problem) throw new Error(`Input ${s.key}: ${problem}`);
  }
  const check = (c: unknown, depth = 0): void => {
    if (!record(c) || depth > 20) throw new Error("Invalid machine condition.");
    if (c.kind === "always") return;
    if (c.kind === "not") return check(c.condition, depth + 1);
    if (c.kind === "all" || c.kind === "any") {
      if (!Array.isArray(c.conditions) || !c.conditions.length)
        throw new Error("Empty condition group.");
      c.conditions.forEach((v: unknown) => check(v, depth + 1));
      return;
    }
    if (
      c.kind !== "signal" ||
      !inputs.has(c.key) ||
      !["eq", "gt", "lt"].includes(c.op) ||
      typeof c.value !== inputs.get(c.key) ||
      (c.op !== "eq" && typeof c.value !== "number") ||
      (typeof c.value === "number" && !Number.isFinite(c.value))
    )
      throw new Error("Machine conditions must reference typed inputs.");
  };
  for (const t of value.transitions) {
    if (
      !record(t) ||
      !text(t.id) ||
      edges.has(t.id) ||
      !(states.has(t.from) || t.from === ANY_STATE) ||
      !states.has(t.to)
    )
      throw new Error("Invalid machine transition.");
    if (
      t.except !== undefined &&
      (t.from !== ANY_STATE || !Array.isArray(t.except) || t.except.some((s: unknown) => typeof s !== "string" || !states.has(s)))
    )
      throw new Error(`Transition ${t.id}: except needs from "${ANY_STATE}" and must list state IDs.`);
    if (
      (t.name !== undefined && (typeof t.name !== "string" || !t.name.trim())) ||
      (t.description !== undefined && typeof t.description !== "string")
    )
      throw new Error(`Transition ${t.id}: name must be nonempty text and description text.`);
    edges.add(t.id);
    check(t.condition);
  }
  return value as unknown as MachineManifest;
}
export function machineGraph(machine: MachineManifest): AutoRoutine {
  return {
    id: machine.id,
    name: machine.name,
    initial: machine.initial,
    nodes: machine.states.map((s) => ({
      ...s,
      kind: "custom",
      action: s.source ?? "Robot implementation",
      timeout: 1,
    })),
    transitions: machine.transitions,
  };
}
export function observedMachine(
  machine: MachineManifest,
  recording: Recording,
  time: number,
): { state?: string; signals: Signals } {
  const stateChannel = recording.channels.find(
    (c) =>
      c.name.replace(/^\//, "") ===
        (machine.stateChannel ?? `Mayhem/States/${machine.id}/state`).replace(
          /^\//,
          "",
        ) || c.name.endsWith(`/Mayhem/States/${machine.id}/state`),
  );
  const state = valueAt(stateChannel, time),
    signals: Signals = {};
  for (const input of machine.inputs) {
    const channel = recording.channels.find(
      (c) =>
        c.name.replace(/^\//, "") ===
          (input.channel ?? input.key).replace(/^\//, "") ||
        c.name.endsWith(`/Mayhem/States/${machine.id}/inputs/${input.key}`),
    );
    const value = valueAt(channel, time);
    if (typeof value === input.type && value !== undefined)
      signals[input.key] = value;
  }
  return { state: typeof state === "string" ? state : undefined, signals };
}
export const exampleMachine: MachineManifest = {
  format: "mayhem-machine",
  version: 1,
  id: "Intake",
  name: "Intake state machine",
  initial: "Idle",
  states: [
    {
      id: "Idle",
      name: "Idle",
      description: "Wait for a request from the robot coordinator.",
    },
    {
      id: "Acquiring",
      name: "Acquiring",
      description: "Run the intake until a piece is detected.",
    },
    {
      id: "Holding",
      name: "Holding",
      description: "Hold the piece until the scoring request.",
    },
  ],
  inputs: [
    {
      key: "intake.requested",
      name: "Intake requested",
      type: "boolean",
      initial: false,
    },
    {
      key: "intake.hasPiece",
      name: "Piece detected",
      type: "boolean",
      initial: false,
    },
    {
      key: "intake.release",
      name: "Release requested",
      type: "boolean",
      initial: false,
    },
  ],
  transitions: [
    {
      id: "acquire",
      from: "Idle",
      to: "Acquiring",
      condition: {
        kind: "signal",
        key: "intake.requested",
        op: "eq",
        value: true,
      },
    },
    {
      id: "captured",
      from: "Acquiring",
      to: "Holding",
      condition: {
        kind: "signal",
        key: "intake.hasPiece",
        op: "eq",
        value: true,
      },
    },
    {
      id: "release",
      from: "Holding",
      to: "Idle",
      condition: {
        kind: "signal",
        key: "intake.release",
        op: "eq",
        value: true,
      },
    },
  ],
};
export function conditionSignals(condition: Condition): string[] {
  if (condition.kind === "signal") return [condition.key];
  if (condition.kind === "not") return conditionSignals(condition.condition);
  if (condition.kind === "always") return [];
  return condition.conditions.flatMap(conditionSignals);
}
