#pragma once
// mayhem::sim rigid-cylinder game pieces (2025 coral and the like). Header-only, C++17, no
// dependencies.
//
// Each piece is a rigid cylinder (radius, length, mass; hollow-tube inertia) with a full 6-DOF
// pose (position + quaternion; the cylinder's axis is its local x, as AdvantageScope's and the
// Mayhem replay's Sim/Coral poses expect) and velocity. States: Standing (resting on an end),
// Lying, Flying (no contact for a few ms), Held (owned by robot code; not simulated) and
// Removed.
//
// Per Step (1 ms):
// - Gravity, then contacts, then a sequential-impulse solve (Coulomb friction with a friction
//   circle, restitution above restSpeed, speculative contacts so nothing tunnels at field
//   speeds) and split-impulse position correction (pushing out of an overlap never adds energy;
//   at most maxPushSpeed, e.g. a piece spawned under a robot).
// - Carpet: the floor plane (or the Terrain's tangent plane under the piece). Contacts sit on the
//   cylinder's real surface: the generator line nearest the floor (two points when lying) and
//   points on each rim at 0 and +-120 degrees from it (a triangle when standing, always aligned so
//   the lowest rim point is the pivot). So a pushed coral rolls across its axis (friction at the
//   contact line spins it up), slides along its axis (mu * g), and a standing one tips over its
//   base edge when the push is high enough and friction holds the base. Rolling resistance is a
//   torque about the axis of rollingResistance * N * radius.
// - Static obstacles: perimeter walls (below their height) and Obstacles prisms with their z
//   range (reef base, coral stations, ...).
// - Robots: each SwerveSim's bumper box (bumperBottomM up to robotBoxTopM or RobotHeight), moving
//   with the robot's pose and velocity; the reaction impulse is applied to the robot
//   (SwerveSim::ApplyExternalForce3, used in its next Step), as GamePieces does for balls.
// - Mechanism colliders the robot code registers or updates each step: convex polygons in a
//   frame's x-z plane extruded along its y, or capsules, with a pose and velocity in the world or
//   relative to a robot (an end effector, an elevator). Reactions go to that robot.
// - Piece-piece: on by default (pieceContacts). Each piece is approximated by a capsule of the
//   same radius and overall length (rounded ends), so pieces rest on each other side-on (a coral
//   lying across or beside others) but a coral balanced end-on on another's end is not stable.
//
// Convex-hull contacts (prisms, bumpers, polygon colliders) use the hull's face normals as
// separating axes, so near a hull's convex edge a piece can be stopped up to r (sqrt 2 - 1)
// (about 2.4 cm for coral) early. Pieces at rest for sleepTime sleep (no drift, no cost) until a
// robot, collider or moving piece comes near them, or the robot code touches them.
//
// Intake hook: Near(a, b, d) returns the pieces whose surface is within d of segment a-b (the
// intake wheels), nearest first, with their pose and velocity. The robot code applies its own
// wheel-contact rules (ApplyImpulse to pull one in), then Hold(index), SetHeldPose each loop while
// it carries it, and Release(index, pose, velocity) to drop or score it.
//
// Logging: Poses() returns every piece's pose (held ones at their SetHeldPose) for Sim/Coral as a
// Pose3d[] (wpilib_sim.hpp: ToPoses), which AdvantageScope and the Mayhem 3D replay draw.
//
// Spheres (2025 algae): SpawnBall adds a rigid ball (SphereParams: radius, mass, thin-shell
// inertia, its own friction/restitution per surface, rolling resistance) to the same solver, so
// balls and cylinders push each other (exact sphere-cylinder distance: an algae rests on a
// standing coral's top), rest on and bounce off capsule colliders (reef pipes), and meet the
// floor, walls, prisms, bumpers and mechanism colliders (exact closest point on the prism, so no
// early stop at edges) with the same force limits and contact reports. Ball indices share the
// piece index space; the coral-specific calls (Count, HeldCount, Poses, Near) skip balls, and
// BallPositions, BallPoses and NearBalls are their ball counterparts.
//
// Call order per 1 ms: robots Step, then CylinderPieces::Step (its forces reach the robots' next
// Step). Deterministic: no randomness, fixed iteration order.
#include "mayhem/sim/field.hpp"
#include "mayhem/sim/swerve.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace mayhem::sim {

/**
 * Ball pieces in a CylinderPieces world (2025 REEFSCAPE algae: a 16.25 in, 1.4 lb playground
 * ball). Friction and restitution apply to that surface type; mechanism colliders use their own.
 */
struct SphereParams {
  double radius = 0.20638, mass = 0.635;
  double inertiaFactor = 2.0 / 3.0;   // I = inertiaFactor m r^2 (2/3 thin shell, 2/5 solid)
  double floorFriction = 0.8, floorRestitution = 0.55;
  // Rolling resistance: torque against the ball's rotation of rollingResistance * N * radius
  // (N: normal force from below). A soft ball flattens where it is pressed, so raise it for a
  // squashed ball; 0.04 matches a playground ball rolling on carpet.
  double rollingResistance = 0.04;
  double obstacleFriction = 0.6, obstacleRestitution = 0.5;
  double robotFriction = 0.6, robotRestitution = 0.4;
  double pieceFriction = 0.5, pieceRestitution = 0.4;  // ball-ball and ball-cylinder
};

struct CylinderParams {
  // Shape (2025 REEFSCAPE coral: 4.5 in OD PVC, 11.875 in long, 1.5 lb).
  double radius = 0.05715, length = 0.301625, mass = 0.6804;
  double innerRadius = 0.0511;       // inertia only (hollow tube); 0 = solid
  // Carpet.
  double floorFriction = 0.8, floorRestitution = 0.2;
  double rollingResistance = 0.04;   // torque about the axis = rollingResistance * N * radius
  // Field elements, robots, other pieces (mechanism colliders carry their own).
  double obstacleFriction = 0.4, obstacleRestitution = 0.2;
  double robotFriction = 0.6, robotRestitution = 0.2;
  double pieceFriction = 0.3, pieceRestitution = 0.2;
  bool pieceContacts = true;
  double restSpeed = 0.15;           // m/s: slower impacts do not bounce
  double robotBoxTopM = -1;          // bumper box top above the robot's floor reference; < 0: RobotHeight()
  // Cap on the total contact force (normal plus friction, N) one robot's bumper box can put on the
  // pieces in a step, and so on the reaction the robot feels from it. Infinite: rigid.
  double robotMaxForce = std::numeric_limits<double>::infinity();
  // Solver.
  int velocityIterations = 10, positionIterations = 4;
  double contactMargin = 0.003;      // m, speculative contact distance (plus the step's travel)
  double penetrationSlop = 0.0005, correction = 0.2, maxPushSpeed = 3.0;
  double standingAngle = 0.35;       // rad from vertical still counted as Standing
  double sleepSpeed = 0.01, sleepAngularSpeed = 0.05, sleepTime = 0.3;
  SphereParams sphere;               // balls added with SpawnBall
};

enum class PieceShape { Cylinder, Sphere };

enum class CylinderState { Standing, Lying, Flying, Held, Removed };

/** Position of the centre and orientation; the cylinder's axis is the local x axis. */
struct CylinderPose {
  Vec3 position{0, 0, 0};
  vec::Quat orientation{};
  Vec3 Axis() const { const auto r = vec::ToMatrix(orientation); return {r[0], r[3], r[6]}; }
  /** Lying on the carpet (z = radius) at (x, y) with its axis along yaw. */
  static CylinderPose Lying(double x, double y, double yaw, double radius) {
    return {{x, y, radius}, vec::FromEuler(0, 0, yaw)};
  }
  /** Standing on its end at (x, y) (axis +z; yaw turns it about the axis). */
  static CylinderPose Standing(double x, double y, double length, double yaw = 0) {
    return {{x, y, length / 2}, vec::FromEuler(yaw, -kPi / 2, 0)};
  }
};

struct Cylinder {
  Vec3 position{0, 0, 0}, velocity{0, 0, 0}, angularVelocity{0, 0, 0};  // world frame
  vec::Quat orientation{};
  CylinderState state = CylinderState::Removed;
  int owner = -1;            // Held: robot index (or any storage id)
  bool asleep = false;
  double stillTime = 0;
  int stepsSinceContact = 1000;
  PieceShape shape = PieceShape::Cylinder;  // Sphere: a ball (SpawnBall); never Standing
  Vec3 Axis() const { const auto r = vec::ToMatrix(orientation); return {r[0], r[3], r[6]}; }
  CylinderPose Pose() const { return {position, orientation}; }
};

/**
 * A kinematic mechanism shape. Polygon: a convex outline in the frame's x-z plane, extruded over
 * `width` along the frame's y (centred). Capsule: segment a-b in the frame, with a radius. The
 * frame's pose and velocity (of its origin) are in the world, or relative to robot `robot`'s
 * origin frame (x forward, y left, z up from the floor reference) when robotFrame is true.
 */
struct MechanismCollider {
  enum class Shape { Polygon, Capsule };
  std::string name;
  Shape shape = Shape::Polygon;
  int robot = -1;            // CylinderPieces::AddRobot index: reaction goes there; -1: none
  bool robotFrame = true;    // pose/velocity relative to the robot (needs robot >= 0)
  bool enabled = true;
  Vec3 position{0, 0, 0};
  vec::Quat orientation{};
  Vec3 velocity{0, 0, 0}, angularVelocity{0, 0, 0};
  std::vector<Vec2> outline;  // Polygon: (x, z) points, convex, any winding
  double width = 0.3;         // Polygon: extent along the frame's y
  Vec3 a{0, 0, 0}, b{0, 0, 0};  // Capsule
  double radius = 0.02;         // Capsule
  double friction = 0.5, restitution = 0.1;
  // Contact compliance (N/m of overlap): a piece squeezed by the collider feels a normal force of
  // stiffness x overlap even when nothing is moving toward it, so a roller or belt pressing on a
  // piece grips it and drives it by friction (compliant wheels squeeze a coral a few mm). 0: rigid.
  double stiffness = 3000;
  // Cap on the total contact force (normal plus friction, N) this collider can put on all pieces
  // in a step, like a mechanism that back-drives or current-limits: a piece pinched against the
  // carpet, a wall or the robot is squeezed or slips instead of being pushed without limit, and
  // the reaction on `robot` is capped the same way. Infinite (default): a rigid, unstoppable shape.
  double maxForce = std::numeric_limits<double>::infinity();
  // Colliders of one robot with the same forceGroup (>= 0) are one mechanism: they share one
  // force budget, the smallest maxForce among them, so an arm built from several shapes (stages,
  // end effector, wheel stacks) cannot push with several times its limit. -1: its own budget.
  int forceGroup = -1;

  /**
   * Place a world-frame collider (robotFrame = false) from a pose and velocity given in robot
   * `sim`'s frame, exactly as robotFrame = true would at the current robot state. Lets robot code
   * keep `robot` >= 0 (for reactions) while positioning the shape itself. Call it every step.
   */
  void SetFromRobotFrame(const SwerveSim& sim, Vec3 framePosition, vec::Quat frameOrientation = {},
                         Vec3 frameVelocity = {0, 0, 0}, Vec3 frameAngularVelocity = {0, 0, 0}) {
    robotFrame = false;
    const auto pose = sim.Pose3();
    const auto vel = sim.FieldVelocity();
    const auto rq = vec::FromEuler(pose.roll, pose.pitch, pose.yaw);
    const auto rr = vec::ToMatrix(rq);
    const Vec3 rel = vec::Mul(rr, framePosition), wr{0, 0, vel.omega};
    position = vec::Add({pose.x, pose.y, pose.z}, rel);
    velocity = vec::Add(vec::Add(Vec3{vel.vx, vel.vy, 0}, vec::Cross(wr, rel)), vec::Mul(rr, frameVelocity));
    angularVelocity = vec::Add(wr, vec::Mul(rr, frameAngularVelocity));
    const auto& a = rq;
    const auto& b = frameOrientation;
    orientation = {a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
                   a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w};
  }
};

/** What a piece touched. */
enum class CylinderContactSource { Floor, Wall, Prism, Robot, Collider, Piece };

/**
 * One piece's contact with one thing in the last Step (CylinderPieces::LastContacts), summed over
 * that pair's contact points. `index`: the Obstacles wall or prism index, AddRobot index,
 * AddCollider index or other piece; -1 for the floor.
 */
struct CylinderContact {
  int piece = -1;
  CylinderContactSource source = CylinderContactSource::Floor;
  int index = -1;
  int robot = -1;                 // robot that felt the reaction (bumper box or collider's robot); -1: none
  Vec3 impulse{0, 0, 0};          // on the piece, N*s, field frame (normal plus friction)
  double normalImpulse = 0;       // N*s
  Vec3 point{0, 0, 0};            // normal-impulse-weighted contact point
  bool limited = false;           // the collider's or bumper's maxForce capped it this step
};

/** A piece near an intake segment (CylinderPieces::Near). */
struct CylinderNear {
  int index = -1;
  double distance = 0;        // piece surface to the segment (< 0: overlapping)
  Vec3 onPiece{0, 0, 0}, onSegment{0, 0, 0};
  CylinderPose pose;
  Vec3 velocity{0, 0, 0}, angularVelocity{0, 0, 0};
  CylinderState state = CylinderState::Removed;
};

class CylinderPieces {
 public:
  explicit CylinderPieces(CylinderParams params = {}) : p_(params) {
    h_ = p_.length / 2;
    const double rr = p_.radius * p_.radius + p_.innerRadius * p_.innerRadius;
    invMass_ = 1 / p_.mass;
    invIa_ = 1 / (p_.mass * rr / 2);
    invIt_ = 1 / (p_.mass * (3 * rr + p_.length * p_.length) / 12);
    rs_ = p_.sphere.radius;
    invMassS_ = 1 / p_.sphere.mass;
    invIs_ = 1 / (p_.sphere.inertiaFactor * p_.sphere.mass * rs_ * rs_);
  }
  const CylinderParams& Params() const { return p_; }

  // --- Pieces -----------------------------------------------------------------------------
  /** New piece at a pose (moving or not): touching the floor it settles, else it flies. */
  int Spawn(const CylinderPose& pose, Vec3 velocity = {0, 0, 0}, Vec3 angularVelocity = {0, 0, 0}) {
    const int i = Slot();
    Cylinder& c = pieces_[static_cast<std::size_t>(i)];
    c = Cylinder{};
    c.position = pose.position;
    c.orientation = pose.orientation;
    c.velocity = velocity;
    c.angularVelocity = angularVelocity;
    c.state = Classify(c, true);
    c.stepsSinceContact = 0;
    return i;
  }
  int SpawnLying(double x, double y, double yaw = 0) { return Spawn(CylinderPose::Lying(x, y, yaw, p_.radius)); }
  int SpawnStanding(double x, double y, double yaw = 0) { return Spawn(CylinderPose::Standing(x, y, p_.length, yaw)); }
  /** Move a piece (any state but Removed) to a pose, at rest, back under physics. */
  void Place(int i, const CylinderPose& pose) {
    Cylinder& c = At(i);
    const Cylinder fresh = Spawned(pose, {0, 0, 0}, {0, 0, 0}, c.shape);
    c = fresh;
  }
  /** Robot code takes the piece: no physics, no contacts until Release. */
  void Hold(int i, int owner) {
    Cylinder& c = At(i);
    c.state = CylinderState::Held;
    c.owner = owner;
    c.velocity = c.angularVelocity = {0, 0, 0};
    c.asleep = false;
  }
  /** Where a held piece is (call every loop while carrying it, so Poses() logs it there). */
  void SetHeldPose(int i, const CylinderPose& pose) {
    Cylinder& c = At(i);
    c.position = pose.position;
    c.orientation = pose.orientation;
  }
  /** Let go of a piece (held or not) at a pose and velocity; it flies until it touches. */
  void Release(int i, const CylinderPose& pose, Vec3 velocity = {0, 0, 0}, Vec3 angularVelocity = {0, 0, 0}) {
    Cylinder& c = At(i);
    c = Spawned(pose, velocity, angularVelocity, c.shape);
    c.state = CylinderState::Flying;
    c.stepsSinceContact = 1000;
  }
  void Remove(int i) { At(i).state = CylinderState::Removed; }
  /** Impulse (N*s, world) at a world point, e.g. intake wheels pulling a piece in. Wakes it. */
  void ApplyImpulse(int i, Vec3 point, Vec3 impulse) {
    Cylinder& c = At(i);
    if (!Simulated(c)) return;
    c.asleep = false;
    c.stillTime = 0;
    const std::size_t ui = static_cast<std::size_t>(i);
    c.velocity = vec::Add(c.velocity, vec::Scale(impulse, InvMass(ui)));
    const Vec3 r = vec::Sub(point, c.position);
    c.angularVelocity = vec::Add(c.angularVelocity, InvInertiaOf(ui, c.Axis(), vec::Cross(r, impulse)));
  }
  void Wake(int i) { At(i).asleep = false; At(i).stillTime = 0; }

  // --- Balls ------------------------------------------------------------------------------
  /** New ball (centre, velocity, spin); Hold, SetHeldPose, Release, Remove, ApplyImpulse, Get work as for coral. */
  int SpawnBall(Vec3 position, Vec3 velocity = {0, 0, 0}, Vec3 angularVelocity = {0, 0, 0}) {
    const int i = Slot();
    pieces_[static_cast<std::size_t>(i)] = Spawned({position, {}}, velocity, angularVelocity, PieceShape::Sphere);
    return i;
  }
  /** A ball resting on the carpet at (x, y). */
  int SpawnBallOnFloor(double x, double y) { return SpawnBall({x, y, rs_}); }
  /** Release a ball at a centre and velocity (no orientation needed). */
  void ReleaseBall(int i, Vec3 position, Vec3 velocity = {0, 0, 0}, Vec3 angularVelocity = {0, 0, 0}) {
    Release(i, {position, At(i).orientation}, velocity, angularVelocity);
  }
  bool IsBall(int i) const { return pieces_.at(static_cast<std::size_t>(i)).shape == PieceShape::Sphere; }
  std::size_t BallCount(CylinderState s) const {
    std::size_t n = 0;
    for (const auto& c : pieces_) n += c.shape == PieceShape::Sphere && c.state == s;
    return n;
  }
  int HeldBallCount(int owner) const {
    int n = 0;
    for (const auto& c : pieces_) n += c.shape == PieceShape::Sphere && c.state == CylinderState::Held && c.owner == owner;
    return n;
  }
  /** Centres of all balls not Removed (held ones where SetHeldPose put them), for Sim/Algae. */
  std::vector<Vec3> BallPositions(bool includeHeld = true) const {
    std::vector<Vec3> out;
    for (const auto& c : pieces_)
      if (c.shape == PieceShape::Sphere && c.state != CylinderState::Removed && (includeHeld || c.state != CylinderState::Held))
        out.push_back(c.position);
    return out;
  }
  /** Ball poses with their rotation (a spinning ball's logo turns in AdvantageScope). */
  std::vector<CylinderPose> BallPoses(bool includeHeld = true) const {
    std::vector<CylinderPose> out;
    for (const auto& c : pieces_)
      if (c.shape == PieceShape::Sphere && c.state != CylinderState::Removed && (includeHeld || c.state != CylinderState::Held))
        out.push_back(c.Pose());
    return out;
  }
  /** Balls (not Held or Removed) whose surface is within d of segment a-b, nearest first. */
  std::vector<CylinderNear> NearBalls(Vec3 a, Vec3 b, double d) const {
    std::vector<CylinderNear> out;
    for (std::size_t i = 0; i < pieces_.size(); ++i) {
      const Cylinder& c = pieces_[i];
      if (c.shape != PieceShape::Sphere || !Simulated(c)) continue;
      const Vec3 e = vec::Sub(b, a);
      const double ee = vec::Dot(e, e);
      const double t = ee > 0 ? std::clamp(vec::Dot(vec::Sub(c.position, a), e) / ee, 0.0, 1.0) : 0.0;
      const Vec3 q = vec::Add(a, vec::Scale(e, t));
      const Vec3 dq = vec::Sub(q, c.position);
      const double dist = vec::Norm(dq);
      if (dist - rs_ > d) continue;
      CylinderNear n;
      n.index = static_cast<int>(i);
      n.distance = dist - rs_;
      n.onPiece = vec::Add(c.position, vec::Scale(dist > 1e-12 ? vec::Scale(dq, 1 / dist) : Vec3{0, 0, -1}, rs_));
      n.onSegment = q;
      n.pose = c.Pose();
      n.velocity = c.velocity;
      n.angularVelocity = c.angularVelocity;
      n.state = c.state;
      out.push_back(n);
    }
    std::stable_sort(out.begin(), out.end(), [](const CylinderNear& x, const CylinderNear& y) { return x.distance < y.distance; });
    return out;
  }

  const std::vector<Cylinder>& Pieces() const { return pieces_; }
  Cylinder& Get(int i) { return At(i); }
  std::size_t Count(CylinderState s) const {
    std::size_t n = 0;
    for (const auto& c : pieces_) n += c.shape == PieceShape::Cylinder && c.state == s;
    return n;
  }
  int HeldCount(int owner) const {
    int n = 0;
    for (const auto& c : pieces_) n += c.shape == PieceShape::Cylinder && c.state == CylinderState::Held && c.owner == owner;
    return n;
  }

  /** Every cylinder's pose (held ones where SetHeldPose put them); Removed ones are left out. */
  std::vector<CylinderPose> Poses(bool includeHeld = true) const {
    std::vector<CylinderPose> out;
    for (const auto& c : pieces_)
      if (c.shape == PieceShape::Cylinder && c.state != CylinderState::Removed && (includeHeld || c.state != CylinderState::Held))
        out.push_back(c.Pose());
    return out;
  }
  std::vector<CylinderPose> Poses(CylinderState state) const {
    std::vector<CylinderPose> out;
    for (const auto& c : pieces_) if (c.shape == PieceShape::Cylinder && c.state == state) out.push_back(c.Pose());
    return out;
  }

  /**
   * Pieces (not Held or Removed) whose surface is within d of segment a-b, nearest first (ties
   * by index). distance < 0 means the segment is inside the piece.
   */
  std::vector<CylinderNear> Near(Vec3 a, Vec3 b, double d) const {
    std::vector<CylinderNear> out;
    for (std::size_t i = 0; i < pieces_.size(); ++i) {
      const Cylinder& c = pieces_[i];
      if (c.shape != PieceShape::Cylinder || !Simulated(c)) continue;
      const Vec3 axis = c.Axis();
      double t = 0;
      const Surface s = SegmentToCylinder(c.position, axis, a, b, t);
      if (s.distance > d) continue;
      CylinderNear n;
      n.index = static_cast<int>(i);
      n.distance = s.distance;
      n.onPiece = s.point;
      n.onSegment = vec::Add(a, vec::Scale(vec::Sub(b, a), t));
      n.pose = c.Pose();
      n.velocity = c.velocity;
      n.angularVelocity = c.angularVelocity;
      n.state = c.state;
      out.push_back(n);
    }
    std::stable_sort(out.begin(), out.end(), [](const CylinderNear& x, const CylinderNear& y) { return x.distance < y.distance; });
    return out;
  }

  // --- Robots and mechanisms -----------------------------------------------------------
  int AddRobot(SwerveSim* robot) {
    robots_.push_back(robot);
    robotImpulse_.push_back({0, 0, 0});
    return static_cast<int>(robots_.size()) - 1;
  }
  /** Total impulse (N*s, field frame) the pieces put on robot r in the last Step. */
  Vec3 LastRobotImpulse(int r) const { return robotImpulse_.at(static_cast<std::size_t>(r)); }
  int AddCollider(MechanismCollider collider) {
    colliders_.push_back(std::move(collider));
    return static_cast<int>(colliders_.size()) - 1;
  }
  /** Update a collider's pose/velocity (or enable it) every step before Step. */
  MechanismCollider& Collider(int i) { return colliders_.at(static_cast<std::size_t>(i)); }
  void ClearColliders() { colliders_.clear(); }

  /** Advance dt (1 ms). terrain/obstacles may be null (flat carpet, open floor). */
  void Step(double dt, const Terrain* terrain = nullptr, const Obstacles* obstacles = nullptr) {
    const std::size_t n = pieces_.size();
    axis_.resize(n);
    side_.resize(n);
    pv_.assign(n, {0, 0, 0});
    pw_.assign(n, {0, 0, 0});
    touched_.assign(n, 0);
    support_.assign(n, 0.0);
    for (auto& j : robotImpulse_) j = {0, 0, 0};
    for (std::size_t i = 0; i < n; ++i) {
      const auto r = vec::ToMatrix(pieces_[i].orientation);
      axis_[i] = {r[0], r[3], r[6]};
      side_[i] = {r[1], r[4], r[7]};
    }
    BuildShapes(obstacles);
    WakeNearMoving();
    // Gravity.
    for (auto& c : pieces_)
      if (Awake(c)) c.velocity[2] -= kGravity * dt;
    // Contacts.
    contacts_.clear();
    for (std::size_t i = 0; i < n; ++i) {
      if (!Awake(pieces_[i])) continue;
      const int pi = static_cast<int>(i);
      const double m = Margin(pieces_[i], dt);
      FloorContacts(pi, terrain, m, dt);
      if (obstacles) {
        for (std::size_t wi = 0; wi < obstacles->Walls().size(); ++wi) {
          const auto& w = obstacles->Walls()[wi];
          const Vec3 nrm{w.inward[0], w.inward[1], 0};
          if (MinAlong(pi, {0, 0, 1}) > w.height) continue;
          const bool ball = Ball(i);
          Surf s{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, ball ? p_.sphere.obstacleFriction : p_.obstacleFriction,
                 ball ? p_.sphere.obstacleRestitution : p_.obstacleRestitution, -1, 0, CylinderContactSource::Wall,
                 static_cast<int>(wi)};
          SurfaceContacts(pi, nrm, nrm[0] * w.point[0] + nrm[1] * w.point[1], nullptr, -1, w.height, s, m, dt);
        }
      }
      for (std::size_t k = 0; k < hullCount_; ++k) HullContacts(pi, hulls_[k], m, dt);
      for (const auto& cap : capsules_) CapsuleContacts(pi, cap, m, dt);
    }
    if (p_.pieceContacts) PieceContacts(dt);
    Solve(dt);
    BuildReports(dt);
    // Rolling resistance, integration, state.
    for (std::size_t i = 0; i < n; ++i) {
      Cylinder& c = pieces_[i];
      if (!Awake(c)) continue;
      const Vec3 a = axis_[i];
      if (support_[i] > 0 && c.shape == PieceShape::Sphere) {
        // A ball's rolling resistance opposes its whole rotation (rolling and spinning in place).
        const double w = vec::Norm(c.angularVelocity);
        const double dw = std::min(w, p_.sphere.rollingResistance * support_[i] * rs_ * invIs_ * dt);
        if (w > 0) c.angularVelocity = vec::Scale(c.angularVelocity, (w - dw) / w);
      } else if (support_[i] > 0) {
        const double wa = vec::Dot(c.angularVelocity, a);
        const double dw = std::min(std::abs(wa), p_.rollingResistance * support_[i] * p_.radius * invIa_ * dt);
        c.angularVelocity = vec::Sub(c.angularVelocity, vec::Scale(a, wa > 0 ? dw : -dw));
      }
      c.position = vec::Add(c.position, vec::Scale(vec::Add(c.velocity, pv_[i]), dt));
      c.orientation = vec::Integrate(c.orientation, vec::Add(c.angularVelocity, pw_[i]), dt);
      c.stepsSinceContact = touched_[i] ? 0 : std::min(c.stepsSinceContact + 1, 1000);
      c.state = Classify(c, false);
      const bool still = touched_[i] && vec::Norm(c.velocity) < p_.sleepSpeed && vec::Norm(c.angularVelocity) < p_.sleepAngularSpeed;
      c.stillTime = still ? c.stillTime + dt : 0;
      if (c.stillTime > p_.sleepTime) {
        c.asleep = true;
        c.velocity = c.angularVelocity = {0, 0, 0};
      }
      if (c.position[2] < -1 || std::abs(c.position[0]) > 1e3 || std::abs(c.position[1]) > 1e3) c.state = CylinderState::Removed;
    }
    // Reactions on robots.
    for (const auto& k : contacts_) {
      if (k.robot < 0 || static_cast<std::size_t>(k.robot) >= robots_.size() || !robots_[k.robot]) continue;
      const Vec3 j = vec::Add(vec::Scale(k.n, k.jn), vec::Add(vec::Scale(k.t1, k.jt1), vec::Scale(k.t2, k.jt2)));
      if (j[0] == 0 && j[1] == 0 && j[2] == 0) continue;
      robotImpulse_[static_cast<std::size_t>(k.robot)] = vec::Sub(robotImpulse_[static_cast<std::size_t>(k.robot)], j);
      robots_[k.robot]->ApplyExternalForce3(-j[0] / dt, -j[1] / dt, -j[2] / dt, k.p[0], k.p[1], k.p[2]);
    }
  }

  std::size_t LastContactCount() const { return contacts_.size(); }
  /** What each piece touched in the last Step and with what impulse (pairs that pushed only). */
  const std::vector<CylinderContact>& LastContacts() const { return reports_; }
  /** The last Step's contacts with one thing, e.g. (Collider, endEffectorIndex). */
  std::vector<CylinderContact> LastContactsWith(CylinderContactSource source, int index) const {
    std::vector<CylinderContact> out;
    for (const auto& r : reports_)
      if (r.source == source && r.index == index) out.push_back(r);
    return out;
  }

 private:
  struct Plane { Vec3 n; double d; bool push; };  // inside: n . x <= d
  /** A kinematic convex shape: velocity field v + omega x (p - origin). */
  struct Hull {
    std::vector<Plane> faces;
    Vec3 lo{0, 0, 0}, hi{0, 0, 0}, origin{0, 0, 0}, vel{0, 0, 0}, omega{0, 0, 0};
    double mu = 0, e = 0, k = 0;
    int robot = -1;
    bool moving = false;
    CylinderContactSource src = CylinderContactSource::Prism;
    int srcIndex = -1, group = -1;
    // The same shape as a right prism, for exact ball contacts: convex CCW polygon in (u, v) about
    // po, extruded along w over [wMin, wMax]. wMinPush false: the w-min face never pushes.
    Vec3 po{0, 0, 0}, eu{1, 0, 0}, ev{0, 1, 0}, ew{0, 0, 1};
    std::vector<Vec2> poly;
    double wMin = 0, wMax = 0;
    bool wMinPush = true;
  };
  struct Capsule {
    Vec3 a{0, 0, 0}, b{0, 0, 0};
    double radius = 0;
    Vec3 origin{0, 0, 0}, vel{0, 0, 0}, omega{0, 0, 0};
    double mu = 0, e = 0, k = 0;
    int robot = -1;
    int srcIndex = -1, group = -1;
    bool moving = false;
  };
  struct Surf {
    Vec3 origin, vel, omega;
    double mu, e;
    int robot;
    double k = 0;
    CylinderContactSource src = CylinderContactSource::Floor;
    int srcIndex = -1, group = -1;
  };
  struct Contact {
    int a = -1, b = -1, robot = -1;
    Vec3 p{0, 0, 0}, n{0, 0, 0}, ra{0, 0, 0}, rb{0, 0, 0}, surfaceVel{0, 0, 0}, t1{0, 0, 0}, t2{0, 0, 0};
    double depth = 0, mu = 0, target = 0, massN = 0, massT1 = 0, massT2 = 0, minJn = 0;
    CylinderContactSource src = CylinderContactSource::Floor;
    int srcIndex = -1, group = -1;
    double jn = 0, jt1 = 0, jt2 = 0, jp = 0;
  };
  struct Surface { double distance; Vec3 normal, point; };

  CylinderParams p_;
  double h_ = 0, invMass_ = 0, invIa_ = 0, invIt_ = 0;
  double rs_ = 0, invMassS_ = 0, invIs_ = 0;  // balls
  std::vector<Cylinder> pieces_;
  std::vector<SwerveSim*> robots_;
  std::vector<Vec3> robotImpulse_;
  std::vector<MechanismCollider> colliders_;
  // Per-step scratch (kept to reuse capacity).
  std::vector<Vec3> axis_, side_, pv_, pw_;
  std::vector<char> touched_;
  std::vector<double> support_;
  std::vector<Hull> hulls_;
  std::size_t hullCount_ = 0;
  std::vector<Capsule> capsules_;
  std::vector<Contact> contacts_;
  std::vector<double> groupForce_, groupSum_;  // per force-limited shape: normal budget (N) and this step's total (N*s)
  std::vector<std::array<int, 3>> sharedGroups_;  // {robot, forceGroup, groupForce_ index or -1}
  std::vector<CylinderContact> reports_;

  static bool Simulated(const Cylinder& c) { return c.state != CylinderState::Held && c.state != CylinderState::Removed; }
  static bool Awake(const Cylinder& c) { return Simulated(c) && !c.asleep; }
  Cylinder& At(int i) { return pieces_.at(static_cast<std::size_t>(i)); }
  int Slot() {
    for (std::size_t i = 0; i < pieces_.size(); ++i)
      if (pieces_[i].state == CylinderState::Removed) return static_cast<int>(i);
    pieces_.emplace_back();
    return static_cast<int>(pieces_.size()) - 1;
  }
  Cylinder Spawned(const CylinderPose& pose, Vec3 v, Vec3 w, PieceShape shape = PieceShape::Cylinder) const {
    Cylinder c;
    c.shape = shape;
    c.position = pose.position;
    c.orientation = pose.orientation;
    c.velocity = v;
    c.angularVelocity = w;
    c.state = Classify(c, true);
    c.stepsSinceContact = 0;
    return c;
  }
  /** On spawn: touching the floor (within 1 cm) counts as a contact. */
  CylinderState Classify(const Cylinder& c, bool spawn) const {
    const Vec3 a = c.Axis();
    bool touching = c.stepsSinceContact <= 2;
    if (c.shape == PieceShape::Sphere) {
      if (spawn) touching = c.position[2] - rs_ < 0.01;
      return touching ? CylinderState::Lying : CylinderState::Flying;
    }
    if (spawn) {
      const double low = c.position[2] - h_ * std::abs(a[2]) - p_.radius * std::sqrt(std::max(0.0, 1 - a[2] * a[2]));
      touching = low < 0.01;
    }
    if (!touching) return CylinderState::Flying;
    return std::abs(a[2]) >= std::cos(p_.standingAngle) ? CylinderState::Standing : CylinderState::Lying;
  }

  Vec3 InvInertia(Vec3 a, Vec3 x) const {
    return vec::Add(vec::Scale(x, invIt_), vec::Scale(a, (invIa_ - invIt_) * vec::Dot(a, x)));
  }
  bool Ball(std::size_t i) const { return pieces_[i].shape == PieceShape::Sphere; }
  double InvMass(std::size_t i) const { return Ball(i) ? invMassS_ : invMass_; }
  Vec3 InvInertiaOf(std::size_t i, Vec3 a, Vec3 x) const { return Ball(i) ? vec::Scale(x, invIs_) : InvInertia(a, x); }
  Vec3 InvInertiaOf(std::size_t i, Vec3 x) const { return InvInertiaOf(i, axis_[i], x); }
  double Margin(const Cylinder& c, double dt) const {
    const double reach = c.shape == PieceShape::Sphere ? rs_ : h_ + p_.radius;
    return p_.contactMargin + (vec::Norm(c.velocity) + vec::Norm(c.angularVelocity) * reach) * dt;
  }
  /** min over the piece of n . x. */
  double MinAlong(int i, Vec3 n) const {
    const Vec3 c = pieces_[static_cast<std::size_t>(i)].position;
    if (Ball(static_cast<std::size_t>(i))) return vec::Dot(n, c) - rs_;
    const double na = vec::Dot(n, axis_[static_cast<std::size_t>(i)]);
    return vec::Dot(n, c) - h_ * std::abs(na) - p_.radius * std::sqrt(std::max(0.0, 1 - na * na));
  }
  void Bounds(int i, double margin, Vec3& lo, Vec3& hi) const {
    const Vec3 c = pieces_[static_cast<std::size_t>(i)].position, a = axis_[static_cast<std::size_t>(i)];
    if (Ball(static_cast<std::size_t>(i))) {
      for (int k = 0; k < 3; ++k) { lo[k] = c[k] - rs_ - margin; hi[k] = c[k] + rs_ + margin; }
      return;
    }
    for (int k = 0; k < 3; ++k) {
      const double e = h_ * std::abs(a[k]) + p_.radius * std::sqrt(std::max(0.0, 1 - a[k] * a[k])) + margin;
      lo[k] = c[k] - e;
      hi[k] = c[k] + e;
    }
  }
  static bool Overlap(Vec3 alo, Vec3 ahi, Vec3 blo, Vec3 bhi) {
    for (int k = 0; k < 3; ++k) if (ahi[k] < blo[k] || bhi[k] < alo[k]) return false;
    return true;
  }
  static Vec3 Normalize(Vec3 v) {
    const double l = vec::Norm(v);
    return l > 1e-15 ? vec::Scale(v, 1 / l) : Vec3{1, 0, 0};
  }
  static Vec3 AnyPerp(Vec3 n) {
    return Normalize(vec::Cross(n, std::abs(n[2]) < 0.9 ? Vec3{0, 0, 1} : Vec3{1, 0, 0}));
  }

  // --- Shapes for this step ------------------------------------------------------------
  Hull& NewHull() {
    if (hullCount_ == hulls_.size()) hulls_.emplace_back();
    Hull& h = hulls_[hullCount_++];
    h.faces.clear();
    h.vel = h.omega = {0, 0, 0};
    h.k = 0;
    h.robot = -1;
    h.src = CylinderContactSource::Prism;
    h.srcIndex = h.group = -1;
    h.moving = false;
    return h;
  }
  /** A force budget shared by one collider's or bumper's contacts; -1 when unlimited. */
  int NewGroup(double maxForce, double mu) {
    if (!(maxForce < std::numeric_limits<double>::infinity())) return -1;
    // Normal budget such that normal plus friction (|j| <= sqrt(1 + mu^2) jn) stays within maxForce.
    groupForce_.push_back(std::max(0.0, maxForce) / std::sqrt(1 + mu * mu));
    return static_cast<int>(groupForce_.size()) - 1;
  }
  /** A collider's force budget: its own, or the one its forceGroup shares on its robot. */
  int ColliderGroup(const MechanismCollider& col) {
    if (col.forceGroup < 0) return NewGroup(col.maxForce, col.friction);
    for (const auto& g : sharedGroups_)
      if (g[0] == col.robot && g[1] == col.forceGroup) return g[2];
    double budget = std::numeric_limits<double>::infinity();
    for (const auto& other : colliders_)
      if (other.enabled && other.robot == col.robot && other.forceGroup == col.forceGroup)
        budget = std::min(budget, std::max(0.0, other.maxForce) / std::sqrt(1 + other.friction * other.friction));
    int index = -1;
    if (budget < std::numeric_limits<double>::infinity()) {
      groupForce_.push_back(budget);
      index = static_cast<int>(groupForce_.size()) - 1;
    }
    sharedGroups_.push_back({col.robot, col.forceGroup, index});
    return index;
  }
  void BuildShapes(const Obstacles* obstacles) {
    hullCount_ = 0;
    groupForce_.clear();
    sharedGroups_.clear();
    constexpr double kBig = 1e3;
    if (obstacles) {
      for (std::size_t i = 0; i < obstacles->Prisms().size(); ++i) {
        if (!obstacles->Enabled(i)) continue;
        const auto& pr = obstacles->Prisms()[i];
        Hull& h = NewHull();
        const auto& v = pr.vertices;
        for (std::size_t k = 0; k < v.size(); ++k) {
          const Vec2 a = v[k], b = v[(k + 1) % v.size()];
          const double ex = b[0] - a[0], ey = b[1] - a[1], len = std::hypot(ex, ey);
          if (len < 1e-12) continue;
          const Vec3 nrm{ey / len, -ex / len, 0};
          h.faces.push_back({nrm, nrm[0] * a[0] + nrm[1] * a[1], true});
        }
        if (std::isfinite(pr.zMax)) h.faces.push_back({{0, 0, 1}, pr.zMax, true});
        if (pr.zMin > 0) h.faces.push_back({{0, 0, -1}, -pr.zMin, true});
        h.lo = {pr.minX, pr.minY, pr.zMin};
        h.hi = {pr.maxX, pr.maxY, std::isfinite(pr.zMax) ? pr.zMax : kBig};
        h.po = {0, 0, 0};
        h.eu = {1, 0, 0}; h.ev = {0, 1, 0}; h.ew = {0, 0, 1};
        h.poly = v;
        h.wMin = pr.zMin;
        h.wMax = std::isfinite(pr.zMax) ? pr.zMax : kBig;
        h.wMinPush = pr.zMin > 0;
        h.mu = p_.obstacleFriction;
        h.e = p_.obstacleRestitution;
        h.srcIndex = static_cast<int>(i);
      }
    }
    for (std::size_t r = 0; r < robots_.size(); ++r) {
      const SwerveSim* robot = robots_[r];
      if (!robot) continue;
      const auto pose = robot->Pose3();
      const auto vel = robot->FieldVelocity();
      const auto& rp = robot->Params();
      const double c = std::cos(pose.yaw), s = std::sin(pose.yaw);
      const double hx = rp.bumperLengthX / 2, hy = rp.bumperLengthY / 2;
      const double bottom = pose.z + rp.bumperBottomM;
      const double top = pose.z + (p_.robotBoxTopM >= 0 ? p_.robotBoxTopM : robot->RobotHeight());
      Hull& h = NewHull();
      const Vec3 o{pose.x, pose.y, pose.z};
      const Vec3 fx{c, s, 0}, fy{-s, c, 0};
      h.faces.push_back({fx, vec::Dot(fx, o) + hx, true});
      h.faces.push_back({vec::Scale(fx, -1), -vec::Dot(fx, o) + hx, true});
      h.faces.push_back({fy, vec::Dot(fy, o) + hy, true});
      h.faces.push_back({vec::Scale(fy, -1), -vec::Dot(fy, o) + hy, true});
      h.faces.push_back({{0, 0, 1}, top, true});
      h.faces.push_back({{0, 0, -1}, -bottom, false});  // a bumper never pushes a piece down
      const double ex = std::abs(c) * hx + std::abs(s) * hy, ey = std::abs(s) * hx + std::abs(c) * hy;
      h.lo = {pose.x - ex, pose.y - ey, bottom};
      h.hi = {pose.x + ex, pose.y + ey, top};
      h.po = o;
      h.eu = fx; h.ev = fy; h.ew = {0, 0, 1};
      h.poly = {{-hx, -hy}, {hx, -hy}, {hx, hy}, {-hx, hy}};
      h.wMin = bottom - pose.z;
      h.wMax = top - pose.z;
      h.wMinPush = false;
      h.origin = o;
      h.vel = {vel.vx, vel.vy, 0};
      h.omega = {0, 0, vel.omega};
      h.mu = p_.robotFriction;
      h.e = p_.robotRestitution;
      h.robot = static_cast<int>(r);
      h.moving = true;
      h.src = CylinderContactSource::Robot;
      h.srcIndex = static_cast<int>(r);
      h.group = NewGroup(p_.robotMaxForce, h.mu);
    }
    capsules_.clear();
    for (std::size_t ci = 0; ci < colliders_.size(); ++ci) {
      const auto& col = colliders_[ci];
      if (!col.enabled) continue;
      // Frame in the world.
      Vec3 origin = col.position, v = col.velocity, w = col.angularVelocity;
      vec::Mat3 rot = vec::ToMatrix(col.orientation);
      const bool onRobot = col.robotFrame && col.robot >= 0 && static_cast<std::size_t>(col.robot) < robots_.size() &&
                           robots_[static_cast<std::size_t>(col.robot)];
      if (onRobot) {
        const SwerveSim* robot = robots_[static_cast<std::size_t>(col.robot)];
        const auto pose = robot->Pose3();
        const auto vel = robot->FieldVelocity();
        const auto rq = vec::FromEuler(pose.roll, pose.pitch, pose.yaw);
        const auto rr = vec::ToMatrix(rq);
        const Vec3 rel = vec::Mul(rr, col.position);
        const Vec3 wr{0, 0, vel.omega};
        origin = vec::Add({pose.x, pose.y, pose.z}, rel);
        v = vec::Add(vec::Add(Vec3{vel.vx, vel.vy, 0}, vec::Cross(wr, rel)), vec::Mul(rr, col.velocity));
        w = vec::Add(wr, vec::Mul(rr, col.angularVelocity));
        rot = vec::ToMatrix(QuatMul(rq, col.orientation));
      }
      const auto toWorld = [&](Vec3 x) { return vec::Add(origin, vec::Mul(rot, x)); };
      if (col.shape == MechanismCollider::Shape::Capsule) {
        Capsule cap;
        cap.a = toWorld(col.a);
        cap.b = toWorld(col.b);
        cap.radius = col.radius;
        cap.origin = origin;
        cap.vel = v;
        cap.omega = w;
        cap.mu = col.friction;
        cap.e = col.restitution;
        cap.k = col.stiffness;
        cap.robot = col.robot;
        cap.srcIndex = static_cast<int>(ci);
        cap.group = ColliderGroup(col);
        cap.moving = vec::Norm(v) > 0 || vec::Norm(w) > 0;
        capsules_.push_back(cap);
        continue;
      }
      if (col.outline.size() < 3) continue;
      std::vector<Vec2> poly = col.outline;
      geometry::MakeCcw(poly);  // CCW in (x, z)
      Hull& h = NewHull();
      const auto face = [&](Vec3 nLocal, double dLocal) {
        const Vec3 nw = vec::Mul(rot, nLocal);
        h.faces.push_back({nw, dLocal + vec::Dot(nw, origin), true});
      };
      for (std::size_t k = 0; k < poly.size(); ++k) {
        const Vec2 a = poly[k], b = poly[(k + 1) % poly.size()];
        const double eu = b[0] - a[0], ev = b[1] - a[1], len = std::hypot(eu, ev);
        if (len < 1e-12) continue;
        const Vec3 nl{ev / len, 0, -eu / len};
        face(nl, nl[0] * a[0] + nl[2] * a[1]);
      }
      face({0, 1, 0}, col.width / 2);
      face({0, -1, 0}, col.width / 2);
      h.lo = {1e300, 1e300, 1e300};
      h.hi = {-1e300, -1e300, -1e300};
      for (const auto& q : poly)
        for (double y : {-col.width / 2, col.width / 2}) {
          const Vec3 pw = toWorld({q[0], y, q[1]});
          for (int k = 0; k < 3; ++k) { h.lo[k] = std::min(h.lo[k], pw[k]); h.hi[k] = std::max(h.hi[k], pw[k]); }
        }
      h.po = origin;
      h.eu = {rot[0], rot[3], rot[6]};   // frame x
      h.ev = {rot[2], rot[5], rot[8]};   // frame z
      h.ew = {rot[1], rot[4], rot[7]};   // frame y (extrusion)
      h.poly = poly;
      h.wMin = -col.width / 2;
      h.wMax = col.width / 2;
      h.wMinPush = true;
      h.origin = origin;
      h.vel = v;
      h.omega = w;
      h.mu = col.friction;
      h.e = col.restitution;
      h.k = col.stiffness;
      h.robot = col.robot;
      h.moving = true;
      h.src = CylinderContactSource::Collider;
      h.srcIndex = static_cast<int>(ci);
      h.group = ColliderGroup(col);
    }
  }

  static vec::Quat QuatMul(const vec::Quat& a, const vec::Quat& b) {
    return {a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w};
  }

  /** Sleeping pieces wake when a robot, collider or awake piece comes within a few cm. */
  void WakeNearMoving() {
    constexpr double kNear = 0.02;
    for (std::size_t i = 0; i < pieces_.size(); ++i) {
      Cylinder& c = pieces_[i];
      if (!Simulated(c) || !c.asleep) continue;
      Vec3 lo, hi;
      Bounds(static_cast<int>(i), kNear, lo, hi);
      bool wake = false;
      for (std::size_t k = 0; k < hullCount_ && !wake; ++k)
        wake = hulls_[k].moving && Overlap(lo, hi, hulls_[k].lo, hulls_[k].hi);
      for (const auto& cap : capsules_) {
        if (wake) break;
        if (!cap.moving) continue;  // static pipes do not keep resting pieces awake
        Vec3 clo, chi;
        for (int k = 0; k < 3; ++k) {
          clo[k] = std::min(cap.a[k], cap.b[k]) - cap.radius;
          chi[k] = std::max(cap.a[k], cap.b[k]) + cap.radius;
        }
        wake = Overlap(lo, hi, clo, chi);
      }
      for (std::size_t j = 0; j < pieces_.size() && !wake && p_.pieceContacts; ++j) {
        if (j == i || !Awake(pieces_[j])) continue;
        Vec3 jlo, jhi;
        Bounds(static_cast<int>(j), kNear, jlo, jhi);
        wake = Overlap(lo, hi, jlo, jhi);
      }
      if (wake) { c.asleep = false; c.stillTime = 0; }
    }
  }

  // --- Contact generation ----------------------------------------------------------------
  void FloorContacts(int i, const Terrain* terrain, double m, double dt) {
    Vec3 nrm{0, 0, 1};
    double d = 0;
    if (terrain && !terrain->Empty()) {
      const Vec3 c = pieces_[static_cast<std::size_t>(i)].position;
      nrm = terrain->Normal(c[0], c[1]);
      d = nrm[0] * c[0] + nrm[1] * c[1] + nrm[2] * terrain->Height(c[0], c[1]);
    }
    if (MinAlong(i, nrm) > d + m) return;
    const bool ball = Ball(static_cast<std::size_t>(i));
    Surf s{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, ball ? p_.sphere.floorFriction : p_.floorFriction,
           ball ? p_.sphere.floorRestitution : p_.floorRestitution, -1};
    SurfaceContacts(i, nrm, d, nullptr, -1, std::numeric_limits<double>::infinity(), s, m, dt);
  }

  /**
   * Contacts of piece i against the plane n . x = d (the piece on the +n side), clipped to the
   * other faces of a hull (clip, except face `skip`) and below maxZ. Candidates: the generator
   * line nearest the plane (clipped) and the rim points at +-120 degrees from it.
   */
  void SurfaceContacts(int i, Vec3 n, double d, const std::vector<Plane>* clip, int skip, double maxZ, const Surf& s,
                       double m, double dt) {
    const std::size_t ui = static_cast<std::size_t>(i);
    if (Ball(ui)) {  // one point: the ball's lowest point along -n
      const Vec3 p = vec::Sub(pieces_[ui].position, vec::Scale(n, rs_));
      const double depth = d - vec::Dot(n, p);
      if (depth >= -m && (p[2] <= maxZ || pieces_[ui].position[2] <= maxZ)) AddContact(i, -1, p, n, depth, s, dt);
      return;
    }
    const Vec3 c = pieces_[ui].position, a = axis_[ui];
    Vec3 dir = vec::Scale(vec::Sub(n, vec::Scale(a, vec::Dot(n, a))), -1);
    const double len = vec::Norm(dir);
    dir = len > 1e-6 ? vec::Scale(dir, 1 / len) : side_[ui];
    const auto inside = [&](Vec3 p) {
      if (p[2] > maxZ) return false;
      if (clip)
        for (std::size_t k = 0; k < clip->size(); ++k)
          if (static_cast<int>(k) != skip && vec::Dot((*clip)[k].n, p) > (*clip)[k].d + m) return false;
      return true;
    };
    // Generator line g(t) = base + t a, t in [-h, h], clipped by the other faces.
    const Vec3 base = vec::Add(c, vec::Scale(dir, p_.radius));
    double t0 = -h_, t1 = h_;
    const auto clipLine = [&](Vec3 nk, double dk) {  // keep nk . g(t) <= dk
      const double f0 = vec::Dot(nk, base) - dk, fa = vec::Dot(nk, a);
      if (std::abs(fa) < 1e-12) { if (f0 > 0) t1 = t0 - 1; return; }
      const double t = -f0 / fa;
      if (fa > 0) t1 = std::min(t1, t); else t0 = std::max(t0, t);
    };
    if (std::isfinite(maxZ)) clipLine({0, 0, 1}, maxZ);
    if (clip)
      for (std::size_t k = 0; k < clip->size(); ++k)
        if (static_cast<int>(k) != skip) clipLine((*clip)[k].n, (*clip)[k].d + m);
    const std::size_t before = contacts_.size();
    const auto add = [&](Vec3 p) {
      const double depth = d - vec::Dot(n, p);
      if (depth >= -m) AddContact(i, -1, p, n, depth, s, dt);
    };
    if (t0 <= t1) {
      add(vec::Add(base, vec::Scale(a, t0)));
      if (t1 - t0 > 1e-4) add(vec::Add(base, vec::Scale(a, t1)));
    }
    const Vec3 cross = vec::Cross(a, dir);
    constexpr double kCos = -0.5, kSin = 0.8660254037844386;
    for (double end : {-1.0, 1.0})
      for (double sn : {-kSin, kSin}) {
        const Vec3 p = vec::Add(vec::Add(c, vec::Scale(a, end * h_)),
                                vec::Scale(vec::Add(vec::Scale(dir, kCos), vec::Scale(cross, sn)), p_.radius));
        if (inside(p)) add(p);
      }
    if (contacts_.size() == before && clip) {
      // Clipped away entirely but overlapping (an edge against the curved side): the deepest end.
      const Vec3 p0 = vec::Add(base, vec::Scale(a, -h_)), p1 = vec::Add(base, vec::Scale(a, h_));
      const Vec3 p = vec::Dot(n, p0) <= vec::Dot(n, p1) ? p0 : p1;
      if (d - vec::Dot(n, p) > 0) AddContact(i, -1, p, n, d - vec::Dot(n, p), s, dt);
    }
  }

  /**
   * The pushing face of `hull` that piece i is least deep behind, judged on the part of the
   * piece inside the hull (grown by the margin m): 12 lines along its side, clipped to the hull,
   * and so its rims. -1 when none of those samples is inside (a corner just touching).
   */
  int LocalFace(int i, const Hull& hull, double m) const {
    constexpr std::size_t kMaxFaces = 24;
    const auto& faces = hull.faces;
    if (faces.size() > kMaxFaces) return -1;
    const std::size_t ui = static_cast<std::size_t>(i);
    const Vec3 c = pieces_[ui].position, a = axis_[ui], u = side_[ui], w = vec::Cross(a, u);
    std::array<double, kMaxFaces> depth;
    depth.fill(-std::numeric_limits<double>::infinity());
    bool any = false;
    const auto consider = [&](Vec3 p) {
      any = true;
      for (std::size_t k = 0; k < faces.size(); ++k) depth[k] = std::max(depth[k], faces[k].d - vec::Dot(faces[k].n, p));
    };
    for (int j = 0; j < 12; ++j) {
      const double angle = j * (kPi / 6);
      const Vec3 base = vec::Add(c, vec::Scale(vec::Add(vec::Scale(u, std::cos(angle)), vec::Scale(w, std::sin(angle))), p_.radius));
      double t0 = -h_, t1 = h_;
      for (std::size_t k = 0; k < faces.size() && t0 <= t1; ++k) {  // keep n . (base + t a) <= d + m
        const double f0 = vec::Dot(faces[k].n, base) - faces[k].d - m, fa = vec::Dot(faces[k].n, a);
        if (std::abs(fa) < 1e-12) { if (f0 > 0) t1 = t0 - 1; continue; }
        const double t = -f0 / fa;
        if (fa > 0) t1 = std::min(t1, t); else t0 = std::max(t0, t);
      }
      if (t0 > t1) continue;
      consider(vec::Add(base, vec::Scale(a, t0)));
      if (t1 > t0) consider(vec::Add(base, vec::Scale(a, t1)));
    }
    if (!any) return -1;
    int best = -1;
    for (std::size_t k = 0; k < faces.size(); ++k)
      if (faces[k].push && (best < 0 || depth[k] < depth[static_cast<std::size_t>(best)])) best = static_cast<int>(k);
    return best;
  }

  void HullContacts(int i, const Hull& hull, double m, double dt) {
    Vec3 lo, hi;
    Bounds(i, m, lo, hi);
    if (!Overlap(lo, hi, hull.lo, hull.hi)) return;
    if (Ball(static_cast<std::size_t>(i))) { BallHullContact(i, hull, m, dt); return; }
    double best = -std::numeric_limits<double>::infinity();
    int bestFace = -1;
    for (std::size_t k = 0; k < hull.faces.size(); ++k) {
      const double sep = MinAlong(i, hull.faces[k].n) - hull.faces[k].d;
      if (sep > m) return;
      if (hull.faces[k].push && sep > best) { best = sep; bestFace = static_cast<int>(k); }
    }
    if (bestFace < 0) return;
    // The face the piece is least deep behind, judged on the part of the piece inside the hull.
    // The whole-piece separation above picks the wrong face for a hull smaller than the piece: a
    // standing coral tipping away from a plate has its base behind the plate's front plane, far
    // "deeper" than it is below the plate's underside, so the underside would win and push the
    // coral back down onto its base (it was then pushed along upright instead of falling).
    if (const int localFace = LocalFace(i, hull, m); localFace >= 0) bestFace = localFace;
    const Plane& f = hull.faces[static_cast<std::size_t>(bestFace)];
    Surf s{hull.origin, hull.vel, hull.omega, hull.mu, hull.e, hull.robot, hull.k, hull.src, hull.srcIndex, hull.group};
    SurfaceContacts(i, f.n, f.d, &hull.faces, bestFace, std::numeric_limits<double>::infinity(), s, m, dt);
  }

  /** A ball against a hull: the exact closest point of its right-prism form. */
  void BallHullContact(int i, const Hull& hull, double m, double dt) {
    if (hull.poly.size() < 3) return;
    const Vec3 c = pieces_[static_cast<std::size_t>(i)].position;
    const Vec3 q = vec::Sub(c, hull.po);
    const double u = vec::Dot(q, hull.eu), v = vec::Dot(q, hull.ev), w = vec::Dot(q, hull.ew);
    bool inside = false;
    Vec2 en{0, 0};
    const Vec2 b = geometry::ClosestOnBoundary(hull.poly, {u, v}, inside, en);
    const auto world = [&](double uu, double vv, double ww) {
      return vec::Add(hull.po, vec::Add(vec::Scale(hull.eu, uu), vec::Add(vec::Scale(hull.ev, vv), vec::Scale(hull.ew, ww))));
    };
    Vec3 n, point;
    double depth;
    if (inside && w >= hull.wMin && w <= hull.wMax) {
      // Centre inside: leave through the nearest pushing face.
      const double side = std::hypot(u - b[0], v - b[1]), top = hull.wMax - w;
      const double bottom = hull.wMinPush ? w - hull.wMin : std::numeric_limits<double>::infinity();
      if (top <= side && top <= bottom) { n = hull.ew; depth = rs_ + top; point = world(u, v, hull.wMax); }
      else if (bottom <= side) { n = vec::Scale(hull.ew, -1); depth = rs_ + bottom; point = world(u, v, hull.wMin); }
      else {
        n = vec::Add(vec::Scale(hull.eu, en[0]), vec::Scale(hull.ev, en[1]));
        depth = rs_ + side;
        point = world(b[0], b[1], w);
      }
    } else {
      const double uu = inside ? u : b[0], vv = inside ? v : b[1], ww = std::clamp(w, hull.wMin, hull.wMax);
      if (!hull.wMinPush && inside && w < hull.wMin) return;  // under a bumper box: it never pushes down
      point = world(uu, vv, ww);
      const Vec3 d = vec::Sub(c, point);
      const double dist = vec::Norm(d);
      depth = rs_ - dist;
      if (depth < -m) return;
      n = dist > 1e-12 ? vec::Scale(d, 1 / dist) : hull.ew;
    }
    if (depth < -m) return;
    Surf s{hull.origin, hull.vel, hull.omega, hull.mu, hull.e, hull.robot, hull.k, hull.src, hull.srcIndex, hull.group};
    if (hull.src == CylinderContactSource::Prism) { s.mu = p_.sphere.obstacleFriction; s.e = p_.sphere.obstacleRestitution; }
    if (hull.src == CylinderContactSource::Robot) { s.mu = p_.sphere.robotFriction; s.e = p_.sphere.robotRestitution; }
    AddContact(i, -1, point, n, depth, s, dt);
  }

  /** Signed distance from q to piece (centre c, axis a), outward normal, nearest surface point. */
  Surface PointToCylinder(Vec3 c, Vec3 a, Vec3 q) const {
    const Vec3 rel = vec::Sub(q, c);
    const double u = vec::Dot(rel, a);
    const Vec3 radial = vec::Sub(rel, vec::Scale(a, u));
    const double rho = vec::Norm(radial);
    const Vec3 e = rho > 1e-12 ? vec::Scale(radial, 1 / rho) : AnyPerp(a);
    const double su = u >= 0 ? 1 : -1, r = p_.radius;
    const Vec3 capN = vec::Scale(a, su);
    if (std::abs(u) <= h_ && rho <= r) {
      const double side = r - rho, cap = h_ - std::abs(u);
      if (side < cap) return {-side, e, vec::Add(vec::Add(c, vec::Scale(a, u)), vec::Scale(e, r))};
      return {-cap, capN, vec::Add(vec::Add(c, vec::Scale(a, su * h_)), radial)};
    }
    if (std::abs(u) <= h_) return {rho - r, e, vec::Add(vec::Add(c, vec::Scale(a, u)), vec::Scale(e, r))};
    if (rho <= r) return {std::abs(u) - h_, capN, vec::Add(vec::Add(c, vec::Scale(a, su * h_)), radial)};
    const Vec3 rim = vec::Add(vec::Add(c, vec::Scale(a, su * h_)), vec::Scale(e, r));
    const Vec3 dd = vec::Sub(q, rim);
    const double dist = vec::Norm(dd);
    return {dist, dist > 1e-12 ? vec::Scale(dd, 1 / dist) : e, rim};
  }
  /** Nearest point of segment p-q to the piece (golden-section search; the distance is convex). */
  Surface SegmentToCylinder(Vec3 c, Vec3 a, Vec3 p, Vec3 q, double& tBest) const {
    const Vec3 e = vec::Sub(q, p);
    const auto f = [&](double t) { return PointToCylinder(c, a, vec::Add(p, vec::Scale(e, t))).distance; };
    constexpr double kG = 0.6180339887498949;
    double lo = 0, hi = 1, x1 = hi - kG * (hi - lo), x2 = lo + kG * (hi - lo), f1 = f(x1), f2 = f(x2);
    for (int k = 0; k < 40 && hi - lo > 1e-6; ++k) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - kG * (hi - lo); f1 = f(x1); }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + kG * (hi - lo); f2 = f(x2); }
    }
    tBest = 0.5 * (lo + hi);
    double best = f(tBest);
    for (double t : {0.0, 1.0}) {
      const double v = f(t);
      if (v < best) { best = v; tBest = t; }
    }
    return PointToCylinder(c, a, vec::Add(p, vec::Scale(e, tBest)));
  }

  void CapsuleContacts(int i, const Capsule& cap, double m, double dt) {
    const std::size_t ui = static_cast<std::size_t>(i);
    Vec3 lo, hi;
    Bounds(i, m + cap.radius, lo, hi);
    Vec3 clo, chi;
    for (int k = 0; k < 3; ++k) { clo[k] = std::min(cap.a[k], cap.b[k]); chi[k] = std::max(cap.a[k], cap.b[k]); }
    if (!Overlap(lo, hi, clo, chi)) return;
    const Vec3 c = pieces_[ui].position, a = axis_[ui];
    Surf s{cap.origin, cap.vel, cap.omega, cap.mu, cap.e, cap.robot, cap.k, CylinderContactSource::Collider, cap.srcIndex, cap.group};
    if (Ball(ui)) {
      const Vec3 e = vec::Sub(cap.b, cap.a);
      const double ee = vec::Dot(e, e);
      const double t = ee > 0 ? std::clamp(vec::Dot(vec::Sub(c, cap.a), e) / ee, 0.0, 1.0) : 0.0;
      const Vec3 q = vec::Add(cap.a, vec::Scale(e, t));
      const Vec3 d = vec::Sub(c, q);
      const double dist = vec::Norm(d);
      const double depth = cap.radius + rs_ - dist;
      if (depth < -m) return;
      const Vec3 n = dist > 1e-12 ? vec::Scale(d, 1 / dist) : Vec3{0, 0, 1};
      AddContact(i, -1, vec::Add(q, vec::Scale(n, cap.radius)), n, depth, s, dt);
      return;
    }
    double tBest = 0;
    const Surface best = SegmentToCylinder(c, a, cap.a, cap.b, tBest);
    const Vec3 e = vec::Sub(cap.b, cap.a);
    const double segLen = vec::Norm(e);
    const auto add = [&](const Surface& sf) {
      const double depth = cap.radius - sf.distance;
      if (depth < -m) return;
      // Normal on the piece points from the capsule toward the piece: -outward normal.
      AddContact(i, -1, sf.point, vec::Scale(sf.normal, -1), depth, s, dt);
    };
    add(best);
    // A capsule lying along the piece touches along a line: also its ends.
    for (double t : {0.0, 1.0})
      if (std::abs(t - tBest) * segLen > 0.02) add(PointToCylinder(c, a, vec::Add(cap.a, vec::Scale(e, t))));
  }

  /** Closest points of segments p1-q1 and p2-q2 (Ericson); s, t in [0, 1]. */
  static void ClosestSegments(Vec3 p1, Vec3 q1, Vec3 p2, Vec3 q2, double& s, double& t) {
    const Vec3 d1 = vec::Sub(q1, p1), d2 = vec::Sub(q2, p2), r = vec::Sub(p1, p2);
    const double a = vec::Dot(d1, d1), e = vec::Dot(d2, d2), f = vec::Dot(d2, r);
    if (a <= 1e-15 && e <= 1e-15) { s = t = 0; return; }
    if (a <= 1e-15) { s = 0; t = std::clamp(f / e, 0.0, 1.0); return; }
    const double c = vec::Dot(d1, r);
    if (e <= 1e-15) { t = 0; s = std::clamp(-c / a, 0.0, 1.0); return; }
    const double b = vec::Dot(d1, d2), denom = a * e - b * b;
    s = denom > 1e-15 ? std::clamp((b * f - c * e) / denom, 0.0, 1.0) : 0.0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = std::clamp(-c / a, 0.0, 1.0); }
    else if (t > 1) { t = 1; s = std::clamp((b - c) / a, 0.0, 1.0); }
  }

  /** Piece-piece: capsules of the piece's radius and overall length. */
  void PieceContacts(double dt) {
    const std::size_t n = pieces_.size();
    const double hc = std::max(0.0, h_ - p_.radius), reach = 2 * (hc + p_.radius);
    for (std::size_t i = 0; i < n; ++i) {
      if (!Simulated(pieces_[i])) continue;
      for (std::size_t j = i + 1; j < n; ++j) {
        if (!Simulated(pieces_[j]) || (!Awake(pieces_[i]) && !Awake(pieces_[j]))) continue;
        const Cylinder &A = pieces_[i], &B = pieces_[j];
        const double m = Margin(A, dt) + Margin(B, dt);
        const Vec3 dc = vec::Sub(B.position, A.position);
        if (Ball(i) || Ball(j)) {
          BallPieceContact(i, j, m, dt);
          continue;
        }
        if (vec::Dot(dc, dc) > (reach + m) * (reach + m)) continue;
        const Vec3 a0 = vec::Sub(A.position, vec::Scale(axis_[i], hc)), a1 = vec::Add(A.position, vec::Scale(axis_[i], hc));
        const Vec3 b0 = vec::Sub(B.position, vec::Scale(axis_[j], hc)), b1 = vec::Add(B.position, vec::Scale(axis_[j], hc));
        const auto add = [&](double s, double t) {
          const Vec3 pa = vec::Add(a0, vec::Scale(vec::Sub(a1, a0), s)), pb = vec::Add(b0, vec::Scale(vec::Sub(b1, b0), t));
          const Vec3 d = vec::Sub(pa, pb);
          const double dist = vec::Norm(d);
          const double depth = 2 * p_.radius - dist;
          if (depth < -m) return;
          const Vec3 nrm = dist > 1e-9 ? vec::Scale(d, 1 / dist) : Vec3{0, 0, 1};  // toward A
          const Vec3 p = vec::Add(pb, vec::Scale(nrm, 0.5 * dist));
          Surf none{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, p_.pieceFriction, p_.pieceRestitution, -1, 0,
                    CylinderContactSource::Piece, static_cast<int>(j)};
          AddContact(static_cast<int>(i), static_cast<int>(j), p, nrm, depth, none, dt);
        };
        double s = 0, t = 0;
        ClosestSegments(a0, a1, b0, b1, s, t);
        const double par = std::abs(vec::Dot(axis_[i], axis_[j]));
        if (par > 0.95 && hc > 0) {
          // Side by side: the overlap's two ends, so the pair cannot pivot on one point.
          const auto proj = [&](Vec3 x) { return std::clamp(vec::Dot(vec::Sub(x, a0), axis_[i]) / (2 * hc), 0.0, 1.0); };
          const double s0 = std::min(proj(b0), proj(b1)), s1 = std::max(proj(b0), proj(b1));
          if ((s1 - s0) * 2 * hc > 0.02) {
            for (double sk : {s0, s1}) {
              const Vec3 pa = vec::Add(a0, vec::Scale(vec::Sub(a1, a0), sk));
              const Vec3 eb = vec::Sub(b1, b0);
              const double tk = std::clamp(vec::Dot(vec::Sub(pa, b0), eb) / vec::Dot(eb, eb), 0.0, 1.0);
              add(sk, tk);
            }
            continue;
          }
        }
        add(s, t);
      }
    }
  }

  /** Ball-ball (centre distance) or ball-cylinder (exact point-to-cylinder distance of the centre). */
  void BallPieceContact(std::size_t i, std::size_t j, double m, double dt) {
    const Cylinder &A = pieces_[i], &B = pieces_[j];
    const Vec3 dc = vec::Sub(A.position, B.position);
    const double ra = Ball(i) ? rs_ : h_ + p_.radius, rb = Ball(j) ? rs_ : h_ + p_.radius;
    if (vec::Dot(dc, dc) > (ra + rb + m) * (ra + rb + m)) return;
    Surf s{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, p_.sphere.pieceFriction, p_.sphere.pieceRestitution, -1, 0,
           CylinderContactSource::Piece, static_cast<int>(j)};
    Vec3 n, p;
    double depth;
    if (Ball(i) && Ball(j)) {
      const double dist = vec::Norm(dc);
      depth = 2 * rs_ - dist;
      n = dist > 1e-9 ? vec::Scale(dc, 1 / dist) : Vec3{0, 0, 1};  // toward A
      p = vec::Add(B.position, vec::Scale(n, rs_));
    } else {
      const std::size_t ball = Ball(i) ? i : j, cyl = Ball(i) ? j : i;
      const Surface sf = PointToCylinder(pieces_[cyl].position, axis_[cyl], pieces_[ball].position);
      depth = rs_ - sf.distance;
      n = ball == i ? sf.normal : vec::Scale(sf.normal, -1);  // toward A
      p = sf.point;
    }
    if (depth < -m) return;
    AddContact(static_cast<int>(i), static_cast<int>(j), p, n, depth, s, dt);
  }

  void AddContact(int a, int b, Vec3 p, Vec3 n, double depth, const Surf& s, double dt) {
    Contact k;
    k.a = a;
    k.b = b;
    k.robot = s.robot;
    k.p = p;
    k.n = n;
    k.depth = depth;
    k.mu = s.mu;
    k.src = s.src;
    k.srcIndex = s.srcIndex;
    k.group = s.group;
    if (s.k > 0 && depth > p_.penetrationSlop) k.minJn = s.k * (depth - p_.penetrationSlop) * dt;
    const Cylinder& A = pieces_[static_cast<std::size_t>(a)];
    k.ra = vec::Sub(p, A.position);
    if (b >= 0) k.rb = vec::Sub(p, pieces_[static_cast<std::size_t>(b)].position);
    else k.surfaceVel = vec::Add(s.vel, vec::Cross(s.omega, vec::Sub(p, s.origin)));
    const Vec3 vr = Relative(k);
    const double vn = vec::Dot(vr, n);
    if (vn < -p_.restSpeed && depth - vn * dt > 0) k.target = -s.e * vn;
    else if (depth < 0) k.target = depth / dt;
    else k.target = 0;
    const Vec3 vt = vec::Sub(vr, vec::Scale(n, vn));
    const double vtn = vec::Norm(vt);
    k.t1 = vtn > 1e-6 ? vec::Scale(vt, 1 / vtn) : AnyPerp(n);
    k.t2 = vec::Cross(n, k.t1);
    k.massN = 1 / EffectiveMass(k, n);
    k.massT1 = 1 / EffectiveMass(k, k.t1);
    k.massT2 = 1 / EffectiveMass(k, k.t2);
    contacts_.push_back(k);
  }
  static constexpr double kGripSpeed = 0.05;  // m/s
  bool Saturated(const Contact& k, double dt) const {
    if (k.group < 0) return false;
    const std::size_t g = static_cast<std::size_t>(k.group);
    return groupSum_[g] >= 0.999 * groupForce_[g] * dt;
  }
  /** LastContacts: per (piece, thing) sums of the solved impulses. */
  void BuildReports(double dt) {
    reports_.clear();
    auto entry = [&](int piece, CylinderContactSource src, int index, int robot) -> CylinderContact& {
      for (auto& r : reports_)
        if (r.piece == piece && r.source == src && r.index == index) return r;
      CylinderContact r;
      r.piece = piece;
      r.source = src;
      r.index = index;
      r.robot = robot;
      reports_.push_back(r);
      return reports_.back();
    };
    for (const auto& k : contacts_) {
      if (k.jn <= 0) continue;
      const Vec3 j = vec::Add(vec::Scale(k.n, k.jn), vec::Add(vec::Scale(k.t1, k.jt1), vec::Scale(k.t2, k.jt2)));
      const bool limited = Saturated(k, dt);
      const auto add = [&](CylinderContact& r, Vec3 jj) {
        r.impulse = vec::Add(r.impulse, jj);
        r.point = vec::Add(vec::Scale(r.point, r.normalImpulse), vec::Scale(k.p, k.jn));
        r.normalImpulse += k.jn;
        r.point = vec::Scale(r.point, 1 / r.normalImpulse);
        r.limited = r.limited || limited;
      };
      add(entry(k.a, k.src, k.srcIndex, k.robot), j);
      if (k.b >= 0) add(entry(k.b, CylinderContactSource::Piece, k.a, -1), vec::Scale(j, -1));
    }
  }
  double EffectiveMass(const Contact& k, Vec3 d) const {
    const Vec3 rna = vec::Cross(k.ra, d);
    const std::size_t a = static_cast<std::size_t>(k.a);
    double m = InvMass(a) + vec::Dot(InvInertiaOf(a, rna), rna);
    if (k.b >= 0) {
      const std::size_t b = static_cast<std::size_t>(k.b);
      const Vec3 rnb = vec::Cross(k.rb, d);
      m += InvMass(b) + vec::Dot(InvInertiaOf(b, rnb), rnb);
    }
    return m;
  }
  Vec3 Relative(const Contact& k) const {
    const Cylinder& A = pieces_[static_cast<std::size_t>(k.a)];
    const Vec3 va = vec::Add(A.velocity, vec::Cross(A.angularVelocity, k.ra));
    if (k.b < 0) return vec::Sub(va, k.surfaceVel);
    const Cylinder& B = pieces_[static_cast<std::size_t>(k.b)];
    return vec::Sub(va, vec::Add(B.velocity, vec::Cross(B.angularVelocity, k.rb)));
  }
  void Impulse(const Contact& k, Vec3 j) {
    const std::size_t a = static_cast<std::size_t>(k.a);
    Cylinder& A = pieces_[a];
    A.velocity = vec::Add(A.velocity, vec::Scale(j, InvMass(a)));
    A.angularVelocity = vec::Add(A.angularVelocity, InvInertiaOf(a, vec::Cross(k.ra, j)));
    if (k.b < 0) return;
    const std::size_t b = static_cast<std::size_t>(k.b);
    Cylinder& B = pieces_[b];
    B.velocity = vec::Sub(B.velocity, vec::Scale(j, InvMass(b)));
    B.angularVelocity = vec::Sub(B.angularVelocity, InvInertiaOf(b, vec::Cross(k.rb, j)));
  }
  void PseudoImpulse(const Contact& k, Vec3 j) {
    const std::size_t a = static_cast<std::size_t>(k.a);
    pv_[a] = vec::Add(pv_[a], vec::Scale(j, InvMass(a)));
    pw_[a] = vec::Add(pw_[a], InvInertiaOf(a, vec::Cross(k.ra, j)));
    if (k.b < 0) return;
    const std::size_t b = static_cast<std::size_t>(k.b);
    pv_[b] = vec::Sub(pv_[b], vec::Scale(j, InvMass(b)));
    pw_[b] = vec::Sub(pw_[b], InvInertiaOf(b, vec::Cross(k.rb, j)));
  }

  void Solve(double dt) {
    groupSum_.assign(groupForce_.size(), 0.0);
    for (int it = 0; it < p_.velocityIterations; ++it) {
      for (auto& k : contacts_) {
        // Normal (within the collider's or bumper's remaining force budget, if it has one).
        const double vn = vec::Dot(Relative(k), k.n);
        // The compliance floor only grips (holds a squeezed piece); it never throws one that is
        // already moving away from the shape.
        const double floorJn = vn < kGripSpeed ? k.minJn : 0.0;
        double jn = std::max(floorJn, k.jn + k.massN * (k.target - vn));
        if (k.group >= 0) {
          const std::size_t g = static_cast<std::size_t>(k.group);
          jn = std::min(jn, std::max(0.0, groupForce_[g] * dt - (groupSum_[g] - k.jn)));
          groupSum_[g] += jn - k.jn;
        }
        const double dj = jn - k.jn;
        k.jn = jn;
        if (dj != 0) Impulse(k, vec::Scale(k.n, dj));
        // Friction (circle).
        const Vec3 vr = Relative(k);
        double j1 = k.jt1 - k.massT1 * vec::Dot(vr, k.t1), j2 = k.jt2 - k.massT2 * vec::Dot(vr, k.t2);
        const double lim = k.mu * k.jn, mag = std::hypot(j1, j2);
        if (mag > lim) { const double sc = mag > 0 ? lim / mag : 0; j1 *= sc; j2 *= sc; }
        const double d1 = j1 - k.jt1, d2 = j2 - k.jt2;
        k.jt1 = j1;
        k.jt2 = j2;
        if (d1 != 0 || d2 != 0) Impulse(k, vec::Add(vec::Scale(k.t1, d1), vec::Scale(k.t2, d2)));
      }
    }
    // Split-impulse position correction: pseudo velocities that move the piece but carry no energy.
    for (int it = 0; it < p_.positionIterations; ++it) {
      for (auto& k : contacts_) {
        if (k.depth <= p_.penetrationSlop) continue;
        if (Saturated(k, dt)) continue;  // a force-limited shape gives way instead of pushing the piece out
        const std::size_t a = static_cast<std::size_t>(k.a);
        Vec3 vp = vec::Add(pv_[a], vec::Cross(pw_[a], k.ra));
        if (k.b >= 0) {
          const std::size_t b = static_cast<std::size_t>(k.b);
          vp = vec::Sub(vp, vec::Add(pv_[b], vec::Cross(pw_[b], k.rb)));
        }
        const double target = std::min(p_.correction * (k.depth - p_.penetrationSlop) / dt, p_.maxPushSpeed);
        const double jp = std::max(0.0, k.jp + k.massN * (target - vec::Dot(vp, k.n)));
        const double dj = jp - k.jp;
        k.jp = jp;
        if (dj != 0) PseudoImpulse(k, vec::Scale(k.n, dj));
      }
    }
    for (const auto& k : contacts_) {
      if (k.jn <= 0 && k.depth < 0) continue;
      touched_[static_cast<std::size_t>(k.a)] = 1;
      if (k.b >= 0) touched_[static_cast<std::size_t>(k.b)] = 1;
      // Support (normal force from below) for rolling resistance.
      if (k.n[2] > 0.5) support_[static_cast<std::size_t>(k.a)] += k.jn / dt;
      if (k.b >= 0 && k.n[2] < -0.5) support_[static_cast<std::size_t>(k.b)] += k.jn / dt;
    }
  }
};

/** WPILib-style roll/pitch/yaw of a piece (gimbal-locked when standing: prefer the quaternion). */
inline Pose3 ToPose3(const CylinderPose& p) {
  const auto r = vec::ToMatrix(p.orientation);
  Pose3 out;
  out.x = p.position[0];
  out.y = p.position[1];
  out.z = p.position[2];
  out.yaw = std::atan2(r[3], r[0]);
  out.pitch = std::asin(std::clamp(-r[6], -1.0, 1.0));
  out.roll = std::atan2(r[7], r[8]);
  return out;
}

}  // namespace mayhem::sim
