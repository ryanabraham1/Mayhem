package mayhemlib.trajectory;

/**
 * A stretch of the trajectory where the intake is planned to be extended (an "Intake extended"
 * constraint in the app). The solver kept the extended intake clear of obstacles and walls here.
 */
public final class IntakeSpan {
  /** Start time [s]. */
  public final double t;
  /** End time [s]. */
  public final double endT;

  public IntakeSpan(double t, double endT) {
    this.t = t;
    this.endT = endT;
  }

  public boolean contains(double time) {
    return time >= t && time <= endT;
  }

  /** True if this span overlaps [a, b]. */
  public boolean overlaps(double a, double b) {
    return t <= Math.max(a, b) && endT >= Math.min(a, b);
  }

  @Override
  public String toString() {
    return "IntakeSpan[" + t + "-" + endT + "]";
  }
}
