package mayhemlib.recovery;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import java.util.ArrayList;
import java.util.List;
import mayhemlib.trajectory.TrajectorySample;

/**
 * A short recovery path from the robot's current state onto the trajectory. Made of one or more
 * quintic segments in x, y and heading; ends exactly on the trajectory state at {@link #joinTime}.
 */
public final class Bridge {
  /** One piece of a bridge. */
  public static final class Segment {
    public final Quintic x;
    public final Quintic y;
    public final Quintic heading;
    public final double duration;

    public Segment(Quintic x, Quintic y, Quintic heading) {
      this.x = x;
      this.y = y;
      this.heading = heading;
      this.duration = x.duration;
    }
  }

  private final List<Segment> segments;
  private final double duration;
  /** Trajectory time where the bridge ends. */
  public final double joinTime;
  public Bridge(List<Segment> segments, double joinTime) {
    this.segments = List.copyOf(segments);
    double d = 0;
    for (Segment s : segments) {
      d += s.duration;
    }
    this.duration = d;
    this.joinTime = joinTime;
  }

  public double duration() {
    return duration;
  }

  public List<Segment> segments() {
    return segments;
  }

  /** State at time tau since the bridge started (clamped). Forces are not modeled (empty). */
  public TrajectorySample sampleAt(double tau) {
    tau = Math.max(0, Math.min(tau, duration));
    double acc = 0;
    Segment seg = segments.get(segments.size() - 1);
    double local = seg.duration;
    for (Segment s : segments) {
      if (tau <= acc + s.duration) {
        seg = s;
        local = tau - acc;
        break;
      }
      acc += s.duration;
    }
    return new TrajectorySample(
        tau, seg.x.p(local), seg.y.p(local), seg.heading.p(local), seg.x.v(local), seg.y.v(local),
        seg.heading.v(local), seg.x.a(local), seg.y.a(local), seg.heading.a(local), null, null);
  }

  /** Poses along the bridge for telemetry. */
  public Pose2d[] poses(int n) {
    List<Pose2d> out = new ArrayList<>();
    for (int i = 0; i <= n; i++) {
      TrajectorySample s = sampleAt(duration * i / n);
      out.add(new Pose2d(s.x, s.y, new Rotation2d(s.heading)));
    }
    return out.toArray(new Pose2d[0]);
  }
}
