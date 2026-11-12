// PoseDriver: the framework-free drive-to-pose behind the WPILib DriveToPose command.
#include "mayhem/pose_driver.hpp"
#include <cassert>
#include <cmath>
#include <limits>
#include <vector>

int main() {
  using namespace mayhem;
  using S = PoseCommandStatus;
  Pose pose{1, 1, 0};
  Velocity velocity;
  std::vector<Velocity> outputs;
  auto driver = [&](double watchdog, Goal goal = Goal{{3, 1.5, .3}}) {
    return PoseDriver([&] { return pose; }, [&] { return velocity; },
                      [&](Velocity v) { outputs.push_back(v); }, goal, Constraints{}, watchdog);
  };
  auto zero = [](Velocity v) { return v.vx == 0 && v.vy == 0 && v.omega == 0; };

  // Drives to the goal, then writes one zero velocity and stays Reached.
  auto drive = driver(5);
  assert(drive.Status() == S::Idle);
  drive.Start(10);
  assert(drive.Running());
  double now = 10;
  S status = S::Running;
  while (status == S::Running && now < 14) {
    now += .02;
    status = drive.Update(now);
    if (status == S::Running) {
      velocity = outputs.back();
      pose.x += velocity.vx * .02; pose.y += velocity.vy * .02;
      pose.heading = Wrap(pose.heading + velocity.omega * .02);
    }
  }
  assert(status == S::Reached && zero(outputs.back()));
  const auto written = outputs.size();
  assert(drive.Update(now + 1) == S::Reached && outputs.size() == written);

  // dt == 0 is skipped: no controller step, no output.
  pose = {1, 1, 0}; velocity = {}; outputs.clear();
  drive.Start(20);
  assert(drive.Update(20) == S::Running && outputs.empty());
  assert(drive.Update(20.02) == S::Running && outputs.size() == 1 && !zero(outputs.back()));

  // Cancel stops a running drive and zeroes the output; a later Cancel still zeroes.
  drive.Cancel();
  assert(drive.Status() == S::Cancelled && zero(outputs.back()));
  assert(drive.Update(21) == S::Cancelled);

  // The watchdog fails a drive that never arrives (frozen pose), with a zero output.
  auto frozen = driver(.5);
  frozen.Start(0);
  for (now = .02; frozen.Update(now) == S::Running; now += .02) assert(now < .6);
  assert(frozen.Status() == S::Failed && zero(outputs.back()) && now >= .5);

  // A non-positive or non-finite watchdog fails on the first update.
  for (double bad : {0.0, -1.0, std::numeric_limits<double>::infinity(), std::nan("")}) {
    auto d = driver(bad);
    d.Start(0);
    assert(d.Update(.02) == S::Failed && zero(outputs.back()));
  }

  // An invalid controller result (non-finite pose) fails with a zero output.
  pose = {std::nan(""), 1, 0};
  auto invalid = driver(5);
  invalid.Start(0);
  assert(invalid.Update(.02) == S::Failed && zero(outputs.back()));
  return 0;
}
