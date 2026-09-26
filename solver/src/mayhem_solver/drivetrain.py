"""Drivetrain physics derived from a RobotConfig.

Motor constants match WPILib's DCMotor factory methods.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .models import RobotConfig

G = 9.81

# nominal voltage, stall torque [Nm], stall current [A], free current [A], free speed [rpm]
MOTORS: dict[str, tuple[float, float, float, float, float]] = {
    "krakenX60": (12.0, 7.09, 366.0, 2.0, 6000.0),
    "krakenX60Foc": (12.0, 9.37, 483.0, 2.0, 5800.0),
    "krakenX44": (12.0, 4.05, 275.0, 1.4, 7530.0),
    "falcon500": (12.0, 4.69, 257.0, 1.5, 6380.0),
    "falcon500Foc": (12.0, 5.84, 304.0, 1.5, 6080.0),
    "neo": (12.0, 2.6, 105.0, 1.8, 5676.0),
    "neoVortex": (12.0, 3.6, 211.0, 3.6, 6784.0),
}


@dataclass(frozen=True)
class Drivetrain:
    mass: float
    moi: float
    modules: tuple[tuple[float, float], ...]
    bumper_corners: tuple[tuple[float, float], ...]  # robot frame, CCW
    wheel_radius: float
    wheel_free_speed: float  # [m/s] at planning voltage
    wheel_stall_force: float  # [N] per module at planning voltage
    wheel_current_force: float  # [N] per module from stator current limit
    friction_force: float  # [N] per module, mu * m * g / n
    cog_height: float
    wheel_cof: float

    @property
    def n_modules(self) -> int:
        return len(self.modules)

    @property
    def max_wheel_force(self) -> float:
        return min(self.friction_force, self.wheel_current_force, self.wheel_stall_force)

    @property
    def max_linear_accel(self) -> float:
        return self.max_wheel_force * self.n_modules / self.mass

    @property
    def max_speed(self) -> float:
        return self.wheel_free_speed

    @property
    def module_radius(self) -> float:
        return max(math.hypot(x, y) for x, y in self.modules)

    @property
    def max_angular_velocity(self) -> float:
        return self.wheel_free_speed / self.module_radius

    @property
    def max_angular_accel(self) -> float:
        return self.max_wheel_force * self.n_modules * self.module_radius / self.moi

    @property
    def circumradius(self) -> float:
        return max(math.hypot(x, y) for x, y in self.bumper_corners)

    @property
    def inradius(self) -> float:
        return min(min(abs(x), abs(y)) for x, y in self.bumper_corners)


def build_drivetrain(cfg: RobotConfig) -> Drivetrain:
    v_nom, t_stall, i_stall, i_free, rpm_free = MOTORS[cfg.motor.type]
    r_ohm = v_nom / i_stall
    kt = t_stall / i_stall
    w_free_nom = rpm_free * 2 * math.pi / 60
    kv = w_free_nom / (v_nom - r_ohm * i_free)

    v = cfg.battery_voltage
    w_free = kv * (v - r_ohm * i_free)  # motor rad/s at planning voltage
    t_stall_v = kt * v / r_ohm

    g = cfg.motor.gearing
    r = cfg.wheel_radius
    eff = cfg.motor.efficiency
    wheel_free_speed = w_free / g * r
    wheel_stall_force = t_stall_v * g * eff / r
    wheel_current_force = kt * cfg.motor.current_limit * g * eff / r

    n = len(cfg.modules)
    friction = cfg.wheel_cof * cfg.mass * G / n

    b = cfg.bumper
    corners = ((b.front, b.left), (-b.back, b.left), (-b.back, -b.right), (b.front, -b.right))

    return Drivetrain(
        mass=cfg.mass,
        moi=cfg.moi,
        modules=tuple((float(x), float(y)) for x, y in cfg.modules),
        bumper_corners=corners,
        wheel_radius=r,
        wheel_free_speed=wheel_free_speed,
        wheel_stall_force=wheel_stall_force,
        wheel_current_force=wheel_current_force,
        friction_force=friction,
        cog_height=cfg.cog_height,
        wheel_cof=cfg.wheel_cof,
    )
