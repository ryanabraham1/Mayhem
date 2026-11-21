#pragma once
/*
 * Portions ported from BLine-Lib (https://github.com/edanliahovetsky/BLine-Lib):
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2025, Edan Liahovetsky
 * Copyright (c) 2025, Rebel Robotics (FRC 2638)
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace mayhem {
// All values use meters, radians, seconds; velocities are field-relative.
struct Pose { double x = 0, y = 0, heading = 0; };
struct Velocity { double vx = 0, vy = 0, omega = 0; };
struct Constraints {
  // BLine-Lib defaults: 4.5 m/s, 12 m/s^2, 720 deg/s, 1500 deg/s^2; README gains 5 / 3.
  double maxVelocity = 4.5, maxAcceleration = 12, maxAngularVelocity = 12.566370614359172;
  double maxAngularAcceleration = 26.179938779914941, translationKp = 5, rotationKp = 3;
  // Default intermediate handoff radius, cross-track gain, and speed floor (0 = off).
  double handoffRadius = .45, crossTrackKp = 2, minVelocity = 0;
  // Slow down before a slower step ahead (speed <= sqrt(cap^2 + 2 a d), d = distance to
  // its handoff point) instead of after its handoff. Needs per-anchor caps; off = BLine.
  bool anticipateSpeedCaps = false;
  // Braking profile for the end of a path (0 = off, the BLine P law alone): while the path
  // ends ahead, speed <= sqrt(2 * stopDeceleration * room), room = remaining distance less
  // (stopLag + dt) * the measured speed toward the target. Set stopDeceleration to what the
  // robot can really brake at (at most maxAcceleration) and stopLag to the drivetrain's
  // velocity-loop lag in seconds. AutoRunner::SetStopDeceleration supplies a live limit.
  double stopDeceleration = 0, stopLag = 0;
};
enum class HeadingMode { Fixed, PointAt, Motion, Free };
enum class MarkerKind { Rotation, Event };
// When an event marker fires: at projected progress t (default), within `distance` of its
// step's goal (GoalDistance), or within `distance` of the field point (x, y) (PointDistance).
enum class MarkerTrigger { Progress, GoalDistance, PointDistance };
// Rotation target or event trigger on the segment leading into its anchor,
// placed by projected progress t in [0, 1]. Progress event markers fire in list order (one
// waits for those before it); an event marker with a distance trigger fires on its own, by
// distance instead of t (first 64 markers of a step). `hold` (AutoRunner): the
// bound action is begun at the marker and ticked every loop until it succeeds or the step
// exits (a `during` action started at the marker), instead of only running its `begin`.
struct PathMarker {
  MarkerKind kind = MarkerKind::Event; double t = .5; double heading = 0;
  std::string_view key; bool profiled = true;
  MarkerTrigger trigger = MarkerTrigger::Progress; double distance = 0, x = 0, y = 0;
  bool hold = false;
};
// Whether an event marker's trigger is met at `progress` along its segment, `goalDistance`
// from its step's goal, with the robot at `pose`.
inline bool MarkerPassed(const PathMarker& m, double progress, double goalDistance, double x, double y) {
  if (m.trigger == MarkerTrigger::GoalDistance) return goalDistance <= m.distance;
  if (m.trigger == MarkerTrigger::PointDistance) return std::hypot(m.x - x, m.y - y) <= m.distance;
  return m.t <= progress;
}
struct Goal {
  Pose pose;
  double translationTolerance = .03, rotationTolerance = 0.03490658503988659;
  double velocityTolerance = .15, settleTime = 0, handoffRadius = 0;
  HeadingMode headingMode = HeadingMode::Fixed;
  double aimX = 0, aimY = 0;
  bool stop = false, projectedHandoff = false, profiled = true;
  const PathMarker* markers = nullptr; std::size_t markerCount = 0;
  // Radians added to the Motion or PointAt heading (pi: face backward while moving).
  double headingOffset = 0;
};
struct ControlState {
  Velocity previous; double settled = 0;
  double sx = 0, sy = 0, rotHeading = 0, rotRemaining = NAN;
  std::size_t events = 0; bool started = false; double acceptedRemaining = INFINITY;
  // Distance-triggered event markers of the active anchor already fired (bit i = marker i).
  std::uint64_t distanceFired = 0;
};
struct ControlResult {
  Velocity command; bool reached = false; bool valid = true; bool handoff = false;
  // Markers [eventsBegin, eventsEnd) of the active anchor were passed this tick: its
  // progress-triggered event markers fired (other markers in the range did not).
  std::size_t eventsBegin = 0, eventsEnd = 0;
  double progress = 0, remaining = 0;
  // Distance to the active anchor, and |heading error| against the heading the
  // follower is steering to this tick (PointAt, Motion, markers included).
  double translationError = 0, rotationError = 0;
  // Distance-triggered event markers of the active anchor that fired this tick (bit i = marker i).
  std::uint64_t distanceEvents = 0;
};
inline double Wrap(double angle) { return std::atan2(std::sin(angle), std::cos(angle)); }
// Path follower ported from BLine-Lib's FollowPath, RotationProgress and ChassisRateLimiter
// (BSD 3-Clause, Copyright (c) 2025 Edan Liahovetsky and Rebel Robotics (FRC 2638); see
// THIRD_PARTY_NOTICES.md). Mirrors follow() in app/src/suite/core/runtime.ts.
// anchors[0] is the active translation target; `final` means anchors[count-1] ends the
// path. No scheduler, vendor, network, file IO, allocation, or agent dependency.
// A dt above MaxDt() (a loop overrun) is integrated as MaxDt() instead of failing.
class PathFollower {
 public:
  static constexpr double kDefaultMaxDt = .1;
  // Below this distance to the target, Motion heading follows the segment direction.
  static constexpr double kMotionMinDistance = .1;
  // Ignored unless finite and positive.
  void SetMaxDt(double maxDt) { if (std::isfinite(maxDt) && maxDt > 0) maxDt_ = maxDt; }
  double MaxDt() const { return maxDt_; }
  void Reset(Pose pose, Velocity measured = {}) {
    state_ = {measured, 0, pose.x, pose.y, pose.heading, NAN, 0, true, INFINITY, 0};
  }
  // caps (optional, `count` entries): max velocity of the step owning each anchor; used
  // only with c.anticipateSpeedCaps.
  ControlResult Calculate(Pose pose, Velocity measured, const Goal* const* anchors,
                          std::size_t count, bool final, const Constraints& c, double dt,
                          const double* caps = nullptr) {
    if (count == 0 || !anchors[0]) return Invalid();
    if (!state_.started) Reset(pose, state_.previous);
    const Goal& T = *anchors[0];
    const double nums[] = {pose.x, pose.y, pose.heading, measured.vx, measured.vy, measured.omega,
      state_.previous.vx, state_.previous.vy, state_.previous.omega, state_.settled, state_.sx,
      state_.sy, dt, c.maxVelocity, c.maxAcceleration, c.maxAngularVelocity,
      c.maxAngularAcceleration, c.translationKp, c.rotationKp, c.handoffRadius, c.crossTrackKp,
      c.minVelocity, c.stopDeceleration, c.stopLag};
    for (double v : nums) if (!std::isfinite(v)) return Invalid();
    if (dt <= 0 || c.maxVelocity <= 0 || c.maxAcceleration <= 0 ||
        c.maxAngularVelocity <= 0 || c.maxAngularAcceleration <= 0 || c.translationKp <= 0 ||
        c.rotationKp <= 0 || c.handoffRadius <= 0 || c.crossTrackKp <= 0 || c.minVelocity < 0 ||
        c.stopDeceleration < 0 || c.stopLag < 0)
      return Invalid();
    dt = std::min(dt, maxDt_);
    for (std::size_t i = 0; i < count; ++i) {
      const Goal* g = anchors[i];
      if (!g) return Invalid();
      const double gv[] = {g->pose.x, g->pose.y, g->pose.heading, g->translationTolerance,
        g->rotationTolerance, g->velocityTolerance, g->settleTime, g->handoffRadius, g->headingOffset};
      for (double v : gv) if (!std::isfinite(v)) return Invalid();
      if (g->translationTolerance <= 0 || g->rotationTolerance <= 0 || g->velocityTolerance <= 0 ||
          g->settleTime < 0 || g->handoffRadius < 0 ||
          (g->headingMode == HeadingMode::PointAt && (!std::isfinite(g->aimX) || !std::isfinite(g->aimY))))
        return Invalid();
      for (std::size_t m = 0; m < g->markerCount; ++m)
        if (!std::isfinite(g->markers[m].t) ||
            (g->markers[m].kind == MarkerKind::Rotation && !std::isfinite(g->markers[m].heading)) ||
            (g->markers[m].trigger != MarkerTrigger::Progress &&
             !(m < 64 && std::isfinite(g->markers[m].distance) && g->markers[m].distance >= 0 &&
               std::isfinite(g->markers[m].x) && std::isfinite(g->markers[m].y))))
          return Invalid();
    }
    const double sx = state_.sx, sy = state_.sy;
    const double segX = T.pose.x - sx, segY = T.pose.y - sy, L = std::hypot(segX, segY);
    const double ux = L > 1e-9 ? segX / L : 0, uy = L > 1e-9 ? segY / L : 0;
    const double rx = pose.x - sx, ry = pose.y - sy;
    const double progress = L > 1e-9 ? std::clamp((rx * ux + ry * uy) / L, 0.0, 1.0) : 1;
    const double crossTrack = L > 1e-9 ? ux * ry - uy * rx : 0;
    const double dx = T.pose.x - pose.x, dy = T.pose.y - pose.y, distance = std::hypot(dx, dy);
    double tail = 0;
    for (std::size_t i = 1; i < count; ++i)
      tail += std::hypot(anchors[i]->pose.x - anchors[i - 1]->pose.x, anchors[i]->pose.y - anchors[i - 1]->pose.y);
    const bool isFinal = final && count == 1;
    const double remaining = final ? distance + tail : INFINITY;
    const double along = (1 - progress) * L + tail;
    const double radius = T.handoffRadius > 0 ? T.handoffRadius : c.handoffRadius;
    const bool handoff = !isFinal && (L <= 1e-9 || distance <= radius ||
      (T.projectedHandoff && L > 1e-9 && progress >= std::clamp(1 - radius / L, 0.0, 1.0)));
    ControlResult out;
    out.progress = progress; out.remaining = remaining;
    out.eventsBegin = state_.events;
    std::size_t events = state_.events;
    for (; events < T.markerCount; ++events)
      if (T.markers[events].kind == MarkerKind::Event && !handoff &&
          T.markers[events].trigger == MarkerTrigger::Progress && T.markers[events].t > progress) break;
    out.eventsEnd = events;
    std::uint64_t distanceFired = state_.distanceFired;
    for (std::size_t m = 0; m < T.markerCount && m < 64; ++m) {
      const std::uint64_t bit = std::uint64_t{1} << m;
      if (T.markers[m].kind != MarkerKind::Event || T.markers[m].trigger == MarkerTrigger::Progress || (distanceFired & bit)) continue;
      if (handoff || MarkerPassed(T.markers[m], progress, distance, pose.x, pose.y)) { distanceFired |= bit; out.distanceEvents |= bit; }
    }
    const double progressAlong = std::min(along, state_.acceptedRemaining);
    double fromHeading = state_.rotHeading;
    double fromRemaining = std::isfinite(state_.rotRemaining) ? state_.rotRemaining : along;
    for (std::size_t m = 0; m < T.markerCount; ++m)
      if (T.markers[m].kind == MarkerKind::Rotation && T.markers[m].t <= progress) {
        fromHeading = T.markers[m].heading; fromRemaining = (1 - T.markers[m].t) * L + tail;
      }
    bool haveNext = false; double nextHeading = 0, nextRemaining = 0; bool nextProfiled = true;
    {
      double segStartX = sx, segStartY = sy, after = tail + L;
      for (std::size_t i = 0; i < count && !haveNext; ++i) {
        const Goal& g = *anchors[i];
        const double len = i == 0 ? L : std::hypot(g.pose.x - segStartX, g.pose.y - segStartY);
        after -= len;
        for (std::size_t m = 0; m < g.markerCount; ++m) {
          const auto& mk = g.markers[m];
          if (mk.kind == MarkerKind::Rotation && (i > 0 || mk.t > progress)) {
            haveNext = true; nextHeading = mk.heading; nextRemaining = (1 - mk.t) * len + after;
            nextProfiled = mk.profiled; break;
          }
        }
        if (!haveNext && g.headingMode == HeadingMode::Fixed) {
          haveNext = true; nextHeading = g.pose.heading; nextRemaining = after; nextProfiled = g.profiled;
        }
        // A Motion step ahead: face its direction of travel by the handoff into its segment
        // (the previous anchor's handoff circle), so the heading never steps at the handoff.
        if (!haveNext && i > 0 && g.headingMode == HeadingMode::Motion && len > 1e-9) {
          const Goal& before = *anchors[i - 1];
          haveNext = true; nextHeading = std::atan2(g.pose.y - segStartY, g.pose.x - segStartX) + g.headingOffset;
          nextRemaining = after + len + (before.handoffRadius > 0 ? before.handoffRadius : c.handoffRadius);
          nextProfiled = true;
        }
        segStartX = g.pose.x; segStartY = g.pose.y;
      }
    }
    double desiredHeading = fromHeading;
    bool rotationTargeted = haveNext;
    for (std::size_t m = 0; m < T.markerCount; ++m) rotationTargeted |= T.markers[m].kind == MarkerKind::Rotation;
    if (haveNext) {
      if (!nextProfiled) desiredHeading = nextHeading;
      else {
        const double span = fromRemaining - nextRemaining;
        const double f = span > 1e-9 ? std::clamp((fromRemaining - progressAlong) / span, 0.0, 1.0) : 1;
        desiredHeading = fromHeading + Wrap(nextHeading - fromHeading) * f;
      }
    }
    const double interpolated = desiredHeading;
    if (T.headingMode == HeadingMode::PointAt) desiredHeading = std::atan2(T.aimY - pose.y, T.aimX - pose.x) + T.headingOffset;
    else if (T.headingMode == HeadingMode::Motion) {
      // Toward the target; near it, along the segment (stable at the end of a path).
      double motion = interpolated;
      if (distance > std::max(T.translationTolerance, kMotionMinDistance)) motion = std::atan2(dy, dx);
      else if (L > 1e-9) motion = std::atan2(segY, segX);
      desiredHeading = motion + T.headingOffset;
    }
    if (isFinal && T.headingMode == HeadingMode::Fixed && distance <= T.translationTolerance) desiredHeading = T.pose.heading;
    const double angle = Wrap(desiredHeading - pose.heading);
    out.translationError = distance; out.rotationError = std::abs(angle);
    const bool inPose = isFinal && distance <= T.translationTolerance &&
                        ((T.headingMode == HeadingMode::Free && !rotationTargeted) || std::abs(angle) <= T.rotationTolerance);
    const bool slow = std::hypot(measured.vx, measured.vy) <= T.velocityTolerance &&
                      std::abs(measured.omega) <= T.velocityTolerance;
    const double settled = inPose && (T.settleTime <= 0 || slow) ? state_.settled + dt : 0;
    if (inPose && (T.settleTime <= 0 || settled >= T.settleTime)) {
      state_.previous = {}; state_.settled = settled; state_.events = events; state_.distanceFired = distanceFired;
      out.reached = true; return out;
    }
    // Translation: P on remaining distance clamped to max velocity, optional floor,
    // aimed at the target, plus cross-track correction along the segment's right normal.
    double speed = std::min(c.translationKp * remaining, c.maxVelocity);
    if (c.anticipateSpeedCaps && caps) {
      // Distance to the slower step's handoff point, less one step of travel (the rate
      // limiter applies a speed change one tick after it is requested).
      double d = distance - radius - speed * dt;
      for (std::size_t i = 1; i < count; ++i) {
        if (std::isfinite(caps[i]) && caps[i] < speed)
          speed = std::min(speed, std::sqrt(caps[i] * caps[i] + 2 * c.maxAcceleration * std::max(0.0, d)));
        d += std::hypot(anchors[i]->pose.x - anchors[i - 1]->pose.x, anchors[i]->pose.y - anchors[i - 1]->pose.y);
      }
    }
    if (c.stopDeceleration > 0 && std::isfinite(remaining)) {
      // Braking profile: never faster than the robot can stop from in the room left. The
      // room is measured from where the robot will be once this command takes effect.
      const double closing = distance > 1e-9 ? std::max(0.0, (measured.vx * dx + measured.vy * dy) / distance) : 0;
      const double room = std::max(0.0, remaining - closing * (c.stopLag + dt));
      speed = std::min(speed, std::sqrt(2 * c.stopDeceleration * room));
    }
    if (c.minVelocity > 0 && remaining > T.translationTolerance)
      speed = std::max(speed, std::min(c.minVelocity, c.maxVelocity));
    double vx = distance > 1e-9 ? speed * dx / distance : 0;
    double vy = distance > 1e-9 ? speed * dy / distance : 0;
    if (L > 1e-9) { vx += c.crossTrackKp * crossTrack * uy; vy -= c.crossTrackKp * crossTrack * ux; }
    // Rotation: P on heading error clamped to max angular velocity.
    double omega = std::clamp(c.rotationKp * angle, -c.maxAngularVelocity, c.maxAngularVelocity);
    // Rate limiting: cap speed, then limit the change of each command by the accelerations.
    const double mag = std::hypot(vx, vy);
    if (mag > c.maxVelocity) { vx *= c.maxVelocity / mag; vy *= c.maxVelocity / mag; }
    const auto& p = state_.previous;
    const double change = std::hypot(vx - p.vx, vy - p.vy), maxChange = c.maxAcceleration * dt;
    if (change > maxChange) {
      vx = p.vx + (vx - p.vx) * maxChange / change; vy = p.vy + (vy - p.vy) * maxChange / change;
    }
    omega = p.omega + std::clamp(omega - p.omega, -c.maxAngularAcceleration * dt, c.maxAngularAcceleration * dt);
    if (!std::isfinite(vx) || !std::isfinite(vy) || !std::isfinite(omega)) return Invalid();
    state_.previous = {vx, vy, omega};
    if (handoff) {
      // Continue from the heading requested now (Motion/PointAt included), so it never jumps.
      state_.rotHeading = desiredHeading; state_.rotRemaining = tail;
      state_.sx = T.pose.x; state_.sy = T.pose.y; state_.events = 0; state_.distanceFired = 0; state_.settled = 0;
      state_.acceptedRemaining = std::min(progressAlong, tail);
    } else {
      if (!std::isfinite(state_.rotRemaining)) state_.rotRemaining = along;
      state_.events = events; state_.distanceFired = distanceFired; state_.settled = settled; state_.acceptedRemaining = progressAlong;
    }
    out.command = state_.previous; out.reached = handoff; out.handoff = handoff;
    return out;
  }
  // Start a new path from the live pose on the next Calculate call.
  void Restart(Velocity measured = {}) { state_ = {}; state_.previous = measured; }
  const ControlState& State() const { return state_; }
 private:
  ControlResult Invalid() { state_ = {}; ControlResult r; r.valid = false; return r; }
  ControlState state_; double maxDt_ = kDefaultMaxDt;
};

// Single-pose convenience wrapper: drive to one goal (a one-anchor path). A goal
// with a handoff radius passes through instead of stopping.
class PoseController {
 public:
  void Reset(Velocity measured = {}) { follower_.Restart(); previous_ = measured; fresh_ = true; }
  // Longest dt integrated per call; a longer loop is clamped (see PathFollower).
  void SetMaxDt(double maxDt) { follower_.SetMaxDt(maxDt); }
  ControlResult Calculate(Pose pose, Velocity measured, const Goal& goal,
                          const Constraints& c, double dt) {
    if (fresh_) { follower_.Reset(pose, previous_); fresh_ = false; }
    const Goal* anchors[] = {&goal};
    const auto r = follower_.Calculate(pose, measured, anchors, 1, !(goal.handoffRadius > 0), c, dt);
    if (!r.valid || r.reached) fresh_ = true, previous_ = r.command;
    return r;
  }
 private:
  PathFollower follower_; Velocity previous_; bool fresh_ = true;
};
}  // namespace mayhem
