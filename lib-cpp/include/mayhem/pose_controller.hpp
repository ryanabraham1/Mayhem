#pragma once
#include <algorithm>
#include <cmath>

namespace mayhem {
// All values use meters, radians, seconds; velocities are field-relative.
struct Pose { double x = 0, y = 0, heading = 0; };
struct Velocity { double vx = 0, vy = 0, omega = 0; };
struct Constraints {
  double maxVelocity = 3.5, maxAcceleration = 3, maxAngularVelocity = 5;
  double maxAngularAcceleration = 10, translationKp = 3.2, rotationKp = 4;
};
enum class HeadingMode { Fixed, PointAt, Motion, Free };
struct Goal {
  Pose pose;
  double translationTolerance = .06, rotationTolerance = .04;
  double velocityTolerance = .15, settleTime = .12, handoffRadius = 0;
  HeadingMode headingMode = HeadingMode::Fixed;
  double aimX = 0, aimY = 0;
};
struct ControlState { Velocity previous; double settled = 0; };
struct ControlResult { Velocity command; bool reached = false; bool valid = true; };
inline double Wrap(double angle) { return std::atan2(std::sin(angle), std::cos(angle)); }

// Original implementation of live-pose point-to-point control. No scheduler, vendor,
// network, file IO, allocation, or agent dependency. Call from any robot architecture.
class PoseController {
 public:
  void Reset(Velocity measured = {}) { state_ = {measured, 0}; }
  ControlResult Calculate(Pose pose, Velocity measured, const Goal& goal,
                          const Constraints& c, double dt) {
    const double values[] = {pose.x, pose.y, pose.heading, measured.vx, measured.vy,
      measured.omega, goal.pose.x, goal.pose.y, goal.pose.heading, goal.translationTolerance,
      goal.rotationTolerance, goal.velocityTolerance, goal.settleTime, goal.handoffRadius,
      c.maxVelocity, c.maxAcceleration, c.maxAngularVelocity, c.maxAngularAcceleration,
      c.translationKp, c.rotationKp, goal.aimX, goal.aimY, dt};
    for (double v : values) if (!std::isfinite(v)) return Invalid();
    if (dt <= 0 || dt > .1 || goal.translationTolerance <= 0 || goal.rotationTolerance <= 0 ||
        goal.velocityTolerance <= 0 || goal.settleTime < 0 || goal.handoffRadius < 0 ||
        c.maxVelocity <= 0 || c.maxAcceleration <= 0 || c.maxAngularVelocity <= 0 ||
        c.maxAngularAcceleration <= 0 || c.translationKp <= 0 || c.rotationKp <= 0) return Invalid();
    const double dx = goal.pose.x - pose.x, dy = goal.pose.y - pose.y;
    const double distance = std::hypot(dx, dy);
    const double targetHeading = goal.headingMode == HeadingMode::PointAt ? std::atan2(goal.aimY-pose.y, goal.aimX-pose.x) : goal.headingMode == HeadingMode::Motion && distance > goal.translationTolerance ? std::atan2(dy,dx) : goal.pose.heading;
    const double angle = goal.headingMode == HeadingMode::Free ? 0 : Wrap(targetHeading - pose.heading);
    if(!std::isfinite(distance)||!std::isfinite(angle)) return Invalid();
    const bool handoff = goal.handoffRadius > 0;
    const bool inPose = distance <= (handoff ? goal.handoffRadius : goal.translationTolerance) &&
                        std::abs(angle) <= goal.rotationTolerance;
    const bool slow = std::hypot(measured.vx, measured.vy) <= goal.velocityTolerance &&
                      (goal.headingMode == HeadingMode::Free || std::abs(measured.omega) <= goal.velocityTolerance);
    state_.settled = inPose && (handoff || slow) ? state_.settled + dt : 0;
    const bool reached = inPose && (handoff || (slow && state_.settled >= goal.settleTime));
    if (reached && !handoff) { state_.previous = {}; return {{}, true, true}; }
    const double speed = handoff ? c.maxVelocity : std::min({c.maxVelocity, c.translationKp * distance,
      std::sqrt(2 * c.maxAcceleration * std::max(0.0, distance - goal.translationTolerance / 2))});
    double vx = distance > 1e-9 ? speed * dx / distance : 0;
    double vy = distance > 1e-9 ? speed * dy / distance : 0;
    const double change = std::hypot(vx - state_.previous.vx, vy - state_.previous.vy);
    const double maxChange = c.maxAcceleration * dt;
    if (change > maxChange) {
      vx = state_.previous.vx + (vx - state_.previous.vx) * maxChange / change;
      vy = state_.previous.vy + (vy - state_.previous.vy) * maxChange / change;
    }
    const double angularSpeed = std::min({c.maxAngularVelocity, c.rotationKp * std::abs(angle),
      std::sqrt(2 * c.maxAngularAcceleration * std::abs(angle))});
    const double desired = angle == 0 ? 0 : std::copysign(angularSpeed, angle);
    const double omega = state_.previous.omega + std::clamp(desired - state_.previous.omega,
      -c.maxAngularAcceleration * dt, c.maxAngularAcceleration * dt);
    if(!std::isfinite(vx)||!std::isfinite(vy)||!std::isfinite(omega)) return Invalid();
    state_.previous = {vx, vy, omega};
    return {state_.previous, reached, true};
  }
  const ControlState& State() const { return state_; }
 private:
  ControlResult Invalid() { state_ = {}; return {{}, false, false}; }
  ControlState state_;
};
}  // namespace mayhem
