#include "mayhem/alliance.hpp"
#include <cassert>
#include <cmath>
#include <iostream>
#include <utility>

namespace {
constexpr double kLength = 16.541, kWidth = 8.0692, kPi = 3.14159265358979323846;
bool Near(double a, double b, double e = 1e-9) { return std::abs(a - b) <= e; }
bool SameAngle(double a, double b, double e = 1e-9) { return std::abs(mayhem::Wrap(a - b)) <= e; }

const mayhem::PathMarker kMarkers[] = {
  {mayhem::MarkerKind::Rotation, .4, .5, {}, true},
  {mayhem::MarkerKind::Event, .6, 0, "intake", true},
};
const std::string_view kDuring[] = {"spinUp"};
mayhem::Goal Aimed() {
  mayhem::Goal g{{6, 2, 0}};
  g.headingMode = mayhem::HeadingMode::PointAt; g.aimX = 4.6; g.aimY = 4.0;
  g.translationTolerance = .02; g.markers = kMarkers; g.markerCount = 2;
  return g;
}
const mayhem::AutoNode kNodes[] = {
  {"aim", mayhem::NodeKind::Pose, Aimed(), 8, "", {}, kDuring, 1},
  {"settle", mayhem::NodeKind::Pose, {{3, 6, 1.2}}, 8, "", {}},
  {"shoot", mayhem::NodeKind::Action, {}, 2, "shooter.fire", {}},
  {"done", mayhem::NodeKind::Finish, {}, 1, "", {}},
};
bool Always(const mayhem::RobotHooks&) { return true; }
const mayhem::AutoTransition kEdges[] = {
  {"a", "aim", "settle", Always}, {"b", "settle", "shoot", Always}, {"c", "shoot", "done", Always},
};
constexpr mayhem::RoutineView kBlue{"test", "aim", kNodes, 4, kEdges, 3};
const mayhem::RoutineInfo kInfo{"Test auto", kBlue, {1.5, 1.0, .3}};

struct Hooks final : mayhem::RobotHooks {
  int events = 0;
  mayhem::ActionStatus TickAction(std::string_view) override { return mayhem::ActionStatus::Succeeded; }
  void PathEvent(std::string_view) override { ++events; }
};
// Closed-loop run with an ideal plant; returns the final pose.
mayhem::Pose Drive(mayhem::RoutineView routine, mayhem::Pose pose, int& events) {
  Hooks hooks; mayhem::AutoRunner runner(routine, hooks); mayhem::Velocity v;
  assert(runner.Start());
  for (int i = 0; i < 2000 && runner.Status() == mayhem::RunStatus::Running; ++i) {
    v = runner.Tick(pose, v, .02);
    pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
  }
  assert(runner.Status() == mayhem::RunStatus::Completed);
  events = hooks.events;
  return pose;
}
}  // namespace

int main() {
  using mayhem::FieldTransform;
  // Pose/heading primitives agree with the existing helpers.
  const mayhem::Pose p{1, 2, .3};
  const auto flip = mayhem::TransformPose(p, FieldTransform::Flip, kLength, kWidth);
  const auto legacy = mayhem::FlipPose(p, kLength, kWidth);
  assert(flip.x == legacy.x && flip.y == legacy.y && flip.heading == legacy.heading);
  const auto mirror = mayhem::TransformPose(p, FieldTransform::Mirror, kLength, kWidth);
  const auto legacyMirror = mayhem::MirrorPose(p, kWidth);
  assert(mirror.x == legacyMirror.x && mirror.y == legacyMirror.y && mirror.heading == legacyMirror.heading);
  const auto across = mayhem::TransformPose(p, FieldTransform::MirrorLength, kLength, kWidth);
  assert(Near(across.x, kLength - 1) && across.y == 2 && SameAngle(across.heading, kPi - .3));

  mayhem::AllianceRoutine red(kInfo, kLength, kWidth, FieldTransform::Flip);
  const auto view = red.View();
  const auto* nodes = view.nodes;
  // Graph identity is shared with the blue source; only field-frame data is copied.
  assert(view.id == kBlue.id && view.initial == kBlue.initial && view.nodeCount == 4);
  assert(view.transitions == kBlue.transitions && view.transitionCount == 3 && nodes != kBlue.nodes);
  const auto& g = nodes[0].goal;
  assert(Near(g.pose.x, kLength - 6) && Near(g.pose.y, kWidth - 2) && SameAngle(g.pose.heading, kPi));
  assert(Near(g.aimX, kLength - 4.6) && Near(g.aimY, kWidth - 4.0));
  assert(g.markers != kMarkers && g.markerCount == 2);
  assert(g.markers[0].kind == mayhem::MarkerKind::Rotation && SameAngle(g.markers[0].heading, .5 + kPi) && g.markers[0].t == .4);
  assert(g.markers[1].key == "intake" && g.markers[1].heading == 0 && g.markers[1].t == .6);
  assert(g.headingMode == mayhem::HeadingMode::PointAt && g.translationTolerance == .02);
  assert(nodes[0].during == kDuring && nodes[0].duringCount == 1 && nodes[2].action == "shooter.fire");
  assert(Near(red.StartPose().x, kLength - 1.5) && Near(red.StartPose().y, kWidth - 1) && SameAngle(red.StartPose().heading, .3 + kPi));
  // The blue source is untouched.
  assert(kNodes[0].goal.pose.x == 6 && kMarkers[0].heading == .5);

  // Apply always re-derives from blue (no accumulation) and reuses its storage.
  assert(red.Apply(FieldTransform::Flip) && red.Apply(FieldTransform::Flip));
  assert(red.View().nodes == nodes && Near(nodes[0].goal.pose.x, kLength - 6));
  assert(red.Apply(FieldTransform::None) && nodes[0].goal.pose.x == 6 && nodes[0].goal.markers[0].heading == .5);
  assert(red.Transform() == FieldTransform::None && red.StartPose().x == 1.5);

  red.Apply(FieldTransform::Mirror);
  assert(nodes[0].goal.pose.x == 6 && Near(nodes[0].goal.pose.y, kWidth - 2) && SameAngle(nodes[0].goal.pose.heading, 0));
  assert(nodes[0].goal.aimX == 4.6 && Near(nodes[0].goal.aimY, kWidth - 4) && SameAngle(nodes[0].goal.markers[0].heading, -.5));
  assert(SameAngle(nodes[1].goal.pose.heading, -1.2));
  red.Apply(FieldTransform::MirrorLength);
  assert(Near(nodes[0].goal.pose.x, kLength - 6) && nodes[0].goal.pose.y == 2 && Near(nodes[0].goal.aimX, kLength - 4.6));
  assert(SameAngle(nodes[0].goal.markers[0].heading, kPi - .5) && SameAngle(nodes[1].goal.pose.heading, kPi - 1.2));

  // Without a field size only None applies.
  mayhem::AllianceRoutine unsized(kBlue, 0, 0);
  assert(!unsized.Apply(FieldTransform::Flip) && unsized.Transform() == FieldTransform::None);
  assert(unsized.View().nodes[0].goal.pose.x == 6);

  // Moving keeps views valid (vector storage moves with it).
  mayhem::AllianceRoutine moved(std::move(red));
  assert(moved.View().nodes == nodes && moved.Transform() == FieldTransform::MirrorLength);

  // Closed loop: the flipped routine from the flipped start ends at the flipped blue
  // result, PointAt aim and rotation markers included, firing the same events.
  int blueEvents = 0, redEvents = 0;
  const auto blueEnd = Drive(kBlue, kInfo.startPose, blueEvents);
  moved.Apply(FieldTransform::Flip);
  const auto redEnd = Drive(moved.View(), moved.StartPose(), redEvents);
  const auto expected = mayhem::FlipPose(blueEnd, kLength, kWidth);
  assert(Near(redEnd.x, expected.x, 1e-6) && Near(redEnd.y, expected.y, 1e-6) && SameAngle(redEnd.heading, expected.heading, 1e-6));
  assert(blueEvents == 1 && redEvents == 1);
  std::cout << "Alliance routine checks passed\n";
}
