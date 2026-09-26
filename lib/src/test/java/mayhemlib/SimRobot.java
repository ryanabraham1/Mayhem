package mayhemlib;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import mayhemlib.follow.DriveCommand;

/** Kinematic robot with first-order velocity response (like a well-tuned velocity loop). */
final class SimRobot {
  double x;
  double y;
  double th;
  double vx;
  double vy;
  double w;
  double tau = 0.06;
  double lastAccelG;

  SimRobot(Pose2d p) {
    x = p.getX();
    y = p.getY();
    th = p.getRotation().getRadians();
  }

  void step(DriveCommand cmd, double dt) {
    double k = Math.min(1, dt / tau);
    double nvx = vx + (cmd.fieldSpeeds.vxMetersPerSecond - vx) * k;
    double nvy = vy + (cmd.fieldSpeeds.vyMetersPerSecond - vy) * k;
    lastAccelG = Math.hypot(nvx - vx, nvy - vy) / dt / 9.81;
    vx = nvx;
    vy = nvy;
    w += (cmd.fieldSpeeds.omegaRadiansPerSecond - w) * k;
    x += vx * dt;
    y += vy * dt;
    th += w * dt;
  }

  void bump(double dx, double dy, double dth) {
    x += dx;
    y += dy;
    th += dth;
    lastAccelG = 3.0;
  }

  Pose2d pose() {
    return new Pose2d(x, y, new Rotation2d(th));
  }

  ChassisSpeeds speeds() {
    return new ChassisSpeeds(vx, vy, w);
  }
}
