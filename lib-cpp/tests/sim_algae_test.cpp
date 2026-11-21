// Ball pieces (2025 algae) in CylinderPieces: carpet bounce and roll, resting in a reef cradle of
// static capsule pipes (stable, asleep, survives scrapes, comes off when lifted out), riding a
// standing coral and falling when it tips, landing on a lying coral, a force-limited pinch,
// bumper pushes, contact reports, the intake query, and determinism.
#include <cstring>
#include <limits>

#include "mayhem/sim/cylinder_pieces.hpp"
#include "sim_check.hpp"
#include "sim_robot.hpp"

using namespace mayhem::sim;
using namespace simtest;

namespace {

constexpr double kDt = 0.001;

void Run(CylinderPieces& pieces, double seconds) {
  const int steps = static_cast<int>(seconds / kDt + 0.5);
  for (int k = 0; k < steps; ++k) pieces.Step(kDt);
}

/**
 * One reef face's two branches as static capsules (radius 0.021 m), face normal +x, face centre
 * at y = 0, reef centre at the origin: (r, z) pipe ends from the 2025 field.
 */
void AddReefFace(CylinderPieces& pieces) {
  struct Pipe { double r0, z0, r1, z1; };
  const Pipe pipes[] = {{0.537, 0.46, 0.537, 1.45},  {0.537, 0.625, 0.776, 0.795}, {0.537, 1.03, 0.776, 1.20},
                        {0.537, 1.38, 0.78, 1.58},   {0.78, 1.58, 0.78, 1.83}};
  for (double y : {-0.164, 0.164})
    for (const auto& q : pipes) {
      MechanismCollider c;
      c.name = "reef pipe";
      c.shape = MechanismCollider::Shape::Capsule;
      c.robotFrame = false;
      c.radius = 0.021;
      c.a = {q.r0, y, q.z0};
      c.b = {q.r1, y, q.z1};
      c.friction = 0.6;
      c.restitution = 0.3;
      c.stiffness = 0;
      pieces.AddCollider(c);
    }
}

void FloorBounceAndRoll() {
  CylinderPieces pieces;
  const double r = pieces.Params().sphere.radius, e = pieces.Params().sphere.floorRestitution;
  const int b = pieces.SpawnBall({0, 0, 1.0});
  SIM_CHECK(pieces.Get(b).state == CylinderState::Flying && pieces.IsBall(b), "spawned in the air: a flying ball");
  double apex = 0;
  bool up = false;
  for (int k = 0; k < 1500; ++k) {
    pieces.Step(kDt);
    if (pieces.Get(b).velocity[2] > 0) up = true;
    if (up) apex = std::max(apex, pieces.Get(b).position[2]);
  }
  const double expected = r + e * e * (1.0 - r);
  std::printf("algae dropped from 1 m: rebound apex %.3f m (e^2 h + r = %.3f m)\n", apex, expected);
  SIM_NEAR(apex, expected, 0.01, "bounce matches the restitution");

  // Rolled at 2 m/s on carpet: rolls (no sliding) and slows by rolling resistance.
  CylinderPieces roll;
  const int c = roll.SpawnBallOnFloor(0, 0);
  roll.Get(c).velocity = {2, 0, 0};
  roll.Get(c).angularVelocity = {0, 2 / r, 0};
  Run(roll, 1.0);
  const auto& B = roll.Get(c);
  const double slip = B.velocity[0] - B.angularVelocity[1] * r;
  std::printf("algae rolled at 2 m/s: %.2f m/s after 1 s (slip %.4f m/s), on the floor at z %.4f\n", B.velocity[0], slip,
              B.position[2]);
  SIM_CHECK(B.velocity[0] > 1.0 && B.velocity[0] < 2.0, "rolling resistance slows it, not friction: %.3f", B.velocity[0]);
  SIM_CHECK(std::abs(slip) < 0.01, "rolls without slipping: %.4f", slip);
  SIM_NEAR(B.position[2], r, 1e-3, "on the carpet");
}

struct CradleResult { Vec3 start{0, 0, 0}, end{0, 0, 0}; bool asleep = false; CylinderState state = CylinderState::Removed; };

/** Settle a low reef algae, then run `disturb` (per step, after settling) and settle again. */
template <class F>
CradleResult Cradle(F&& disturb, double disturbSeconds) {
  CylinderPieces pieces;
  AddReefFace(pieces);
  const int b = pieces.SpawnBall({0.76, 0, 0.95});
  Run(pieces, 1.0);
  CradleResult out;
  out.start = pieces.Get(b).position;
  out.asleep = pieces.Get(b).asleep;
  const int steps = static_cast<int>(disturbSeconds / kDt);
  for (int k = 0; k < steps; ++k) {
    disturb(pieces, k, out.start);
    pieces.Step(kDt);
  }
  Run(pieces, 2.0);
  out.end = pieces.Get(b).position;
  out.state = pieces.Get(b).state;
  return out;
}

/** A 2 cm-thick vertical plate sweeping across the face (along y) at 0.5 m/s, overlapping the ball by `depth`. */
auto Scrape(double depth) {
  return [depth](CylinderPieces& pieces, int k, Vec3 ball) {
    static int plate = -1;
    if (k == 0) {
      const double outer = ball[0] + pieces.Params().sphere.radius;
      MechanismCollider p;
      p.robotFrame = false;
      p.outline = {{outer - depth, ball[2] - 0.25}, {outer + 0.4, ball[2] - 0.25}, {outer + 0.4, ball[2] + 0.25},
                   {outer - depth, ball[2] + 0.25}};
      p.width = 0.02;
      p.position = {0, -0.6, 0};
      p.velocity = {0, 0.5, 0};
      p.maxForce = 300;
      plate = pieces.AddCollider(p);
    }
    auto& p = pieces.Collider(plate);
    p.position[1] += 0.5 * kDt;
    if (p.position[1] > 0.6) p.enabled = false;
  };
}

/** A plate under the ball's outer half rising `lift` at 0.5 m/s, holding 0.2 s, then dropping away. */
auto Lift(double lift) {
  return [lift](CylinderPieces& pieces, int k, Vec3 ball) {
    static int plate = -1;
    static double z0 = 0;
    if (k == 0) {
      MechanismCollider p;
      p.robotFrame = false;
      p.outline = {{0.60, -0.03}, {1.0, -0.03}, {1.0, 0}, {0.60, 0}};
      p.width = 0.25;  // fits between the branches
      z0 = ball[2] - pieces.Params().sphere.radius - 0.002;
      p.position = {0, 0, z0};
      p.maxForce = 300;
      plate = pieces.AddCollider(p);
    }
    auto& p = pieces.Collider(plate);
    const double t = k * kDt, rise = lift / 0.5;
    if (t < rise) { p.velocity = {0, 0, 0.5}; p.position[2] = z0 + 0.5 * (t + kDt); }
    else if (t < rise + 0.2) { p.velocity = {0, 0, 0}; }
    else { p.velocity = {0, 0, -0.5}; p.position[2] -= 0.5 * kDt; if (p.position[2] < z0 - 0.3) p.enabled = false; }
  };
}

void ReefCradle() {
  const auto still = Cradle([](CylinderPieces&, int, Vec3) {}, 0.0);
  std::printf("reef algae settles at r %.3f m, z %.3f m (y %.4f), asleep %d\n", still.start[0], still.start[2], still.start[1],
              still.asleep);
  SIM_CHECK(still.asleep, "the cradled algae sleeps");
  SIM_CHECK(still.start[2] > 0.85 && still.start[2] < 1.0 && std::abs(still.start[1]) < 1e-3, "between the L2 and L3 arms");
  SIM_CHECK(vec::Norm(vec::Sub(still.end, still.start)) < 1e-3, "stays put: moved %.4f m", vec::Norm(vec::Sub(still.end, still.start)));

  {
    CylinderPieces high;
    AddReefFace(high);
    const int b = high.SpawnBall({0.76, 0, 1.35});
    Run(high, 3.0);
    const auto& H = high.Get(b);
    std::printf("high reef algae (L3-L4) settles at r %.3f m, z %.3f m, asleep %d\n", H.position[0], H.position[2], H.asleep);
    SIM_CHECK(H.asleep && H.position[2] > 1.25 && H.position[2] < 1.45, "the high algae rests between the L3 and L4 arms");
  }
  for (double depth : {0.01, 0.06}) {
    const auto s = Cradle(Scrape(depth), 2.6);
    const double moved = vec::Norm(vec::Sub(s.end, s.start));
    std::printf("plate scraping across the face %.0f cm deep (300 N): algae moved %.4f m\n", depth * 100, moved);
    SIM_CHECK(moved < 0.01, "a scrape leaves it wedged: %.4f m", moved);
  }
  const auto small = Cradle(Lift(0.01), 1.0);
  const auto mid = Cradle(Lift(0.06), 1.0);
  const auto big = Cradle(Lift(0.12), 1.0);
  std::printf("lifted from below: 1 cm -> back at r %.3f z %.3f; 6 cm -> r %.3f z %.3f; 12 cm -> off at (%.2f, %.2f, %.3f)\n",
              small.end[0], small.end[2], mid.end[0], mid.end[2], big.end[0], big.end[1], big.end[2]);
  SIM_CHECK(vec::Norm(vec::Sub(small.end, small.start)) < 0.01, "a 1 cm bump: it settles back");
  SIM_CHECK(big.end[2] < CylinderParams{}.sphere.radius + 0.01 && big.end[0] > 0.9, "lifted 12 cm it rolls out and falls to the carpet");
}

void RidesStandingCoral() {
  CylinderPieces pieces;
  const auto& p = pieces.Params();
  const int coral = pieces.SpawnStanding(2, 2);
  const int ball = pieces.SpawnBall({2, 2, p.length + p.sphere.radius});
  Run(pieces, 1.5);
  const Vec3 on = pieces.Get(ball).position;
  std::printf("algae staged on a standing coral: centre z %.4f m (expected %.4f), coral state %d, both asleep %d %d\n", on[2],
              p.length + p.sphere.radius, static_cast<int>(pieces.Get(coral).state), pieces.Get(ball).asleep,
              pieces.Get(coral).asleep);
  SIM_NEAR(on[2], p.length + p.sphere.radius, 2e-3, "rests on the coral's top");
  SIM_CHECK(pieces.Get(coral).state == CylinderState::Standing, "the coral stays standing under it");
  SIM_CHECK(pieces.Get(ball).asleep, "sleeps there");
  // Knock the coral over: a push near its base.
  pieces.ApplyImpulse(coral, {2 - p.radius, 2, 0.04}, {0.9, 0, 0});
  Run(pieces, 3.0);
  const auto& B = pieces.Get(ball);
  std::printf("coral knocked over: coral state %d, algae falls to z %.3f at (%.2f, %.2f)\n", static_cast<int>(pieces.Get(coral).state),
              B.position[2], B.position[0], B.position[1]);
  SIM_CHECK(pieces.Get(coral).state == CylinderState::Lying, "the coral lies down");
  SIM_CHECK(B.position[2] < p.length, "the algae comes down with it: z %.3f", B.position[2]);
}

void LandsOnLyingCoral() {
  CylinderPieces pieces;
  const auto& p = pieces.Params();
  const int coral = pieces.SpawnLying(1, 1, 0);  // axis along x
  const int ball = pieces.SpawnBall({1.05, 1, 1.0});
  double maxCoralSpeed = 0;
  for (int k = 0; k < 4000; ++k) {
    pieces.Step(kDt);
    maxCoralSpeed = std::max(maxCoralSpeed, vec::Norm(pieces.Get(coral).velocity));
  }
  const auto& B = pieces.Get(ball);
  std::printf("algae dropped on a lying coral: ends at (%.2f, %.2f, %.3f); the coral moved up to %.2f m/s\n", B.position[0],
              B.position[1], B.position[2], maxCoralSpeed);
  SIM_CHECK(maxCoralSpeed > 0.05, "the impact moves the coral");
  SIM_CHECK(B.position[2] > p.sphere.radius - 1e-3 && B.position[2] < 2 * p.radius + p.sphere.radius + 1e-3,
            "it ends on the coral or the carpet beside it");
  SIM_CHECK(pieces.Get(coral).state != CylinderState::Removed && B.state != CylinderState::Removed, "nothing explodes");
}

void PinchedByForceLimitedPlate() {
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  const double r = pieces.Params().sphere.radius;
  const int ball = pieces.SpawnBallOnFloor(1 + 0.42 + r + 0.05, 2);
  MechanismCollider plate;
  plate.robot = robot;
  plate.maxForce = 150;
  const double cx = 0.42 + r + 0.05;
  plate.outline = {{cx - 0.15, 0}, {cx + 0.15, 0}, {cx + 0.15, 0.02}, {cx - 0.15, 0.02}};
  plate.width = 0.3;
  plate.position = {0, 0, 2 * r + 0.03};
  const int pl = pieces.AddCollider(plate);
  double maxJ = 0, maxSpeed = 0, maxTilt = 0;
  bool reported = false;
  rig.Run(Drive(0), 0.8, nullptr, nullptr, [&] {
    auto& col = pieces.Collider(pl);
    const bool moving = col.position[2] > r;  // presses down to the ball's centre
    col.velocity = {0, 0, moving ? -1.0 : 0.0};
    col.position[2] = std::max(r, col.position[2] - (moving ? kDt : 0));
    pieces.Step(kDt);
    maxJ = std::max(maxJ, vec::Norm(pieces.LastRobotImpulse(robot)));
    maxSpeed = std::max(maxSpeed, vec::Norm(pieces.Get(ball).velocity));
    const auto p3 = rig.sim.Pose3();
    maxTilt = std::max({maxTilt, std::abs(p3.roll), std::abs(p3.pitch)});
    for (const auto& c : pieces.LastContactsWith(CylinderContactSource::Collider, pl))
      reported = reported || (c.piece == ball && c.robot == robot && c.limited);
  });
  std::printf("algae pinched into the carpet by a 150 N plate: max robot impulse %.4f N s/step, ball %.2f m/s, tilt %.2f deg\n", maxJ,
              maxSpeed, maxTilt * 180 / kPi);
  SIM_CHECK(maxJ <= 150 * kDt * (1 + 1e-9), "robot impulse within maxForce dt: %.4f", maxJ);
  SIM_CHECK(maxSpeed < 3, "squeezed, not launched: %.2f m/s", maxSpeed);
  SIM_CHECK(maxTilt < 0.02, "the robot does not tip");
  SIM_CHECK(reported, "the contact report names the plate, the ball and the robot, marked limited");
}

void BumperAndIntake() {
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  const double r = pieces.Params().sphere.radius;
  const int ball = pieces.SpawnBallOnFloor(2.2, 2);
  pieces.SpawnBallOnFloor(4.0, 3.5);
  const auto near = pieces.NearBalls({2.2 - r - 0.03, 1.8, r}, {2.2 - r - 0.03, 2.2, r}, 0.05);
  std::printf("intake query: %zu ball(s) within 5 cm, nearest %d at %.4f m\n", near.size(), near.empty() ? -1 : near[0].index,
              near.empty() ? 0.0 : near[0].distance);
  SIM_CHECK(near.size() == 1 && near[0].index == ball && std::abs(near[0].distance - 0.03) < 1e-9, "only the ball in front, 3 cm away");
  SIM_CHECK(pieces.Near({2.2 - r - 0.03, 1.8, r}, {2.2 - r - 0.03, 2.2, r}, 0.05).empty(), "the coral query skips balls");
  double impulse = 0;
  rig.Run(Drive(1.0), 1.5, nullptr, nullptr, [&] {
    pieces.Step(kDt);
    impulse += std::abs(pieces.LastRobotImpulse(robot)[0]);
  });
  const double front = rig.sim.Pose().x + 0.42;
  std::printf("bumper at 1 m/s: ball at x %.2f (robot front %.2f), impulse on the robot %.3f N s\n", pieces.Get(ball).position[0], front,
              impulse);
  SIM_CHECK(pieces.Get(ball).position[0] > front + r - 0.01, "pushed ahead of the bumper");
  SIM_CHECK(impulse > 0.3, "the robot feels it");
  SIM_CHECK(pieces.BallPositions().size() == 2 && pieces.Poses().empty(), "logging: two ball positions, no coral poses");
}

double Mixed(std::vector<double>* trace) {
  CylinderPieces pieces;
  AddReefFace(pieces);
  Rig rig;
  rig.sim.SetPose(2, 0, kPi);
  pieces.AddRobot(&rig.sim);
  pieces.SpawnBall({0.76, 0, 0.95});
  for (int i = 0; i < 6; ++i) pieces.SpawnLying(1.2 + 0.3 * i, 0.4 * (i % 3) - 0.4, 0.5 * i);
  pieces.SpawnStanding(1.6, -0.9);
  pieces.SpawnBall({1.6, -0.9, pieces.Params().length + pieces.Params().sphere.radius});
  pieces.SpawnBall({2.5, 0.6, 0.6});
  rig.Run(Drive(-0.8, 0.2, 0.3), 2.0, nullptr, nullptr, [&] {
    pieces.Step(kDt);
    if (trace)
      for (const auto& c : pieces.Pieces()) trace->insert(trace->end(), {c.position[0], c.position[1], c.position[2], c.velocity[0]});
  });
  return 0;
}

void Determinism() {
  std::vector<double> a, b;
  Mixed(&a);
  Mixed(&b);
  SIM_CHECK(!a.empty() && a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0,
            "identical mixed coral/algae runs are bit-identical");
}

}  // namespace

int main() {
  FloorBounceAndRoll();
  ReefCradle();
  RidesStandingCoral();
  LandsOnLyingCoral();
  PinchedByForceLimitedPlate();
  BumperAndIntake();
  Determinism();
  return SimResult("sim_algae");
}
