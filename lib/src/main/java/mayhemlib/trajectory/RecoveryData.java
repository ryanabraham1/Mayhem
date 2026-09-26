package mayhemlib.trajectory;

import edu.wpi.first.math.geometry.Translation2d;
import java.util.ArrayList;
import java.util.List;
import mayhemlib.geometry.ConvexPolygon;

/** Geometry and limits exported by the app for on-robot bump recovery. */
public final class RecoveryData {
  public final Translation2d[] bumper;
  public final List<ConvexPolygon> obstacles;
  public final double fieldLength;
  public final double fieldWidth;
  public final FieldSymmetry symmetry;
  public final List<Translation2d> roadmapNodes;
  public final List<int[]> roadmapEdges;
  public final double maxVelocity;
  public final double maxAcceleration;
  public final double maxAngularVelocity;
  public final double maxAngularAcceleration;
  public final double[] mustHitTimes;

  public RecoveryData(
      Translation2d[] bumper, List<ConvexPolygon> obstacles, double fieldLength, double fieldWidth,
      FieldSymmetry symmetry, List<Translation2d> roadmapNodes, List<int[]> roadmapEdges,
      double maxVelocity, double maxAcceleration, double maxAngularVelocity,
      double maxAngularAcceleration, double[] mustHitTimes) {
    this.bumper = bumper;
    this.obstacles = obstacles;
    this.fieldLength = fieldLength;
    this.fieldWidth = fieldWidth;
    this.symmetry = symmetry;
    this.roadmapNodes = roadmapNodes;
    this.roadmapEdges = roadmapEdges;
    this.maxVelocity = maxVelocity;
    this.maxAcceleration = maxAcceleration;
    this.maxAngularVelocity = maxAngularVelocity;
    this.maxAngularAcceleration = maxAngularAcceleration;
    this.mustHitTimes = mustHitTimes;
  }

  /** Robot circumscribed radius (from the bumper corners). */
  public double circumradius() {
    double r = 0;
    for (Translation2d c : bumper) {
      r = Math.max(r, c.getNorm());
    }
    return r;
  }

  public RecoveryData flipped() {
    List<ConvexPolygon> obs = new ArrayList<>();
    for (ConvexPolygon p : obstacles) {
      obs.add(p.flipped(symmetry, fieldLength, fieldWidth));
    }
    List<Translation2d> nodes = new ArrayList<>();
    for (Translation2d n : roadmapNodes) {
      nodes.add(new Translation2d(
          symmetry.flipX(n.getX(), fieldLength), symmetry.flipY(n.getY(), fieldWidth)));
    }
    return new RecoveryData(bumper, obs, fieldLength, fieldWidth, symmetry, nodes, roadmapEdges,
        maxVelocity, maxAcceleration, maxAngularVelocity, maxAngularAcceleration, mustHitTimes);
  }

  public RecoveryData withMustHitTimes(double[] times) {
    return new RecoveryData(bumper, obstacles, fieldLength, fieldWidth, symmetry, roadmapNodes,
        roadmapEdges, maxVelocity, maxAcceleration, maxAngularVelocity, maxAngularAcceleration,
        times);
  }
}
