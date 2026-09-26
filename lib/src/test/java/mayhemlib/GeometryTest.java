package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.math.geometry.Translation2d;
import mayhemlib.geometry.ConvexPolygon;
import mayhemlib.recovery.Quintic;
import org.junit.jupiter.api.Test;

class GeometryTest {
  static ConvexPolygon box(double x0, double y0, double x1, double y1) {
    return new ConvexPolygon(new double[] {x0, x1, x1, x0}, new double[] {y0, y0, y1, y1});
  }

  @Test
  void satDetectsOverlapAndSeparation() {
    ConvexPolygon a = box(0, 0, 1, 1);
    assertTrue(a.intersects(box(0.5, 0.5, 2, 2)));
    assertFalse(a.intersects(box(1.1, 0, 2, 1)));
    // rotated square whose AABB overlaps but shape does not
    Translation2d[] corners = {new Translation2d(0.5, 0.5), new Translation2d(-0.5, 0.5),
        new Translation2d(-0.5, -0.5), new Translation2d(0.5, -0.5)};
    ConvexPolygon diamond = ConvexPolygon.footprint(corners, 1.62, 1.62, Math.PI / 4);
    assertFalse(a.intersects(diamond));
    assertTrue(a.intersects(ConvexPolygon.footprint(corners, 1.3, 1.3, Math.PI / 4)));
  }

  @Test
  void clockwiseInputIsNormalized() {
    ConvexPolygon cw = new ConvexPolygon(new double[] {0, 0, 1, 1}, new double[] {0, 1, 1, 0});
    assertTrue(cw.contains(0.5, 0.5));
    assertEquals(0.5, cw.distanceTo(1.5, 0.5), 1e-12);
    assertEquals(0.0, cw.distanceToSegment(-1, 0.5, 2, 0.5), 1e-12);
  }

  @Test
  void quinticMatchesBoundaryConditions() {
    Quintic q = new Quintic(1, 2, 3, 4, -1, 0.5, 1.7);
    assertEquals(1, q.p(0), 1e-12);
    assertEquals(2, q.v(0), 1e-12);
    assertEquals(3, q.a(0), 1e-12);
    assertEquals(4, q.p(1.7), 1e-9);
    assertEquals(-1, q.v(1.7), 1e-9);
    assertEquals(0.5, q.a(1.7), 1e-9);
  }
}
