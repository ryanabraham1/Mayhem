/**
 * Feedback from people and the agent tasks it turns into. Each item is one JSON file in the robot
 * repo (`tools/mayhem/review/<id>.json`), so it travels with the code, merges without conflicts,
 * and an agent reads it with the same context a person saw: the log, the moment in it, the code
 * revision, where the robot was.
 */

export const REVIEW_DIR = "tools/mayhem/review";

export type FeedbackKind = "comment" | "thumbs-up" | "thumbs-down" | "field-point" | "driver-form" | "pit-note";

export type TaskStatus =
  /** Recorded, nothing to do (a thumbs-up). */
  | "noted"
  /** Waiting for an agent. */
  | "open"
  /** An agent took it. */
  | "claimed"
  /** The agent's plain-English plan waits for a person. */
  | "plan"
  /** A person approved the plan; the agent is working. */
  | "approved"
  /** The agent says it is done; a person checks the change. */
  | "review"
  | "done"
  | "declined";

export const STATUS_NAMES: Record<TaskStatus, string> = {
  noted: "Noted",
  open: "Waiting for an agent",
  claimed: "Agent is planning",
  plan: "Plan to approve",
  approved: "Agent is working",
  review: "Ready to check",
  done: "Done",
  declined: "Declined",
};

export interface Anchor {
  /** Log file name (as in the log library) and seconds into it. */
  log?: string;
  /** The log file on the computer it was collected on (agents there can open it). */
  logPath?: string;
  time?: number;
  /** Git revision the robot (or simulation) was running. */
  revision?: string;
  /** Field position, blue-origin meters. */
  pose?: { x: number; y: number; heading?: number };
  /** A sim proof scenario, routine, finding or other behavior item the feedback is about. */
  scenario?: string;
  routine?: string;
  /** The auto step selected in the Autonomous editor (its target, for pose steps). */
  step?: { id: string; name: string; kind: string; x?: number; y?: number; heading?: number; action?: string };
  /** A state machine and the state or transition selected on the State machines page. */
  machine?: string;
  state?: string;
  transition?: string;
  /** The Mayhem project file the routine lives in. */
  project?: string;
  behavior?: string;
  /** Match name or number, e.g. "Qual 14". */
  match?: string;
  /** Right-clicked anywhere else: the app page, the card or panel, and the item under the pointer. */
  page?: string;
  section?: string;
  element?: string;
}

export interface Change {
  /** Commit the agent made for this task. */
  revision: string;
  at: string;
  summary?: string;
  /** behavior_diff of the change: red (safety), yellow, green (path only, passes the preview). */
  level?: "red" | "yellow" | "green" | "none";
  findings?: string[];
}

export interface ReviewItem {
  format: "mayhem-review-item";
  version: 1;
  id: string;
  createdAt: string;
  author: string;
  kind: FeedbackKind;
  /** Short title; the text, plan and history explain. */
  title: string;
  text: string;
  anchor: Anchor;
  /** Post-match driver form answers. */
  form?: Record<string, string | number | boolean>;
  status: TaskStatus;
  /** Agent working on it (its name, e.g. "claude-1"). */
  agent?: string;
  /** Plain-English plan, written before any code changes. */
  plan?: string;
  planDecision?: { by: string; at: string; approved: boolean; note?: string };
  /** Revision the work starts from (to diff the change against). */
  base?: string;
  changes: Change[];
  resolution?: string;
  history: { at: string; by: string; what: string }[];
  updatedAt: string;
}

const KINDS: FeedbackKind[] = ["comment", "thumbs-up", "thumbs-down", "field-point", "driver-form", "pit-note"];
const STATUSES = Object.keys(STATUS_NAMES) as TaskStatus[];

export function newId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createItem(input: { author: string; kind: FeedbackKind; title?: string; text: string; anchor?: Anchor; form?: ReviewItem["form"] }, now = new Date()): ReviewItem {
  if (!KINDS.includes(input.kind)) throw new Error(`Unknown feedback kind ${input.kind}`);
  const author = input.author.trim() || "someone";
  const text = input.text.trim();
  const title = (input.title?.trim() || text.split(/\n|\. /)[0] || (input.kind === "thumbs-up" ? "Looks good" : input.kind === "driver-form" ? "Driver form" : "Feedback")).slice(0, 120);
  const at = now.toISOString();
  return {
    format: "mayhem-review-item",
    version: 1,
    id: newId(now),
    createdAt: at,
    author,
    kind: input.kind,
    title,
    text,
    anchor: input.anchor ?? {},
    ...(input.form ? { form: input.form } : {}),
    // Praise is recorded, not worked on.
    status: input.kind === "thumbs-up" ? "noted" : "open",
    changes: [],
    history: [{ at, by: author, what: `added ${input.kind.replace("-", " ")}` }],
    updatedAt: at,
  };
}

export function parseItem(text: string): ReviewItem {
  const v = JSON.parse(text);
  if (v?.format !== "mayhem-review-item" || v.version !== 1 || typeof v.id !== "string" || !/^[\w-]+$/.test(v.id))
    throw new Error("Not a mayhem-review-item v1.");
  if (!KINDS.includes(v.kind) || !STATUSES.includes(v.status) || typeof v.title !== "string" || !Array.isArray(v.history) || !Array.isArray(v.changes))
    throw new Error(`Review item ${v.id} is malformed.`);
  return v as ReviewItem;
}

export const itemPath = (id: string) => `${REVIEW_DIR}/${id}.json`;
export const serializeItem = (item: ReviewItem) => JSON.stringify(item, null, 2) + "\n";

/** Who may move a task where: agents claim, plan and report; people approve, decline and close. */
const MOVES: Record<string, { from: TaskStatus[]; to: TaskStatus; by: "agent" | "person" | "anyone" }> = {
  claim: { from: ["open"], to: "claimed", by: "agent" },
  plan: { from: ["claimed", "plan", "approved"], to: "plan", by: "agent" },
  approve: { from: ["plan"], to: "approved", by: "person" },
  reject: { from: ["plan"], to: "claimed", by: "person" },
  progress: { from: ["approved", "review"], to: "approved", by: "agent" },
  finish: { from: ["approved"], to: "review", by: "agent" },
  accept: { from: ["review"], to: "done", by: "person" },
  reopen: { from: ["review", "done", "declined", "noted", "claimed", "plan", "approved"], to: "open", by: "person" },
  decline: { from: ["open", "claimed", "plan", "approved", "review"], to: "declined", by: "person" },
  release: { from: ["claimed", "plan"], to: "open", by: "agent" },
};
export type Move = keyof typeof MOVES;

/** Applies a move, returning the updated item; throws with a plain reason when it isn't allowed. */
export function move(item: ReviewItem, action: Move, by: string, extra: { plan?: string; note?: string; change?: Omit<Change, "at">; resolution?: string } = {}, now = new Date()): ReviewItem {
  const m = MOVES[action];
  if (!m) throw new Error(`Unknown action ${action}`);
  if (!m.from.includes(item.status)) throw new Error(`Can't ${action} a task that is "${STATUS_NAMES[item.status]}".`);
  if (m.by === "agent" && action !== "claim" && item.agent && item.agent !== by) throw new Error(`Task ${item.id} belongs to ${item.agent}.`);
  if (action === "plan" && !extra.plan?.trim()) throw new Error("A plan needs text: what will change on the robot, in plain words.");
  if (action === "progress" && !extra.change?.revision) throw new Error("Report the commit (revision) you made.");
  const at = now.toISOString();
  const next: ReviewItem = structuredClone(item);
  next.status = m.to;
  next.updatedAt = at;
  if (action === "claim") next.agent = by;
  if (action === "release") delete next.agent;
  if (action === "plan") {
    next.plan = extra.plan!.trim();
    delete next.planDecision;
  }
  if (action === "approve" || action === "reject") next.planDecision = { by, at, approved: action === "approve", ...(extra.note ? { note: extra.note } : {}) };
  if (extra.change) next.changes.push({ ...extra.change, at });
  if (extra.resolution) next.resolution = extra.resolution;
  const words: Record<string, string> = {
    claim: "claimed it",
    plan: "proposed a plan",
    approve: "approved the plan",
    reject: "asked for a different plan",
    progress: `committed ${extra.change?.revision.slice(0, 7)}`,
    finish: "marked it ready to check",
    accept: "accepted the change",
    reopen: "reopened it",
    decline: "declined it",
    release: "gave it back",
  };
  next.history.push({ at, by, what: words[action] + (extra.note ? `: ${extra.note}` : "") });
  return next;
}

/** Commit trailer that links a commit to the task it is for ("why" links on the Changes page). */
export const TASK_TRAILER = /^Mayhem-Task:\s*([\w-]+)\s*$/gim;
export function tasksInMessage(message: string): string[] {
  return [...message.matchAll(TASK_TRAILER)].map((m) => m[1]);
}

/** Questions on the post-match driver form. */
export const DRIVER_FORM: { key: string; label: string; kind: "scale" | "yesno" | "text" }[] = [
  { key: "drive", label: "How did the robot drive?", kind: "scale" },
  { key: "controls", label: "Did every button do what you expected?", kind: "yesno" },
  { key: "auto", label: "Did the auto do what it should?", kind: "yesno" },
  { key: "intake", label: "Intake worked well", kind: "scale" },
  { key: "shooter", label: "Shooter worked well", kind: "scale" },
  { key: "broke", label: "Anything break, stall, or act weird? When?", kind: "text" },
  { key: "change", label: "One thing you want changed", kind: "text" },
];
