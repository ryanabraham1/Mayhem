// Swerve plant: traction/current-limited acceleration, top speed, sliding, walls, the REBUILT
// bump (straight, 45 degrees, crawling high-centre), braking on a ramp, static slope loads,
// Phoenix request emulation and determinism.
#include <chrono>
#include <cstring>
#include <vector>

#include "sim_check.hpp"
#include "sim_robot.hpp"

using namespace mayhem::sim;
using namespace simtest;

namespace {

constexpr double kDeg = kPi / 180;

// REBUILT BUMP (2026 manual 5.5): 1.128 m deep, 1.854 m wide, 0.1654 m tall, two 15-degree HDPE
// ramps meeting at a ridge; the 1.27 cm ramp board leaves a lip at each toe.
void AddRebuiltBump(Terrain& t, double cx, double cy, double yaw) {
  t.AddProfile(cx, cy, yaw, 1.854,
               {{-0.564, 0}, {-0.556, 0.0127}, {0, 0.1654}, {0.556, 0.0127}, {0.564, 0}});
}

bool Finite(const SwerveSim& s) {
  const auto p = s.Pose3();
  return std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z) && std::isfinite(p.roll) &&
         std::isfinite(p.pitch) && std::isfinite(p.yaw);
}

void AccelerationAndTopSpeed() {
  // Open loop at 12 V: traction-limited launch, then the FOC free speed (5.23 m/s at 12 V).
  Rig rig;
  swerve::FieldCentric full = Drive(0);
  full.driveRequestType = swerve::DriveRequestType::OpenLoopVoltage;
  full.velocityX = 5.23;  // 12 V
  full.desaturateWheelSpeeds = false;
  double v250 = 0;
  int ms = 0;
  rig.Run(full, 3.0, nullptr, nullptr, [&] { if (++ms == 250) v250 = rig.sim.FieldVelocity().vx; });
  const double top = rig.sim.FieldVelocity().vx;
  const double launch = v250 / 0.25;
  const auto& p = rig.sim.Params();
  std::printf("open loop 12 V: launch %.2f m/s^2 (mu_k g %.2f, mu_s g %.2f), top speed %.3f m/s\n", launch,
              p.muKinetic * kGravity, p.muStatic * kGravity, top);
  SIM_NEAR(top, 5.2, 0.1, "top speed");
  SIM_CHECK(launch > 0.8 * p.muKinetic * kGravity && launch < 1.02 * p.muStatic * kGravity,
            "traction-limited launch: %.2f", launch);

  // Current-limited: 40 A slip current is far below the traction limit.
  SwerveParams sp = ReferenceParams();
  SwerveSim sim(sp);
  auto c = ReferenceConstants(sp);
  swerve::ConfigureLikePhoenix(sim, c, SteerGains(), DriveGains(), 40);
  for (std::size_t i = 0; i < 4; ++i) {
    sim.DriveMotor(i).SetControl(VoltageOut{12});
    sim.SteerMotor(i).SetControl(PositionVoltage{0});  // coupling torque must not turn the modules
  }
  for (int i = 0; i < 100; ++i) sim.Step(0.001, 12.5);
  const double motorTorque = 40 * DcMotor::KrakenX60Foc().Kt() - DcMotor::KrakenX60Foc().FrictionTorque();
  // Effective mass includes the four wheels' rotational inertia (J / R^2 each).
  const double effectiveMass = sp.massKg + 4 * sp.wheelInertia / (sp.wheelRadius * sp.wheelRadius);
  const double expected = 4 * motorTorque * sp.driveGearing * sp.driveEfficiency / sp.wheelRadius / effectiveMass -
                          sp.rollingResistance * kGravity * sp.massKg / effectiveMass;
  const double measured = sim.FieldVelocity().vx / 0.1;
  std::printf("40 A current-limited launch: %.3f m/s^2 (closed form %.3f)\n", measured, expected);
  SIM_NEAR(measured, expected, 0.05 * expected, "current-limited acceleration");
}

void LateralSlide() {
  // Wheels locked forward, robot sliding sideways at 3 m/s: kinetic friction stops it.
  Rig rig;
  swerve::PointWheelsAt fwd;
  fwd.moduleDirection = 0;
  rig.Run(fwd, 0.3);
  rig.sim.SetVelocity(0, 3, 0);
  double t = 0, stopped = -1, slip = 0;
  rig.Run(fwd, 1.0, nullptr, nullptr, [&] {
    t += 0.001;
    slip = std::max(slip, rig.sim.ModuleSlip(0));
    if (stopped < 0 && std::abs(rig.sim.FieldVelocity().vy) < 0.01) stopped = t;
  });
  const double decel = 3 / stopped;
  std::printf("lateral slide from 3 m/s: stops in %.3f s (%.2f m/s^2, mu_k g = %.2f), peak slip %.2f m/s\n", stopped,
              decel, kGravity, slip);
  SIM_CHECK(stopped > 0, "stops");
  SIM_CHECK(decel > 0.85 * kGravity && decel < 1.15 * 1.2 * kGravity, "kinetic decel %.2f", decel);
  SIM_CHECK(std::abs(rig.sim.FieldVelocity().vy) < 0.01 && std::abs(rig.sim.FieldVelocity().vx) < 0.05, "at rest");

  // Commanding a lateral speed with the wheels turning: steer settles, robot reaches it.
  Rig r2;
  r2.Run(Drive(0, 2.0), 1.5);
  SIM_NEAR(r2.sim.FieldVelocity().vy, 2.0, 0.08, "field-centric strafe speed");
  SIM_NEAR(std::cos(r2.sim.ModuleSteerAngle(0)), 0.0, 0.05, "modules pointed sideways");
}

void Walls() {
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 8, 8, 0.3);
  obstacles.AddBox("thin_panel", 3, 6, 0, 0.05, 2.0);  // 5 cm thick panel
  Rig rig;
  rig.sim.SetPose(5, 2, 0);
  double maxFront = 0;
  bool sawWall = false;
  rig.Run(Drive(5.0), 2.5, nullptr, &obstacles, [&] {
    maxFront = std::max(maxFront, rig.sim.Pose().x + 0.42);
    for (const auto& e : rig.sim.Contacts()) sawWall = sawWall || e.name == "perimeter/xmax";
  });
  std::printf("wall at 8.000: deepest bumper position %.4f, final speed %.3f\n", maxFront, rig.sim.FieldVelocity().vx);
  SIM_CHECK(sawWall, "contact event for perimeter/xmax");
  SIM_CHECK(maxFront < 8.03, "no tunnelling: %.4f", maxFront);
  SIM_CHECK(std::abs(rig.sim.FieldVelocity().vx) < 0.05 && Finite(rig.sim), "stopped, finite");
  SIM_CHECK(std::abs(rig.sim.Pose3().pitch) < 5 * kDeg, "no explosion");

  // Full speed into a 5 cm panel: never pushed through.
  Rig r2;
  r2.sim.SetPose(1, 6, 0);
  double maxX = 0;
  r2.Run(Drive(5.2), 2.0, nullptr, &obstacles, [&] { maxX = std::max(maxX, r2.sim.Pose().x); });
  std::printf("thin panel at x 2.975..3.025: robot centre max %.4f\n", maxX);
  SIM_CHECK(maxX < 3 - 0.025 - 0.42 + 0.03, "thin panel not tunnelled: %.4f", maxX);

  // Overhead structure: a short robot drives under, a tall one does not.
  Obstacles trench;
  trench.AddBox("trench", 3, 2, 0, 0.3, 1.3, 0.5652, 1.0);
  for (double height : {0.5, 0.7}) {
    Rig r;
    r.sim.SetRobotHeight(height);
    r.sim.SetPose(1.5, 2, 0);
    r.Run(Drive(2.0), 2.0, nullptr, &trench);
    const bool passed = r.sim.Pose().x > 3.5;
    std::printf("robot %.2f m tall under a 0.5652 m trench: %s\n", height, passed ? "passes" : "blocked");
    SIM_CHECK(passed == (height < 0.5652), "trench clearance");
  }
}

struct Crossing {
  double maxPitch = 0, maxRoll = 0, minSpeed = 1e9, maxDepth = 0, maxFrameForce = 0, minWheel = 1e9, maxZ = 0, minZ = 1e9;
  bool crossed = false, beached = false, finite = true;
  double seconds = 0;
};

Crossing CrossBump(double speed, double heading, double clearance, double maxSeconds = 6, double bumperBottom = 0.06) {
  Terrain terrain;
  AddRebuiltBump(terrain, 4, 4, 0);
  SwerveParams p = ReferenceParams(clearance);
  p.bumperBottomM = bumperBottom;
  Rig rig(p);
  const double start = 1.6;
  rig.sim.SetPose(4 - start, 4, heading, &terrain);
  Crossing c;
  const double k = p.tireNormalStiffness;
  rig.Run(Drive(speed), 0.6, &terrain, nullptr);  // get up to speed before the bump
  int ms = 0;
  const int limit = static_cast<int>(maxSeconds * 1000);
  while (ms < limit && rig.sim.Pose().x < 4 + 1.3) {
    rig.Run(Drive(speed), 0.02, &terrain, nullptr, [&] {
      ++ms;
      const auto pose = rig.sim.Pose3();
      c.maxPitch = std::max(c.maxPitch, std::abs(pose.pitch));
      c.maxRoll = std::max(c.maxRoll, std::abs(pose.roll));
      c.maxZ = std::max(c.maxZ, pose.z);
      c.minZ = std::min(c.minZ, pose.z);
      if (pose.x > 3.0 && pose.x < 5.0) c.minSpeed = std::min(c.minSpeed, rig.sim.FieldVelocity().vx);
      for (std::size_t i = 0; i < 4; ++i) {
        c.maxDepth = std::max(c.maxDepth, rig.sim.ModuleNormalForce(i) / k);
        if (pose.x > 3.2 && pose.x < 4.8) c.minWheel = std::min(c.minWheel, rig.sim.ModuleNormalForce(i));
      }
      c.maxFrameForce = std::max(c.maxFrameForce, rig.sim.FrameContactForce());
      c.beached = c.beached || rig.sim.Beached();
      c.finite = c.finite && Finite(rig.sim);
    });
  }
  c.crossed = rig.sim.Pose().x >= 4 + 1.3;
  c.seconds = ms / 1000.0;
  return c;
}

void Bump() {
  const double staticLoad = 68 * kGravity / 4;
  // Straight on, generous 8 cm clearance: crosses at every speed, pitch follows the 15-degree ramps.
  for (double speed : {1.0, 2.0, 4.0}) {
    const auto c = CrossBump(speed, 0, 0.08);
    std::printf("bump straight %.0f m/s (8 cm clearance): crossed %d in %.2f s, max pitch %.1f deg, min speed %.2f, "
                "max z %.3f, max tread compression %.1f mm, frame force %.0f N, min wheel load %.0f N\n",
                speed, c.crossed, c.seconds, c.maxPitch / kDeg, c.minSpeed, c.maxZ, c.maxDepth * 1000, c.maxFrameForce,
                c.minWheel);
    SIM_CHECK(c.finite && c.crossed, "crosses at %.0f m/s", speed);
    SIM_CHECK(c.maxPitch > 8 * kDeg && c.maxPitch < 30 * kDeg, "pitch %.1f deg", c.maxPitch / kDeg);
    // Landing off the ridge compresses the tread; the wheel centre stays well above the surface.
    SIM_CHECK(c.maxDepth < 0.03, "nothing passes through: %.4f", c.maxDepth);
    SIM_CHECK(c.minZ > -0.03, "robot never sinks below the floor: %.4f", c.minZ);
    SIM_CHECK(c.minSpeed < speed - 0.05, "climbing costs speed (%.2f)", c.minSpeed);
  }
  // 45 degrees: roll appears and a wheel unloads.
  {
    const auto c = CrossBump(1.5, 45 * kDeg, 0.08);
    std::printf("bump at 45 deg: crossed %d, max roll %.1f deg, max pitch %.1f deg, min wheel load %.0f N (static %.0f)\n",
                c.crossed, c.maxRoll / kDeg, c.maxPitch / kDeg, c.minWheel, staticLoad);
    SIM_CHECK(c.finite && c.crossed, "crosses at 45 deg");
    SIM_CHECK(c.maxRoll > 3 * kDeg, "roll appears: %.2f deg", c.maxRoll / kDeg);
    SIM_CHECK(c.minWheel < 0.5 * staticLoad, "a wheel unloads: %.0f N", c.minWheel);
  }
  // This robot's 4.1 cm belly pan on the ridge: crawling high-centres it.
  {
    const auto c = CrossBump(0.3, 0, 0.041, 8);
    std::printf("crawl 0.3 m/s with 4.1 cm clearance: beached %d, crossed %d, frame force %.0f N, min wheel load %.0f N\n",
                c.beached, c.crossed, c.maxFrameForce, c.minWheel);
    SIM_CHECK(c.finite && c.beached, "high-centred on the ridge");
  }
  {
    const auto c = CrossBump(4.0, 0, 0.041);
    std::printf("4 m/s with 4.1 cm clearance: crossed %d, beached %d, frame force %.0f N, min speed %.2f\n", c.crossed,
                c.beached, c.maxFrameForce, c.minSpeed);
    SIM_CHECK(c.finite, "finite at 4 m/s, low clearance");
  }
}

void RampHoldAndSlopeLoads() {
  // A long 10-degree ramp; the robot parks on it facing uphill.
  for (double mu : {1.2, 0.15}) {
    Terrain terrain;
    const double angle = 15 * kDeg, length = 6;
    terrain.AddRamp(5, 4, 0, length, 4, 0, length * std::tan(angle));
    SwerveParams p = ReferenceParams(0.08);
    p.muStatic = mu;
    p.muKinetic = mu * 0.85;
    Rig rig(p);
    rig.sim.SetPose(5, 4, 0, &terrain);
    swerve::SwerveDriveBrake brake;
    rig.Run(brake, 0.5, &terrain, nullptr);  // settle into the X
    const double x0 = rig.sim.Pose().x;
    rig.Run(brake, 2.0, &terrain, nullptr);
    const double moved = rig.sim.Pose().x - x0;
    std::printf("X-brake on a 15-degree ramp, mu_s %.2f: moved %.4f m in 2 s\n", mu, moved);
    if (mu > std::tan(angle)) SIM_CHECK(std::abs(moved) < 0.01, "holds: %.4f", moved);
    else SIM_CHECK(moved < -0.2, "slides down: %.4f", moved);
  }
  // Static wheel loads on a 10-degree slope vs the rigid-body closed form.
  {
    Terrain terrain;
    const double angle = 10 * kDeg, length = 6;
    terrain.AddRamp(5, 4, 0, length, 4, 0, length * std::tan(angle));
    SwerveParams p = ReferenceParams(0.08);
    Rig rig(p);
    rig.sim.SetPose(5, 4, 0, &terrain);
    swerve::SwerveDriveBrake brake;
    rig.Run(brake, 2.0, &terrain, nullptr);
    const double m = p.massKg, g = kGravity, a = 0.2627, h = p.cgHeightM;
    // Front (uphill) pair total: N_f 2a = m g (a cos - h sin).
    const double front = m * g * (a * std::cos(angle) - h * std::sin(angle)) / (2 * a) / 2;
    const double rear = m * g * std::cos(angle) / 2 - front;
    const double fl = rig.sim.ModuleNormalForce(0), bl = rig.sim.ModuleNormalForce(2);
    std::printf("10-degree slope loads: front %.1f N (closed form %.1f), rear %.1f N (closed form %.1f), pitch %.2f deg\n",
                fl, front, bl, rear, rig.sim.Pose3().pitch / kDeg);
    // Wheel normals are perpendicular to the ramp; the closed form counts those components.
    SIM_NEAR(fl, front, 0.03 * front, "front wheel load");
    SIM_NEAR(bl, rear, 0.03 * rear, "rear wheel load");
  }
}

void Requests() {
  using namespace swerve;
  // Discretize: pure translation unchanged; rotation bends translation per the Pose2d log.
  const auto d = Discretize({1, 0, 0}, 0.02);
  SIM_NEAR(d.vx, 1, 1e-12, "discretize vx");
  const auto r = Discretize({2, 0, 3}, 0.02);
  SIM_CHECK(r.vy < 0 && std::abs(r.omega - 3) < 1e-12, "discretize adds lateral correction (%.5f)", r.vy);
  // Optimize flips > 90 degrees.
  const auto o = Optimize({2, kPi}, 0.1);
  SIM_NEAR(o.speed, -2, 1e-12, "optimize speed");
  SIM_NEAR(WrapAngle(o.angle), 0, 1e-12, "optimize angle");
  // Module math: straight request with modules already at 0: drive rotor rps = v G / (2 pi R).
  SwerveParams p = ReferenceParams();
  SwerveRequestEmulator em(ReferenceConstants(p));
  ControlParameters params;
  params.updatePeriod = 0;
  FieldCentric fc;
  fc.velocityX = 2;
  fc.driveRequestType = DriveRequestType::Velocity;
  fc.forwardPerspective = ForwardPerspective::BlueAlliance;
  auto out = em.Compute(fc, params, {0, 0, 0, 0}, {0, 0, 0, 0});
  const auto* vv = std::get_if<VelocityVoltage>(&out[0].drive);
  SIM_CHECK(vv != nullptr, "VelocityVoltage drive");
  if (vv) SIM_NEAR(vv->velocity, 2 * p.driveGearing / (2 * kPi * p.wheelRadius), 1e-9, "drive rotor rps");
  // Cosine compensation and coupling.
  out = em.Compute(fc, params, {0.5, 0, 0, 0}, {1.0, 0, 0, 0});
  vv = std::get_if<VelocityVoltage>(&out[0].drive);
  if (vv) SIM_NEAR(vv->velocity, 2 * p.driveGearing / (2 * kPi * p.wheelRadius) * std::cos(0.5) + 1.0 / (2 * kPi) * 3.125,
                   1e-9, "cosine + coupling");
  // Deadband and operator perspective.
  FieldCentric small = fc;
  small.velocityX = 0.05;
  small.deadband = 0.1;
  out = em.Compute(small, params, {0, 0, 0, 0}, {0, 0, 0, 0});
  vv = std::get_if<VelocityVoltage>(&out[0].drive);
  if (vv) SIM_NEAR(vv->velocity, 0, 1e-12, "deadband");
  FieldCentric red = fc;
  red.forwardPerspective = ForwardPerspective::OperatorPerspective;
  params.operatorForwardDirection = kPi;
  out = em.Compute(red, params, {kPi, kPi, kPi, kPi}, {0, 0, 0, 0});
  SIM_NEAR(std::abs(WrapAngle(out[0].target.angle)), kPi, 1e-9, "red perspective drives toward -x");
  // Desaturation to speedAt12Volts.
  ApplyRobotSpeeds fast;
  fast.speeds = {5, 0, 6};
  out = em.Compute(fast, params, {0, 0, 0, 0}, {0, 0, 0, 0});
  double maxSpeed = 0;
  for (const auto& m : out) maxSpeed = std::max(maxSpeed, std::abs(m.target.speed));
  SIM_NEAR(maxSpeed, 5.23, 1e-9, "desaturated");
  // Open loop volts.
  FieldCentric ol = fc;
  ol.driveRequestType = DriveRequestType::OpenLoopVoltage;
  out = em.Compute(ol, params, {0, 0, 0, 0}, {0, 0, 0, 0});
  const auto* vo = std::get_if<VoltageOut>(&out[0].drive);
  if (vo) SIM_NEAR(vo->volts, 2 / 5.23 * 12, 1e-9, "open-loop volts");
  // Wheel force feedforward: 50 N forward per module -> volts.
  ApplyRobotSpeeds ff;
  ff.speeds = {1, 0, 0};
  ff.driveRequestType = DriveRequestType::Velocity;
  ff.wheelForceFeedforwardsX = {50, 50, 50, 50};
  ff.wheelForceFeedforwardsY = {0, 0, 0, 0};
  out = em.Compute(ff, params, {0, 0, 0, 0}, {0, 0, 0, 0});
  vv = std::get_if<VelocityVoltage>(&out[0].drive);
  const auto foc = DcMotor::KrakenX60Foc();
  if (vv) SIM_NEAR(vv->feedForward, 50 * p.wheelRadius / p.driveGearing / foc.Kt() * 12 / foc.stallCurrent, 1e-9, "force ff volts");
  // Facing angle turns the robot to the target heading.
  Rig rig;
  FieldCentricFacingAngle face;
  face.targetDirection = kPi / 2;
  face.headingController = {6, 0, 0};
  face.driveRequestType = DriveRequestType::Velocity;
  face.forwardPerspective = ForwardPerspective::BlueAlliance;
  rig.Run(face, 2.0);
  SIM_NEAR(rig.sim.Pose().yaw, kPi / 2, 0.03, "FieldCentricFacingAngle heading");
  // Closed-loop velocity tracking through the emulator.
  Rig r2;
  r2.Run(Drive(3.0), 2.0);
  SIM_NEAR(r2.sim.FieldVelocity().vx, 3.0, 0.1, "FieldCentric Velocity 3 m/s");
  SIM_NEAR(r2.sim.Pose().y, 0, 0.01, "drives straight");
}

std::vector<double> Trace() {
  Terrain terrain;
  AddRebuiltBump(terrain, 4, 4, 0.3);
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 8, 8);
  Rig rig;
  rig.sim.SetPose(2, 3.6, 0.2, &terrain);
  std::vector<double> out;
  rig.Run(Drive(3.0, 0.5, 1.0), 2.0, &terrain, &obstacles, [&] {
    const auto p = rig.sim.Pose3();
    out.insert(out.end(), {p.x, p.y, p.z, p.roll, p.pitch, p.yaw, rig.sim.TotalSupplyCurrent()});
  });
  return out;
}

void RobotContacts() {
  // A robot drives into a parked (coasting) one: it pushes it, they never overlap deeply.
  Rig a, b;
  a.sim.SetPose(2, 4, 0);
  b.sim.SetPose(3.0, 4, kPi / 2);
  double maxOverlap = 0;
  for (int l = 0; l < 100; ++l) {
    a.requests.Apply(Drive(3.0), a.sim, swerve::SwerveRequestEmulator::ParamsFrom(a.sim, a.time));
    for (int k = 0; k < 20; ++k) {
      CollideRobots(a.sim, b.sim);
      a.sim.Step(0.001, 12.5);
      b.sim.Step(0.001, 12.5);
      a.time += 0.001;
      maxOverlap = std::max(maxOverlap, 0.84 - (b.sim.Pose().x - a.sim.Pose().x));
    }
  }
  std::printf("robot pushing a coasting robot: pushed %.2f m, max bumper overlap %.1f mm\n", b.sim.Pose().x - 3.0, maxOverlap * 1000);
  SIM_CHECK(b.sim.Pose().x > 3.5, "pushed: %.3f", b.sim.Pose().x);
  // Contact forces are capped at 3x weight, so a 3 m/s hit compresses the bumpers a few cm.
  SIM_CHECK(maxOverlap < 0.05, "no deep overlap: %.4f", maxOverlap);
  // Two robots teleported 30 cm into each other separate gently.
  {
    Rig r1, r2;
    r1.sim.SetPose(2, 2, 0);
    r2.sim.SetPose(2.54, 2.1, 0.2);
    double peak = 0;
    swerve::SwerveDriveBrake brake;
    for (int l = 0; l < 100; ++l) {
      r1.requests.Apply(brake, r1.sim, swerve::SwerveRequestEmulator::ParamsFrom(r1.sim, r1.time));
      r2.requests.Apply(brake, r2.sim, swerve::SwerveRequestEmulator::ParamsFrom(r2.sim, r2.time));
      for (int k = 0; k < 20; ++k) {
        CollideRobots(r1.sim, r2.sim);
        r1.sim.Step(0.001, 12.5);
        r2.sim.Step(0.001, 12.5);
        r1.time += 0.001;
        r2.time += 0.001;
        peak = std::max({peak, std::hypot(r1.sim.FieldVelocity().vx, r1.sim.FieldVelocity().vy),
                         std::hypot(r2.sim.FieldVelocity().vx, r2.sim.FieldVelocity().vy)});
      }
    }
    std::printf("robots spawned 30 cm into each other: peak speed %.2f m/s, tilts %.2f / %.2f deg\n", peak,
                r1.sim.TiltAngle() / kDeg, r2.sim.TiltAngle() / kDeg);
    SIM_CHECK(peak < 1.0 && Finite(r1.sim) && Finite(r2.sim) && r1.sim.TiltAngle() < 3 * kDeg, "gentle separation");
  }
  // 20 ms Steps stay numerically stable (the physics sub-step length is fixed; the devices then
  // update at 50 Hz, so closed loops are not Phoenix-like: call Step at 1 ms for that).
  Rig c;
  for (std::size_t i = 0; i < 4; ++i) {
    c.sim.DriveMotor(i).SetControl(VoltageOut{6});
    c.sim.SteerMotor(i).SetControl(StaticBrake{});
  }
  double maxTilt = 0;
  for (int i = 0; i < 100; ++i) {
    c.sim.Step(0.02, 12.5);
    maxTilt = std::max(maxTilt, c.sim.TiltAngle());
  }
  const double speed = std::hypot(c.sim.FieldVelocity().vx, c.sim.FieldVelocity().vy);
  std::printf("20 ms Steps: speed %.2f m/s, max tilt %.2f deg\n", speed, maxTilt / kDeg);
  SIM_CHECK(Finite(c.sim) && speed < 5.5 && maxTilt < 5 * kDeg, "20 ms steps stable: %.3f m/s", speed);
}

struct SpawnRun { double maxZ = 0, maxSpeed = 0, maxTilt = 0, finalLoad = 0; bool everBeached = false, finite = true; };

SpawnRun RunFrom(Rig& rig, const swerve::SwerveRequest& request, double seconds, const Obstacles& obstacles) {
  SpawnRun r;
  rig.Run(request, seconds, nullptr, &obstacles, [&] {
    const auto p = rig.sim.Pose3();
    const auto v = rig.sim.FieldVelocity();
    r.maxZ = std::max(r.maxZ, p.z);
    r.maxSpeed = std::max(r.maxSpeed, std::hypot(v.vx, v.vy));
    r.maxTilt = std::max(r.maxTilt, rig.sim.TiltAngle());
    r.everBeached = r.everBeached || rig.sim.Beached();
    r.finite = r.finite && Finite(rig.sim);
  });
  for (std::size_t i = 0; i < 4; ++i) r.finalLoad += rig.sim.ModuleNormalForce(i);
  return r;
}

// Regression (v0.9.24): a robot teleported under an overhead trench arm (taller than its zMin)
// was launched metres into the air and ended overturned, floating on its bumper edges.
void SpawnInsideObstacles() {
  const double weight = 68 * kGravity;
  {
    SwerveParams p = ReferenceParams();
    p.robotHeightM = 0.61;
    Rig rig(p);
    Obstacles obstacles;
    obstacles.SetPerimeter(0, 0, 16.54, 8.07);
    obstacles.AddBox("trench_arm", 4.62, 7.43, 0, 1.19, 1.28, 0.5652, 1.02);
    rig.sim.SetPose(4.43, 7.42, -1.57);
    // Keeps commanding a path into the arm for 3 s: it is pushed out, then rams the arm with its
    // top edge (a wheelie, as a real robot would), but never launches.
    const auto r = RunFrom(rig, Drive(1.0, -0.5), 3.0, obstacles);
    const auto settle = RunFrom(rig, Drive(0, 0), 1.0, obstacles);
    std::printf("spawned under a trench arm, driving into it: max z %.3f m, max speed %.2f m/s, max tilt %.1f deg; "
                "stopped: wheel load %.0f N, tilt %.2f deg\n",
                r.maxZ, r.maxSpeed, r.maxTilt / kDeg, settle.finalLoad, rig.sim.TiltAngle() / kDeg);
    SIM_CHECK(r.finite && r.maxZ < 0.15 && r.maxSpeed < 2.0 && r.maxTilt < 30 * kDeg, "no launch");
    // (While ramming, the 16-degree wheelie puts the rear bumper on the carpet, so Beached() may
    // briefly and correctly report it; once stopped it must not.)
    SIM_CHECK(!rig.sim.Beached(), "not beached once stopped");
    SIM_CHECK(settle.finalLoad > 0.95 * weight && rig.sim.TiltAngle() < 2 * kDeg, "settles on its wheels: %.0f N", settle.finalLoad);
    // A robot shorter than the arm is unaffected.
    Rig shortRig;
    shortRig.sim.SetRobotHeight(0.5);
    shortRig.sim.SetPose(4.43, 7.42, -1.57);
    const auto s2 = RunFrom(shortRig, Drive(0, 0), 0.5, obstacles);
    SIM_CHECK(std::abs(shortRig.sim.Pose().x - 4.43) < 0.01 && s2.maxSpeed < 0.05, "short robot under the arm stays put");
  }
  {
    // Overlapping the perimeter wall by 22 cm and a full-height column by 30 cm: pushed out gently.
    Obstacles obstacles;
    obstacles.SetPerimeter(0, 0, 8, 8);
    obstacles.AddBox("column", 4, 4, 0, 0.6, 0.6, 0, 2);
    for (int which = 0; which < 2; ++which) {
      Rig rig;
      if (which == 0) rig.sim.SetPose(0.2, 2, 0);
      else rig.sim.SetPose(4 - 0.3 - 0.42 + 0.3, 4, 0);
      swerve::SwerveDriveBrake brake;
      const auto r = RunFrom(rig, brake, 2.0, obstacles);
      const double x = rig.sim.Pose().x;
      const double clearOf = which == 0 ? x - 0.42 : (4 - 0.3) - (x + 0.42);
      std::printf("spawned %s: max speed %.2f m/s, max tilt %.2f deg, final clearance %.3f m\n",
                  which == 0 ? "22 cm into the wall" : "30 cm into a column", r.maxSpeed, r.maxTilt / kDeg, clearOf);
      SIM_CHECK(r.finite && r.maxSpeed < 0.6 && r.maxTilt < 3 * kDeg && r.maxZ < 0.02, "gentle push-out");
      SIM_CHECK(clearOf > -0.03, "resolved: %.3f", clearOf);
      SIM_CHECK(r.finalLoad > 0.95 * weight, "on its wheels");
    }
  }
}

void Determinism() {
  const auto a = Trace(), b = Trace();
  SIM_CHECK(a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0,
            "two identical runs match bit for bit");
}

void Speed() {
  Terrain terrain;
  AddRebuiltBump(terrain, 4, 4, 0);
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 16.5, 8.1, 0.3);
  Rig rig;
  rig.sim.SetPose(2, 4, 0, &terrain);
  const auto t0 = std::chrono::steady_clock::now();
  rig.Run(Drive(2.0, 0, 0.5), 20.0, &terrain, &obstacles);
  const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::printf("20 s of swerve (bump + perimeter, %d sub-steps/ms): %.1f ms wall clock\n", rig.sim.Substeps(), wall * 1000);
  if (kSimOptimized) SIM_CHECK(wall < 2.0, "20 s simulates in well under real time: %.3f s", wall);
}

}  // namespace

int main() {
  AccelerationAndTopSpeed();
  LateralSlide();
  Walls();
  Bump();
  RampHoldAndSlopeLoads();
  Requests();
  RobotContacts();
  SpawnInsideObstacles();
  Determinism();
  Speed();
  return SimResult("sim_swerve");
}
