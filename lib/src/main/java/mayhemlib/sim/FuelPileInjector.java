package mayhemlib.sim;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A simulated pile of fuel for testing auto unbeach at a desk. The first time the robot drives into
 * the pile it gets beached: the pose is held in place (the wheels spin) except for motion downhill,
 * which is back the way the robot came, and the simulated IMU reads the matching pitch and roll.
 * Once the robot has backed off by {@code releaseDistance} the pile is gone and the tilt returns to
 * zero.
 *
 * <pre>{@code
 * if (RobotBase.isSimulation()) {
 *   FuelPileInjector pile = new FuelPileInjector(
 *       () -> drivetrain.getState().Pose, drivetrain::resetPose,
 *       (pitch, roll) -> drivetrain.getPigeon2().getSimState()
 *           .setPitch(Degrees.of(pitch)).setRoll(Degrees.of(roll)),
 *       new Translation2d(9.0, 6.25), 0.3, 12);
 *   pile.command().schedule();
 * }
 * }</pre>
 *
 * The tilt callback receives CTRE Pigeon 2 pitch and roll in degrees (positive pitch nose down,
 * positive roll left side up).
 */
public final class FuelPileInjector {
  private enum Phase {
    ARMED,
    BEACHED,
    CLEARED
  }

  private final Supplier<Pose2d> pose;
  private final Consumer<Pose2d> resetPose;
  private final BiConsumer<Double, Double> setTilt;
  private final Translation2d center;
  private final double radius;
  private final double tiltDegrees;
  private double releaseDistance = 0.5;

  private Phase phase = Phase.ARMED;
  private Translation2d last;
  private Translation2d beachedAt;
  private Translation2d pinned;
  private Translation2d downhill = Translation2d.kZero;
  private int beachCount;

  /**
   * @param pose current robot pose (the simulated estimate)
   * @param resetPose resets the pose estimate, as {@link BumpInjector} does
   * @param setTilt receives pitch and roll in degrees (CTRE Pigeon 2 convention)
   * @param center pile center, in the blue-origin field frame
   * @param radius the robot gets beached when its center is this close to the center [m]
   * @param tiltDegrees tilt of the robot while beached
   */
  public FuelPileInjector(Supplier<Pose2d> pose, Consumer<Pose2d> resetPose,
      BiConsumer<Double, Double> setTilt, Translation2d center, double radius, double tiltDegrees) {
    this.pose = pose;
    this.resetPose = resetPose;
    this.setTilt = setTilt;
    this.center = center;
    this.radius = radius;
    this.tiltDegrees = tiltDegrees;
  }

  /** How far the robot has to back off before it is free [m]. Default 0.5. */
  public FuelPileInjector withReleaseDistance(double meters) {
    releaseDistance = meters;
    return this;
  }

  /** Runs {@link #update()} every loop, including while disabled, until cancelled. */
  public Command command() {
    return Commands.run(this::update).ignoringDisable(true).withName("FuelPileInjector");
  }

  /** Call once per loop. */
  public void update() {
    Pose2d p = pose.get();
    Translation2d here = p.getTranslation();
    switch (phase) {
      case ARMED:
        if (here.getDistance(center) <= radius) {
          Translation2d travel = last == null ? Translation2d.kZero : here.minus(last);
          if (travel.getNorm() > 1e-6) {
            downhill = travel.div(-travel.getNorm());
          } else if (here.getDistance(center) > 1e-6) {
            downhill = here.minus(center).div(here.getDistance(center));
          } else {
            downhill = new Translation2d(-1, 0).rotateBy(p.getRotation());
          }
          beachedAt = here;
          pinned = here;
          phase = Phase.BEACHED;
          beachCount++;
        }
        break;
      case BEACHED:
        double along = dot(here.minus(pinned), downhill);
        pinned = pinned.plus(downhill.times(Math.max(0, along)));
        if (dot(pinned.minus(beachedAt), downhill) >= releaseDistance) {
          phase = Phase.CLEARED;
          setTilt.accept(0.0, 0.0);
        } else {
          resetPose.accept(new Pose2d(pinned, p.getRotation()));
          Translation2d d = downhill.rotateBy(p.getRotation().unaryMinus());
          setTilt.accept(tiltDegrees * d.getX(), -tiltDegrees * d.getY());
        }
        break;
      case CLEARED:
      default:
        break;
    }
    last = here;
  }

  private static double dot(Translation2d a, Translation2d b) {
    return a.getX() * b.getX() + a.getY() * b.getY();
  }

  /** Re-arms the pile (and clears the tilt), for repeated tests. */
  public void reset() {
    phase = Phase.ARMED;
    last = null;
    setTilt.accept(0.0, 0.0);
  }

  public boolean isBeached() {
    return phase == Phase.BEACHED;
  }

  /** Number of times the robot has been beached on this pile. */
  public int beachCount() {
    return beachCount;
  }
}
