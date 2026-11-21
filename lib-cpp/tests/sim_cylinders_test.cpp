// Cylinder game pieces (2025 coral): resting stably, tipping when pushed high, sliding when
// pushed low, rolling across the axis vs sliding along it, a bumper pushing one, walls and
// prisms stopping them, stacking, the intake query and hold/release, 20 pieces under a time
// budget, and determinism.
#include <chrono>
#include <cstring>
#include <limits>

#include "mayhem/sim/cylinder_pieces.hpp"
#include "sim_check.hpp"
#include "sim_robot.hpp"

using namespace mayhem::sim;
using namespace simtest;

namespace {

constexpr double kDt = 0.001;

void Run(CylinderPieces& pieces, double seconds, const Obstacles* obstacles = nullptr) {
  const int steps = static_cast<int>(seconds / kDt + 0.5);
  for (int k = 0; k < steps; ++k) pieces.Step(kDt, nullptr, obstacles);
}

double Tilt(const Cylinder& c) { return std::acos(std::clamp(std::abs(c.Axis()[2]), 0.0, 1.0)); }

void RestsStably() {
  CylinderPieces pieces;
  const int s = pieces.SpawnStanding(1, 1, 0.3);
  const int l = pieces.SpawnLying(2, 1, 0.7);
  const Vec3 s0 = pieces.Get(s).position, l0 = pieces.Get(l).position;
  Run(pieces, 2.0);
  const auto& S = pieces.Get(s);
  const auto& L = pieces.Get(l);
  const double ds = vec::Norm(vec::Sub(S.position, s0)), dl = vec::Norm(vec::Sub(L.position, l0));
  std::printf("at rest 2 s: standing moved %.2f mm (z %.4f, tilt %.3f deg), lying moved %.2f mm (z %.4f), asleep %d %d\n",
              ds * 1e3, S.position[2], Tilt(S) * 180 / kPi, dl * 1e3, L.position[2], S.asleep, L.asleep);
  SIM_CHECK(S.state == CylinderState::Standing && L.state == CylinderState::Lying, "states: %d %d", static_cast<int>(S.state),
            static_cast<int>(L.state));
  SIM_CHECK(ds < 1e-3 && dl < 1e-3, "no drift: %.3g %.3g m", ds, dl);
  SIM_NEAR(S.position[2], pieces.Params().length / 2, 1e-3, "standing on its end");
  SIM_NEAR(L.position[2], pieces.Params().radius, 1e-3, "lying on its side");
  SIM_CHECK(S.asleep && L.asleep, "pieces at rest go to sleep");
}

void DropAndBounce() {
  CylinderPieces pieces;
  const int i = pieces.Spawn({{0, 0, 1.0}, vec::FromEuler(0, 0, 0.4)});
  SIM_CHECK(pieces.Get(i).state == CylinderState::Flying, "spawned in the air: Flying");
  double apex = 0;
  bool hit = false;
  for (int k = 0; k < 2000; ++k) {
    pieces.Step(kDt);
    const auto& c = pieces.Get(i);
    if (c.velocity[2] > 0) hit = true;
    if (hit) apex = std::max(apex, c.position[2]);
  }
  const double r = pieces.Params().radius, e = pieces.Params().floorRestitution;
  const double expected = r + e * e * (1.0 - r);
  std::printf("dropped flat from 1 m: rebound apex %.4f m (e^2 h + r = %.4f m), ends %d at z %.4f\n", apex, expected,
              static_cast<int>(pieces.Get(i).state), pieces.Get(i).position[2]);
  SIM_NEAR(apex, expected, 0.01, "restitution 0.2 rebound");
  SIM_CHECK(pieces.Get(i).state == CylinderState::Lying, "comes to rest lying");
}

/** Pushes a standing coral with a horizontal capsule at height z moving +x at 0.5 m/s for 0.6 s. */
struct PushResult { double tilt, baseSlide, topX, pushTilt, pushSlide; CylinderState state; };
PushResult PushStanding(double z, double speed = 0.5) {
  CylinderPieces pieces;
  const int i = pieces.SpawnStanding(2, 2);
  Run(pieces, 0.1);
  MechanismCollider rod;
  rod.name = "rod";
  rod.shape = MechanismCollider::Shape::Capsule;
  rod.robotFrame = false;
  rod.radius = 0.02;
  const double r = pieces.Params().radius;
  rod.a = {0, -0.3, 0};
  rod.b = {0, 0.3, 0};
  rod.position = {2 - r - rod.radius - 0.005, 2, z};
  rod.velocity = {speed, 0, 0};
  const int c = pieces.AddCollider(rod);
  double pushTilt = 0, pushSlide = 0;
  for (int k = 0; k < 2000; ++k) {
    if (k < 600) pieces.Collider(c).position[0] += speed * kDt;
    else pieces.Collider(c).enabled = false;
    pieces.Step(kDt);
    if (k < 600) {
      pushTilt = std::max(pushTilt, Tilt(pieces.Get(i)));
      pushSlide = pieces.Get(i).position[0] - 2;
    }
  }
  const auto& p = pieces.Get(i);
  const Vec3 a = p.Axis();
  // The end nearest the floor is the base.
  const double h = pieces.Params().length / 2;
  const Vec3 e0 = vec::Add(p.position, vec::Scale(a, h)), e1 = vec::Sub(p.position, vec::Scale(a, h));
  const Vec3 base = e0[2] < e1[2] ? e0 : e1, top = e0[2] < e1[2] ? e1 : e0;
  std::printf("  (push at %.2f m, %.1f m/s: base at x %.3f, top at x %.3f)\n", z, speed, base[0], top[0]);
  return {Tilt(p), std::hypot(base[0] - 2, base[1] - 2), top[0], pushTilt, pushSlide, p.state};
}

void Tipping() {
  const auto high = PushStanding(0.27);
  std::printf("standing coral pushed at 0.27 m: tilt %.1f deg, state %d, base moved %.3f m, top end at x %.3f\n",
              high.tilt * 180 / kPi, static_cast<int>(high.state), high.baseSlide, high.topX);
  SIM_CHECK(high.state == CylinderState::Lying && high.tilt > 1.4, "pushed at the top it falls over");
  SIM_CHECK(high.topX > 2.1, "falls away from the push: top end at x %.3f", high.topX);
  // Pushed at the base it slides upright (a slight lean where the rod meets the lifted back rim);
  // when the push stops, carpet friction stops the base and it trips forward, as it should for
  // mu > r / h_cm (0.8 > 0.38).
  const auto low = PushStanding(0.03, 0.5);
  std::printf("standing coral pushed at 0.03 m: max tilt while pushed %.1f deg, slid %.3f m; after the push: tilt %.1f deg, "
              "state %d\n", low.pushTilt * 180 / kPi, low.pushSlide, low.tilt * 180 / kPi, static_cast<int>(low.state));
  SIM_CHECK(low.pushTilt < 0.2, "pushed at the base it stays upright while pushed: %.1f deg", low.pushTilt * 180 / kPi);
  SIM_CHECK(low.pushSlide > 0.25, "and slides along: %.3f m", low.pushSlide);
  SIM_CHECK(high.baseSlide < 0.1, "pushed high it pivots on its base edge instead of sliding: %.3f m", high.baseSlide);
}

void RollVsSlide() {
  // Lying along x. Kicked across its axis (+y) it skids, spins up and rolls; along it, it slides.
  CylinderParams p;
  CylinderPieces across(p), along(p);
  const int a = across.SpawnLying(1, 1, 0), b = along.SpawnLying(1, 1, 0);
  across.Get(a).velocity = {0, 1.0, 0};
  along.Get(b).velocity = {1.0, 0, 0};
  double maxSpin = 0, rollingSpeed = 0;
  for (int k = 0; k < 4000; ++k) {
    across.Step(kDt);
    along.Step(kDt);
    const auto& c = across.Get(a);
    const double spin = vec::Dot(c.angularVelocity, c.Axis());
    if (k == 300) rollingSpeed = std::abs(c.velocity[1]) - std::abs(spin) * p.radius;
    maxSpin = std::max(maxSpin, std::abs(spin));
  }
  const double dAcross = across.Get(a).position[1] - 1, dAlong = along.Get(b).position[0] - 1;
  const double slideClosed = 1.0 / (2 * p.floorFriction * kGravity);
  std::printf("kicked at 1 m/s: across the axis %.3f m (max spin %.1f rad/s, slip at 0.3 s %.4f m/s), "
              "along the axis %.3f m (mu g closed form %.3f m)\n", dAcross, maxSpin, rollingSpeed, dAlong, slideClosed);
  SIM_NEAR(dAlong, slideClosed, 0.1 * slideClosed, "slides along its axis at mu g");
  SIM_CHECK(std::abs(along.Get(b).angularVelocity[0]) < 0.05, "no roll when sliding along the axis");
  SIM_CHECK(dAcross > 4 * dAlong, "rolls much farther across its axis");
  SIM_CHECK(std::abs(rollingSpeed) < 0.01, "rolls without slipping: %.4f m/s", rollingSpeed);
  SIM_CHECK(std::abs(across.Get(a).Axis()[0]) > 0.99, "keeps its heading while rolling");
  // Rolling resistance stops it in a reasonable distance (the tube is hollow: about half the
  // energy is in spin).
  SIM_CHECK(dAcross < 3.0 && across.Get(a).state == CylinderState::Lying, "rolling resistance stops it: %.2f m", dAcross);
}

void BumperPushes() {
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  const int c = pieces.SpawnLying(2.0, 2, kPi / 2);  // across the robot's path
  double impulse = 0, minGap = 1;
  rig.Run(Drive(1.0), 2.0, nullptr, nullptr, [&] {
    pieces.Step(kDt);
    impulse += std::abs(pieces.LastRobotImpulse(robot)[0]);
    const double front = rig.sim.Pose().x + 0.42;
    minGap = std::min(minGap, pieces.Get(c).position[0] - pieces.Params().radius - front);
  });
  const auto& p = pieces.Get(c);
  std::printf("bumper at 1 m/s: coral at x %.3f (robot front %.3f), min gap %.4f m, impulse on robot %.3f N s, state %d\n",
              p.position[0], rig.sim.Pose().x + 0.42, minGap, impulse, static_cast<int>(p.state));
  SIM_CHECK(p.position[0] > rig.sim.Pose().x + 0.42 + 0.04, "coral pushed ahead of the bumper");
  SIM_CHECK(minGap > -0.005, "coral stays outside the bumper: %.4f m", minGap);
  SIM_CHECK(impulse > 0.3, "the robot feels the coral: %.3f N s", impulse);
  SIM_CHECK(p.state == CylinderState::Lying, "still lying");
  // A robot spawned on top of a coral pushes it out without launching it.
  CylinderPieces under;
  Rig r2;
  r2.sim.SetPose(3, 3, 0.3);
  under.AddRobot(&r2.sim);
  const int u = under.SpawnLying(3.1, 3, 0.2);
  double fastest = 0;
  swerve::SwerveDriveBrake brake;
  r2.Run(brake, 1.0, nullptr, nullptr, [&] {
    under.Step(kDt);
    fastest = std::max(fastest, vec::Norm(under.Get(u).velocity));
  });
  const auto pose = r2.sim.Pose();
  const double dx = under.Get(u).position[0] - pose.x, dy = under.Get(u).position[1] - pose.y;
  const double lu = std::cos(pose.yaw) * dx + std::sin(pose.yaw) * dy, lv = -std::sin(pose.yaw) * dx + std::cos(pose.yaw) * dy;
  std::printf("robot spawned on a coral: coral ends at robot-frame (%.3f, %.3f), fastest %.2f m/s\n", lu, lv, fastest);
  SIM_CHECK(std::abs(lu) > 0.42 || std::abs(lv) > 0.42, "pushed out from under the robot");
  SIM_CHECK(fastest < 4, "leaves gently: %.2f m/s", fastest);
}

void WallsAndPrisms() {
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 3, 3);
  CylinderPieces pieces;
  const double r = pieces.Params().radius;
  // Rolling (axis along y) at 2 m/s toward the x = 3 wall.
  const int c = pieces.SpawnLying(2, 1.5, kPi / 2);
  pieces.Get(c).velocity = {2, 0, 0};
  pieces.Get(c).angularVelocity = {0, 2 / r, 0};
  double maxX = 0, minVx = 0;
  for (int k = 0; k < 3000; ++k) {
    pieces.Step(kDt, nullptr, &obstacles);
    maxX = std::max(maxX, pieces.Get(c).position[0]);
    minVx = std::min(minVx, pieces.Get(c).velocity[0]);
  }
  std::printf("rolling into a wall at 2 m/s: max x %.4f (wall at 3 - r = %.4f), rebound %.2f m/s, rests at x %.3f\n", maxX,
              3 - r, minVx, pieces.Get(c).position[0]);
  SIM_CHECK(maxX < 3 - r + 0.002, "the wall stops it: %.4f", maxX);
  SIM_CHECK(minVx < -0.1 && minVx > -0.8, "bounces back softly: %.2f m/s", minVx);
  // Sliding axially into a reef-like hexagonal prism.
  Obstacles reef;
  std::vector<Vec2> hex;
  for (int k = 0; k < 6; ++k) hex.push_back({5 + 0.8 * std::cos(k * kPi / 3), 2 + 0.8 * std::sin(k * kPi / 3)});
  reef.AddPolygon("reef", hex, 0, 0.3);
  CylinderPieces hp;
  const int s = hp.SpawnLying(3.6, 2, 0);
  hp.Get(s).velocity = {3, 0, 0};
  double maxR = 0;
  for (int k = 0; k < 1500; ++k) {
    hp.Step(kDt, nullptr, &reef);
    maxR = std::max(maxR, hp.Get(s).position[0] + pieces.Params().length / 2);
  }
  const double corner = 5 - 0.8;  // a vertex points at the coral
  std::printf("sliding end-first into a hexagon's corner at x %.3f: front end reached %.4f, rests at %.3f\n", corner, maxR,
              hp.Get(s).position[0] + pieces.Params().length / 2);
  SIM_CHECK(maxR < corner + 0.002 && maxR > corner - 0.03, "the prism stops it: %.4f", maxR);
  // Dropped onto a box prism: rests on top; one hanging over the edge falls off.
  Obstacles table;
  table.AddBox("table", 1, 1, 0, 0.6, 0.6, 0, 0.2);
  CylinderPieces tp;
  const int on = tp.Spawn({{1, 1, 0.3}, vec::FromEuler(0, 0, 0.3)});
  const int off = tp.Spawn({{1.35, 0.8, 0.3}, vec::FromEuler(0, 0, 0)});  // centre 5 cm past the edge
  Run(tp, 2.0, &table);
  std::printf("on a 0.2 m box: centred one at z %.4f, overhanging one at z %.4f (state %d)\n", tp.Get(on).position[2],
              tp.Get(off).position[2], static_cast<int>(tp.Get(off).state));
  SIM_NEAR(tp.Get(on).position[2], 0.2 + r, 0.002, "rests on the box top");
  SIM_CHECK(tp.Get(off).position[2] < 0.15, "tips off the edge: z %.3f", tp.Get(off).position[2]);
}

void Stacking() {
  // Two lying side by side between blocks (PVC on PVC is slippery: without them the pair rolls
  // apart under the third), a third dropped onto the groove; another dropped across a fourth.
  CylinderPieces pieces;
  const double r = pieces.Params().radius;
  Obstacles blocks;
  blocks.AddBox("left", 1, 1 - r - 0.05, 0, 0.5, 0.1, 0, 0.05);
  blocks.AddBox("right", 1, 1 + 3 * r + 0.05 + 0.002, 0, 0.5, 0.1, 0, 0.05);
  const int b0 = pieces.SpawnLying(1, 1, 0);
  const int b1 = pieces.SpawnLying(1, 1 + 2 * r + 0.002, 0);
  const int top = pieces.Spawn({{1, 1 + r + 0.001, 0.2}, vec::FromEuler(0, 0, 0)});  // onto the groove
  const int cross = pieces.Spawn({{2, 1, 0.4}, vec::FromEuler(0, 0, kPi / 2)});
  pieces.SpawnLying(2, 1, 0);
  Run(pieces, 3.0, &blocks);
  std::printf("stacking: bottom pair at y %.4f, %.4f\n", pieces.Get(b0).position[1], pieces.Get(b1).position[1]);
  const double grooveZ = r + std::sqrt(4 * r * r - r * r);  // resting on two touching tubes
  std::printf("stacking: on the groove of two at z %.4f (expected %.4f), crosswise on one at z %.4f (expected %.4f)\n",
              pieces.Get(top).position[2], grooveZ, pieces.Get(cross).position[2], 3 * r);
  SIM_NEAR(pieces.Get(top).position[2], grooveZ, 0.01, "rests on two others");
  SIM_NEAR(pieces.Get(cross).position[2], 3 * r, 0.005, "rests crosswise on another");
  CylinderParams noStack;
  noStack.pieceContacts = false;
  CylinderPieces ghost(noStack);
  ghost.SpawnLying(1, 1, 0);
  const int g = ghost.Spawn({{1, 1, 0.4}, vec::FromEuler(0, 0, kPi / 2)});
  Run(ghost, 2.0);
  SIM_NEAR(ghost.Get(g).position[2], r, 0.002, "pieceContacts off: pieces pass through each other");
}

void IntakeHook() {
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 1, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  const double r = pieces.Params().radius;
  const int c = pieces.SpawnLying(1.8, 1, kPi / 2);
  pieces.SpawnLying(3.0, 1, kPi / 2);
  // Intake wheels: a segment across the front, 3 cm above the coral's top.
  const Vec3 wa{1.8, 0.8, 2 * r + 0.03}, wb{1.8, 1.2, 2 * r + 0.03};
  const auto near = pieces.Near(wa, wb, 0.05);
  std::printf("intake query: %zu within 5 cm, nearest %d at %.4f m\n", near.size(), near.empty() ? -1 : near[0].index,
              near.empty() ? 0.0 : near[0].distance);
  SIM_CHECK(near.size() == 1 && near[0].index == c, "only the coral under the wheels");
  SIM_NEAR(near.empty() ? 0.0 : near[0].distance, 0.03, 1e-4, "surface distance");
  SIM_CHECK(pieces.Near(wa, wb, 0.02).empty(), "nothing within 2 cm");
  // Robot code takes it, carries it, lets go above the floor.
  pieces.Hold(c, robot);
  SIM_CHECK(pieces.HeldCount(robot) == 1 && pieces.Near(wa, wb, 2.0).size() == 1 && pieces.Near(wa, wb, 2.0)[0].index != c, "held pieces are not offered again");
  CylinderPose carried{{1.5, 1, 0.8}, vec::FromEuler(0, 0.3, 0)};
  pieces.SetHeldPose(c, carried);
  Run(pieces, 0.5);
  SIM_NEAR(pieces.Get(c).position[2], 0.8, 1e-12, "held piece stays where the robot code put it");
  SIM_CHECK(pieces.Poses().size() == 2 && pieces.Poses(false).size() == 1, "Poses lists held pieces optionally");
  pieces.Release(c, carried, {1, 0, 0});
  SIM_CHECK(pieces.Get(c).state == CylinderState::Flying, "released: Flying");
  Run(pieces, 2.0);
  std::printf("released at 0.8 m moving 1 m/s: rests at (%.2f, %.2f, %.3f) state %d\n", pieces.Get(c).position[0],
              pieces.Get(c).position[1], pieces.Get(c).position[2], static_cast<int>(pieces.Get(c).state));
  SIM_CHECK(pieces.Get(c).state == CylinderState::Lying && pieces.Get(c).position[0] > 1.6, "lands and settles");
  // ApplyImpulse wakes and moves a sleeping piece.
  const int sleeper = pieces.SpawnLying(4, 2, 0);
  Run(pieces, 1.0);
  SIM_CHECK(pieces.Get(sleeper).asleep, "asleep before the pull");
  pieces.ApplyImpulse(sleeper, pieces.Get(sleeper).position, {0, 0.3, 0});
  Run(pieces, 0.2);
  SIM_CHECK(pieces.Get(sleeper).position[1] > 2.02, "impulse pulls it: y %.3f", pieces.Get(sleeper).position[1]);
}

void PolygonCollider() {
  // An end-effector plate in front of the robot, registered in the robot frame, sweeps a coral.
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  CylinderParams p = pieces.Params();
  (void)p;
  MechanismCollider plate;
  plate.name = "end effector";
  plate.robot = robot;
  plate.outline = {{0.42, 0.02}, {0.62, 0.02}, {0.62, 0.30}, {0.42, 0.30}};  // x-z, ahead of the bumper
  plate.width = 0.4;
  pieces.AddCollider(plate);
  const int c = pieces.SpawnLying(2.0, 2, kPi / 2);
  rig.Run(Drive(0.8), 1.5, nullptr, nullptr, [&] { pieces.Step(kDt); });
  const double front = rig.sim.Pose().x + 0.62;
  std::printf("end-effector plate: coral at x %.3f, plate front at %.3f\n", pieces.Get(c).position[0], front);
  SIM_CHECK(pieces.Get(c).position[0] > front + pieces.Params().radius - 0.005, "plate pushes the coral ahead of the bumper");
}

void SpinningRoller() {
  // A world-frame roller (capsule along y) resting on top of a lying coral. Spinning, its surface
  // drags the coral by friction (the collider's velocity field includes w x r); still, it doesn't.
  auto run = [](double spin) {
    CylinderPieces pieces;
    const double r = pieces.Params().radius;
    const int c = pieces.SpawnLying(0, 0, kPi / 2);  // axis along y
    MechanismCollider roller;
    roller.name = "roller";
    roller.shape = MechanismCollider::Shape::Capsule;
    roller.robotFrame = false;
    roller.radius = 0.025;
    roller.position = {0, 0, 2 * r + roller.radius - 0.004};  // squeezing the coral 4 mm
    roller.a = {0, -0.2, 0};
    roller.b = {0, 0.2, 0};
    roller.angularVelocity = {0, spin, 0};  // +y: the roller's underside moves toward -x
    roller.friction = 1.0;
    pieces.AddCollider(roller);
    Run(pieces, 0.5);
    return pieces.Get(c).position[0];
  };
  const double moved = run(60), still = run(0);
  std::printf("spinning roller on a coral: moved it %.3f m in 0.5 s (still roller: %.4f m)\n", moved, still);
  SIM_CHECK(moved < -0.05, "a spinning roller drives the coral: %.3f", moved);
  SIM_CHECK(std::abs(still) < 0.005, "a still roller only presses it: %.4f", still);
}

struct PinchResult {
  double maxImpulse = 0;   // largest |LastRobotImpulse| in one step, N*s
  double maxTilt = 0;      // robot roll/pitch, rad
  double maxSpeed = 0;     // coral, m/s
  double maxReported = 0;  // largest normal impulse LastContactsWith(Collider, plate) reported
  bool limitedSeen = false, reportedRobot = true;
  CylinderState state = CylinderState::Lying;
};

/**
 * A plate on the robot (robot frame) moves at 1 m/s through a coral's space, pinching it against
 * the carpet (standing coral ahead of the bumper) or the robot's own box top (coral lying on it).
 */
PinchResult Pinch(bool onRobotTop, double maxForce, double robotMaxForce) {
  CylinderParams cp;
  cp.robotBoxTopM = 0.25;
  cp.robotMaxForce = robotMaxForce;
  CylinderPieces pieces(cp);
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  const double r = cp.radius;
  const int c = onRobotTop ? pieces.SpawnLying(1.0, 2, kPi / 2) : pieces.SpawnStanding(1.0 + 0.42 + 0.20, 2, cp.length);
  if (onRobotTop) pieces.Place(c, {{1.0, 2, 0.25 + r}, vec::FromEuler(0, 0, kPi / 2)});
  MechanismCollider plate;
  plate.name = "end effector";
  plate.robot = robot;
  plate.maxForce = maxForce;
  const double x0 = onRobotTop ? -0.1 : 0.52, x1 = onRobotTop ? 0.1 : 0.72;
  plate.outline = {{x0, 0}, {x1, 0}, {x1, 0.02}, {x0, 0.02}};
  plate.width = 0.35;
  const double zStart = onRobotTop ? 0.25 + 2 * r + 0.05 : cp.length + 0.05, zEnd = onRobotTop ? 0.25 + r : 0.10;
  plate.position = {0, 0, zStart};
  const int pl = pieces.AddCollider(plate);
  PinchResult out;
  rig.Run(Drive(0), 0.8, nullptr, nullptr, [&] {
    auto& col = pieces.Collider(pl);
    const bool moving = col.position[2] > zEnd;
    col.velocity = {0, 0, moving ? -1.0 : 0.0};
    col.position[2] = std::max(zEnd, col.position[2] - (moving ? kDt : 0));
    pieces.Step(kDt);
    out.maxImpulse = std::max(out.maxImpulse, vec::Norm(pieces.LastRobotImpulse(robot)));
    const auto p3 = rig.sim.Pose3();
    out.maxTilt = std::max({out.maxTilt, std::abs(p3.roll), std::abs(p3.pitch)});
    out.maxSpeed = std::max(out.maxSpeed, vec::Norm(pieces.Get(c).velocity));
    for (const auto& rep : pieces.LastContactsWith(CylinderContactSource::Collider, pl)) {
      out.maxReported = std::max(out.maxReported, rep.normalImpulse);
      out.limitedSeen = out.limitedSeen || rep.limited;
      out.reportedRobot = out.reportedRobot && rep.robot == robot && rep.piece == c;
    }
  });
  out.state = pieces.Get(c).state;
  return out;
}

void ForceLimitedPinch() {
  const double kInf = std::numeric_limits<double>::infinity();
  for (bool top : {false, true}) {
    const char* what = top ? "coral on the robot's box, plate from above" : "standing coral, plate pressing it into the carpet";
    const PinchResult rigid = Pinch(top, kInf, kInf);
    const double limit = 150, robotLimit = top ? 300 : kInf;
    const PinchResult soft = Pinch(top, limit, robotLimit);
    std::printf("%s: rigid plate max %.2f N s/step (%.0f N), tilt %.1f deg, coral %.1f m/s; maxForce %.0f N: max %.3f N s/step, "
                "tilt %.2f deg, coral %.2f m/s, state %d, limited %d\n",
                what, rigid.maxImpulse, rigid.maxImpulse / kDt, rigid.maxTilt * 180 / kPi, rigid.maxSpeed, limit, soft.maxImpulse,
                soft.maxTilt * 180 / kPi, soft.maxSpeed, static_cast<int>(soft.state), soft.limitedSeen);
    const double bound = (limit + (top ? robotLimit : 0)) * kDt * (1 + 1e-9);
    SIM_CHECK(soft.maxImpulse <= bound, "robot impulse within the force limits: %.4f > %.4f N s", soft.maxImpulse, bound);
    SIM_CHECK(soft.maxReported <= limit * kDt * (1 + 1e-9), "plate's normal impulse within maxForce dt: %.4f", soft.maxReported);
    SIM_CHECK(soft.maxTilt < 0.02, "the robot does not tip: %.3f rad", soft.maxTilt);
    SIM_CHECK(soft.maxSpeed < 3, "the coral is squeezed, not launched: %.2f m/s", soft.maxSpeed);
    SIM_CHECK(soft.state != CylinderState::Removed && soft.state != CylinderState::Flying, "coral still on the field");
    SIM_CHECK(soft.limitedSeen && soft.reportedRobot, "contact report names the plate, the coral and the robot, marked limited");
  }
}

void ClawOnSameRobot() {
  // Two jaws on one robot close through a lying coral (across its axis) at 0.5 m/s each.
  auto run = [](double maxForce, double& maxImpulse, double& maxSpeed, double& gap) {
    CylinderPieces pieces;
    Rig rig;
    rig.sim.SetPose(1, 2, 0);
    const int robot = pieces.AddRobot(&rig.sim);
    const double r = pieces.Params().radius;
    const int c = pieces.SpawnLying(1.0 + 0.42 + 0.10, 2, 0);  // axis along x, ahead of the bumper
    int jaw[2];
    for (int side = 0; side < 2; ++side) {
      MechanismCollider j;
      j.name = side ? "left jaw" : "right jaw";
      j.robot = robot;
      j.maxForce = maxForce;
      j.outline = {{0.40, 0.0}, {0.64, 0.0}, {0.64, 0.12}, {0.40, 0.12}};
      j.width = 0.02;
      j.position = {0, side ? 0.12 : -0.12, 0};
      jaw[side] = pieces.AddCollider(j);
    }
    maxImpulse = maxSpeed = 0;
    rig.Run(Drive(0), 0.6, nullptr, nullptr, [&] {
      for (int side = 0; side < 2; ++side) {
        auto& j = pieces.Collider(jaw[side]);
        const double sign = side ? 1 : -1, y = std::abs(j.position[1]);
        const bool moving = y > 0.02;
        j.velocity = {0, moving ? -0.5 * sign : 0.0, 0};
        j.position[1] = sign * std::max(0.02, y - (moving ? 0.5 * kDt : 0));
      }
      pieces.Step(kDt);
      maxImpulse = std::max(maxImpulse, vec::Norm(pieces.LastRobotImpulse(robot)));
      maxSpeed = std::max(maxSpeed, vec::Norm(pieces.Get(c).velocity));
    });
    gap = 2 * (std::abs(pieces.Collider(jaw[0]).position[1]) - 0.01);
    (void)r;
  };
  double rigidJ, rigidV, g, softJ, softV;
  run(std::numeric_limits<double>::infinity(), rigidJ, rigidV, g);
  run(100, softJ, softV, g);
  std::printf("claw closing through a coral: rigid jaws max %.2f N s/step, coral %.1f m/s; 100 N jaws max %.3f N s/step, coral %.2f m/s\n",
              rigidJ, rigidV, softJ, softV);
  SIM_CHECK(softJ <= 2 * 100 * kDt * (1 + 1e-9), "robot impulse within both jaws' limits: %.4f", softJ);
  SIM_CHECK(softV < 3, "the coral is held or squeezed out, not launched: %.2f m/s", softV);
}

/**
 * A plate's face pushes a standing coral at height h at 0.5 m/s. `lean` (rad) tilts the face:
 * positive leans its top edge forward over the coral, negative leads with its bottom edge.
 */
struct PlatePush { CylinderState state; double uprightSlide; };
PlatePush PushWithPlate(double lean, double h) {
  CylinderPieces pieces;
  const auto& p = pieces.Params();
  const int c = pieces.SpawnStanding(2, 2, p.length);
  MechanismCollider plate;
  plate.robotFrame = false;
  plate.friction = 0.5;
  const double s = std::sin(lean), co = std::cos(lean), len = 0.25;
  Vec2 a{0, h}, b = lean >= 0 ? Vec2{-len * s, h - len * co} : Vec2{len * s, h + len * co};
  if (lean == 0) { a = {0, h - 0.01}; b = {0, h + 0.01}; }  // a 2 cm bar
  plate.outline = {a, b, {b[0] - 0.2, b[1]}, {a[0] - 0.2, a[1]}};
  plate.width = 0.3;
  plate.position = {2 - p.radius - 0.05, 2, 0};
  plate.velocity = {0.5, 0, 0};
  const int id = pieces.AddCollider(plate);
  double slide = 0;
  for (int k = 0; k < 1500; ++k) {
    auto& col = pieces.Collider(id);
    if (k < 800) col.position[0] += 0.5 * kDt; else col.velocity = {0, 0, 0};
    pieces.Step(kDt);
    if (Tilt(pieces.Get(c)) < 0.2) slide = pieces.Get(c).position[0] - 2;
  }
  return {pieces.Get(c).state, slide};
}

void PlateTipsStandingCoral() {
  // A coral pushed above r / mu (7 cm for carpet at 0.8) pivots over its base edge; a bar or a
  // sloped face smaller than the coral tips it like a rod does, at the top included. (The hull
  // contact used to pick the bar's underside once the coral leaned 10 degrees and push it back
  // down onto its base, so it was carried along upright.)
  int tipped = 0, cases = 0;
  for (double lean : {0.0, 0.35, 0.7, -0.35, -0.7})
    for (double h : {0.15, 0.22, 0.28}) {
      const PlatePush r = PushWithPlate(lean, h);
      cases++;
      tipped += r.state == CylinderState::Lying;
      SIM_CHECK(r.state == CylinderState::Lying, "face leaning %.0f deg at %.2f m tips the coral (state %d)", lean * 180 / kPi, h,
                static_cast<int>(r.state));
      SIM_CHECK(r.uprightSlide < 0.12, "and does not carry it along upright: %.3f m", r.uprightSlide);
    }
  // Pushed at 4 cm (below r / mu) by a face pressing down on it, it slides upright.
  const PlatePush low = PushWithPlate(0.35, 0.04);
  std::printf("standing coral pushed by bars and sloped faces at 0.15-0.28 m: %d of %d tip; at 0.04 m pressing down: slides %.2f m upright\n",
              tipped, cases, low.uprightSlide);
  SIM_CHECK(low.state == CylinderState::Standing && low.uprightSlide > 0.25, "pushed low it slides: %.3f m", low.uprightSlide);
}

/** An end effector made of `n` shapes, 0.9 m ahead of the robot's centre, comes down onto a lying coral. */
struct ArmPress { double maxForce = 0, maxTilt = 0; };
ArmPress PressCoral(int n, double maxForce, bool shared) {
  CylinderPieces pieces;
  Rig rig;
  rig.sim.SetPose(1, 2, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  pieces.SpawnLying(1.9, 2, kPi / 2);
  std::vector<int> ids;
  for (int i = 0; i < n; ++i) {
    MechanismCollider c;
    c.robot = robot;
    c.maxForce = maxForce;
    c.forceGroup = shared ? 0 : -1;
    const double w = 0.30 / n;
    c.outline = {{0.8, 0}, {1.0, 0}, {1.0, 0.05}, {0.8, 0.05}};
    c.width = w;
    c.position = {0, -0.15 + w / 2 + i * w, 0.5};
    ids.push_back(pieces.AddCollider(c));
  }
  ArmPress out;
  rig.Run(Drive(0), 1.5, nullptr, nullptr, [&] {
    for (int id : ids) {
      auto& c = pieces.Collider(id);
      const bool moving = c.position[2] > 0;
      c.velocity = {0, 0, moving ? -0.5 : 0.0};
      c.position[2] = std::max(0.0, c.position[2] - (moving ? 0.5 * kDt : 0));
    }
    pieces.Step(kDt);
    out.maxForce = std::max(out.maxForce, vec::Norm(pieces.LastRobotImpulse(robot)) / kDt);
    const auto p3 = rig.sim.Pose3();
    out.maxTilt = std::max({out.maxTilt, std::abs(p3.roll), std::abs(p3.pitch)});
  });
  return out;
}

void SharedForceBudget() {
  // The 68 kg reference robot (wheels 0.26 m from its centre) is lifted at the front by a push
  // up at 0.9 m of more than m g a / (0.9 + a) = 151 N. An arm of three shapes limited to 100 N
  // each pushes with up to 300 N; sharing one budget (forceGroup) it pushes with 100 N in all.
  const ArmPress each = PressCoral(3, 100, false), shared = PressCoral(3, 100, true), one = PressCoral(1, 100, false);
  std::printf("arm of 3 shapes at 100 N pressing a lying coral 0.9 m out: separate budgets %.0f N on the robot, tilt %.1f deg; "
              "shared budget %.0f N, tilt %.2f deg; one shape %.0f N, tilt %.2f deg\n",
              each.maxForce, each.maxTilt * 180 / kPi, shared.maxForce, shared.maxTilt * 180 / kPi, one.maxForce, one.maxTilt * 180 / kPi);
  SIM_CHECK(each.maxForce > 200 && each.maxTilt > 0.05, "separate budgets add up and lift the robot: %.0f N, %.3f rad", each.maxForce, each.maxTilt);
  SIM_CHECK(shared.maxForce <= 100 * (1 + 1e-9), "a shared budget caps the whole arm: %.1f N", shared.maxForce);
  SIM_CHECK(shared.maxTilt < 0.01 && one.maxTilt < 0.01, "below the lifting force the robot stays down: %.4f, %.4f rad", shared.maxTilt, one.maxTilt);
  SIM_CHECK(one.maxForce <= 100 * (1 + 1e-9), "one shape within its limit: %.1f N", one.maxForce);
  // Above the lifting force the front does come up, as far as the coral under the arm holds it.
  const ArmPress strong = PressCoral(1, 200, false);
  std::printf("one shape at 200 N (above the 151 N lifting force): %.0f N, tilt %.1f deg\n", strong.maxForce, strong.maxTilt * 180 / kPi);
  SIM_CHECK(strong.maxForce <= 200 * (1 + 1e-9), "reaction within maxForce: %.1f N", strong.maxForce);
  SIM_CHECK(strong.maxTilt > 0.05 && strong.maxTilt < 0.15, "lifts onto the coral and no further: %.3f rad", strong.maxTilt);
}

void RobotFramePlacement() {
  // A world-frame collider placed with SetFromRobotFrame behaves exactly like a robotFrame one.
  auto run = [](bool helper) {
    CylinderPieces pieces;
    Rig rig;
    rig.sim.SetPose(1, 2, 0);
    const int robot = pieces.AddRobot(&rig.sim);
    const int c = pieces.SpawnLying(2.2, 2.1, kPi / 2);
    MechanismCollider plate;
    plate.robot = robot;
    plate.outline = {{0.42, 0.02}, {0.62, 0.02}, {0.62, 0.30}, {0.42, 0.30}};
    plate.width = 0.4;
    plate.position = {0, 0, 0.01};
    plate.velocity = {0.1, 0, 0};
    const int pl = pieces.AddCollider(plate);
    rig.Run(Drive(0.8, 0, 0.5), 1.5, nullptr, nullptr, [&] {
      if (helper) pieces.Collider(pl).SetFromRobotFrame(rig.sim, {0, 0, 0.01}, {}, {0.1, 0, 0});
      pieces.Step(kDt);
    });
    return pieces.Get(c).position;
  };
  const Vec3 a = run(false), b = run(true);
  std::printf("SetFromRobotFrame vs robotFrame: coral ends %.6f apart\n", vec::Norm(vec::Sub(a, b)));
  SIM_CHECK(vec::Norm(vec::Sub(a, b)) < 1e-9, "same result as a robot-frame collider");
}

double Many(std::vector<double>* trace) {
  Obstacles obstacles;
  obstacles.SetPerimeter(0, 0, 8, 6, 0.3);
  std::vector<Vec2> hex;
  for (int k = 0; k < 6; ++k) hex.push_back({4 + 0.8 * std::cos(k * kPi / 3), 3 + 0.8 * std::sin(k * kPi / 3)});
  obstacles.AddPolygon("reef", hex, 0, 0.3);
  obstacles.AddBox("station", 0.4, 0.4, kPi / 4, 1.5, 0.3, 0, 1.0);
  CylinderPieces pieces;
  for (int i = 0; i < 20; ++i) {
    const double x = 1.2 + 0.35 * (i % 10), y = i < 10 ? 1.3 : 4.7;
    if (i % 3 == 0) pieces.SpawnStanding(x, y);
    else pieces.Spawn({{x, y, 0.2 + 0.05 * (i % 4)}, vec::FromEuler(0.1 * i, 0.2, 0.3 * i)}, {0.3 * ((i % 5) - 2), 0, 0});
  }
  Rig rig;
  rig.sim.SetPose(0.8, 1.3, 0);
  const int robot = pieces.AddRobot(&rig.sim);
  MechanismCollider plate;
  plate.robot = robot;
  plate.outline = {{0.42, 0.02}, {0.6, 0.02}, {0.6, 0.3}, {0.42, 0.3}};
  plate.width = 0.4;
  pieces.AddCollider(plate);
  MechanismCollider elevator;
  elevator.shape = MechanismCollider::Shape::Capsule;
  elevator.robot = robot;
  elevator.a = {0.1, 0, 0.2};
  elevator.b = {0.1, 0, 1.2};
  elevator.radius = 0.05;
  pieces.AddCollider(elevator);
  double pieceTime = 0;
  rig.Run(Drive(2.0, 0, 0.4), 3.0, nullptr, &obstacles, [&] {
    const auto t0 = std::chrono::steady_clock::now();
    pieces.Step(kDt, nullptr, &obstacles);
    pieceTime += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  });
  if (trace) {
    for (const auto& c : pieces.Pieces()) {
      trace->insert(trace->end(), c.position.begin(), c.position.end());
      trace->insert(trace->end(), {c.orientation.w, c.orientation.x, c.orientation.y, c.orientation.z});
    }
    const auto pose = rig.sim.Pose3();
    trace->insert(trace->end(), {pose.x, pose.y, pose.yaw});
  } else {
    int bad = 0, standing = 0;
    for (const auto& c : pieces.Pieces()) {
      for (double v : c.position) bad += !std::isfinite(v);
      bad += c.position[0] < 0 || c.position[0] > 8 || c.position[1] < 0 || c.position[1] > 6;
      standing += c.state == CylinderState::Standing;
    }
    std::printf("20 coral + robot with plate and elevator plowing for 3 s: %.1f us/step; %d standing; bad %d\n",
                pieceTime / 3000 * 1e6, standing, bad);
    SIM_CHECK(bad == 0, "all finite and on the field");
  }
  return pieceTime / 3000;
}

void Budget() {
  const double perStep = Many(nullptr);
  if (kSimOptimized) SIM_CHECK(perStep < 150e-6, "20 pieces under 0.15 ms per 1 ms step: %.1f us", perStep * 1e6);
}

void Determinism() {
  std::vector<double> a, b;
  Many(&a);
  Many(&b);
  SIM_CHECK(a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0,
            "identical runs give bit-identical pieces and robot");
}

}  // namespace

int main() {
  RestsStably();
  DropAndBounce();
  Tipping();
  RollVsSlide();
  BumperPushes();
  WallsAndPrisms();
  Stacking();
  IntakeHook();
  PolygonCollider();
  SpinningRoller();
  ForceLimitedPinch();
  ClawOnSameRobot();
  PlateTipsStandingCoral();
  SharedForceBudget();
  RobotFramePlacement();
  Budget();
  Determinism();
  return SimResult("sim_cylinders");
}
