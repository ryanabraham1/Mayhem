package mayhemlib.follow;

/** Gains and limits for trajectory following. Defaults suit a typical 60 kg swerve. */
public final class FollowerConfig {
  /** Proportional gain on position error [(m/s)/m]. */
  public double translationKp = 6.0;
  /** Derivative-style gain on velocity error [(m/s)/(m/s)]. */
  public double translationKv = 0.0;
  /** Proportional gain on heading error [(rad/s)/rad]. */
  public double rotationKp = 5.0;
  /** Largest translational feedback correction added on top of feedforward [m/s]. */
  public double maxFeedbackVelocity = 1.5;
  /** Largest rotational feedback correction [rad/s]. */
  public double maxFeedbackOmega = 3.0;
  /** Hard cap on commanded translational speed (feedforward + feedback) [m/s]. */
  public double maxVelocity = 5.0;
  /** Hard cap on commanded angular speed [rad/s]. */
  public double maxOmega = 12.0;
  /** Send per-module force feedforwards from the trajectory. */
  public boolean useForceFeedforward = true;
  /** Number of swerve modules. */
  public int modules = 4;

  public FollowerConfig withTranslationKp(double kp) {
    translationKp = kp;
    return this;
  }

  public FollowerConfig withRotationKp(double kp) {
    rotationKp = kp;
    return this;
  }

  public FollowerConfig withMaxVelocity(double v) {
    maxVelocity = v;
    return this;
  }

  public FollowerConfig withForceFeedforward(boolean enabled) {
    useForceFeedforward = enabled;
    return this;
  }
}
