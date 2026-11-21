// Sensor models: the AprilTag camera (projection, detection limits, occlusion, motion blur,
// latency, noise growing with distance, single-tag ambiguity, determinism), SampledSignal timing
// and the gyro's scale error, bias drift and saturation.
#include <cstring>

#include "mayhem/sim/camera.hpp"
#include "mayhem/sim/sensors.hpp"
#include "sim_check.hpp"

using namespace mayhem::sim;

namespace {

constexpr double kDt = 0.001;

/** A tag at (x, y, z) facing yaw (its +x direction). */
AprilTag Tag(int id, double x, double y, double z, double yaw) { return {id, {{x, y, z}, vec::FromEuler(0, 0, yaw)}}; }

RigidPose RobotAt(double x, double y, double yaw) { return {{x, y, 0}, vec::FromEuler(0, 0, yaw)}; }

CameraParams Ideal() {
  CameraParams p;
  p.robotToCamera = {{0.2, 0, 0.5}, {}};  // forward-facing, 0.5 m up
  p.pixelNoisePx = 0;
  p.latencyS = 0;
  p.latencyJitterS = 0;
  return p;
}

/** First frame captured from a still robot (latency 0 publishes it immediately). */
CameraFrame Snap(AprilTagCamera& cam, const RigidPose& robot, const Obstacles* obs = nullptr, Vec3 v = {0, 0, 0},
                 Vec3 w = {0, 0, 0}) {
  static double t = 0;
  t += 10;  // a fresh capture each call
  auto frames = cam.Update(t, robot, v, w, obs);
  return frames.empty() ? CameraFrame{} : frames.back();
}

void Projection() {
  AprilTagCamera cam(Ideal(), {Tag(1, 3.2, 0, 0.5, kPi)});
  Vec2 uv;
  const RigidPose c = cam.CameraPose(RobotAt(0, 0, 0));
  SIM_CHECK(cam.Project(c, {3.2, 0, 0.5}, uv), "point ahead projects");
  SIM_NEAR(uv[0], 640, 1e-9, "centre u");
  SIM_NEAR(uv[1], 400, 1e-9, "centre v");
  cam.Project(c, {3.2, 0.3, 0.5}, uv);
  SIM_CHECK(uv[0] < 640, "a point to the left is left in the image: u %.1f", uv[0]);
  cam.Project(c, {3.2, 0, 0.8}, uv);
  SIM_CHECK(uv[1] < 400, "a point above is up in the image: v %.1f", uv[1]);
  SIM_CHECK(!cam.Project(c, {-1, 0, 0.5}, uv), "behind the lens: no projection");
}

void ExactWithoutNoise() {
  AprilTagCamera cam(Ideal(), {Tag(1, 4, 0.5, 0.6, kPi), Tag(2, 4, -0.6, 0.3, kPi), Tag(3, 4.5, 1.5, 0.9, kPi - 0.4)});
  const RigidPose robot = RobotAt(0.7, 0.2, 0.15);
  const CameraFrame f = Snap(cam, robot);
  std::printf("ideal camera: %zu tags, multi %d, error %.2e m, yaw %.2e rad, reproj %.2e px\n", f.tags.size(),
              f.multiTag, f.truthErrorM, f.truthYawErrorRad, f.reprojectionErrorPx);
  SIM_CHECK(f.tags.size() == 3 && f.multiTag && f.hasEstimate, "three tags seen: %zu", f.tags.size());
  SIM_CHECK(f.truthErrorM < 1e-6 && f.truthYawErrorRad < 1e-6, "noise-free PnP recovers the pose: %.2e m", f.truthErrorM);

  // One tag, seen obliquely: the right solution has zero error, the mirrored one does not.
  AprilTagCamera one(Ideal(), {Tag(1, 3, 1.0, 0.5, kPi + 0.6)});
  const CameraFrame g = Snap(one, RobotAt(0, 0, 0.3));
  std::printf("ideal single tag: error %.2e m, ambiguity %.3f, alternate off by %.3f m\n", g.truthErrorM, g.ambiguity,
              vec::Norm(vec::Sub(g.altRobotPose.position, g.robotPose.position)));
  SIM_CHECK(g.hasEstimate && !g.multiTag && g.truthErrorM < 1e-6, "single tag exact: %.2e", g.truthErrorM);
  SIM_CHECK(g.ambiguity < 0.05, "noise-free oblique view is unambiguous: %.3f", g.ambiguity);
}

void DetectionLimits() {
  AprilTagCamera cam(Ideal(), {Tag(1, 3, 0, 0.5, kPi),     // ahead, facing the robot
                               Tag(2, 3, 2, 0.5, 0),       // ahead but facing away
                               Tag(3, -3, 0, 0.5, 0),      // behind the robot
                               Tag(4, 9, 0, 0.5, kPi),     // too far (7 m limit)
                               Tag(5, 2, 3, 0.5, -kPi / 2)}); // outside the field of view
  const CameraFrame f = Snap(cam, RobotAt(0, 0, 0));
  std::vector<int> ids;
  for (const auto& t : f.tags) ids.push_back(t.id);
  std::printf("detection limits: sees %zu tag(s)%s\n", ids.size(), ids.size() == 1 && ids[0] == 1 ? " (only the visible one)" : "");
  SIM_CHECK(ids.size() == 1 && ids[0] == 1, "only the facing, in-view, in-range tag is seen");

  // Grazing angle beyond 75 degrees: not detected.
  AprilTagCamera graze(Ideal(), {Tag(1, 3, 0, 0.5, kPi + 1.4)});
  SIM_CHECK(Snap(graze, RobotAt(0, 0, 0)).tags.empty(), "a tag viewed edge-on is not detected");
  // Small in the image: a 6.5 in tag at 6.5 m is ~23 px; a 15 px minimum still sees it, 30 px does not.
  CameraParams small = Ideal();
  small.minSidePx = 30;
  AprilTagCamera far(small, {Tag(1, 6.7, 0, 0.5, kPi)});
  SIM_CHECK(Snap(far, RobotAt(0, 0, 0)).tags.empty(), "tags smaller than minSidePx are not detected");
  // Ignored ids.
  AprilTagCamera filt(Ideal(), {Tag(1, 3, 0, 0.5, kPi), Tag(2, 3, 0.6, 0.5, kPi)});
  filt.SetIgnoredTags({2});
  SIM_CHECK(Snap(filt, RobotAt(0, 0, 0)).tags.size() == 1, "ignored tags are skipped");
}

void Occlusion() {
  AprilTagCamera cam(Ideal(), {Tag(1, 4, 0, 0.5, kPi)});
  Obstacles obs;
  obs.AddBox("blocker", 2, 0, 0, 0.3, 0.3, 0, 1.0);
  SIM_CHECK(Snap(cam, RobotAt(0, 0, 0), &obs).tags.empty(), "a prism between camera and tag hides it");
  Obstacles low;
  low.AddBox("low", 2, 0, 0, 0.3, 0.3, 0, 0.2);  // below the line of sight
  SIM_CHECK(Snap(cam, RobotAt(0, 0, 0), &low).tags.size() == 1, "a low prism does not");
  Obstacles behind;
  behind.AddBox("mount", 4.15, 0, 0, 0.3, 1.0, 0, 1.0);  // the structure the tag is mounted on
  SIM_CHECK(Snap(cam, RobotAt(0, 0, 0), &behind).tags.size() == 1, "a tag on its own structure's face is visible");
  // Another robot in the way.
  std::vector<Occluder> robots{{{{1.6, -0.4}, {2.4, -0.4}, {2.4, 0.4}, {1.6, 0.4}}, 0, 0.9}};
  auto frames = cam.Update(1000, RobotAt(0, 0, 0), {0, 0, 0}, {0, 0, 0}, nullptr, &robots);
  SIM_CHECK(!frames.empty() && frames.back().tags.empty(), "another robot hides it");
}

void MotionBlur() {
  CameraParams p = Ideal();
  AprilTagCamera cam(p, {Tag(1, 3, 0, 0.5, kPi), Tag(2, 3, 0.8, 0.5, kPi)});
  const CameraFrame still = Snap(cam, RobotAt(0, 0, 0));
  const CameraFrame slow = Snap(cam, RobotAt(0, 0, 0), nullptr, {0, 0, 0}, {0, 0, 1.0});
  const CameraFrame fast = Snap(cam, RobotAt(0, 0, 0), nullptr, {0, 0, 0}, {0, 0, 8.0});
  const double blurSlow = slow.tags.empty() ? -1 : slow.tags[0].blurPx;
  std::printf("motion blur (4 ms exposure): still %.2f px, 1 rad/s %.2f px (%zu tags), 8 rad/s %zu tags\n",
              still.tags[0].blurPx, blurSlow, slow.tags.size(), fast.tags.size());
  // Yaw rate w moves the image by about fx * w * exposure pixels.
  SIM_NEAR(blurSlow, 914.0 * 1.0 * 0.004, 0.6, "blur at 1 rad/s ~ fx w t_exp");
  SIM_CHECK(still.tags[0].blurPx < 1e-6, "no blur standing still");
  SIM_CHECK(fast.tags.empty(), "spinning at 8 rad/s blurs the tags out");
}

void LatencyAndRate() {
  CameraParams p = Ideal();
  p.fps = 25;
  p.latencyS = 0.035;
  AprilTagCamera cam(p, {Tag(1, 3, 0, 0.5, kPi)});
  int frames = 0;
  double firstCapture = -1, firstPublish = -1, maxAge = 0;
  for (int k = 0; k <= 1000; ++k) {
    const double t = k * kDt;
    for (const auto& f : cam.Update(t, RobotAt(0, 0, 0), {0, 0, 0}, {0, 0, 0})) {
      if (firstCapture < 0) { firstCapture = f.captureTime; firstPublish = t; }
      maxAge = std::max(maxAge, t - f.captureTime);
      ++frames;
    }
  }
  std::printf("timing: %d frames in 1 s at 25 fps, first captured %.3f s and published %.3f s\n", frames, firstCapture,
              firstPublish);
  SIM_CHECK(frames == 25 || frames == 24, "25 fps: %d frames", frames);
  SIM_NEAR(firstPublish - firstCapture, 0.035, 1.5e-3, "published latencyS after capture");
  SIM_CHECK(maxAge < 0.0365, "never later than the latency: %.4f", maxAge);
}

struct Stats { double meanError = 0, meanAmbiguity = 0, flipped = 0; int n = 0; };

Stats Sample(const std::vector<AprilTag>& tags, const RigidPose& robot, int frames, double noise, std::uint64_t seed = 7) {
  CameraParams p = Ideal();
  p.pixelNoisePx = noise;
  p.seed = seed;
  AprilTagCamera cam(p, tags);
  Stats s;
  for (int i = 0; i < frames; ++i) {
    auto out = cam.Update(i * 0.04, robot, {0, 0, 0}, {0, 0, 0});
    for (const auto& f : out) {
      if (!f.hasEstimate) continue;
      s.meanError += f.truthErrorM;
      s.meanAmbiguity += f.ambiguity;
      // Flipped: the reported solution is farther from the truth than the alternate one.
      if (!f.multiTag && vec::Norm(vec::Sub(f.altRobotPose.position, robot.position)) < f.truthErrorM) s.flipped += 1;
      ++s.n;
    }
  }
  if (s.n) { s.meanError /= s.n; s.meanAmbiguity /= s.n; s.flipped /= s.n; }
  return s;
}

void NoiseGrowsWithDistance() {
  // Two coplanar tags 0.7 m apart. Coplanar targets far away barely constrain the camera's orbit
  // about them (tilt changes foreshortening only to second order), so the error grows fast.
  const std::vector<AprilTag> pair{Tag(1, 0, 0.35, 0.5, kPi), Tag(2, 0, -0.35, 0.5, kPi)};
  const Stats nearS = Sample(pair, RobotAt(-1.5, 0, 0), 200, 0.5);
  const Stats farS = Sample(pair, RobotAt(-5.0, 0, 0), 200, 0.5);
  // The same two tags on faces 60 degrees apart (like adjacent reef faces): not coplanar.
  const std::vector<AprilTag> corner{Tag(1, 0, 0.35, 0.5, kPi - 0.5236), Tag(2, 0, -0.35, 0.5, kPi + 0.5236)};
  const Stats cornerS = Sample(corner, RobotAt(-5.0, 0, 0), 200, 0.5);
  std::printf("two tags, 0.5 px noise: mean error %.1f mm at 1.5 m, %.1f mm at 5 m (ratio %.1f); on faces 60 deg apart at 5 m %.1f mm\n",
              nearS.meanError * 1e3, farS.meanError * 1e3, farS.meanError / nearS.meanError, cornerS.meanError * 1e3);
  SIM_CHECK(nearS.n == 200 && farS.n == 200 && cornerS.n == 200, "all frames estimated");
  SIM_CHECK(nearS.meanError < 0.02, "close multi-tag error is centimetres or less: %.4f", nearS.meanError);
  SIM_CHECK(farS.meanError > 4 * nearS.meanError, "error grows faster than distance: %.4f vs %.4f", farS.meanError,
            nearS.meanError);
  SIM_CHECK(cornerS.meanError < 0.5 * farS.meanError, "non-coplanar tags constrain the pose better: %.4f vs %.4f",
            cornerS.meanError, farS.meanError);
}

void SingleTagAmbiguity() {
  // The sign of a single tag's tilt shows only in perspective (its near edge looks longer than
  // its far edge), so viewed nearly frontally the two PnP solutions fit about equally well.
  const std::vector<AprilTag> one{Tag(1, 0, 0, 0.5, kPi)};
  const Stats frontal = Sample(one, RobotAt(-2.5, 0.1, 0), 300, 0.5);
  const Stats oblique = Sample(one, RobotAt(-2.5 * std::cos(0.7), 2.5 * std::sin(0.7), -0.7), 300, 0.5);
  // Far away even an oblique view is ambiguous: the perspective cue is ~0.7 px on a 30 px tag.
  const Stats farOblique = Sample(one, RobotAt(-4.5 * std::cos(0.7), 4.5 * std::sin(0.7), -0.7), 300, 0.5);
  std::printf("single tag, 0.5 px: at 2.5 m frontal ambiguity %.2f (%.0f%% flipped), 40 deg off %.2f (%.0f%%); "
              "4.5 m 40 deg off %.2f (%.0f%%)\n",
              frontal.meanAmbiguity, frontal.flipped * 100, oblique.meanAmbiguity, oblique.flipped * 100,
              farOblique.meanAmbiguity, farOblique.flipped * 100);
  SIM_CHECK(frontal.meanAmbiguity > 0.5, "frontal single tag is ambiguous: %.2f", frontal.meanAmbiguity);
  SIM_CHECK(frontal.flipped > 0.1, "frontal frames often report the mirrored pose: %.3f", frontal.flipped);
  SIM_CHECK(oblique.meanAmbiguity < 0.5 * frontal.meanAmbiguity, "a close oblique view is unambiguous: %.2f",
            oblique.meanAmbiguity);
  SIM_CHECK(oblique.flipped < 0.01, "a close oblique view does not flip: %.3f", oblique.flipped);
  SIM_CHECK(farOblique.flipped > oblique.flipped, "far away it can");
}

void Determinism() {
  auto run = [] {
    CameraParams p;
    p.robotToCamera = {{0.2, 0, 0.5}, vec::FromEuler(0, -0.2, 0)};
    AprilTagCamera cam(p, {Tag(1, 4, 0.5, 0.6, kPi), Tag(2, 4, -0.6, 0.3, kPi)});
    std::vector<double> out;
    for (int k = 0; k < 2000; ++k) {
      const double t = k * kDt;
      const RigidPose robot{{0.5 * t, 0.2 * std::sin(t), 0}, vec::FromEuler(0, 0, 0.3 * std::sin(2 * t))};
      for (const auto& f : cam.Update(t, robot, {0.5, 0.2 * std::cos(t), 0}, {0, 0, 0.6 * std::cos(2 * t)}))
        out.insert(out.end(), {f.publishTime, f.robotPose.position[0], f.robotPose.position[1], f.ambiguity});
    }
    return out;
  };
  const auto a = run(), b = run();
  SIM_CHECK(!a.empty() && a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0,
            "identical camera runs give bit-identical frames");
}

void Signals() {
  SampledSignal<double> s(0.01, 0.005);
  double seenAt20 = -1, stampAt20 = -1;
  for (int k = 0; k <= 30; ++k) {
    const double t = k * kDt;
    s.Update(t, t);  // the true value is the time itself
    if (k == 20) { seenAt20 = s.Value(); stampAt20 = s.Timestamp(); }
  }
  // At t = 20 ms: samples at 0, 10, 20 ms; the 20 ms one arrives at 25 ms, so 10 ms is visible.
  SIM_NEAR(seenAt20, 0.010, 1e-12, "100 Hz with 5 ms latency: value at 20 ms is the 10 ms sample");
  SIM_NEAR(stampAt20, 0.010, 1e-12, "timestamp is the capture time");
}

void Gyro() {
  // 1% scale error over ten turns, plus 0.001 rad/s bias over the same 20 s.
  GyroParams p;
  p.scaleError = 0.01;
  p.biasRadPerS = 0.001;
  p.updatePeriodS = 0;
  GyroModel g(p);
  const double w = 10 * 2 * kPi / 20.0;
  for (int k = 0; k <= 20000; ++k) {
    const double t = k * kDt;
    g.Step(t, kDt, w * t, {0, 0, w});
  }
  const double expected = 1.01 * 10 * 2 * kPi + 0.001 * 20;
  std::printf("gyro: ten turns read %.4f rad (true %.4f, expected %.4f)\n", g.Yaw(), 10 * 2 * kPi, expected);
  SIM_NEAR(g.Yaw(), expected, 1e-3, "scale error and bias accumulate");

  GyroParams sat;
  sat.updatePeriodS = 0;
  GyroModel s(sat);
  for (int k = 0; k <= 1000; ++k) s.Step(k * kDt, kDt, 40.0 * k * kDt, {0, 0, 40});
  SIM_NEAR(s.Yaw(), 34.9, 0.05, "spinning past 2000 deg/s under-reports");
  SIM_NEAR(s.Rates()[2], 34.9, 1e-9, "the rate saturates");

  GyroParams rw;
  rw.biasRandomWalk = 0.0005;
  rw.yawNoiseRad = 0.001;
  GyroModel a(rw), b(rw);
  for (int k = 0; k <= 5000; ++k) { a.Step(k * kDt, kDt, 0, {0, 0, 0}); b.Step(k * kDt, kDt, 0, {0, 0, 0}); }
  std::printf("gyro still for 5 s with bias instability: %.5f rad\n", a.Yaw());
  SIM_CHECK(a.Yaw() == b.Yaw() && a.Yaw() != 0, "random walk is seeded and deterministic");
}

}  // namespace

int main() {
  Projection();
  ExactWithoutNoise();
  DetectionLimits();
  Occlusion();
  MotionBlur();
  LatencyAndRate();
  NoiseGrowsWithDistance();
  SingleTagAmbiguity();
  Determinism();
  Signals();
  Gyro();
  return SimResult("sim_sensors");
}
