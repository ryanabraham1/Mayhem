package mayhemlib.recovery;

/**
 * Tuning for auto unbeach: detecting that the robot has high-centered on fuel from its IMU tilt and
 * driving off it. Distances in meters, speeds in m/s, tilt in degrees.
 */
public final class UnbeachConfig {
  /** Master switch. Tilt is ignored while false. */
  public boolean enabled = true;

  /** Tilt (angle between the robot's up axis and vertical) at or above which the robot may be beached. */
  public double tiltThresholdDegrees = 8.0;
  /** Tilt must stay above the threshold this long before it counts as beached [s]. */
  public double detectSeconds = 0.2;
  /** Tilt at or below which the robot counts as flat again (hysteresis below the threshold). */
  public double flatThresholdDegrees = 4.0;
  /** Tilt must stay flat this long before the auto resumes [s]. */
  public double flatSeconds = 0.15;

  /** How far from the robot the escape point sits, in the downhill direction. */
  public double escapeDistance = 1.0;
  /** Fastest speed toward the escape point. */
  public double escapeSpeed = 2.0;
  /** Slowest speed toward the escape point, so the robot keeps moving as it closes in. */
  public double minEscapeSpeed = 0.8;
  /** Proportional gain on the distance to the escape point [(m/s)/m]. */
  public double escapeKp = 4.0;
  /** Within this distance of the escape point it counts as reached, and a new one is picked if still tilted. */
  public double reachTolerance = 0.1;
  /** Pick a fresh escape point from the current tilt this often while still beached [s]. */
  public double retargetSeconds = 0.75;
  /** Give up and resume the auto after this long, even if still tilted [s]. */
  public double maxSeconds = 2.5;
  /** After an unbeach ends, wait this long before another can start [s]. */
  public double cooldownSeconds = 0.75;
  /** Keep escape points at least this far inside the field walls (when the path file has field size). */
  public double fieldMargin = 0.4;

  public UnbeachConfig disabled() {
    enabled = false;
    return this;
  }

  public UnbeachConfig withTiltThreshold(double degrees) {
    tiltThresholdDegrees = degrees;
    return this;
  }

  public UnbeachConfig withEscape(double distanceMeters, double speedMetersPerSecond) {
    escapeDistance = distanceMeters;
    escapeSpeed = speedMetersPerSecond;
    return this;
  }
}
