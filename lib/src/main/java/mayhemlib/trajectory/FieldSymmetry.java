package mayhemlib.trajectory;

/**
 * How the field is symmetric between alliances. Trajectories are always authored in blue-alliance
 * coordinates (WPILib origin); red-alliance versions are derived by this transform.
 */
public enum FieldSymmetry {
  /** Red side is the blue side rotated 180 degrees about the field center. */
  ROTATIONAL,
  /** Red side is the blue side mirrored across the field's center line (x = length / 2). */
  MIRROR;

  public static FieldSymmetry fromString(String s) {
    return "mirror".equalsIgnoreCase(s) ? MIRROR : ROTATIONAL;
  }

  public double flipX(double x, double length) {
    return length - x;
  }

  public double flipY(double y, double width) {
    return this == ROTATIONAL ? width - y : y;
  }

  public double flipHeading(double heading) {
    return this == ROTATIONAL ? heading + Math.PI : Math.PI - heading;
  }

  /** Flips a field-frame vector (velocity, acceleration, force); returns {x, y}. */
  public double[] flipVector(double x, double y) {
    return this == ROTATIONAL ? new double[] {-x, -y} : new double[] {-x, y};
  }

  /** Flips an angular rate (omega or alpha). */
  public double flipAngular(double w) {
    return this == ROTATIONAL ? w : -w;
  }
}
