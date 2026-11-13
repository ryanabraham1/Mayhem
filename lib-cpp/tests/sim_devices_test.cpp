// Motor curves, TalonFX emulation, battery and 1-DOF mechanisms.
#include "mayhem/sim/battery.hpp"
#include "mayhem/sim/mechanisms.hpp"
#include "mayhem/sim/motor.hpp"
#include "mayhem/sim/talonfx.hpp"
#include "sim_check.hpp"

using namespace mayhem::sim;

namespace {

constexpr double kDt = 0.001;

// Free speed: unloaded rotor at 12 V settles at the published free speed and free current.
void MotorCurves() {
  for (const DcMotor m : {DcMotor::KrakenX60(), DcMotor::KrakenX60Foc(), DcMotor::Falcon500(), DcMotor::KrakenX44(), DcMotor::Neo()}) {
    TalonFxConfig cfg;
    cfg.supplyLimitEnable = cfg.statorLimitEnable = false;
    TalonFx talon(m, cfg);
    talon.SetControl(VoltageOut{12});
    Flywheel rotor{1e-4, 1, 0, 0};
    for (int i = 0; i < 3000; ++i) rotor.Step(kDt, talon.Step(kDt, 12, rotor.RotorPosition(), rotor.RotorVelocity()), talon.RotorDamping());
    SIM_NEAR(rotor.Velocity(), m.freeSpeed, 0.01 * m.freeSpeed, "free speed");
    SIM_NEAR(talon.StatorCurrent(), m.freeCurrent, 0.2, "free current");
    // Stall: rotor held still.
    talon.Step(kDt, 12, 0, 0);
    SIM_NEAR(talon.TorqueCurrent(), m.stallCurrent, 1e-6 * m.stallCurrent, "stall current");
    SIM_NEAR(talon.TorqueAt(0), m.stallTorque, 1e-9, "stall torque");
  }
  // Kv / R / Kt identities.
  const auto k = DcMotor::KrakenX60();
  SIM_NEAR(k.Current(k.freeSpeed, 12), k.freeCurrent, 1e-9, "Current() at free speed");
  SIM_NEAR(k.WithCount(2).stallTorque, 2 * k.stallTorque, 1e-12, "WithCount");
  SIM_NEAR(k.WithCount(2).R(), k.R() / 2, 1e-12, "WithCount resistance");
  SIM_NEAR(k.WithCount(2).Kv(), k.Kv(), 1e-9, "WithCount Kv");
}

void FocCurve() {
  TalonFx talon = TalonFx::KrakenX60();
  TalonFxConfig cfg;
  cfg.statorLimitEnable = cfg.supplyLimitEnable = false;
  talon.Configure(cfg);
  talon.SetControl(VoltageOut{12, true});
  talon.Step(kDt, 12, 0, 0);
  SIM_NEAR(talon.TorqueAt(0), 9.37, 1e-9, "FOC stall torque");
  talon.SetControl(VoltageOut{12, false});
  talon.Step(kDt, 12, 0, 0);
  SIM_NEAR(talon.TorqueAt(0), 7.09, 1e-9, "trapezoidal stall torque");
}

// Shooter-like flywheel under velocity closed loop.
void VelocityLoop() {
  TalonFxConfig cfg;
  cfg.slots[0].kP = 0.5;
  cfg.slots[0].kV = 12.0 / (6000.0 / 60.0 / 1.5);  // V per mechanism rot/s
  cfg.sensorToMechanismRatio = 1.5;
  TalonFx talon(DcMotor::KrakenX60(), cfg);
  Flywheel wheel{0.004, 1.5, 0, 0.02};
  talon.SetControl(VelocityVoltage{40});
  double peakStator = 0;
  for (int i = 0; i < 2000; ++i) {
    wheel.Step(kDt, talon.Step(kDt, 12, wheel.RotorPosition(), wheel.RotorVelocity()), talon.RotorDamping());
    peakStator = std::max(peakStator, std::abs(talon.StatorCurrent()));
  }
  SIM_NEAR(talon.Velocity(), 40, 0.4, "flywheel velocity (mechanism rps)");
  SIM_NEAR(wheel.Velocity() / (2 * kPi), 40, 0.4, "flywheel physical speed");
  SIM_CHECK(peakStator <= 120.5, "stator limit held: %.1f", peakStator);
  // A game piece takes energy out; the loop recovers.
  const double before = wheel.Velocity();
  wheel.RemoveEnergy(0.25 * wheel.Energy());
  SIM_CHECK(wheel.Velocity() < before * 0.9, "energy removed");
  for (int i = 0; i < 1500; ++i) wheel.Step(kDt, talon.Step(kDt, 12, wheel.RotorPosition(), wheel.RotorVelocity()), talon.RotorDamping());
  SIM_NEAR(talon.Velocity(), 40, 0.4, "flywheel recovers");
}

// Elevator (50 lb carriage-ish) with position control and gravity feedforward.
void PositionAndMotionMagic() {
  auto makeElevator = [] { return Elevator{8, 0.0254, 9, 0, 1.2, kPi / 2, 0, 0.1}; };
  // Mechanism units: drum rotations (sensorToMechanismRatio = gearing).
  TalonFxConfig cfg;
  cfg.sensorToMechanismRatio = 9;
  cfg.slots[0].kP = 60;
  cfg.slots[0].kD = 1;
  cfg.slots[0].kG = 0.35;
  cfg.slots[0].kV = 1.1;
  cfg.mmCruiseVelocity = 4;
  cfg.mmAcceleration = 12;
  cfg.neutral = TalonFxConfig::Neutral::Brake;
  const double target = 1.0 / (2 * kPi * 0.0254);  // drum rotations for 1 m

  // PositionVoltage.
  {
    Elevator e = makeElevator();
    TalonFx talon(DcMotor::KrakenX60(), cfg);
    talon.SetMechanismPosition(e.Position() / (2 * kPi * 0.0254));
    talon.SetControl(PositionVoltage{target});
    for (int i = 0; i < 3000; ++i) e.Step(kDt, talon.Step(kDt, 12, e.RotorPosition(), e.RotorVelocity()), talon.RotorDamping());
    SIM_NEAR(e.Position(), 1.0, 0.01, "PositionVoltage elevator height");
    SIM_NEAR(talon.Position(), target, 0.05, "PositionVoltage reported position");
  }
  // Motion Magic trapezoid: reference never exceeds cruise, reaches target.
  for (int mode = 0; mode < 3; ++mode) {
    Elevator e = makeElevator();
    TalonFxConfig c = cfg;
    if (mode == 1) c.mmJerk = 100;
    TalonFx talon(DcMotor::KrakenX60(), c);
    talon.SetMechanismPosition(e.Position() / (2 * kPi * 0.0254));
    if (mode == 2) {
      c.mmExpoKv = 1.1;
      c.mmExpoKa = 0.2;
      talon.Configure(c);
      talon.SetControl(MotionMagicExpoVoltage{target});
    } else {
      talon.SetControl(MotionMagicVoltage{target});
    }
    double maxRefVel = 0, maxErr = 0, prevRef = talon.Position();
    for (int i = 0; i < 4000; ++i) {
      e.Step(kDt, talon.Step(kDt, 12, e.RotorPosition(), e.RotorVelocity()), talon.RotorDamping());
      const double ref = talon.ClosedLoopReference();
      maxRefVel = std::max(maxRefVel, (ref - prevRef) / kDt);
      prevRef = ref;
      maxErr = std::max(maxErr, std::abs(talon.ClosedLoopError()));
    }
    const char* name = mode == 0 ? "MotionMagic" : (mode == 1 ? "MotionMagic+jerk" : "MotionMagicExpo");
    std::printf("%s: max reference velocity %.3f rot/s, max tracking error %.4f rot, final %.4f m\n", name, maxRefVel,
                maxErr, e.Position());
    SIM_NEAR(e.Position(), 1.0, 0.01, name);
    if (mode < 2) SIM_CHECK(maxRefVel <= c.mmCruiseVelocity + 1e-6, "%s cruise velocity respected: %.4f", name, maxRefVel);
    else SIM_CHECK(maxRefVel <= 12 / c.mmExpoKv + 1e-6, "Expo max velocity respected: %.4f", maxRefVel);
  }
}

// Arm with ArmCosine kG: exact gravity feedforward holds it at any angle with kP = 0.
void ArmGravity() {
  const double gearing = 60, mass = 3, length = 0.4;
  const DcMotor m = DcMotor::KrakenX60();
  // Volts that cancel gravity at horizontal: torque = m g L / gearing at the rotor.
  const double kG = mass * kGravity * length / gearing / m.Kt() * m.R();
  for (double start : {0.0, 0.6, -0.4}) {
    Arm arm{0.5, gearing, mass, length, -1.5, 1.5, 0, start};
    TalonFxConfig cfg;
    cfg.sensorToMechanismRatio = gearing;
    cfg.slots[0].kG = kG;
    cfg.slots[0].gravity = SlotGains::Gravity::ArmCosine;
    cfg.slots[0].kD = 2;
    TalonFx talon(m, cfg);
    talon.SetMechanismPosition(start / (2 * kPi));
    talon.SetControl(PositionVoltage{start / (2 * kPi)});
    for (int i = 0; i < 1000; ++i) arm.Step(kDt, talon.Step(kDt, 12, arm.RotorPosition(), arm.RotorVelocity()), talon.RotorDamping());
    // Internal friction of the motor slightly helps; the arm must not sag.
    SIM_NEAR(arm.Angle(), start, 0.01, "ArmCosine kG holds the arm");
  }
  // Pitch offset changes gravity: tilting the robot makes the held arm sag.
  Arm arm{0.5, gearing, mass, length, -1.5, 1.5, 0, 0};
  arm.SetPitchOffset(0.5);
  TalonFxConfig cfg;
  cfg.sensorToMechanismRatio = gearing;
  cfg.slots[0].kG = kG;
  cfg.slots[0].gravity = SlotGains::Gravity::ArmCosine;
  TalonFx talon(m, cfg);
  talon.SetControl(PositionVoltage{0});
  for (int i = 0; i < 500; ++i) arm.Step(kDt, talon.Step(kDt, 12, arm.RotorPosition(), arm.RotorVelocity()), talon.RotorDamping());
  SIM_CHECK(arm.Angle() > 0.005, "tilted robot changes the arm's gravity torque: %.4f", arm.Angle());
}

// Current limits: stator limit at stall, supply limit with the lower limit after the lower time.
void CurrentLimits() {
  {
    TalonFxConfig cfg;
    cfg.statorLimit = 40;
    TalonFx talon(DcMotor::KrakenX60(), cfg);
    talon.SetControl(VoltageOut{12});
    talon.Step(kDt, 12, 0, 0);
    SIM_NEAR(talon.StatorCurrent(), 40, 1e-6, "stator limit at stall");
    SIM_NEAR(talon.TorqueAt(0), 40 * DcMotor::KrakenX60().Kt(), 1e-9, "torque at the stator limit");
  }
  {
    // A spinning load that demands > 70 A supply: flywheel with heavy viscous drag.
    TalonFxConfig cfg;
    cfg.statorLimit = 200;
    TalonFx talon(DcMotor::KrakenX60(), cfg);
    Flywheel load{0.01, 1, 0.12, 0};
    talon.SetControl(VoltageOut{12});
    double maxSupply = 0, lateSupply = 0;
    for (int i = 0; i < 3000; ++i) {
      load.Step(kDt, talon.Step(kDt, 12, load.RotorPosition(), load.RotorVelocity()), talon.RotorDamping());
      if (i > 200 && i < 900) maxSupply = std::max(maxSupply, talon.SupplyCurrent());
      if (i > 1300) lateSupply = std::max(lateSupply, talon.SupplyCurrent());
    }
    std::printf("supply limit: %.2f A before lower time, %.2f A after\n", maxSupply, lateSupply);
    SIM_CHECK(maxSupply <= 70 + 1e-6 && maxSupply > 65, "supply limit 70 A: %.3f", maxSupply);
    SIM_CHECK(lateSupply <= 40 + 1e-6 && talon.SupplyLimitLowered(), "lowered to 40 A: %.3f", lateSupply);
  }
  {
    // Torque current request is honoured up to the peak torque current.
    TalonFx talon(DcMotor::KrakenX60Foc());
    talon.SetControl(TorqueCurrentFOC{60});
    talon.Step(kDt, 12, 0, 0);
    SIM_NEAR(talon.TorqueCurrent(), 60, 1e-9, "TorqueCurrentFOC amps");
  }
}

// Brake vs coast, follower directions.
void NeutralAndFollowers() {
  Flywheel w1{0.002, 1, 0, 0}, w2{0.002, 1, 0, 0};
  w1.SetState(0, 300);
  w2.SetState(0, 300);
  TalonFxConfig brake;
  brake.neutral = TalonFxConfig::Neutral::Brake;
  TalonFx a(DcMotor::KrakenX60(), brake), b(DcMotor::KrakenX60());
  for (int i = 0; i < 300; ++i) {
    w1.Step(kDt, a.Step(kDt, 12, w1.RotorPosition(), w1.RotorVelocity()), a.RotorDamping());
    w2.Step(kDt, b.Step(kDt, 12, w2.RotorPosition(), w2.RotorVelocity()), b.RotorDamping());
  }
  SIM_CHECK(w1.Velocity() < 0.2 * w2.Velocity(), "brake stops faster than coast: %.1f vs %.1f", w1.Velocity(), w2.Velocity());

  // Leader (not inverted) + opposed follower (not inverted): the follower's rotor turns the other
  // raw way, i.e. both drive the shared mechanism the same way when wired in the leader's frame.
  TalonFx leader(DcMotor::KrakenX60()), follower(DcMotor::KrakenX60());
  follower.SetLeader(&leader);
  follower.SetControl(Follower{1, true});
  leader.SetControl(VoltageOut{6});
  leader.Step(kDt, 12, 0, 0);
  const double tf = follower.Step(kDt, 12, 0, 0);
  SIM_NEAR(follower.MotorVoltage(), -leader.MotorVoltage(), 1e-9, "opposed follower voltage (its own frame)");
  SIM_CHECK(tf > 0, "follower torque helps the leader in the mechanism frame: %.3f", tf);
  follower.SetControl(StrictFollower{1});
  follower.Step(kDt, 12, 0, 0);
  SIM_NEAR(follower.MotorVoltage(), leader.MotorVoltage(), 1e-9, "strict follower voltage");
}

void BatteryAndStops() {
  Battery battery;
  SIM_NEAR(battery.Step(100), 12.6 - 102 * 0.023, 1e-9, "battery sag at 100 A (+2 A base load)");
  SIM_CHECK(!battery.Brownout(), "no brownout at 100 A");
  battery.Step(300);
  SIM_CHECK(battery.Brownout(), "brownout below 6.75 V: %.2f", battery.Voltage());
  // Driving an elevator into its top stop at full voltage: clamps, no NaN, no overshoot.
  Elevator e{5, 0.02, 5, 0, 0.5, kPi / 2, 0, 0};
  TalonFxConfig cfg;
  cfg.statorLimitEnable = cfg.supplyLimitEnable = false;
  TalonFx talon(DcMotor::KrakenX60(), cfg);
  talon.SetControl(VoltageOut{12});
  double maxPos = 0;
  for (int i = 0; i < 3000; ++i) {
    e.Step(kDt, talon.Step(kDt, 12, e.RotorPosition(), e.RotorVelocity()), talon.RotorDamping());
    maxPos = std::max(maxPos, e.Position());
    SIM_CHECK(std::isfinite(e.Position()), "finite");
  }
  SIM_CHECK(maxPos <= 0.5 + 1e-12 && e.AtUpperStop(), "rigid stop holds: %.6f", maxPos);
  // Spring stop: small, bounded penetration.
  Arm arm{0.2, 50, 2, 0.3, -1, 1, 2000, 0};
  TalonFx t2(DcMotor::KrakenX60(), cfg);
  t2.SetControl(VoltageOut{12});
  double maxAngle = 0;
  for (int i = 0; i < 2000; ++i) {
    arm.Step(kDt, t2.Step(kDt, 12, arm.RotorPosition(), arm.RotorVelocity()), t2.RotorDamping());
    maxAngle = std::max(maxAngle, arm.Angle());
  }
  SIM_CHECK(maxAngle < 1.2 && std::isfinite(maxAngle), "spring stop bounded: %.4f", maxAngle);
}

}  // namespace

int main() {
  MotorCurves();
  FocCurve();
  VelocityLoop();
  PositionAndMotionMagic();
  ArmGravity();
  CurrentLimits();
  NeutralAndFollowers();
  BatteryAndStops();
  return SimResult("sim_devices");
}
