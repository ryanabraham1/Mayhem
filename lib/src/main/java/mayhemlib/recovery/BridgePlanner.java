package mayhemlib.recovery;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import java.util.List;
import java.util.Optional;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectorySample;

/**
 * Plans a fast "bridge" from the robot's current state back onto the trajectory.
 *
 * <p>For each candidate join time t_j (bounded by the next must-hit point), it builds the fastest
 * quintic from the current state to the trajectory state at t_j that respects the exported
 * velocity/acceleration limits. The winner minimizes arrival time at the end of the trajectory,
 * {@code bridgeDuration + (T - t_j)}. There is no obstacle avoidance: bridges are short and go
 * straight back to the path, which keeps planning cheap on a roboRIO. Pure Java, allocation-light,
 * well under a millisecond.
 */
public final class BridgePlanner {
  private final RecoveryConfig cfg;

  public BridgePlanner(RecoveryConfig cfg) {
    this.cfg = cfg;
  }

  /** Planner result with diagnostics. */
  public static final class Result {
    public final Optional<Bridge> bridge;
    public final int candidatesTried;
    public final double planSeconds;

    Result(Optional<Bridge> bridge, int tried, double secs) {
      this.bridge = bridge;
      this.candidatesTried = tried;
      this.planSeconds = secs;
    }
  }

  private static final class Limits {
    final double v;
    final double a;
    final double w;
    final double al;

    Limits(RecoveryData r, double scale) {
      v = r.maxVelocity * scale;
      a = r.maxAcceleration * scale;
      w = r.maxAngularVelocity * scale;
      al = r.maxAngularAcceleration * scale;
    }
  }

  /** Start/end state for one quintic segment. */
  private static final class State {
    final double x;
    final double y;
    final double th;
    final double vx;
    final double vy;
    final double w;
    final double ax;
    final double ay;
    final double al;

    State(double x, double y, double th, double vx, double vy, double w, double ax, double ay, double al) {
      this.x = x;
      this.y = y;
      this.th = th;
      this.vx = vx;
      this.vy = vy;
      this.w = w;
      this.ax = ax;
      this.ay = ay;
      this.al = al;
    }

    static State of(TrajectorySample s) {
      return new State(s.x, s.y, s.heading, s.vx, s.vy, s.omega, s.ax, s.ay, s.alpha);
    }
  }

  /**
   * @param traj the (alliance-correct) trajectory being followed
   * @param tNow current trajectory clock time
   * @param pose measured pose
   * @param fieldSpeeds measured field-relative speeds
   */
  public Result plan(MayhemTrajectory traj, double tNow, Pose2d pose, ChassisSpeeds fieldSpeeds) {
    long t0 = System.nanoTime();
    RecoveryData rec = traj.recovery();
    if (rec == null) {
      return new Result(Optional.empty(), 0, 0);
    }
    Limits lim = new Limits(rec, cfg.limitScale);
    double T = traj.totalTime();

    // join window bounded by must-hit points
    double prevMust = 0;
    double nextMust = T;
    for (double m : rec.mustHitTimes) {
      if (m <= tNow + 1e-6) {
        prevMust = Math.max(prevMust, m);
      } else {
        nextMust = Math.min(nextMust, m);
      }
    }
    double lo = Math.max(prevMust, tNow - cfg.maxJoinBehind);
    double hi = Math.min(nextMust, Math.min(T, tNow + cfg.maxJoinLookahead));
    if (hi < lo) {
      hi = lo;
    }
    int n = Math.max(2, cfg.joinCandidates);

    double vx0 = fieldSpeeds == null ? 0 : fieldSpeeds.vxMetersPerSecond;
    double vy0 = fieldSpeeds == null ? 0 : fieldSpeeds.vyMetersPerSecond;
    double w0 = fieldSpeeds == null ? 0 : fieldSpeeds.omegaRadiansPerSecond;
    double th0Raw = pose.getRotation().getRadians();

    // fastest dynamically-feasible bridge per join time; keep the earliest arrival at the end
    Bridge best = null;
    double bestCost = Double.POSITIVE_INFINITY;
    int tried = 0;
    for (int i = 0; i < n; i++) {
      double tj = lo + (hi - lo) * i / (n - 1);
      tried++;
      TrajectorySample target = traj.sampleAt(tj);
      double th0 = target.heading - MathUtil.angleModulus(target.heading - th0Raw);
      State start = new State(pose.getX(), pose.getY(), th0, vx0, vy0, w0, 0, 0, 0);
      Bridge.Segment seg = fastestSegment(start, State.of(target), lim);
      if (seg != null && seg.duration - tj < bestCost) {
        best = new Bridge(List.of(seg), tj);
        bestCost = seg.duration - tj;
      }
    }
    double secs = (System.nanoTime() - t0) * 1e-9;
    return new Result(Optional.ofNullable(best), tried, secs);
  }

  // ---------------------------------------------------------------------------------------------

  /** Shortest-duration quintic satisfying the limits, or null. */
  Bridge.Segment fastestSegment(State s, State e, Limits lim) {
    double dist = Math.hypot(e.x - s.x, e.y - s.y);
    double dth = Math.abs(e.th - s.th);
    double tLow = Math.max(0.05, Math.max(dist / lim.v, dth / lim.w));
    // velocities at the ends may legitimately exceed the limit (robot was shoved)
    double vCap = Math.max(lim.v, Math.max(Math.hypot(s.vx, s.vy), Math.hypot(e.vx, e.vy))) * 1.01;
    double wCap = Math.max(lim.w, Math.max(Math.abs(s.w), Math.abs(e.w))) * 1.01;
    double prev = -1;
    double feasibleT = -1;
    double Tk = tLow;
    for (int k = 0; k < 28; k++, Tk *= 1.2) {
      if (feasible(s, e, Tk, lim, vCap, wCap)) {
        feasibleT = Tk;
        break;
      }
      prev = Tk;
      if (Tk > 8) {
        break;
      }
    }
    if (feasibleT < 0) {
      return null;
    }
    if (prev > 0) {
      double a = prev;
      double b = feasibleT;
      for (int i = 0; i < 10; i++) {
        double mid = 0.5 * (a + b);
        if (feasible(s, e, mid, lim, vCap, wCap)) {
          b = mid;
        } else {
          a = mid;
        }
      }
      feasibleT = b;
    }
    return segment(s, e, feasibleT);
  }

  private static Bridge.Segment segment(State s, State e, double T) {
    return new Bridge.Segment(
        new Quintic(s.x, s.vx, s.ax, e.x, e.vx, e.ax, T),
        new Quintic(s.y, s.vy, s.ay, e.y, e.vy, e.ay, T),
        new Quintic(s.th, s.w, s.al, e.th, e.w, e.al, T));
  }

  private static boolean feasible(State s, State e, double T, Limits lim, double vCap, double wCap) {
    Bridge.Segment seg = segment(s, e, T);
    int m = 24;
    double aCap = Math.max(lim.a, Math.max(Math.hypot(s.ax, s.ay), Math.hypot(e.ax, e.ay))) * 1.01;
    double alCap = Math.max(lim.al, Math.max(Math.abs(s.al), Math.abs(e.al))) * 1.01;
    for (int i = 0; i <= m; i++) {
      double t = T * i / m;
      double vx = seg.x.v(t);
      double vy = seg.y.v(t);
      if (vx * vx + vy * vy > vCap * vCap) {
        return false;
      }
      double ax = seg.x.a(t);
      double ay = seg.y.a(t);
      if (ax * ax + ay * ay > aCap * aCap) {
        return false;
      }
      if (Math.abs(seg.heading.v(t)) > wCap || Math.abs(seg.heading.a(t)) > alCap) {
        return false;
      }
      // combined wheel-speed budget: translation + rotation share the same wheels
      if (Math.hypot(vx, vy) / vCap + Math.abs(seg.heading.v(t)) / (wCap * 2) > 1.25) {
        return false;
      }
    }
    return true;
  }
}
