package mayhemlib.recovery;

import edu.wpi.first.math.MathUtil;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.PriorityQueue;
import mayhemlib.geometry.ConvexPolygon;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectorySample;

/**
 * Plans a fast "bridge" from the robot's current state back onto the trajectory.
 *
 * <p>For each candidate join time t_j (bounded by the next must-hit point), it builds the fastest
 * quintic from the current state to the trajectory state at t_j that respects the exported
 * velocity/acceleration limits, then checks the swept bumper footprint against the field
 * obstacles. The winner minimizes arrival time at the end of the trajectory,
 * {@code bridgeDuration + (T - t_j)}. If every direct bridge is blocked, it routes through the
 * precomputed roadmap. Pure Java, allocation-light, typically well under a millisecond.
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

    Bridge best = null;
    double bestCost = Double.POSITIVE_INFINITY;
    int tried = 0;
    List<Double> joins = new ArrayList<>();
    for (int i = 0; i < n; i++) {
      joins.add(lo + (hi - lo) * i / (n - 1));
    }
    // 1) fastest dynamically-feasible bridge per join time (cheap), 2) collision-check best-first
    List<Bridge> ranked = new ArrayList<>();
    for (double tj : joins) {
      tried++;
      TrajectorySample target = traj.sampleAt(tj);
      double th0 = target.heading - MathUtil.angleModulus(target.heading - th0Raw);
      State start = new State(pose.getX(), pose.getY(), th0, vx0, vy0, w0, 0, 0, 0);
      Bridge.Segment seg = fastestSegment(start, State.of(target), lim);
      if (seg != null) {
        ranked.add(new Bridge(List.of(seg), tj, false));
      }
    }
    ranked.sort((p, q) -> Double.compare(p.duration() - p.joinTime, q.duration() - q.joinTime));
    for (Bridge b : ranked) {
      if (collisionFree(b, rec)) {
        best = b;
        bestCost = b.duration() - b.joinTime;
        break;
      }
    }

    // Brake first: if the robot is moving toward trouble, a single quintic overshoots. Decelerate
    // to rest at the acceleration limit, then bridge from there.
    Bridge.Segment brake = null;
    State afterBrake = null;
    if (best == null && Math.hypot(vx0, vy0) + Math.abs(w0) * rec.circumradius() > 0.15) {
      State s0 = new State(pose.getX(), pose.getY(), th0Raw, vx0, vy0, w0, 0, 0, 0);
      brake = brakeSegment(s0, lim);
      afterBrake = new State(brake.x.p(brake.duration), brake.y.p(brake.duration),
          brake.heading.p(brake.duration), 0, 0, 0, 0, 0, 0);
      Bridge brakeOnly = new Bridge(List.of(brake), tNow, false);
      if (collisionFree(brakeOnly, rec)) {
        List<Bridge> ranked2 = new ArrayList<>();
        for (double tj : joins) {
          tried++;
          TrajectorySample target = traj.sampleAt(tj);
          double th1 = target.heading - MathUtil.angleModulus(target.heading - afterBrake.th);
          State st = new State(afterBrake.x, afterBrake.y, th1, 0, 0, 0, 0, 0, 0);
          Bridge.Segment seg = fastestSegment(st, State.of(target), lim);
          if (seg != null) {
            // keep heading continuous across the two pieces
            Bridge.Segment b0 = rebaseHeading(brake, th1 - afterBrake.th);
            ranked2.add(new Bridge(List.of(b0, seg), tj, false));
          }
        }
        ranked2.sort((p, q) -> Double.compare(p.duration() - p.joinTime, q.duration() - q.joinTime));
        for (Bridge b : ranked2) {
          if (collisionFree(b, rec)) {
            best = b;
            bestCost = b.duration() - b.joinTime;
            break;
          }
        }
      } else {
        brake = null;
        afterBrake = null;
      }
    }

    if (best == null && !rec.roadmapNodes.isEmpty()) {
      // route around obstacles through the roadmap; try far join times first (fewer detours)
      for (int i = joins.size() - 1; i >= 0; i -= Math.max(1, joins.size() / 4)) {
        double tj = joins.get(i);
        tried++;
        TrajectorySample target = traj.sampleAt(tj);
        double th0 = target.heading - MathUtil.angleModulus(target.heading - th0Raw);
        Bridge b;
        if (afterBrake != null) {
          double th1 = target.heading - MathUtil.angleModulus(target.heading - afterBrake.th);
          State st = new State(afterBrake.x, afterBrake.y, th1, 0, 0, 0, 0, 0, 0);
          Bridge rest = routedBridge(st, State.of(target), tj, rec, lim);
          if (rest == null) {
            continue;
          }
          List<Bridge.Segment> segs = new ArrayList<>();
          segs.add(rebaseHeading(brake, th1 - afterBrake.th));
          segs.addAll(rest.segments());
          b = new Bridge(segs, tj, true);
        } else {
          State start = new State(pose.getX(), pose.getY(), th0, vx0, vy0, w0, 0, 0, 0);
          b = routedBridge(start, State.of(target), tj, rec, lim);
        }
        if (b != null && b.duration() - tj < bestCost && collisionFree(b, rec)) {
          best = b;
          bestCost = b.duration() - tj;
        }
      }
    }
    double secs = (System.nanoTime() - t0) * 1e-9;
    return new Result(Optional.ofNullable(best), tried, secs);
  }

  // ---------------------------------------------------------------------------------------------

  /** Constant deceleration to rest along the current velocity (and angular velocity). */
  static Bridge.Segment brakeSegment(State s, Limits lim) {
    double v = Math.hypot(s.vx, s.vy);
    // Exported limits are 70% of the robot's real capability; emergency braking may use ~90%.
    double a = 1.3 * lim.a;
    double al = 1.3 * lim.al;
    double tb = Math.max(Math.max(v / a, Math.abs(s.w) / al), 0.02);
    double ax = -s.vx / tb;
    double ay = -s.vy / tb;
    double aw = -s.w / tb;
    return new Bridge.Segment(
        new Quintic(s.x, s.vx, ax, s.x + s.vx * tb / 2, 0, ax, tb),
        new Quintic(s.y, s.vy, ay, s.y + s.vy * tb / 2, 0, ay, tb),
        new Quintic(s.th, s.w, aw, s.th + s.w * tb / 2, 0, aw, tb));
  }

  /** Same segment with its heading shifted by a multiple of 2*pi (keeps headings continuous). */
  static Bridge.Segment rebaseHeading(Bridge.Segment seg, double shift) {
    if (Math.abs(shift) < 1e-12) {
      return seg;
    }
    double T = seg.duration;
    Quintic h = seg.heading;
    return new Bridge.Segment(seg.x, seg.y,
        new Quintic(h.p(0) + shift, h.v(0), h.a(0), h.p(T) + shift, h.v(T), h.a(T), T));
  }

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

  /** Swept footprint check. Collisions while the robot is still overlapping at the start are ignored. */
  boolean collisionFree(Bridge b, RecoveryData rec) {
    return isCollisionFree(b, rec, cfg.collisionCheckStep);
  }

  /**
   * Swept bumper check of a bridge against the field (public for refiners), using conservative
   * advancement: from each pose, step forward by (clearance / fastest bumper-point speed), which can
   * never skip over an obstacle, and do an exact SAT test only when clearance is nearly zero.
   * Contact while the robot is still overlapping at the very start (it was shoved into something)
   * is ignored until it first gets clear.
   */
  public static boolean isCollisionFree(Bridge b, RecoveryData rec, double maxStep) {
    double T = b.duration();
    double r = rec.circumradius();
    double vBound = 0.1;
    for (int i = 0; i <= 32; i++) {
      TrajectorySample s = b.sampleAt(T * i / 32);
      vBound = Math.max(vBound, Math.hypot(s.vx, s.vy) + Math.abs(s.omega) * r);
    }
    vBound *= 1.25; // margin for between-sample peaks
    double minStep = 0.002;
    boolean startClear = false;
    double tau = 0;
    while (true) {
      TrajectorySample s = b.sampleAt(tau);
      double clearance = centerClearance(rec, s.x, s.y) - r;
      boolean hit = clearance < 0.01 && hits(rec, s.x, s.y, s.heading);
      if (!hit) {
        startClear = true;
      } else if (startClear || tau > 0.5) {
        return false;
      }
      if (tau >= T) {
        return true;
      }
      double step = clearance > 0.01 ? clearance / vBound : minStep;
      tau = Math.min(T, tau + Math.max(minStep, Math.min(step, Math.max(maxStep, minStep))));
    }
  }

  /** Distance from the robot center to the nearest obstacle or wall. */
  static double centerClearance(RecoveryData rec, double x, double y) {
    double d = Math.min(Math.min(x, rec.fieldLength - x), Math.min(y, rec.fieldWidth - y));
    for (ConvexPolygon o : rec.obstacles) {
      // cheap bound first: distance to the AABB never exceeds the true distance
      double dx = Math.max(Math.max(o.minX() - x, 0), x - o.maxX());
      double dy = Math.max(Math.max(o.minY() - y, 0), y - o.maxY());
      if (Math.hypot(dx, dy) >= d) {
        continue;
      }
      d = Math.min(d, o.distanceTo(x, y));
    }
    return d;
  }

  static boolean hits(RecoveryData rec, double x, double y, double th) {
    ConvexPolygon fp = ConvexPolygon.footprint(rec.bumper, x, y, th);
    if (fp.minX() < 0 || fp.minY() < 0 || fp.maxX() > rec.fieldLength || fp.maxY() > rec.fieldWidth) {
      return true;
    }
    for (ConvexPolygon o : rec.obstacles) {
      if (fp.intersects(o)) {
        return true;
      }
    }
    return false;
  }

  private Bridge routedBridge(State s, State e, double tj, RecoveryData rec, Limits lim) {
    List<Translation2d> nodes = rec.roadmapNodes;
    int N = nodes.size();
    double r = rec.circumradius();
    double[][] adj = new double[N][];
    List<List<Integer>> nbr = new ArrayList<>();
    for (int i = 0; i < N; i++) {
      nbr.add(new ArrayList<>());
    }
    for (int[] ed : rec.roadmapEdges) {
      if (ed[0] < N && ed[1] < N) {
        nbr.get(ed[0]).add(ed[1]);
        nbr.get(ed[1]).add(ed[0]);
      }
    }
    // Dijkstra from start (virtual node N) to goal (virtual node N+1)
    int S = N;
    int G = N + 1;
    double[] dist = new double[N + 2];
    int[] parent = new int[N + 2];
    Arrays.fill(dist, Double.POSITIVE_INFINITY);
    Arrays.fill(parent, -1);
    dist[S] = 0;
    PriorityQueue<double[]> pq = new PriorityQueue<>((p, q) -> Double.compare(p[0], q[0]));
    pq.add(new double[] {0, S});
    boolean[] goalVisible = new boolean[N];
    for (int i = 0; i < N; i++) {
      goalVisible[i] = clear(rec, nodes.get(i).getX(), nodes.get(i).getY(), e.x, e.y, r * 0.9);
    }
    while (!pq.isEmpty()) {
      double[] top = pq.poll();
      int u = (int) top[1];
      if (top[0] > dist[u]) {
        continue;
      }
      if (u == G) {
        break;
      }
      double ux = u == S ? s.x : nodes.get(u).getX();
      double uy = u == S ? s.y : nodes.get(u).getY();
      List<Integer> next = new ArrayList<>();
      if (u == S) {
        for (int i = 0; i < N; i++) {
          if (clear(rec, s.x, s.y, nodes.get(i).getX(), nodes.get(i).getY(), r * 0.7)) {
            next.add(i);
          }
        }
      } else {
        next.addAll(nbr.get(u));
        if (goalVisible[u]) {
          next.add(G);
        }
      }
      for (int v : next) {
        double vx = v == G ? e.x : nodes.get(v).getX();
        double vy = v == G ? e.y : nodes.get(v).getY();
        double nd = dist[u] + Math.hypot(vx - ux, vy - uy);
        if (nd < dist[v]) {
          dist[v] = nd;
          parent[v] = u;
          pq.add(new double[] {nd, v});
        }
      }
    }
    if (parent[G] < 0) {
      return null;
    }
    List<double[]> pts = new ArrayList<>();
    for (int v = G; v != -1; v = parent[v]) {
      if (v == G) {
        pts.add(0, new double[] {e.x, e.y});
      } else if (v == S) {
        pts.add(0, new double[] {s.x, s.y});
      } else {
        pts.add(0, new double[] {nodes.get(v).getX(), nodes.get(v).getY()});
      }
    }
    // via-point velocities along the bisector, heading interpolated by arc length
    double total = 0;
    double[] cum = new double[pts.size()];
    for (int i = 1; i < pts.size(); i++) {
      total += Math.hypot(pts.get(i)[0] - pts.get(i - 1)[0], pts.get(i)[1] - pts.get(i - 1)[1]);
      cum[i] = total;
    }
    List<State> states = new ArrayList<>();
    states.add(s);
    double estTime = total / (0.6 * lim.v) + 0.5;
    double wVia = (e.th - s.th) / estTime;
    for (int i = 1; i < pts.size() - 1; i++) {
      double[] p = pts.get(i);
      double[] a = pts.get(i - 1);
      double[] c = pts.get(i + 1);
      double dx = c[0] - a[0];
      double dy = c[1] - a[1];
      double nrm = Math.hypot(dx, dy);
      double la = Math.hypot(p[0] - a[0], p[1] - a[1]);
      double lc = Math.hypot(c[0] - p[0], c[1] - p[1]);
      double speed = Math.min(0.6 * lim.v, Math.sqrt(lim.a * Math.min(la, lc)));
      double u = total > 1e-9 ? cum[i] / total : 0;
      double th = s.th + (e.th - s.th) * u;
      states.add(new State(p[0], p[1], th, speed * dx / nrm, speed * dy / nrm, wVia, 0, 0, 0));
    }
    states.add(e);
    List<Bridge.Segment> segs = new ArrayList<>();
    for (int i = 0; i + 1 < states.size(); i++) {
      Bridge.Segment seg = fastestSegment(states.get(i), states.get(i + 1), lim);
      if (seg == null) {
        return null;
      }
      segs.add(seg);
    }
    return new Bridge(segs, tj, true);
  }

  private static boolean clear(RecoveryData rec, double ax, double ay, double bx, double by, double r) {
    for (ConvexPolygon o : rec.obstacles) {
      if (o.distanceToSegment(ax, ay, bx, by) < r) {
        return false;
      }
    }
    return true;
  }
}
