#pragma once
// mayhem::sim AprilTag adapter (C++20, WPILib 2026): field layouts and camera estimates as WPILib
// types. Separate from wpilib_sim.hpp because it needs WPILib's apriltag library.
//
//   auto layout = frc::AprilTagFieldLayout::LoadField(frc::AprilTagField::k2025ReefscapeWelded);
//   mayhem::sim::AprilTagCamera cam(params, mayhem::sim::ToAprilTags(layout));
//   for (const auto& f : cam.Update(now, swerve, &obstacles))
//     if (f.hasEstimate) estimator.AddVisionMeasurement(mayhem::sim::ToPose3d(f.robotPose).ToPose2d(),
//                                                       units::second_t{f.captureTime});
#include "mayhem/sim/camera.hpp"
#include "mayhem/sim/wpilib_sim.hpp"

#include <frc/apriltag/AprilTagFieldLayout.h>
#include <frc/geometry/Pose3d.h>
#include <frc/geometry/Quaternion.h>
#include <frc/geometry/Transform3d.h>

#include <vector>

namespace mayhem::sim {

inline frc::Pose3d ToPose3d(const RigidPose& p) {
  const auto& q = p.orientation;
  return {units::meter_t{p.position[0]}, units::meter_t{p.position[1]}, units::meter_t{p.position[2]},
          frc::Rotation3d{frc::Quaternion{q.w, q.x, q.y, q.z}}};
}
inline RigidPose ToRigidPose(const frc::Pose3d& p) {
  const auto q = p.Rotation().GetQuaternion();
  return {{p.X().value(), p.Y().value(), p.Z().value()}, {q.W(), q.X(), q.Y(), q.Z()}};
}
/** A robot-to-camera Transform3d (as PhotonVision takes it) as a RigidPose. */
inline RigidPose ToRigidPose(const frc::Transform3d& t) {
  const auto q = t.Rotation().GetQuaternion();
  return {{t.X().value(), t.Y().value(), t.Z().value()}, {q.W(), q.X(), q.Y(), q.Z()}};
}
/** The layout's tags, with its origin applied (GetTagPose). */
inline std::vector<AprilTag> ToAprilTags(const frc::AprilTagFieldLayout& layout) {
  std::vector<AprilTag> out;
  for (const auto& t : layout.GetTags())
    if (const auto pose = layout.GetTagPose(t.ID)) out.push_back({t.ID, ToRigidPose(*pose)});
  return out;
}

}  // namespace mayhem::sim
