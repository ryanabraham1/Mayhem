package mayhemlib.trajectory;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;

/**
 * One state along a trajectory. All vectors are field-frame (blue origin unless flipped). Heading
 * is continuous (unwrapped) so it interpolates correctly; use {@link #getPose()} for a wrapped
 * rotation. Module forces are field-frame newtons in module order (FL, FR, BL, BR).
 */
public final class TrajectorySample {
  public final double t;
  public final double x;
  public final double y;
  public final double heading;
  public final double vx;
  public final double vy;
  public final double omega;
  public final double ax;
  public final double ay;
  public final double alpha;
  public final double[] fx;
  public final double[] fy;

  public TrajectorySample(
      double t, double x, double y, double heading, double vx, double vy, double omega,
      double ax, double ay, double alpha, double[] fx, double[] fy) {
    this.t = t;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.vx = vx;
    this.vy = vy;
    this.omega = omega;
    this.ax = ax;
    this.ay = ay;
    this.alpha = alpha;
    this.fx = fx == null ? new double[0] : fx;
    this.fy = fy == null ? new double[0] : fy;
  }

  public Pose2d getPose() {
    return new Pose2d(x, y, new Rotation2d(heading));
  }

  /** Field-relative chassis speeds. */
  public ChassisSpeeds getFieldSpeeds() {
    return new ChassisSpeeds(vx, vy, omega);
  }

  public double speed() {
    return Math.hypot(vx, vy);
  }

  /** Same state at a different time stamp. */
  public TrajectorySample withTime(double newT) {
    return new TrajectorySample(newT, x, y, heading, vx, vy, omega, ax, ay, alpha, fx, fy);
  }

  public TrajectorySample flipped(FieldSymmetry sym, double length, double width) {
    double[] v = sym.flipVector(vx, vy);
    double[] a = sym.flipVector(ax, ay);
    double[] nfx = new double[fx.length];
    double[] nfy = new double[fy.length];
    for (int i = 0; i < fx.length; i++) {
      double[] f = sym.flipVector(fx[i], fy[i]);
      nfx[i] = f[0];
      nfy[i] = f[1];
    }
    if (sym == FieldSymmetry.MIRROR && fx.length == 4) {
      // Mirroring swaps left and right modules: FL<->FR, BL<->BR.
      nfx = new double[] {nfx[1], nfx[0], nfx[3], nfx[2]};
      nfy = new double[] {nfy[1], nfy[0], nfy[3], nfy[2]};
    }
    return new TrajectorySample(
        t, sym.flipX(x, length), sym.flipY(y, width), sym.flipHeading(heading), v[0], v[1],
        sym.flipAngular(omega), a[0], a[1], sym.flipAngular(alpha), nfx, nfy);
  }

  /**
   * State at time {@code t} inside the interval starting at {@code start}, using the same
   * constant-acceleration model the optimizer used between samples. Forces are linearly
   * interpolated toward {@code end}.
   */
  public static TrajectorySample integrate(TrajectorySample start, TrajectorySample end, double t) {
    double tau = t - start.t;
    double span = end.t - start.t;
    double u = span > 1e-9 ? Math.min(Math.max(tau / span, 0), 1) : 0;
    double[] fx = lerp(start.fx, end.fx, u);
    double[] fy = lerp(start.fy, end.fy, u);
    return new TrajectorySample(
        t,
        start.x + start.vx * tau + 0.5 * start.ax * tau * tau,
        start.y + start.vy * tau + 0.5 * start.ay * tau * tau,
        start.heading + start.omega * tau + 0.5 * start.alpha * tau * tau,
        start.vx + start.ax * tau,
        start.vy + start.ay * tau,
        start.omega + start.alpha * tau,
        start.ax,
        start.ay,
        start.alpha,
        fx,
        fy);
  }

  private static double[] lerp(double[] a, double[] b, double u) {
    int n = Math.min(a.length, b.length);
    double[] out = new double[n];
    for (int i = 0; i < n; i++) {
      out[i] = a[i] + (b[i] - a[i]) * u;
    }
    return out;
  }
}
