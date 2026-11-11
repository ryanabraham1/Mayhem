#include "mayhem/pose_controller.hpp"
#include <cassert>
#include <chrono>
#include <iostream>
#include <limits>

int main(int argc, char**) {
  using namespace mayhem;
  Constraints c;
  Goal g{{5.8, 2.4, -.35}};
  Pose pose{1.4, 4, 0};
  Velocity velocity;
  PoseController controller;
  if (argc > 1) {
    std::cout.precision(17);
    for (int i = 0; i < 100; ++i) {
      const auto result = controller.Calculate(pose, velocity, g, c, .02);
      velocity = result.command;
      pose.x += velocity.vx * .02; pose.y += velocity.vy * .02;
      pose.heading = Wrap(pose.heading + velocity.omega * .02);
      std::cout << pose.x << ' ' << pose.y << ' ' << pose.heading << '\n';
    }
    return 0;
  }
  bool reached = false;
  for (int i = 0; i < 1000; ++i) {
    const auto result = controller.Calculate(pose, velocity, g, c, .02);
    assert(result.valid);
    assert(std::hypot(result.command.vx, result.command.vy) <= c.maxVelocity + 1e-9);
    assert(std::abs(result.command.omega) <= c.maxAngularVelocity + 1e-9);
    if (result.reached) { reached = true; break; }
    velocity = result.command;
    pose.x += velocity.vx * .02; pose.y += velocity.vy * .02;
    pose.heading = Wrap(pose.heading + velocity.omega * .02);
  }
  assert(reached);
  assert(std::hypot(pose.x - g.pose.x, pose.y - g.pose.y) <= g.translationTolerance);
  // Frozen measured pose cannot become a success merely because time elapsed.
  controller.Reset();
  for (int i = 0; i < 1000; ++i) assert(!controller.Calculate({}, {}, g, c, .02).reached);
  // With a settle time, passing a goal quickly is not a settled arrival.
  controller.Reset();
  g.settleTime = .12;
  assert(!controller.Calculate(g.pose, {2, 0, 0}, g, c, .02).reached);
  g.settleTime = 0;
  g.handoffRadius = .3;
  assert(controller.Calculate(g.pose, {2, 0, 0}, g, c, .02).reached);
  // Path: intermediate anchors hand off at speed; events fire in order; ends at the last anchor.
  {
    static const PathMarker marks[] = {{MarkerKind::Event, .4, 0, "intake", true},
                                       {MarkerKind::Rotation, .5, 1.2, {}, true}};
    Goal a{{4, 1, 0}}; a.headingMode = HeadingMode::Free;
    Goal b{{6, 3, 0}}; b.markers = marks; b.markerCount = 2;
    Goal e{{9, 3, 1.57}};
    const Goal* chain[] = {&a, &b, &e};
    PathFollower follower; Pose p{1, 1, 0}; Velocity v; follower.Reset(p);
    std::size_t index = 0; double minHandoffSpeed = 1e9; int events = 0; bool done = false;
    for (int i = 0; i < 2000 && !done; ++i) {
      const auto r = follower.Calculate(p, v, chain + index, 3 - index, true, c, .02);
      assert(r.valid);
      for (std::size_t m = r.eventsBegin; m < r.eventsEnd; ++m)
        if (chain[index]->markers[m].kind == MarkerKind::Event) ++events;
      if (r.handoff) { minHandoffSpeed = std::min(minHandoffSpeed, std::hypot(r.command.vx, r.command.vy)); ++index; }
      else if (r.reached) done = true;
      v = r.command;
      p.x += v.vx * .02; p.y += v.vy * .02; p.heading = Wrap(p.heading + v.omega * .02);
    }
    assert(done && index == 2 && events == 1);
    assert(minHandoffSpeed > 1.5);
    assert(std::hypot(p.x - 9, p.y - 3) <= e.translationTolerance + 1e-9);
  }
  // Shortest angular error across the +/-pi boundary.
  g = {{0, 0, -3.13}}; g.rotationTolerance = .01;
  controller.Reset();
  assert(controller.Calculate({0, 0, 3.13}, {}, g, c, .02).command.omega > 0);
  assert(!controller.Calculate({}, {}, g, c, 0).valid);
  g.pose.x = std::numeric_limits<double>::quiet_NaN();
  assert(!controller.Calculate({}, {}, g, c, .02).valid);
  g = {{5.8, 2.4, -.35}};
  const auto start = std::chrono::steady_clock::now();
  double checksum = 0;
  for (int i = 0; i < 100000; ++i) checksum += controller.Calculate({1, 1, 0}, {}, g, c, .02).command.vx;
  const auto elapsed = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count();
  std::cout << "Controller checks passed; " << elapsed / 100000 << " us/tick; checksum=" << checksum << '\n';
}
