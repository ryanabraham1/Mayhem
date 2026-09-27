package mayhemlib.trajectory;

/**
 * A stretch of the trajectory over rough terrain (e.g. the field bump), drawn in the app as a
 * rough-terrain zone. The plan keeps full speed here; the runner expects the robot to fall behind.
 */
public final class TerrainSpan {
  /** Start time [s]. */
  public final double t;
  /** End time [s]. */
  public final double endT;
  /** Fraction of the planned speed the robot is expected to keep. */
  public final double expectedSpeed;
  /** Feedback strength while on the terrain (1 = normal). */
  public final double feedbackScale;

  public TerrainSpan(double t, double endT, double expectedSpeed, double feedbackScale) {
    this.t = t;
    this.endT = endT;
    this.expectedSpeed = expectedSpeed;
    this.feedbackScale = feedbackScale;
  }

  public boolean contains(double time) {
    return time >= t && time <= endT;
  }

  /** Estimated time lost on this span [s]. */
  public double expectedDelay() {
    return (endT - t) * (1 / Math.max(expectedSpeed, 1e-3) - 1);
  }

  public TerrainSpan shifted(double dt) {
    return new TerrainSpan(t + dt, endT + dt, expectedSpeed, feedbackScale);
  }

  @Override
  public String toString() {
    return "TerrainSpan[" + t + "-" + endT + "]";
  }
}
