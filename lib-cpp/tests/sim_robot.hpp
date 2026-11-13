#pragma once
// Reference robot for the sim tests: 68 kg, 0.525 m square wheelbase, Kraken X60 (FOC) at
// 5.9:1 on 2 in wheels (~5.2 m/s free), 18.75:1 steer with 3.125 coupling; Phoenix gains from
// Team 3256's 2026 TunerConstants.
#include "mayhem/sim/swerve_requests.hpp"

namespace simtest {

using namespace mayhem::sim;

inline SwerveParams ReferenceParams(double frameClearance = 0.041) {
  SwerveParams p;
  p.massKg = 68;
  p.moiKgM2 = 5.5;
  p.cgHeightM = 0.18;
  const double a = 0.2627;
  p.modulePositions = {{a, a}, {a, -a}, {-a, a}, {-a, -a}};  // FL, FR, BL, BR
  p.wheelRadius = 0.0508;
  p.driveGearing = 5.902777777777778;
  p.steerGearing = 18.75;
  p.couplingRatio = 3.125;
  p.driveMotor = DcMotor::KrakenX60();
  p.driveMotorFoc = DcMotor::KrakenX60Foc();
  p.wheelInertia = 0.004;
  p.steerInertia = 0.004;
  p.bumperLengthX = p.bumperLengthY = 0.84;
  p.frameClearanceM = frameClearance;
  return p;
}

inline swerve::DrivetrainConstants ReferenceConstants(const SwerveParams& p) {
  return swerve::DrivetrainConstants::From(p, 5.23);
}

inline SlotGains SteerGains() {
  SlotGains g;
  g.kP = 100; g.kD = 0.5; g.kS = 0.1; g.kV = 2.33;
  g.staticSign = SlotGains::StaticSign::ClosedLoopSign;
  return g;
}
inline SlotGains DriveGains() {
  SlotGains g;
  g.kP = 0.1; g.kV = 0.124;
  return g;
}

/** A robot plus the Phoenix request emulator, stepped like a 50 Hz robot loop over 1 ms physics. */
struct Rig {
  SwerveSim sim;
  swerve::SwerveRequestEmulator requests;
  double time = 0;
  explicit Rig(SwerveParams p = ReferenceParams())
      : sim(p), requests(ReferenceConstants(p)) {
    swerve::ConfigureLikePhoenix(sim, requests.Constants(), SteerGains(), DriveGains(), 120);
  }
  /** Run `seconds` with `request` re-applied every 20 ms; onMs is called after every 1 ms step. */
  template <class F>
  void Run(const swerve::SwerveRequest& request, double seconds, const Terrain* terrain, const Obstacles* obstacles,
           F&& onMs) {
    const int loops = static_cast<int>(seconds / 0.02 + 0.5);
    for (int l = 0; l < loops; ++l) {
      requests.Apply(request, sim, swerve::SwerveRequestEmulator::ParamsFrom(sim, time));
      for (int k = 0; k < 20; ++k) {
        sim.Step(0.001, 12.5, terrain, obstacles);
        time += 0.001;
        onMs();
      }
    }
  }
  void Run(const swerve::SwerveRequest& request, double seconds, const Terrain* terrain = nullptr,
           const Obstacles* obstacles = nullptr) {
    Run(request, seconds, terrain, obstacles, [] {});
  }
};

inline swerve::FieldCentric Drive(double vx, double vy = 0, double omega = 0) {
  swerve::FieldCentric r;
  r.velocityX = vx; r.velocityY = vy; r.rotationalRate = omega;
  r.driveRequestType = swerve::DriveRequestType::Velocity;
  r.forwardPerspective = swerve::ForwardPerspective::BlueAlliance;
  return r;
}

}  // namespace simtest
