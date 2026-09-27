package mayhemlib.follow;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import mayhemlib.trajectory.TrajectorySample;

/**
 * Feedforward + saturated proportional feedback. The feedback is clamped so that a large error
 * (e.g. after a bump) never produces a lurch beyond what the drivetrain can do.
 */
public final class HolonomicFollower {
  private final FollowerConfig cfg;

  public HolonomicFollower(FollowerConfig cfg) {
    this.cfg = cfg;
  }

  public FollowerConfig config() {
    return cfg;
  }

  /**
   * @param ref reference state
   * @param pose measured pose
   * @param measured measured field-relative speeds (may be null)
   * @param rate trajectory clock rate in [0, 1]; feedforward velocity scales by rate and
   *     acceleration/force by rate^2 (a consistent time reparameterization)
   */
  public DriveCommand calculate(TrajectorySample ref, Pose2d pose, ChassisSpeeds measured, double rate) {
    return calculate(ref, pose, measured, rate, 1.0);
  }

  /**
   * Like {@link #calculate(TrajectorySample, Pose2d, ChassisSpeeds, double)} with the feedback
   * (and its saturation limits) scaled by {@code feedbackScale} in [0, 1], e.g. on rough terrain.
   */
  public DriveCommand calculate(
      TrajectorySample ref, Pose2d pose, ChassisSpeeds measured, double rate, double feedbackScale) {
    double ex = ref.x - pose.getX();
    double ey = ref.y - pose.getY();
    double eth = MathUtil.angleModulus(ref.heading - pose.getRotation().getRadians());

    double fbx = cfg.translationKp * ex;
    double fby = cfg.translationKp * ey;
    if (measured != null && cfg.translationKv != 0) {
      fbx += cfg.translationKv * (ref.vx * rate - measured.vxMetersPerSecond);
      fby += cfg.translationKv * (ref.vy * rate - measured.vyMetersPerSecond);
    }
    double fbn = Math.hypot(fbx, fby);
    if (fbn > cfg.maxFeedbackVelocity) {
      fbx *= cfg.maxFeedbackVelocity / fbn;
      fby *= cfg.maxFeedbackVelocity / fbn;
    }
    double fbw = MathUtil.clamp(cfg.rotationKp * eth, -cfg.maxFeedbackOmega, cfg.maxFeedbackOmega);
    fbx *= feedbackScale;
    fby *= feedbackScale;
    fbw *= feedbackScale;

    double vx = ref.vx * rate + fbx;
    double vy = ref.vy * rate + fby;
    double n = Math.hypot(vx, vy);
    if (n > cfg.maxVelocity) {
      vx *= cfg.maxVelocity / n;
      vy *= cfg.maxVelocity / n;
    }
    double w = MathUtil.clamp(ref.omega * rate + fbw, -cfg.maxOmega, cfg.maxOmega);

    double[] fx = new double[cfg.modules];
    double[] fy = new double[cfg.modules];
    if (cfg.useForceFeedforward && ref.fx.length == cfg.modules) {
      double r2 = rate * rate;
      for (int i = 0; i < cfg.modules; i++) {
        fx[i] = ref.fx[i] * r2;
        fy[i] = ref.fy[i] * r2;
      }
    }
    return new DriveCommand(new ChassisSpeeds(vx, vy, w), fx, fy);
  }

  /** Translational distance between reference and pose. */
  public static double positionError(TrajectorySample ref, Pose2d pose) {
    return Math.hypot(ref.x - pose.getX(), ref.y - pose.getY());
  }

  /** Absolute heading error in radians. */
  public static double headingError(TrajectorySample ref, Pose2d pose) {
    return Math.abs(MathUtil.angleModulus(ref.heading - pose.getRotation().getRadians()));
  }
}
