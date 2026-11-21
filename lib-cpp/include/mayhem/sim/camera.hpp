#pragma once
// mayhem::sim AprilTag camera: what a PhotonVision-style coprocessor reports, not the truth.
// Header-only, C++17, no WPILib (wpilib_apriltag.hpp converts WPILib's field layouts).
//
// Each frame the camera projects the four corners of every tag in the layout through a pinhole
// model, keeps the tags a detector would find, adds corner noise, and solves the camera pose from
// the noisy corners the way the coprocessor does (Gauss-Newton / Levenberg-Marquardt PnP):
// - Detection: in front of the lens, inside the image (with a margin), shortest projected edge
//   >= minSidePx, closer than maxDistanceM, viewed within maxViewAngleRad of the tag's normal,
//   no corner hidden behind an Obstacles prism or an extra occluder (another robot), and motion
//   blur below maxBlurPx.
// - Motion blur: each corner's image velocity (from the robot's linear and angular velocity)
//   times the exposure. Blur adds blur/sqrt(12) of noise to that tag's corners (a uniform smear),
//   on top of pixelNoisePx.
// - Estimation: two or more tags give one multi-tag solution over all their corners. One tag
//   gives two candidate solutions, as IPPE does: the tag tilted either way about the axis across
//   the line of sight. The candidate with the lower reprojection error is reported, so a noisy,
//   nearly frontal single tag can report the mirrored pose, as on a real robot. `ambiguity` is
//   best/alternate reprojection error (PhotonVision's definition).
// - Timing: frames are captured at `fps` and published latencyS (+ uniform jitter) later, each
//   with its capture time, which is the timestamp robot code gives its pose estimator.
// The estimation error therefore grows with distance and view angle, depends on how many tags and
// how far apart they are, and shows up while the robot spins or drives fast, from the same
// geometry that causes it on a real camera. Deterministic for a given seed.
//
// Frames (WPILib conventions): field x, y on the carpet, z up. A tag's +x points out of its face.
// The camera's x is its optical axis, y left, z up; robotToCamera places it in the robot frame
// (origin at the frame centre on the floor). Image u grows to the right, v downward.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <string>
#include <utility>
#include <vector>

#include "mayhem/sim/field.hpp"
#include "mayhem/sim/rng.hpp"
#include "mayhem/sim/swerve.hpp"

namespace mayhem::sim {

/** A position and orientation (world/parent frame). */
struct RigidPose {
  Vec3 position{0, 0, 0};
  vec::Quat orientation{};
};

namespace rigid {
inline vec::Quat Mul(const vec::Quat& a, const vec::Quat& b) {
  return {a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
          a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w};
}
inline vec::Quat Conj(const vec::Quat& q) { return {q.w, -q.x, -q.y, -q.z}; }
inline Vec3 Rotate(const vec::Quat& q, Vec3 v) { return vec::Mul(vec::ToMatrix(q), v); }
/** a then b, b expressed in a's frame (WPILib Pose3d + Transform3d). */
inline RigidPose Compose(const RigidPose& a, const RigidPose& b) {
  return {vec::Add(a.position, Rotate(a.orientation, b.position)), Mul(a.orientation, b.orientation)};
}
inline RigidPose Inverse(const RigidPose& p) {
  const vec::Quat qi = Conj(p.orientation);
  return {vec::Scale(Rotate(qi, p.position), -1), qi};
}
/** World point to p's local frame. */
inline Vec3 ToLocal(const RigidPose& p, Vec3 x) { return vec::MulT(vec::ToMatrix(p.orientation), vec::Sub(x, p.position)); }
inline double Yaw(const vec::Quat& q) {
  const auto r = vec::ToMatrix(q);
  return std::atan2(r[3], r[0]);
}
}  // namespace rigid

/** One tag of a field layout (WPILib: the tag's +x points out of its face). */
struct AprilTag {
  int id = 0;
  RigidPose pose;
};

/** A convex prism that blocks the camera's view (e.g. another robot's bumper box). */
struct Occluder {
  std::vector<Vec2> polygon;  // convex, any winding
  double zMin = 0, zMax = 1;
};

/**
 * Defaults describe a typical global-shutter coprocessor camera (1280x800, 70 degree horizontal
 * field of view, 30 fps). Noise, latency, exposure and the detection limits are starting
 * estimates: measure yours (see docs/SIMULATION.md, "AprilTag camera").
 */
struct CameraParams {
  std::string name = "camera";
  RigidPose robotToCamera;  // camera frame: x optical axis, y left, z up
  int widthPx = 1280, heightPx = 800;
  double horizontalFovRad = 1.2217;  // 70 deg; sets fx = fy unless fx > 0
  double fx = 0, fy = 0, cx = -1, cy = -1;  // calibrated intrinsics override the FOV (cx/cy < 0: image centre)
  double fps = 30;
  double latencyS = 0.030;       // capture to result available on the roboRIO
  double latencyJitterS = 0.005;  // extra uniform 0..jitter per frame
  double exposureS = 0.004;
  double pixelNoisePx = 0.25;    // corner noise, 1 sigma per axis
  double maxBlurPx = 8;          // a tag blurred more than this is not detected
  double minSidePx = 15;         // shortest projected tag edge a detector finds
  double edgeMarginPx = 2;       // corners this close to the image edge are not detected
  double maxDistanceM = 7;
  double maxViewAngleRad = 1.31;  // 75 deg between the tag's normal and the direction to the camera
  double frameDropProbability = 0;
  double tagSizeM = 0.1651;      // 6.5 in black square (FRC 2024-2026 tags, 36h11)
  std::uint64_t seed = 1;
};

struct TagSighting {
  int id = 0;
  /** Noisy image corners in tag-frame order (y, z): (-,-), (+,-), (+,+), (-,+). */
  std::array<Vec2, 4> corners{};
  double distanceM = 0, viewAngleRad = 0, blurPx = 0;
};

struct CameraFrame {
  double captureTime = 0, publishTime = 0;
  std::vector<TagSighting> tags;
  bool hasEstimate = false;
  bool multiTag = false;
  RigidPose robotPose;     // field-relative estimate of the robot origin
  RigidPose altRobotPose;  // one tag: the other PnP solution (equals robotPose for multi-tag)
  double reprojectionErrorPx = 0;  // RMS over the corners used
  double ambiguity = 0;            // one tag: best / alternate reprojection error; 0 for multi-tag
  double averageTagDistanceM = 0;
  // Simulation diagnostics, never for robot code: estimate vs the true pose at capture.
  double truthErrorM = 0, truthYawErrorRad = 0;
};

class AprilTagCamera {
 public:
  AprilTagCamera(CameraParams params, std::vector<AprilTag> layout)
      : p_(std::move(params)), tags_(std::move(layout)), rng_(p_.seed) {
    if (p_.fx <= 0) p_.fx = (p_.widthPx / 2.0) / std::tan(p_.horizontalFovRad / 2);
    if (p_.fy <= 0) p_.fy = p_.fx;
    if (p_.cx < 0) p_.cx = p_.widthPx / 2.0;
    if (p_.cy < 0) p_.cy = p_.heightPx / 2.0;
  }

  const CameraParams& Params() const { return p_; }
  const std::vector<AprilTag>& Layout() const { return tags_; }
  /** Move the camera on the robot (a turret, a camera on an elevator). */
  void SetRobotToCamera(const RigidPose& robotToCamera) { p_.robotToCamera = robotToCamera; }
  void SetEnabled(bool enabled) { enabled_ = enabled; }
  /** Tags with these ids are ignored (PhotonVision's fiducial ID filter). */
  void SetIgnoredTags(std::vector<int> ids) { ignored_ = std::move(ids); }

  /**
   * Advance to time `now` (seconds, monotonic) with the robot's true pose and velocity (world
   * frame, of the robot origin). Captures a frame when one is due and returns the frames whose
   * results reach the roboRIO by `now`, oldest first. Call it every sim step.
   */
  std::vector<CameraFrame> Update(double now, const RigidPose& robot, Vec3 linearVelocity, Vec3 angularVelocity,
                                  const Obstacles* occluders = nullptr, const std::vector<Occluder>* extra = nullptr) {
    const double period = p_.fps > 0 ? 1.0 / p_.fps : 0;
    if (enabled_ && (!started_ || now + 1e-9 >= nextCapture_)) {
      nextCapture_ = (started_ && now - nextCapture_ < period) ? nextCapture_ + period : now + period;
      started_ = true;
      if (!(p_.frameDropProbability > 0 && rng_.Uniform() < p_.frameDropProbability)) {
        CameraFrame f = Capture(now, robot, linearVelocity, angularVelocity, occluders, extra);
        double publish = now + p_.latencyS + (p_.latencyJitterS > 0 ? rng_.Uniform(0, p_.latencyJitterS) : 0);
        publish = std::max(publish, lastPublish_);
        lastPublish_ = publish;
        f.publishTime = publish;
        pending_.push_back(std::move(f));
      }
    }
    std::vector<CameraFrame> out;
    while (!pending_.empty() && pending_.front().publishTime <= now + 1e-9) {
      out.push_back(std::move(pending_.front()));
      pending_.pop_front();
    }
    if (!out.empty()) latest_ = out.back();
    return out;
  }

  /** Same, reading the true pose and velocity from a SwerveSim. */
  std::vector<CameraFrame> Update(double now, const SwerveSim& robot, const Obstacles* occluders = nullptr,
                                  const std::vector<Occluder>* extra = nullptr) {
    const auto p3 = robot.Pose3();
    const RigidPose pose{{p3.x, p3.y, p3.z}, vec::FromEuler(p3.roll, p3.pitch, p3.yaw)};
    const Vec3 w = robot.AngularVelocity();
    const Vec3 v = vec::Add(robot.LinearVelocity(), vec::Cross(w, vec::Sub(pose.position, robot.CenterOfMass())));
    return Update(now, pose, v, w, occluders, extra);
  }

  /** The most recently published frame (empty before the first). */
  const CameraFrame& Latest() const { return latest_; }

  /** A robot's bumper box up to its height, to pass as an extra occluder for other cameras. */
  static Occluder RobotOccluder(const SwerveSim& robot) {
    const auto pose = robot.Pose();
    const auto& sp = robot.Params();
    const auto c = OrientedBox{pose.x, pose.y, pose.yaw, sp.bumperLengthX / 2, sp.bumperLengthY / 2}.Corners();
    return {{c.begin(), c.end()}, 0, std::max(robot.RobotHeight(), sp.bumperTopM)};
  }

  /** The camera's field pose for a robot pose. */
  RigidPose CameraPose(const RigidPose& robot) const { return rigid::Compose(robot, p_.robotToCamera); }

  /** Pinhole projection of a field point; false behind the lens. */
  bool Project(const RigidPose& camera, Vec3 point, Vec2& uv) const {
    const Vec3 c = rigid::ToLocal(camera, point);
    if (c[0] < 1e-6) return false;
    uv = {p_.cx - p_.fx * c[1] / c[0], p_.cy - p_.fy * c[2] / c[0]};
    return true;
  }

  /** Tag corners in the field, in TagSighting order. */
  std::array<Vec3, 4> Corners(const AprilTag& tag) const {
    const double s = p_.tagSizeM / 2;
    const std::array<Vec2, 4> yz{{{-s, -s}, {s, -s}, {s, s}, {-s, s}}};
    std::array<Vec3, 4> out{};
    for (int i = 0; i < 4; ++i)
      out[i] = vec::Add(tag.pose.position, rigid::Rotate(tag.pose.orientation, {0, yz[i][0], yz[i][1]}));
    return out;
  }

 private:
  CameraParams p_;
  std::vector<AprilTag> tags_;
  std::vector<int> ignored_;
  Rng rng_;
  bool enabled_ = true, started_ = false;
  double nextCapture_ = 0, lastPublish_ = -1e300;
  std::deque<CameraFrame> pending_;
  CameraFrame latest_;

  CameraFrame Capture(double now, const RigidPose& robot, Vec3 v, Vec3 w, const Obstacles* obstacles,
                      const std::vector<Occluder>* extra) {
    CameraFrame f;
    f.captureTime = now;
    const RigidPose cam = CameraPose(robot);
    // Camera pose a moment later, for each corner's image velocity.
    constexpr double kDt = 1e-3;
    const RigidPose robotLater{vec::Add(robot.position, vec::Scale(v, kDt)), vec::Integrate(robot.orientation, w, kDt)};
    const RigidPose camLater = CameraPose(robotLater);

    std::vector<Vec3> world;
    std::vector<Vec2> image;
    double distSum = 0;
    for (const auto& tag : tags_) {
      if (std::find(ignored_.begin(), ignored_.end(), tag.id) != ignored_.end()) continue;
      const Vec3 toCam = vec::Sub(cam.position, tag.pose.position);
      const double dist = vec::Norm(toCam);
      if (dist > p_.maxDistanceM || dist < 1e-6) continue;
      const Vec3 n = rigid::Rotate(tag.pose.orientation, {1, 0, 0});
      const double view = std::acos(std::clamp(vec::Dot(n, toCam) / dist, -1.0, 1.0));
      if (view > p_.maxViewAngleRad) continue;
      const auto corners = Corners(tag);
      TagSighting s;
      s.id = tag.id;
      s.distanceM = dist;
      s.viewAngleRad = view;
      bool ok = true;
      for (int i = 0; i < 4 && ok; ++i) {
        Vec2 a, b;
        if (!Project(cam, corners[i], a) || !Project(camLater, corners[i], b)) { ok = false; break; }
        if (a[0] < p_.edgeMarginPx || a[0] > p_.widthPx - p_.edgeMarginPx || a[1] < p_.edgeMarginPx ||
            a[1] > p_.heightPx - p_.edgeMarginPx) ok = false;
        s.corners[i] = a;
        s.blurPx = std::max(s.blurPx, std::hypot(b[0] - a[0], b[1] - a[1]) / kDt * p_.exposureS);
      }
      if (!ok || s.blurPx > p_.maxBlurPx) continue;
      double minSide = 1e300;
      for (int i = 0; i < 4; ++i) {
        const Vec2& a = s.corners[i];
        const Vec2& b = s.corners[(i + 1) % 4];
        minSide = std::min(minSide, std::hypot(b[0] - a[0], b[1] - a[1]));
      }
      if (minSide < p_.minSidePx) continue;
      for (int i = 0; i < 4 && ok; ++i)
        if (Blocked(cam.position, corners[i], obstacles, extra)) ok = false;
      if (!ok) continue;
      const double sigma = std::hypot(p_.pixelNoisePx, s.blurPx / std::sqrt(12.0));
      for (auto& c : s.corners) {
        if (sigma > 0) { c[0] += rng_.Normal(0, sigma); c[1] += rng_.Normal(0, sigma); }
      }
      for (int i = 0; i < 4; ++i) { world.push_back(corners[i]); image.push_back(s.corners[i]); }
      distSum += dist;
      f.tags.push_back(s);
    }
    if (f.tags.empty()) return f;
    f.averageTagDistanceM = distSum / f.tags.size();
    f.multiTag = f.tags.size() >= 2;

    double err = 0;
    RigidPose best = Solve(cam, world, image, err);
    double bestErr = err;
    RigidPose alt = best;
    double altErr = bestErr;
    if (!f.multiTag) {
      const AprilTag& tag = *std::find_if(tags_.begin(), tags_.end(), [&](const AprilTag& t) { return t.id == f.tags[0].id; });
      const RigidPose mirrored = Mirror(cam, tag);
      double e2 = 0;
      const RigidPose other = Solve(mirrored, world, image, e2);
      if (e2 < bestErr) { alt = best; altErr = bestErr; best = other; bestErr = e2; }
      else { alt = other; altErr = e2; }
      f.ambiguity = altErr > 1e-12 ? bestErr / altErr : 1;
    }
    const RigidPose camToRobot = rigid::Inverse(p_.robotToCamera);
    f.hasEstimate = true;
    f.robotPose = rigid::Compose(best, camToRobot);
    f.altRobotPose = rigid::Compose(alt, camToRobot);
    f.reprojectionErrorPx = bestErr;
    f.truthErrorM = vec::Norm(vec::Sub(f.robotPose.position, robot.position));
    double dyaw = rigid::Yaw(f.robotPose.orientation) - rigid::Yaw(robot.orientation);
    f.truthYawErrorRad = std::abs(std::remainder(dyaw, 2 * 3.14159265358979323846));
    return f;
  }

  /** Does the segment from the camera to just short of `target` cross an occluder? */
  static bool Blocked(Vec3 from, Vec3 target, const Obstacles* obstacles, const std::vector<Occluder>* extra) {
    const Vec3 d = vec::Sub(target, from);
    const double len = vec::Norm(d);
    if (len < 0.03) return false;
    const double tEnd = 1 - 0.02 / len;  // the tag sits on its own structure's face
    auto hits = [&](const std::vector<Vec2>& poly, double zMin, double zMax) {
      double t0 = 0, t1 = tEnd;
      auto clip = [&](double num, double den) {  // keep t where num + den t >= 0
        if (std::abs(den) < 1e-15) return num >= 0;
        const double t = -num / den;
        if (den > 0) t0 = std::max(t0, t); else t1 = std::min(t1, t);
        return t0 <= t1;
      };
      if (!clip(from[2] - zMin, d[2]) || !clip(zMax - from[2], -d[2])) return false;
      // Convex polygon of either winding: inside is the side of each edge the centroid is on.
      Vec2 c{0, 0};
      for (const auto& v : poly) { c[0] += v[0]; c[1] += v[1]; }
      c[0] /= poly.size(); c[1] /= poly.size();
      for (std::size_t i = 0; i < poly.size(); ++i) {
        const Vec2& a = poly[i];
        const Vec2& b = poly[(i + 1) % poly.size()];
        Vec2 n{a[1] - b[1], b[0] - a[0]};  // left normal
        if (n[0] * (c[0] - a[0]) + n[1] * (c[1] - a[1]) < 0) n = {-n[0], -n[1]};
        if (!clip(n[0] * (from[0] - a[0]) + n[1] * (from[1] - a[1]), n[0] * d[0] + n[1] * d[1])) return false;
      }
      return t0 < t1;
    };
    if (obstacles) {
      const auto& prisms = obstacles->Prisms();
      for (std::size_t i = 0; i < prisms.size(); ++i) {
        if (!obstacles->Enabled(i)) continue;
        const auto& pr = prisms[i];
        const double x0 = std::min(from[0], from[0] + d[0]), x1 = std::max(from[0], from[0] + d[0]);
        const double y0 = std::min(from[1], from[1] + d[1]), y1 = std::max(from[1], from[1] + d[1]);
        if (x1 < pr.minX || x0 > pr.maxX || y1 < pr.minY || y0 > pr.maxY) continue;
        if (hits(pr.vertices, pr.zMin, std::min(pr.zMax, 1e6))) return true;
      }
    }
    if (extra)
      for (const auto& o : *extra)
        if (o.polygon.size() >= 3 && hits(o.polygon, o.zMin, o.zMax)) return true;
    return false;
  }

  /** Starting pose for the second single-tag solution: the tag tilted the other way. */
  static RigidPose Mirror(const RigidPose& cam, const AprilTag& tag) {
    const Vec3 n = rigid::Rotate(tag.pose.orientation, {1, 0, 0});
    const Vec3 c = vec::Sub(cam.position, tag.pose.position);
    const Vec3 m = vec::Sub(vec::Scale(n, 2 * vec::Dot(c, n)), c);
    const Vec3 axis = vec::Cross(c, m);
    const double s = vec::Norm(axis);
    if (s < 1e-9 * vec::Dot(c, c)) return cam;  // frontal: both solutions coincide
    const double angle = std::atan2(s, vec::Dot(c, m));
    const Vec3 w = vec::Scale(axis, angle / s);
    return {vec::Add(tag.pose.position, m), vec::Integrate(cam.orientation, w, 1.0)};
  }

  double Residuals(const RigidPose& cam, const std::vector<Vec3>& X, const std::vector<Vec2>& u, std::vector<double>& r) const {
    r.resize(2 * X.size());
    double sum = 0;
    for (std::size_t i = 0; i < X.size(); ++i) {
      Vec2 uv;
      if (!Project(cam, X[i], uv)) uv = {1e6, 1e6};
      r[2 * i] = uv[0] - u[i][0];
      r[2 * i + 1] = uv[1] - u[i][1];
      sum += r[2 * i] * r[2 * i] + r[2 * i + 1] * r[2 * i + 1];
    }
    return sum;
  }

  static RigidPose Perturb(const RigidPose& cam, const std::array<double, 6>& d) {
    return {vec::Add(cam.position, {d[0], d[1], d[2]}), vec::Integrate(cam.orientation, {d[3], d[4], d[5]}, 1.0)};
  }

  /** Levenberg-Marquardt PnP from a starting camera pose; rmsPx is the final RMS reprojection error. */
  RigidPose Solve(RigidPose cam, const std::vector<Vec3>& X, const std::vector<Vec2>& u, double& rmsPx) const {
    std::vector<double> r, rp;
    double cost = Residuals(cam, X, u, r);
    double lambda = 1e-3;
    const std::size_t m = r.size();
    std::vector<std::array<double, 6>> J(m);
    for (int iter = 0; iter < 30; ++iter) {
      constexpr double h = 1e-7;
      for (int k = 0; k < 6; ++k) {
        std::array<double, 6> d{};
        d[k] = h;
        Residuals(Perturb(cam, d), X, u, rp);
        for (std::size_t i = 0; i < m; ++i) J[i][k] = (rp[i] - r[i]) / h;
      }
      double A[6][6] = {}, g[6] = {};
      for (std::size_t i = 0; i < m; ++i)
        for (int a = 0; a < 6; ++a) {
          g[a] += J[i][a] * r[i];
          for (int b = 0; b < 6; ++b) A[a][b] += J[i][a] * J[i][b];
        }
      bool improved = false;
      for (int tries = 0; tries < 8 && !improved; ++tries) {
        double M[6][7];
        for (int a = 0; a < 6; ++a) {
          for (int b = 0; b < 6; ++b) M[a][b] = A[a][b] + (a == b ? lambda * (A[a][a] + 1e-12) : 0);
          M[a][6] = -g[a];
        }
        std::array<double, 6> d{};
        if (!SolveLinear(M, d)) { lambda *= 10; continue; }
        const RigidPose next = Perturb(cam, d);
        const double c2 = Residuals(next, X, u, rp);
        if (c2 <= cost) {
          const double step = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + d[3] * d[3] + d[4] * d[4] + d[5] * d[5]);
          const double drop = cost - c2;
          cam = next;
          cost = c2;
          r.swap(rp);
          lambda = std::max(1e-9, lambda / 10);
          improved = true;
          if (step < 1e-10 || drop < 1e-14 * (1 + cost)) iter = 1000;
        } else {
          lambda *= 10;
        }
      }
      if (!improved) break;
    }
    rmsPx = X.empty() ? 0 : std::sqrt(cost / X.size());
    return cam;
  }

  static bool SolveLinear(double M[6][7], std::array<double, 6>& x) {
    for (int c = 0; c < 6; ++c) {
      int piv = c;
      for (int rr = c + 1; rr < 6; ++rr)
        if (std::abs(M[rr][c]) > std::abs(M[piv][c])) piv = rr;
      if (std::abs(M[piv][c]) < 1e-300) return false;
      if (piv != c)
        for (int k = 0; k < 7; ++k) std::swap(M[c][k], M[piv][k]);
      for (int rr = c + 1; rr < 6; ++rr) {
        const double f = M[rr][c] / M[c][c];
        for (int k = c; k < 7; ++k) M[rr][k] -= f * M[c][k];
      }
    }
    for (int c = 5; c >= 0; --c) {
      double s = M[c][6];
      for (int k = c + 1; k < 6; ++k) s -= M[c][k] * x[k];
      x[c] = s / M[c][c];
    }
    return true;
  }
};

}  // namespace mayhem::sim
