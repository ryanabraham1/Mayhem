// Game pieces: projectile range vs closed form, drag and Magnus, 500 balls at 1 kHz, robot
// pushing and intaking, goals, determinism.
#include <chrono>
#include <cstring>

#include "mayhem/sim/game_pieces.hpp"
#include "mayhem/sim/rng.hpp"
#include "sim_check.hpp"
#include "sim_robot.hpp"

using namespace mayhem::sim;
using namespace simtest;

namespace {

constexpr double kDt = 0.001;

/** Horizontal distance until the ball first comes back down to its launch height. */
double Range(BallParams p, double speed, double angle, Vec3 spin = {0, 0, 0}) {
  GamePieces pieces(p);
  const double z0 = 1.0;
  const int i = pieces.Launch({0, 0, z0}, {speed * std::cos(angle), 0, speed * std::sin(angle)}, spin);
  Vec3 prev = pieces.Balls()[0].position;
  for (int k = 0; k < 10000; ++k) {
    pieces.Step(kDt);
    const Vec3 x = pieces.Get(i).position;
    if (k > 10 && x[2] <= z0 && prev[2] > z0) {
      const double t = (prev[2] - z0) / (prev[2] - x[2]);  // interpolate the crossing
      return prev[0] + t * (x[0] - prev[0]);
    }
    prev = x;
  }
  return -1;
}

void Projectiles() {
  BallParams vacuum;
  vacuum.dragCd = 0;
  vacuum.magnus = 0;
  for (double angle : {30.0, 45.0, 60.0}) {
    const double a = angle * kPi / 180, v = 8;
    const double closed = v * v * std::sin(2 * a) / kGravity;
    const double sim = Range(vacuum, v, a);
    std::printf("drag-free range at %.0f deg, 8 m/s: %.4f m (closed form %.4f)\n", angle, sim, closed);
    SIM_NEAR(sim, closed, 1e-3, "drag-free range");
  }
  BallParams air;  // defaults: Cd 0.47, foam ball
  const double withDrag = Range(air, 8, kPi / 4);
  const double backspin = Range(air, 8, kPi / 4, {0, -200, 0});  // backspin on a +x shot
  const double topspin = Range(air, 8, kPi / 4, {0, 200, 0});
  std::printf("with drag: %.3f m; backspin: %.3f m; topspin: %.3f m\n", withDrag, backspin, topspin);
  SIM_CHECK(withDrag < 6.52 && withDrag > 3, "drag shortens the shot");
  SIM_CHECK(backspin > withDrag && topspin < withDrag, "Magnus: backspin lifts, topspin drops");
}

void GroundAndBounce() {
  GamePieces pieces;
  const int i = pieces.Spawn(0, 0, 2.0);  // dropped from 2 m
  double maxAfterBounce = 0;
  bool bounced = false;
  for (int k = 0; k < 3000; ++k) {
    pieces.Step(kDt);
    const auto& b = pieces.Get(i);
    if (b.velocity[2] > 0) bounced = true;
    if (bounced) maxAfterBounce = std::max(maxAfterBounce, b.position[2]);
  }
  const double r = pieces.Params().radius, e = pieces.Params().restitution;
  // Drag makes the first rebound a little lower than e^2 (h - r).
  std::printf("drop from 2 m: rebound apex %.3f m (drag-free e^2 h = %.3f m)\n", maxAfterBounce, r + e * e * (2.0 - r));
  SIM_CHECK(maxAfterBounce < r + e * e * (2.0 - r) && maxAfterBounce > r + 0.7 * e * e * (2.0 - r), "rebound height");
  SIM_CHECK(pieces.Get(i).state == PieceState::OnGround, "comes to rest on the ground");
  // Rolling ball decelerates by rolling friction and stops.
  const int j = pieces.Spawn(0, 2, -1, {2, 0, 0});
  for (int k = 0; k < 15000; ++k) pieces.Step(kDt);
  const double expected = 4.0 / (2 * pieces.Params().rollingFriction * kGravity);
  std::printf("rolling from 2 m/s: stopped after %.2f m (rolling friction only %.2f m)\n", pieces.Get(j).position[0], expected);
  SIM_CHECK(pieces.Get(j).position[0] < expected && pieces.Get(j).position[0] > 0.6 * expected, "rolling distance");
  // Rolls down a ramp.
  Terrain terrain;
  terrain.AddRamp(5, 0, 0, 2, 1, 0.3, 0);  // descends toward +x
  GamePieces p2;
  const int k = p2.Spawn(4.5, 0, -1);
  p2.Get(k).position[2] = terrain.Height(4.5, 0) + p2.Params().radius;
  for (int s = 0; s < 1000; ++s) p2.Step(kDt, &terrain);
  // 8.5-degree slope: (5/7) g sin(theta) - rolling friction ~ 0.74 m/s^2 -> ~0.37 m in 1 s.
  SIM_NEAR(p2.Get(k).position[0] - 4.5, 0.37, 0.05, "rolls downhill");
}

void ManyBalls() {
  GamePieces pieces;
  Rng rng(7);
  for (int i = 0; i < 500; ++i)
    pieces.Spawn(1 + 0.2 * (i % 40) + rng.Uniform(-0.02, 0.02), 1 + 0.2 * (i / 40), -1,
                 {rng.Uniform(-1, 1), rng.Uniform(-1, 1), 0});
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 10, 5);
  Rig rig;
  rig.sim.SetPose(0.6, 2.0, 0);
  pieces.AddRobot(&rig.sim);
  const auto t0 = std::chrono::steady_clock::now();
  double pieceTime = 0;
  rig.Run(Drive(2.5), 2.0, nullptr, &obstacles, [&] {
    const auto a = std::chrono::steady_clock::now();
    pieces.Step(kDt, nullptr, &obstacles);
    pieceTime += std::chrono::duration<double>(std::chrono::steady_clock::now() - a).count();
  });
  const double total = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::printf("500 balls + robot plowing through them for 2 s at 1 kHz: pieces %.1f us/step, total %.1f ms (%.0fx real time)\n",
              pieceTime / 2000 * 1e6, total * 1000, 2.0 / total);
  if (kSimOptimized) SIM_CHECK(pieceTime / 2000 < 500e-6, "500 balls under 0.5 ms per 1 ms step: %.1f us", pieceTime / 2000 * 1e6);
  // Physical sanity: all finite, none overlapping badly, none inside the robot.
  int bad = 0, overlaps = 0;
  const auto& balls = pieces.Balls();
  const double r = pieces.Params().radius;
  for (std::size_t i = 0; i < balls.size(); ++i) {
    for (double c : balls[i].position) bad += !std::isfinite(c);
    for (std::size_t j = i + 1; j < balls.size(); ++j) {
      const double d = std::hypot(balls[i].position[0] - balls[j].position[0], balls[i].position[1] - balls[j].position[1]);
      overlaps += d < 2 * r * 0.8 && std::abs(balls[i].position[2] - balls[j].position[2]) < r;
    }
  }
  std::printf("after plowing: robot at x %.2f moving %.2f m/s; deep overlaps %d\n", rig.sim.Pose().x, rig.sim.FieldVelocity().vx,
              overlaps);
  SIM_CHECK(bad == 0, "finite");
  SIM_CHECK(overlaps < 10, "balls do not pile into each other: %d", overlaps);
  Rig empty;
  empty.sim.SetPose(0.6, 2.0, 0);
  empty.Run(Drive(2.5), 2.0, nullptr, &obstacles);
  std::printf("distance in 2 s: %.3f m through balls, %.3f m on an empty field\n", rig.sim.Pose().x - 0.6, empty.sim.Pose().x - 0.6);
  SIM_CHECK(rig.sim.Pose().x < empty.sim.Pose().x - 0.01, "pushing balls costs the robot distance");
}

void IntakeAndGoal() {
  GamePieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 1, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  int captured = 0;
  IntakeZone zone;
  zone.robot = robot;
  zone.xMin = 0.42; zone.xMax = 0.65; zone.yMin = -0.3; zone.yMax = 0.3; zone.zMin = 0; zone.zMax = 0.3;
  zone.enabled = true;
  zone.canAccept = [&] { return pieces.HeldCount(robot) < 2; };  // capacity 2
  zone.onIntake = [&](int) { ++captured; };
  pieces.AddIntake(zone);
  for (int i = 0; i < 3; ++i) pieces.Spawn(2.0 + 0.4 * i, 1, -1);
  rig.Run(Drive(1.5), 2.0, nullptr, nullptr, [&] { pieces.Step(kDt); });
  std::printf("intake: captured %d, held %d, third ball at x %.2f\n", captured, pieces.HeldCount(robot), pieces.Get(2).position[0]);
  SIM_CHECK(captured == 2 && pieces.HeldCount(robot) == 2, "capacity respected");
  SIM_CHECK(pieces.Get(2).state == PieceState::OnGround && pieces.Get(2).position[0] > 2.8, "full robot pushes the third ball");

  // Shoot one into a goal: falling into a 0.6 m cylinder whose top is at 1.8 m.
  int scored = -1;
  GoalVolume goal;
  goal.shape = GoalVolume::Shape::Cylinder;
  goal.cx = 4.5; goal.cy = 1; goal.radius = 0.3; goal.zMin = 1.5; goal.zMax = 1.8;
  goal.onScore = [&](int ball, int) { scored = ball; };
  pieces.AddGoal(goal);
  // Aim drag-free (the goal check is the test here, so no drag).
  BallParams vacuum;
  vacuum.dragCd = 0;
  GamePieces shooter(vacuum);
  shooter.AddGoal(goal);
  const int ball = shooter.Spawn(0, 0, 0);
  shooter.SetHeld(ball, 0);
  const double dx = 4.5 - 1.5, vx = 4.0, t = dx / vx;
  const double z0 = 0.6, zTarget = 1.65, vz = (zTarget - z0 + 0.5 * kGravity * t * t) / t;
  shooter.LaunchHeld(0, {1.5, 1, z0}, {vx, 0, vz});
  shooter.Goal(0).onScore = [&](int b, int) { scored = b; };
  for (int k = 0; k < 2000 && scored < 0; ++k) shooter.Step(kDt);
  std::printf("shot into goal: scored ball %d, state %d\n", scored, static_cast<int>(shooter.Get(ball).state));
  SIM_CHECK(scored == ball && shooter.Get(ball).state == PieceState::Scored, "goal scored while falling in");
  // Rising through the same volume does not score.
  GamePieces up(vacuum);
  int wrong = -1;
  up.AddGoal(goal);
  up.Goal(0).onScore = [&](int b, int) { wrong = b; };
  up.Launch({4.5, 1, 1.0}, {0, 0, 3.0});
  for (int k = 0; k < 200; ++k) up.Step(kDt);
  SIM_CHECK(wrong < 0, "upward pass does not score");
}

// Regression: a robot teleported on top of game pieces settles on its wheels and the pieces
// are pushed out from under it (pieces never hold a robot up).
void SpawnOverBalls() {
  GamePieces pieces;
  for (int i = 0; i < 5; ++i)
    for (int j = 0; j < 5; ++j) pieces.Spawn(3 - 0.3 + 0.15 * i, 3 - 0.3 + 0.15 * j);
  Rig rig;
  rig.sim.SetPose(3, 3, 0.3);
  pieces.AddRobot(&rig.sim);
  double maxSpeed = 0, maxTilt = 0, maxZ = 0, maxBallSpeed = 0;
  swerve::SwerveDriveBrake brake;
  rig.Run(brake, 2.0, nullptr, nullptr, [&] {
    pieces.Step(kDt);
    maxSpeed = std::max(maxSpeed, std::hypot(rig.sim.FieldVelocity().vx, rig.sim.FieldVelocity().vy));
    maxTilt = std::max(maxTilt, rig.sim.TiltAngle());
    maxZ = std::max(maxZ, rig.sim.Pose3().z);
    for (const auto& b : pieces.Balls()) maxBallSpeed = std::max(maxBallSpeed, std::hypot(b.velocity[0], b.velocity[1]));
  });
  double load = 0;
  for (std::size_t i = 0; i < 4; ++i) load += rig.sim.ModuleNormalForce(i);
  int inside = 0;
  const auto pose = rig.sim.Pose();
  for (const auto& b : pieces.Balls()) {
    const double dx = b.position[0] - pose.x, dy = b.position[1] - pose.y;
    const double u = std::cos(pose.yaw) * dx + std::sin(pose.yaw) * dy, v = -std::sin(pose.yaw) * dx + std::cos(pose.yaw) * dy;
    inside += std::abs(u) < 0.42 && std::abs(v) < 0.42;
  }
  std::printf("robot spawned on 25 balls: robot max speed %.3f m/s, max tilt %.2f deg, max z %.4f m, wheel load %.0f N, "
              "balls left inside %d, fastest ball %.2f m/s\n", maxSpeed, maxTilt * 180 / kPi, maxZ, load, inside, maxBallSpeed);
  SIM_CHECK(inside == 0, "pieces pushed out from under the robot: %d", inside);
  SIM_CHECK(maxSpeed < 0.3 && maxTilt < 0.03 && maxZ < 0.01, "robot stays put and level");
  SIM_CHECK(load > 0.95 * 68 * kGravity, "robot rests on its wheels: %.0f N", load);
  SIM_CHECK(maxBallSpeed < 6, "pieces leave gently: %.2f", maxBallSpeed);
}

std::vector<double> Trace() {
  GamePieces pieces;
  Rng rng(42);
  for (int i = 0; i < 200; ++i) pieces.Spawn(rng.Uniform(0.5, 4.5), rng.Uniform(0.5, 4.5), -1, {rng.Normal(0, 1), rng.Normal(0, 1), 0});
  for (int i = 0; i < 20; ++i) pieces.Launch({2, 2, 1}, {rng.Normal(3, 1), rng.Normal(0, 1), rng.Uniform(2, 5)}, {0, rng.Normal(0, 50), 0});
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 5, 5);
  obstacles.AddCylinder("post", 2.5, 2.5, 0.2, 0, 2);
  Rig rig;
  rig.sim.SetPose(0.6, 2.5, 0);
  pieces.AddRobot(&rig.sim);
  rig.Run(Drive(2.0, 0.3, 0.5), 1.0, nullptr, &obstacles, [&] { pieces.Step(kDt, nullptr, &obstacles); });
  std::vector<double> out;
  for (const auto& b : pieces.Balls()) out.insert(out.end(), b.position.begin(), b.position.end());
  const auto p = rig.sim.Pose3();
  out.insert(out.end(), {p.x, p.y, p.yaw});
  return out;
}

void Determinism() {
  const auto a = Trace(), b = Trace();
  SIM_CHECK(a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0,
            "identical seeds give bit-identical pieces and robot");
  Rng r1(5), r2(5);
  bool same = true;
  for (int i = 0; i < 1000; ++i) same = same && r1.Normal() == r2.Normal();
  SIM_CHECK(same, "Rng is reproducible");
}

}  // namespace

int main() {
  Projectiles();
  GroundAndBounce();
  ManyBalls();
  IntakeAndGoal();
  SpawnOverBalls();
  Determinism();
  return SimResult("sim_pieces");
}
