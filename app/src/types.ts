// Mirrors solver/src/mayhem_solver/models.py (the source of truth; see schemas/mayhem.schema.json).

export type Vec2 = [number, number];

export type MotorType =
  | "krakenX60" | "krakenX60Foc" | "krakenX44" | "falcon500" | "falcon500Foc" | "neo" | "neoVortex";

export interface Bumper { front: number; back: number; left: number; right: number }
export type IntakeSide = "front" | "back" | "left" | "right";
/** Mechanism that reaches past one bumper side when deployed; only counts where an intakeExtended constraint applies. */
export interface Intake { side: IntakeSide; extension: number; width: number; offset: number }
export interface Motor { type: MotorType; gearing: number; currentLimit: number; efficiency: number }
export interface RobotConfig {
  mass: number; moi: number; bumper: Bumper; modules: Vec2[]; wheelRadius: number; wheelCof: number;
  motor: Motor; batteryVoltage: number; cogHeight: number; intake: Intake;
}

export interface Obstacle {
  id: string; name: string; kind: "polygon" | "circle"; points: Vec2[]; center: Vec2; radius: number;
  margin: number; enabled: boolean;
}
export type DecorationStyle =
  | "blueZone" | "redZone" | "tape" | "blueTape" | "redTape" | "fuel" | "structure" | "blue" | "red";
export interface Decoration {
  kind: "polygon" | "line" | "circle"; points: Vec2[]; center: Vec2; radius: number; style: DecorationStyle; width: number;
}
export interface Field {
  id: string; name: string; length: number; width: number; symmetry: "mirror" | "rotational";
  wallMargin: number; obstacles: Obstacle[]; decorations: Decoration[]; notes: string;
}

export interface Tolerance { kind: "none" | "circle" | "box"; radius: number; dx: number; dy: number }
export interface Waypoint {
  id: string; x: number; y: number; heading: number;
  translationMode: "fixed" | "guide"; headingMode: "fixed" | "free"; headingTolerance: number;
  tolerance: Tolerance; stop: boolean; split: boolean; intervals: number | null;
  /** id of a project pose variable; when set, x/y/heading come from it */
  poseRef?: string | null;
}
export interface PoseVariable { id: string; name: string; x: number; y: number; heading: number }
export interface Scope { kind: "waypoint" | "range" | "zone"; from: number; to: number; region: Vec2[] }
export type ConstraintData =
  | { type: "maxVelocity"; value: number }
  | { type: "maxAcceleration"; value: number }
  | { type: "maxAngularVelocity"; value: number }
  | { type: "pointAt"; x: number; y: number; tolerance: number; flip: boolean }
  | { type: "keepIn"; points: Vec2[] }
  | { type: "keepOut"; points: Vec2[]; margin: number }
  | { type: "roughTerrain"; expectedSpeed: number; feedbackScale: number }
  | { type: "straightLine"; tolerance: number }
  | { type: "intakeExtended" };
export type ConstraintType = ConstraintData["type"];
export interface Constraint { id: string; enabled: boolean; scope: Scope; data: ConstraintData }

export type RecoveryPolicy = "fireAtJoin" | "fireImmediately" | "skip";
export interface Marker {
  id: string; name: string; command: string; waypoint: number; offset: number;
  endWaypoint: number | null; endOffset: number; recoveryPolicy: RecoveryPolicy; mustHit: boolean;
}
export interface SolverSettings {
  targetDt: number; smoothing: number; candidates: number; maxIterations: number; timeLimit: number;
}

export interface Sample {
  t: number; x: number; y: number; heading: number; vx: number; vy: number; omega: number;
  ax: number; ay: number; alpha: number; fx: number[]; fy: number[];
}
export interface EventOut {
  name: string; command: string; t: number; endT: number | null; recoveryPolicy: RecoveryPolicy; mustHit: boolean;
}
export interface SolveStats {
  success: boolean; totalTime: number; solveSeconds: number; iterations: number; candidate: number; attempts: string[];
}
export interface TrajectoryOutput {
  inputHash: string; samples: Sample[]; waypointTimes: number[]; splits: number[]; events: EventOut[];
  terrain?: { t: number; endT: number; expectedSpeed: number; feedbackScale: number; expectedDelay: number }[];
  intake?: { t: number; endT: number }[];
  recovery: { obstacles: Vec2[][]; roadmapNodes: Vec2[]; roadmapEdges: [number, number][]; mustHitTimes: number[] } & Record<string, unknown>;
  stats: SolveStats;
}
export interface Trajectory {
  formatVersion: number; name: string; waypoints: Waypoint[]; constraints: Constraint[]; markers: Marker[];
  settings: SolverSettings; output: TrajectoryOutput | null;
  /** sidebar folder; organisational only */
  folder?: string | null;
}
export interface Project {
  formatVersion: number; name: string; robot: RobotConfig; field: Field; commands: string[]; deployDir: string;
  poses: PoseVariable[];
  /** path folders shown in the sidebar, in order */
  folders: string[];
}
export interface Issue {
  severity: "error" | "warning" | "info"; message: string; waypoint?: number | null; t?: number | null;
  x?: number | null; y?: number | null;
}
export interface DrivetrainInfo {
  maxSpeed: number; maxAcceleration: number; maxAngularVelocity: number; maxAngularAcceleration: number;
  wheelStallForce: number; wheelCurrentForce: number; frictionForce: number; limitingForce: string;
}
