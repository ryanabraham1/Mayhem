"""Data models for Mayhem project and trajectory files.

These Pydantic models are the single source of truth for the on-disk formats.
`python -m mayhem_solver.schema` exports JSON Schema from them, which is used to
generate the TypeScript types for the app. The Java library mirrors the output
section by hand (see lib/).

All units are SI: meters, radians, seconds, kilograms, newtons. Field frame is
the WPILib blue-alliance origin (bottom-left corner, +x toward red wall).
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

FORMAT_VERSION = 1


class Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="ignore"
    )

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")


# ---------------------------------------------------------------------------
# Robot
# ---------------------------------------------------------------------------

MotorType = Literal[
    "krakenX60",
    "krakenX60Foc",
    "krakenX44",
    "falcon500",
    "falcon500Foc",
    "neo",
    "neoVortex",
]


class Bumper(Model):
    """Bumper outline as distances from robot center (always positive)."""

    front: float = 0.45
    back: float = 0.45
    left: float = 0.45
    right: float = 0.45


class Intake(Model):
    """A mechanism that reaches past one bumper side when deployed (e.g. an over-the-bumper intake).

    It only counts for collisions where an intakeExtended constraint says it is out.
    """

    side: Literal["front", "back", "left", "right"] = "front"
    extension: float = Field(0.3, ge=0, description="How far it reaches past the bumper edge [m]")
    width: float = Field(0.0, ge=0, description="Width along the bumper side [m]; 0 = the whole side")
    offset: float = Field(
        0.0,
        description="Shift of its center along the side [m]: toward robot left on the front/back, "
                    "toward robot front on the left/right. Ignored when width is 0.",
    )


class Motor(Model):
    type: MotorType = "krakenX60"
    gearing: float = Field(6.75, description="Drive reduction (motor turns per wheel turn)")
    current_limit: float = Field(80.0, description="Drive stator current limit [A]")
    efficiency: float = Field(0.9, description="Drivetrain efficiency multiplier on torque")


class RobotConfig(Model):
    mass: float = Field(60.0, description="Robot mass incl. bumpers and battery [kg]")
    moi: float = Field(6.0, description="Rotational inertia about vertical axis [kg m^2]")
    bumper: Bumper = Bumper()
    modules: list[tuple[float, float]] = Field(
        default_factory=lambda: [(0.28, 0.28), (0.28, -0.28), (-0.28, 0.28), (-0.28, -0.28)],
        description="Module positions relative to robot center [m] (FL, FR, BL, BR)",
    )
    wheel_radius: float = 0.0508
    wheel_cof: float = Field(1.2, description="Wheel-carpet coefficient of friction")
    motor: Motor = Motor()
    battery_voltage: float = Field(
        11.0, description="Voltage budget used for planning (leave headroom for feedback)"
    )
    cog_height: float = Field(
        0.0, description="Center of gravity height [m]; >0 enables weight-transfer model"
    )
    intake: Intake = Intake()


# ---------------------------------------------------------------------------
# Field
# ---------------------------------------------------------------------------


class Obstacle(Model):
    id: str
    name: str = "Obstacle"
    kind: Literal["polygon", "circle"] = "polygon"
    points: list[tuple[float, float]] = Field(default_factory=list)
    center: tuple[float, float] = (0.0, 0.0)
    radius: float = 0.5
    margin: float = Field(0.0, description="Extra clearance around this obstacle [m]")
    enabled: bool = True
    fuel_collision: Literal["paths", "block", "pass"] = Field(
        "paths",
        description="App fuel sim only: 'paths' = fuel bounces off it when enabled, 'block' = always "
                    "(e.g. a bump robots drive over), 'pass' = never (e.g. an overhead trench). "
                    "Not part of the input hash.",
    )


class Decoration(Model):
    """Non-obstacle field artwork (tape, zones, game pieces) drawn by the app."""

    kind: Literal["polygon", "line", "circle"] = "polygon"
    points: list[tuple[float, float]] = Field(default_factory=list)
    center: tuple[float, float] = (0.0, 0.0)
    radius: float = 0.1
    style: Literal["blueZone", "redZone", "tape", "blueTape", "redTape", "fuel", "structure", "blue", "red"] = "tape"
    width: float = 0.05


class Field_(Model):
    """A field definition. Named Field_ to avoid clashing with pydantic.Field."""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="ignore", title="Field"
    )

    id: str = "blank"
    name: str = "Blank field"
    length: float = 16.541
    width: float = 8.0692
    symmetry: Literal["mirror", "rotational"] = "rotational"
    wall_margin: float = 0.02
    obstacles: list[Obstacle] = Field(default_factory=list)
    decorations: list[Decoration] = Field(default_factory=list)
    notes: str = ""


# ---------------------------------------------------------------------------
# Trajectory inputs
# ---------------------------------------------------------------------------


class Tolerance(Model):
    kind: Literal["none", "circle", "box"] = "none"
    radius: float = 0.1
    dx: float = 0.1
    dy: float = 0.1


class Waypoint(Model):
    id: str
    x: float
    y: float
    heading: float = 0.0
    translation_mode: Literal["fixed", "guide"] = Field(
        "fixed", description="guide = only shapes the initial guess, not a constraint"
    )
    heading_mode: Literal["fixed", "free"] = "fixed"
    heading_tolerance: float = Field(0.0, description="Allowed heading error [rad]")
    tolerance: Tolerance = Tolerance()
    stop: bool = False
    split: bool = False
    intervals: Optional[int] = Field(None, description="Override sample count to next waypoint")
    pose_ref: Optional[str] = Field(None, description="id of a project pose variable; when set, x/y/heading come from it")


class Scope(Model):
    """Where a constraint applies.

    kind=waypoint: at waypoint `from_` only.
    kind=range: every sample between waypoint `from_` and `to` inclusive.
    kind=zone: every sample whose robot center is inside `region`.
    """

    kind: Literal["waypoint", "range", "zone"] = "range"
    from_: int = Field(0, alias="from")
    to: int = 0
    region: list[tuple[float, float]] = Field(default_factory=list)


class MaxVelocity(Model):
    type: Literal["maxVelocity"] = "maxVelocity"
    value: float = 2.0


class MaxAcceleration(Model):
    type: Literal["maxAcceleration"] = "maxAcceleration"
    value: float = 3.0


class MaxAngularVelocity(Model):
    type: Literal["maxAngularVelocity"] = "maxAngularVelocity"
    value: float = 3.0


class PointAt(Model):
    type: Literal["pointAt"] = "pointAt"
    x: float = 0.0
    y: float = 0.0
    tolerance: float = 0.05
    flip: bool = Field(False, description="Face away from the target instead")


class KeepIn(Model):
    """Robot bumper must stay inside a convex polygon."""

    type: Literal["keepIn"] = "keepIn"
    points: list[tuple[float, float]] = Field(default_factory=list)


class KeepOut(Model):
    """Per-trajectory obstacle (polygon) in addition to field obstacles."""

    type: Literal["keepOut"] = "keepOut"
    points: list[tuple[float, float]] = Field(default_factory=list)
    margin: float = 0.0


class StraightLine(Model):
    """Robot center stays on the straight segment between the scope's two end waypoints."""
    type: Literal["straightLine"] = "straightLine"
    tolerance: float = Field(0.02, description="Allowed distance from the line [m]")


class RoughTerrain(Model):
    """Terrain (e.g. the field bump) where the robot is expected to lose speed.

    Does not slow the plan down: the solver keeps full speed.
    The covered time spans are exported so MayhemLib can expect the robot to fall behind there
    (no hit detection, clock follows the robot, softer correction) instead of fighting it.
    """

    type: Literal["roughTerrain"] = "roughTerrain"
    expected_speed: float = Field(
        0.7, gt=0, le=1, description="Fraction of the planned speed the robot is expected to keep"
    )
    feedback_scale: float = Field(
        0.3, ge=0, le=1, description="On-robot feedback strength while on the terrain (1 = normal)"
    )


class IntakeExtended(Model):
    """The robot's intake (robot config) is deployed over this scope.

    Obstacle, wall and keep-in checks use the bumper plus the intake there. The covered time
    spans are exported so MayhemLib can tell robot code when to deploy it.
    """

    type: Literal["intakeExtended"] = "intakeExtended"


ConstraintData = Annotated[
    Union[MaxVelocity, MaxAcceleration, MaxAngularVelocity, PointAt, KeepIn, KeepOut, StraightLine,
          RoughTerrain, IntakeExtended],
    Field(discriminator="type"),
]


class Constraint(Model):
    id: str
    enabled: bool = True
    scope: Scope = Scope()
    data: ConstraintData


class Marker(Model):
    id: str
    name: str
    command: str = ""
    waypoint: int = 0
    offset: float = Field(0.0, description="Seconds relative to the waypoint's time")
    end_waypoint: Optional[int] = Field(None, description="Set to make this a zone marker")
    end_offset: float = 0.0
    recovery_policy: Literal["fireAtJoin", "fireImmediately", "skip"] = "fireAtJoin"
    must_hit: bool = Field(
        False, description="Recovery may not skip past this marker's time"
    )


class SolverSettings(Model):
    target_dt: float = Field(0.08, description="Target time between samples [s]")
    smoothing: float = Field(0.02, description="Weight of force-rate regularization")
    candidates: int = Field(3, description="Number of homotopy candidates to try")
    max_iterations: int = 1500
    time_limit: float = Field(60.0, description="Wall-clock budget per trajectory [s]")


class Trajectory(Model):
    format_version: int = FORMAT_VERSION
    name: str
    waypoints: list[Waypoint] = Field(default_factory=list)
    constraints: list[Constraint] = Field(default_factory=list)
    markers: list[Marker] = Field(default_factory=list)
    settings: SolverSettings = SolverSettings()
    folder: Optional[str] = Field(
        None, description="Sidebar folder; organisational only, ignored by the solver"
    )
    output: Optional["TrajectoryOutput"] = None


# ---------------------------------------------------------------------------
# Trajectory outputs (consumed by MayhemLib)
# ---------------------------------------------------------------------------


class Sample(Model):
    t: float
    x: float
    y: float
    heading: float
    vx: float
    vy: float
    omega: float
    ax: float
    ay: float
    alpha: float
    fx: list[float] = Field(description="Per-module field-frame force x [N]")
    fy: list[float] = Field(description="Per-module field-frame force y [N]")


class EventOut(Model):
    name: str
    command: str
    t: float
    end_t: Optional[float] = None
    recovery_policy: Literal["fireAtJoin", "fireImmediately", "skip"] = "fireAtJoin"
    must_hit: bool = False


class TerrainSpan(Model):
    """A stretch of the trajectory over rough terrain (from a roughTerrain constraint)."""

    t: float
    end_t: float
    expected_speed: float
    feedback_scale: float
    expected_delay: float = Field(description="Estimated time lost on this span [s]")


class IntakeSpan(Model):
    """A stretch of the trajectory where the intake is planned to be extended."""

    t: float
    end_t: float


class Limits(Model):
    """Conservative limits for the on-robot bridge planner."""

    max_velocity: float
    max_acceleration: float
    max_angular_velocity: float
    max_angular_acceleration: float


class RecoveryPayload(Model):
    bumper: list[tuple[float, float]] = Field(description="Bumper corners, robot frame")
    obstacles: list[list[tuple[float, float]]] = Field(
        description="Convex obstacle pieces incl. margin, field frame (blue)"
    )
    field_length: float
    field_width: float
    symmetry: Literal["mirror", "rotational"]
    roadmap_nodes: list[tuple[float, float]]
    roadmap_edges: list[tuple[int, int]]
    limits: Limits
    must_hit_times: list[float]


class SolveStats(Model):
    success: bool
    total_time: float
    solve_seconds: float
    iterations: int
    candidate: int
    attempts: list[str] = Field(default_factory=list)


class TrajectoryOutput(Model):
    input_hash: str
    samples: list[Sample]
    waypoint_times: list[float]
    splits: list[int] = Field(description="Sample indices where a new segment starts")
    events: list[EventOut]
    terrain: list[TerrainSpan] = Field(default_factory=list)
    intake: list[IntakeSpan] = Field(default_factory=list)
    recovery: RecoveryPayload
    stats: SolveStats


Trajectory.model_rebuild()


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


class PoseVariable(Model):
    id: str
    name: str
    x: float
    y: float
    heading: float = 0.0


class SimRobot(Model):
    """Another robot (ally or opponent) in the app's fuel playback sim.

    It drives a smooth curve through `points` with a trapezoidal speed profile, facing along the
    curve. Only used for playback; the solver ignores it.
    """

    id: str
    name: str = "Robot"
    alliance: Literal["blue", "red"] = "red"
    points: list[tuple[float, float]] = Field(default_factory=list)
    max_velocity: float = Field(3.0, gt=0)
    max_acceleration: float = Field(3.0, gt=0)
    start_delay: float = Field(0.0, ge=0, description="Seconds to wait before driving")
    size: float = Field(0.9, gt=0, description="Bumper-to-bumper width of its square frame [m]")
    intake: bool = Field(True, description="Intake out (at the front) while it drives")
    intake_rate: float = Field(10.0, ge=0, description="Fuel per second it can take in")
    capacity: int = Field(0, ge=0, description="Fuel it can hold; 0 = no limit")
    enabled: bool = True


class FuelSimConfig(Model):
    """Settings for the app's fuel playback sim (our robot's intake plus other robots' autos)."""

    intake_rate: float = Field(10.0, ge=0, description="Fuel per second our intake can take in")
    capacity: int = Field(0, ge=0, description="Fuel our robot can hold; 0 = no limit")
    robots: list[SimRobot] = Field(default_factory=list)


class Project(Model):
    format_version: int = FORMAT_VERSION
    name: str = "Mayhem Project"
    robot: RobotConfig = RobotConfig()
    field: Field_ = Field_()
    commands: list[str] = Field(default_factory=list)
    deploy_dir: str = Field(
        "", description="Robot project deploy dir (…/src/main/deploy/mayhem)"
    )
    poses: list[PoseVariable] = Field(default_factory=list)
    folders: list[str] = Field(
        default_factory=list, description="Path folders shown in the sidebar, in order"
    )
    fuel_sim: FuelSimConfig = Field(
        default_factory=FuelSimConfig, description="Fuel playback sim setup; not used by the solver"
    )


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


class Issue(Model):
    severity: Literal["error", "warning", "info"]
    message: str
    waypoint: Optional[int] = None
    t: Optional[float] = None
    x: Optional[float] = None
    y: Optional[float] = None
