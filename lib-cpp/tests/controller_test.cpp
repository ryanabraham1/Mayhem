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
  // Passing a goal quickly is not a settled arrival.
  controller.Reset();
  assert(!controller.Calculate(g.pose, {2, 0, 0}, g, c, .02).reached);
  g.handoffRadius = .3;
  assert(controller.Calculate(g.pose, {2, 0, 0}, g, c, .02).reached);
  // Shortest angular error across the +/-pi boundary.
  g = {{0, 0, -3.13}};
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
