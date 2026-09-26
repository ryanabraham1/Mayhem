package mayhemlib.recovery;

/** 1-D quintic polynomial with position/velocity/acceleration boundary conditions. */
public final class Quintic {
  private final double c0;
  private final double c1;
  private final double c2;
  private final double c3;
  private final double c4;
  private final double c5;
  public final double duration;

  public Quintic(double p0, double v0, double a0, double p1, double v1, double a1, double T) {
    duration = T;
    double T2 = T * T;
    double T3 = T2 * T;
    c0 = p0;
    c1 = v0;
    c2 = 0.5 * a0;
    c3 = (20 * (p1 - p0) - (8 * v1 + 12 * v0) * T - (3 * a0 - a1) * T2) / (2 * T3);
    c4 = (30 * (p0 - p1) + (14 * v1 + 16 * v0) * T + (3 * a0 - 2 * a1) * T2) / (2 * T3 * T);
    c5 = (12 * (p1 - p0) - 6 * (v1 + v0) * T - (a0 - a1) * T2) / (2 * T3 * T2);
  }

  public double p(double t) {
    return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * c5))));
  }

  public double v(double t) {
    return c1 + t * (2 * c2 + t * (3 * c3 + t * (4 * c4 + t * 5 * c5)));
  }

  public double a(double t) {
    return 2 * c2 + t * (6 * c3 + t * (12 * c4 + t * 20 * c5));
  }
}
