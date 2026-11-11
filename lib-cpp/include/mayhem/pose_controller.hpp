#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <string_view>

namespace mayhem {
// All values use meters, radians, seconds; velocities are field-relative.
struct Pose { double x = 0, y = 0, heading = 0; };
struct Velocity { double vx = 0, vy = 0, omega = 0; };
struct Constraints {
  double maxVelocity = 3.5, maxAcceleration = 3, maxAngularVelocity = 5;
  double maxAngularAcceleration = 10, translationKp = 3.2, rotationKp = 4;
  // Default intermediate handoff radius, cross-track gain, and speed floor (0 = off).
  double handoffRadius = .45, crossTrackKp = 2, minVelocity = 0;
};
enum class HeadingMode { Fixed, PointAt, Motion, Free };
enum class MarkerKind { Rotation, Event };
// Rotation target or event trigger on the segment leading into its anchor,
// placed by projected progress t in [0, 1].
struct PathMarker {
  MarkerKind kind = MarkerKind::Event; double t = .5; double heading = 0;
  std::string_view key; bool profiled = true;
};
struct Goal {
  Pose pose;
  double translationTolerance = .03, rotationTolerance = 0.03490658503988659;
  double velocityTolerance = .15, settleTime = 0, handoffRadius = 0;
  HeadingMode headingMode = HeadingMode::Fixed;
  double aimX = 0, aimY = 0;
  bool stop = false, projectedHandoff = true, profiled = true;
  const PathMarker* markers = nullptr; std::size_t markerCount = 0;
};
struct ControlState {
  Velocity previous; double settled = 0;
  double sx = 0, sy = 0, rotHeading = 0, rotRemaining = NAN;
  std::size_t events = 0; bool started = false;
};
struct ControlResult {
  Velocity command; bool reached = false; bool valid = true; bool handoff = false;
  // Markers [eventsBegin, eventsEnd) of the active anchor were passed this tick.
  std::size_t eventsBegin = 0, eventsEnd = 0;
  double progress = 0, remaining = 0;
};
inline double Wrap(double angle) { return std::atan2(std::sin(angle), std::cos(angle)); }
inline constexpr double kBrakingShare = .75;

// Original BLine-style path follower; mirrors follow() in app/src/suite/core/runtime.ts.
// anchors[0] is the active translation target; `final` means anchors[count-1] ends the
// path. No scheduler, vendor, network, file IO, allocation, or agent dependency.
class PathFollower {
 public:
  void Reset(Pose pose, Velocity measured = {}) {
    state_ = {measured, 0, pose.x, pose.y, pose.heading, NAN, 0, true};
  }
  ControlResult Calculate(Pose pose, Velocity measured, const Goal* const* anchors,
                          std::size_t count, bool final, const Constraints& c, double dt) {
    if (count == 0 || !anchors[0]) return Invalid();
    if (!state_.started) Reset(pose, state_.previous);
    const Goal& T = *anchors[0];
    const double nums[] = {pose.x, pose.y, pose.heading, measured.vx, measured.vy, measured.omega,
      state_.previous.vx, state_.previous.vy, state_.previous.omega, state_.settled, state_.sx,
      state_.sy, dt, c.maxVelocity, c.maxAcceleration, c.maxAngularVelocity,
      c.maxAngularAcceleration, c.translationKp, c.rotationKp, c.handoffRadius, c.crossTrackKp,
      c.minVelocity};
    for (double v : nums) if (!std::isfinite(v)) return Invalid();
    if (dt <= 0 || dt > .1 || c.maxVelocity <= 0 || c.maxAcceleration <= 0 ||
        c.maxAngularVelocity <= 0 || c.maxAngularAcceleration <= 0 || c.translationKp <= 0 ||
        c.rotationKp <= 0 || c.handoffRadius <= 0 || c.crossTrackKp <= 0 || c.minVelocity < 0)
      return Invalid();
    for (std::size_t i = 0; i < count; ++i) {
      const Goal* g = anchors[i];
      if (!g) return Invalid();
      const double gv[] = {g->pose.x, g->pose.y, g->pose.heading, g->translationTolerance,
        g->rotationTolerance, g->velocityTolerance, g->settleTime, g->handoffRadius};
      for (double v : gv) if (!std::isfinite(v)) return Invalid();
      if (g->translationTolerance <= 0 || g->rotationTolerance <= 0 || g->velocityTolerance <= 0 ||
          g->settleTime < 0 || g->handoffRadius < 0 ||
          (g->headingMode == HeadingMode::PointAt && (!std::isfinite(g->aimX) || !std::isfinite(g->aimY))))
        return Invalid();
      for (std::size_t m = 0; m < g->markerCount; ++m)
        if (!std::isfinite(g->markers[m].t) ||
            (g->markers[m].kind == MarkerKind::Rotation && !std::isfinite(g->markers[m].heading)))
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
      if (T.markers[events].kind == MarkerKind::Event && T.markers[events].t > progress && !handoff) break;
    out.eventsEnd = events;
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
        const double f = span > 1e-9 ? std::clamp((fromRemaining - along) / span, 0.0, 1.0) : 1;
        desiredHeading = fromHeading + Wrap(nextHeading - fromHeading) * f;
      }
    }
    const double interpolated = desiredHeading;
    if (T.headingMode == HeadingMode::PointAt) desiredHeading = std::atan2(T.aimY - pose.y, T.aimX - pose.x);
    else if (T.headingMode == HeadingMode::Motion && distance > T.translationTolerance) desiredHeading = std::atan2(dy, dx);
    if (isFinal && T.headingMode == HeadingMode::Fixed && distance <= T.translationTolerance) desiredHeading = T.pose.heading;
    const double angle = Wrap(desiredHeading - pose.heading);
    const bool inPose = isFinal && distance <= T.translationTolerance &&
                        ((T.headingMode == HeadingMode::Free && !rotationTargeted) || std::abs(angle) <= T.rotationTolerance);
    const bool slow = std::hypot(measured.vx, measured.vy) <= T.velocityTolerance &&
                      std::abs(measured.omega) <= T.velocityTolerance;
    const double settled = inPose && (T.settleTime <= 0 || slow) ? state_.settled + dt : 0;
    if (inPose && (T.settleTime <= 0 || settled >= T.settleTime)) {
      state_.previous = {}; state_.settled = settled; state_.events = events;
      out.reached = true; return out;
    }
    double speed = std::min({c.maxVelocity, c.translationKp * remaining,
      std::sqrt(2 * kBrakingShare * c.maxAcceleration * std::max(0.0, remaining - T.translationTolerance / 2))});
    if (c.minVelocity > 0 && remaining > T.translationTolerance)
      speed = std::max(speed, std::min(c.minVelocity, c.maxVelocity));
    double vx = distance > 1e-9 ? speed * dx / distance : 0;
    double vy = distance > 1e-9 ? speed * dy / distance : 0;
    if (L > 1e-9 && distance > T.translationTolerance) {
      vx += c.crossTrackKp * crossTrack * uy; vy -= c.crossTrackKp * crossTrack * ux;
    }
    const double mag = std::hypot(vx, vy);
    if (mag > speed && mag > 1e-9) { vx *= speed / mag; vy *= speed / mag; }
    const auto& p = state_.previous;
    const double change = std::hypot(vx - p.vx, vy - p.vy), maxChange = c.maxAcceleration * dt;
    if (change > maxChange) {
      vx = p.vx + (vx - p.vx) * maxChange / change; vy = p.vy + (vy - p.vy) * maxChange / change;
    }
    const double angularSpeed = std::min({c.maxAngularVelocity, c.rotationKp * std::abs(angle),
      std::sqrt(2 * c.maxAngularAcceleration * std::abs(angle))});
    const double desired = angle == 0 ? 0 : std::copysign(angularSpeed, angle);
    const double omega = p.omega + std::clamp(desired - p.omega,
      -c.maxAngularAcceleration * dt, c.maxAngularAcceleration * dt);
    if (!std::isfinite(vx) || !std::isfinite(vy) || !std::isfinite(omega)) return Invalid();
    state_.previous = {vx, vy, omega};
    if (handoff) {
      state_.rotHeading = interpolated; state_.rotRemaining = tail;
      state_.sx = T.pose.x; state_.sy = T.pose.y; state_.events = 0; state_.settled = 0;
    } else {
      if (!std::isfinite(state_.rotRemaining)) state_.rotRemaining = along;
      state_.events = events; state_.settled = settled;
    }
    out.command = state_.previous; out.reached = handoff; out.handoff = handoff;
    return out;
  }
  // Start a new path from the live pose on the next Calculate call.
  void Restart(Velocity measured = {}) { state_ = {}; state_.previous = measured; }
  const ControlState& State() const { return state_; }
 private:
  ControlResult Invalid() { state_ = {}; ControlResult r; r.valid = false; return r; }
  ControlState state_;
};

// Single-pose convenience wrapper: drive to one goal (a one-anchor path). A goal
// with a handoff radius passes through instead of stopping.
class PoseController {
 public:
  void Reset(Velocity measured = {}) { follower_ = {}; previous_ = measured; fresh_ = true; }
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
