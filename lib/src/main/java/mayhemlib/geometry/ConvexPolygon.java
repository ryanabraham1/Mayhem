package mayhemlib.geometry;

import edu.wpi.first.math.geometry.Translation2d;
import java.util.List;
import mayhemlib.trajectory.FieldSymmetry;

/** A convex polygon with separating-axis-theorem collision tests. Vertices are CCW. */
public final class ConvexPolygon {
  private final double[] xs;
  private final double[] ys;
  private final double minX;
  private final double maxX;
  private final double minY;
  private final double maxY;

  public ConvexPolygon(double[] xs, double[] ys) {
    if (xs.length != ys.length || xs.length < 3) {
      throw new IllegalArgumentException("A polygon needs at least 3 vertices");
    }
    // enforce CCW
    double area2 = 0;
    for (int i = 0; i < xs.length; i++) {
      int j = (i + 1) % xs.length;
      area2 += xs[i] * ys[j] - xs[j] * ys[i];
    }
    if (area2 < 0) {
      xs = reverse(xs);
      ys = reverse(ys);
    }
    this.xs = xs;
    this.ys = ys;
    double a = Double.POSITIVE_INFINITY;
    double b = Double.NEGATIVE_INFINITY;
    double c = Double.POSITIVE_INFINITY;
    double d = Double.NEGATIVE_INFINITY;
    for (int i = 0; i < xs.length; i++) {
      a = Math.min(a, xs[i]);
      b = Math.max(b, xs[i]);
      c = Math.min(c, ys[i]);
      d = Math.max(d, ys[i]);
    }
    minX = a;
    maxX = b;
    minY = c;
    maxY = d;
  }

  public static ConvexPolygon of(List<Translation2d> pts) {
    double[] x = new double[pts.size()];
    double[] y = new double[pts.size()];
    for (int i = 0; i < pts.size(); i++) {
      x[i] = pts.get(i).getX();
      y[i] = pts.get(i).getY();
    }
    return new ConvexPolygon(x, y);
  }

  /** Robot bumper footprint at a pose; corners are in the robot frame. */
  public static ConvexPolygon footprint(Translation2d[] corners, double x, double y, double theta) {
    double c = Math.cos(theta);
    double s = Math.sin(theta);
    double[] px = new double[corners.length];
    double[] py = new double[corners.length];
    for (int i = 0; i < corners.length; i++) {
      double cx = corners[i].getX();
      double cy = corners[i].getY();
      px[i] = x + c * cx - s * cy;
      py[i] = y + s * cx + c * cy;
    }
    return new ConvexPolygon(px, py);
  }

  public int size() {
    return xs.length;
  }

  public double x(int i) {
    return xs[i];
  }

  public double y(int i) {
    return ys[i];
  }

  public double minX() {
    return minX;
  }

  public double maxX() {
    return maxX;
  }

  public double minY() {
    return minY;
  }

  public double maxY() {
    return maxY;
  }

  /** True if the polygons overlap (touching counts as overlap). */
  public boolean intersects(ConvexPolygon o) {
    if (maxX < o.minX || o.maxX < minX || maxY < o.minY || o.maxY < minY) {
      return false;
    }
    return !separatedAlongEdges(this, o) && !separatedAlongEdges(o, this);
  }

  private static boolean separatedAlongEdges(ConvexPolygon a, ConvexPolygon b) {
    int n = a.xs.length;
    for (int i = 0; i < n; i++) {
      int j = (i + 1) % n;
      // outward normal of CCW edge
      double nx = a.ys[j] - a.ys[i];
      double ny = a.xs[i] - a.xs[j];
      double aMax = Double.NEGATIVE_INFINITY;
      for (int k = 0; k < n; k++) {
        aMax = Math.max(aMax, nx * a.xs[k] + ny * a.ys[k]);
      }
      double bMin = Double.POSITIVE_INFINITY;
      for (int k = 0; k < b.xs.length; k++) {
        bMin = Math.min(bMin, nx * b.xs[k] + ny * b.ys[k]);
      }
      if (bMin > aMax) {
        return true;
      }
    }
    return false;
  }

  public boolean contains(double px, double py) {
    int n = xs.length;
    for (int i = 0; i < n; i++) {
      int j = (i + 1) % n;
      double cross = (xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]);
      if (cross < 0) {
        return false;
      }
    }
    return true;
  }

  /** Distance from a point to this polygon (0 if inside). */
  public double distanceTo(double px, double py) {
    if (contains(px, py)) {
      return 0;
    }
    double best = Double.POSITIVE_INFINITY;
    int n = xs.length;
    for (int i = 0; i < n; i++) {
      int j = (i + 1) % n;
      best = Math.min(best, segmentPointDistance(xs[i], ys[i], xs[j], ys[j], px, py));
    }
    return best;
  }

  /** Minimum distance between segment a-b and this polygon (0 if they touch). */
  public double distanceToSegment(double ax, double ay, double bx, double by) {
    if (contains(ax, ay) || contains(bx, by)) {
      return 0;
    }
    double best = Double.POSITIVE_INFINITY;
    int n = xs.length;
    for (int i = 0; i < n; i++) {
      int j = (i + 1) % n;
      if (segmentsIntersect(ax, ay, bx, by, xs[i], ys[i], xs[j], ys[j])) {
        return 0;
      }
      best = Math.min(best, segmentPointDistance(ax, ay, bx, by, xs[i], ys[i]));
      best = Math.min(best, segmentPointDistance(xs[i], ys[i], xs[j], ys[j], ax, ay));
      best = Math.min(best, segmentPointDistance(xs[i], ys[i], xs[j], ys[j], bx, by));
    }
    return best;
  }

  public ConvexPolygon flipped(FieldSymmetry sym, double length, double width) {
    double[] nx = new double[xs.length];
    double[] ny = new double[ys.length];
    for (int i = 0; i < xs.length; i++) {
      nx[i] = sym.flipX(xs[i], length);
      ny[i] = sym.flipY(ys[i], width);
    }
    return new ConvexPolygon(nx, ny); // constructor restores CCW order after mirroring
  }

  static double segmentPointDistance(
      double ax, double ay, double bx, double by, double px, double py) {
    double dx = bx - ax;
    double dy = by - ay;
    double len2 = dx * dx + dy * dy;
    double u = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(ax + u * dx - px, ay + u * dy - py);
  }

  static boolean segmentsIntersect(
      double ax, double ay, double bx, double by, double cx, double cy, double dx, double dy) {
    double d1 = cross(cx, cy, dx, dy, ax, ay);
    double d2 = cross(cx, cy, dx, dy, bx, by);
    double d3 = cross(ax, ay, bx, by, cx, cy);
    double d4 = cross(ax, ay, bx, by, dx, dy);
    return ((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0));
  }

  private static double cross(double ax, double ay, double bx, double by, double px, double py) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  }

  private static double[] reverse(double[] a) {
    double[] r = new double[a.length];
    for (int i = 0; i < a.length; i++) {
      r[i] = a[a.length - 1 - i];
    }
    return r;
  }
}
