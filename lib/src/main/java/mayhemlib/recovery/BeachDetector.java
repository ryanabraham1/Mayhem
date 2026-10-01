package mayhemlib.recovery;

import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;

/**
 * Decides when the robot is beached (sitting tilted on fuel) from IMU pitch and roll, and which way
 * is downhill.
 *
 * <p>Angles follow the CTRE Pigeon 2 convention (X forward, Y left, Z up, right-hand rule): positive
 * pitch is nose down, positive roll is left side up.
 */
public final class BeachDetector {
  private final UnbeachConfig cfg;
  private boolean beached;
  private double tiltSince = Double.NaN;
  private double flatSince = Double.NaN;
  private double tilt = Double.NaN;

  public BeachDetector(UnbeachConfig cfg) {
    this.cfg = cfg;
  }

  public void reset() {
    beached = false;
    tiltSince = Double.NaN;
    flatSince = Double.NaN;
  }

  /** Angle between the robot's up axis and vertical [deg]; NaN if either angle is NaN. */
  public static double tiltDegrees(double pitchDeg, double rollDeg) {
    double p = Math.toRadians(pitchDeg);
    double r = Math.toRadians(rollDeg);
    double c = Math.max(-1, Math.min(1, Math.cos(p) * Math.cos(r)));
    return Math.toDegrees(Math.acos(c));
  }

  /**
   * Unit vector in the field frame pointing downhill, which is the way the robot's up axis leans.
   * Zero when the robot is level or the angles are unavailable.
   */
  public static Translation2d downhill(double pitchDeg, double rollDeg, Rotation2d heading) {
    double p = Math.toRadians(pitchDeg);
    double r = Math.toRadians(rollDeg);
    double fwd = Math.sin(p) * Math.cos(r);
    double left = -Math.sin(r);
    double n = Math.hypot(fwd, left);
    if (Double.isNaN(n) || n < 1e-9) {
      return Translation2d.kZero;
    }
    return new Translation2d(fwd / n, left / n).rotateBy(heading);
  }

  /**
   * @return true while the robot counts as beached: tilted past the threshold for
   *     {@code detectSeconds}, and until it has been flat for {@code flatSeconds}
   */
  public boolean update(double now, double pitchDeg, double rollDeg) {
    tilt = tiltDegrees(pitchDeg, rollDeg);
    if (Double.isNaN(tilt)) {
      reset();
      return false;
    }
    if (!beached) {
      if (tilt >= cfg.tiltThresholdDegrees) {
        if (Double.isNaN(tiltSince)) {
          tiltSince = now;
        }
        if (now - tiltSince >= cfg.detectSeconds) {
          beached = true;
          flatSince = Double.NaN;
        }
      } else {
        tiltSince = Double.NaN;
      }
    } else if (tilt <= cfg.flatThresholdDegrees) {
      if (Double.isNaN(flatSince)) {
        flatSince = now;
      }
      if (now - flatSince >= cfg.flatSeconds) {
        reset();
      }
    } else {
      flatSince = Double.NaN;
    }
    return beached;
  }

  public boolean isBeached() {
    return beached;
  }

  /** Tilt from the last {@link #update} [deg], NaN before the first or without a sensor. */
  public double lastTiltDegrees() {
    return tilt;
  }
}
