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
    margin: float = Field(0.03, description="Extra clearance around this obstacle [m]")
    enabled: bool = True


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
    margin: float = 0.03


ConstraintData = Annotated[
    Union[MaxVelocity, MaxAcceleration, MaxAngularVelocity, PointAt, KeepIn, KeepOut],
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
    recovery: RecoveryPayload
    stats: SolveStats


Trajectory.model_rebuild()


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


class Project(Model):
    format_version: int = FORMAT_VERSION
    name: str = "Mayhem Project"
    robot: RobotConfig = RobotConfig()
    field: Field_ = Field_()
    commands: list[str] = Field(default_factory=list)
    deploy_dir: str = Field(
        "", description="Robot project deploy dir (…/src/main/deploy/mayhem)"
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
