import math

from mayhem_solver.drivetrain import build_drivetrain
from mayhem_solver.models import RobotConfig


def test_kraken_numbers_are_sane():
    d = build_drivetrain(RobotConfig())
    # Kraken X60 @ 11V, 6.75:1, 2in wheel -> ~4.2 m/s
    assert 3.8 < d.max_speed < 4.6
    assert math.isclose(d.friction_force, 1.2 * 60 * 9.81 / 4, rel_tol=1e-6)
    assert d.max_wheel_force == min(d.friction_force, d.wheel_current_force, d.wheel_stall_force)
    assert d.inradius == 0.45 and math.isclose(d.circumradius, math.hypot(0.45, 0.45))


def test_current_limit_reduces_force():
    lo = build_drivetrain(RobotConfig(motor={"currentLimit": 20}))
    hi = build_drivetrain(RobotConfig(motor={"currentLimit": 120}))
    assert lo.wheel_current_force < hi.wheel_current_force
