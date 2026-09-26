package mayhemlib.sim;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Transform2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.Random;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Simulated collisions for testing recovery at a desk. A bump teleports the simulated robot by a
 * field-frame offset, which is what the vision-fused estimator reports after a real hit.
 *
 * <pre>{@code
 * // bump 0.6 m sideways 1.2 s into the auto (simulation only)
 * if (RobotBase.isSimulation()) {
 *   Commands.waitSeconds(1.2).andThen(BumpInjector.bump(drivetrain::getPose, drivetrain::resetPose,
 *       new Translation2d(0, 0.6), Rotation2d.fromDegrees(20))).schedule();
 * }
 * }</pre>
 */
public final class BumpInjector {
  private BumpInjector() {}

  /** Instantly shifts the pose by a field-frame translation and rotation. */
  public static Command bump(Supplier<Pose2d> pose, Consumer<Pose2d> resetPose,
      Translation2d fieldOffset, Rotation2d rotation) {
    return Commands.runOnce(() -> resetPose.accept(apply(pose.get(), fieldOffset, rotation)))
        .ignoringDisable(true)
        .withName("BumpInjector");
  }

  /** Random bumps every {@code meanInterval} seconds on average, up to {@code maxOffset} meters. */
  public static Command randomBumps(Supplier<Pose2d> pose, Consumer<Pose2d> resetPose,
      double meanInterval, double maxOffset, double maxRotationRad, long seed) {
    Random rng = new Random(seed);
    return Commands.defer(() -> Commands.waitSeconds(-Math.log(1 - rng.nextDouble()) * meanInterval)
            .andThen(Commands.runOnce(() -> {
              double ang = rng.nextDouble() * 2 * Math.PI;
              double mag = maxOffset * (0.3 + 0.7 * rng.nextDouble());
              Translation2d off = new Translation2d(mag * Math.cos(ang), mag * Math.sin(ang));
              Rotation2d rot = new Rotation2d((rng.nextDouble() * 2 - 1) * maxRotationRad);
              resetPose.accept(apply(pose.get(), off, rot));
            })), java.util.Set.of())
        .repeatedly()
        .withName("RandomBumps");
  }

  public static Pose2d apply(Pose2d p, Translation2d fieldOffset, Rotation2d rotation) {
    return new Pose2d(p.getTranslation().plus(fieldOffset), p.getRotation().plus(rotation));
  }

  /** Robot-relative variant (e.g. "hit from the left"). */
  public static Pose2d applyRobotRelative(Pose2d p, Transform2d t) {
    return p.plus(t);
  }
}
