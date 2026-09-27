package mayhemlib.trajectory;

import edu.wpi.first.math.geometry.Pose2d;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A solved Mayhem trajectory (or one split segment of it). Immutable; flipping or taking a segment
 * returns a new instance.
 */
public final class MayhemTrajectory {
  private static final double MUST_HIT_EPS = 1e-3;

  private final String name;
  private final List<TrajectorySample> samples;
  private final List<TrajectoryEvent> events;
  private final List<TerrainSpan> terrain;
  private final int[] splits;
  private final double[] waypointTimes;
  private final RecoveryData recovery;
  private final String inputHash;
  private final boolean flipped;

  public MayhemTrajectory(
      String name, List<TrajectorySample> samples, List<TrajectoryEvent> events, int[] splits,
      double[] waypointTimes, RecoveryData recovery, String inputHash, boolean flipped) {
    this(name, samples, events, List.of(), splits, waypointTimes, recovery, inputHash, flipped);
  }

  public MayhemTrajectory(
      String name, List<TrajectorySample> samples, List<TrajectoryEvent> events,
      List<TerrainSpan> terrain, int[] splits, double[] waypointTimes, RecoveryData recovery,
      String inputHash, boolean flipped) {
    if (samples.isEmpty()) {
      throw new IllegalArgumentException("Trajectory '" + name + "' has no samples");
    }
    this.name = name;
    this.samples = Collections.unmodifiableList(new ArrayList<>(samples));
    this.events = Collections.unmodifiableList(new ArrayList<>(events));
    this.terrain = Collections.unmodifiableList(new ArrayList<>(terrain));
    this.splits = splits.clone();
    this.waypointTimes = waypointTimes.clone();
    this.recovery = recovery;
    this.inputHash = inputHash;
    this.flipped = flipped;
  }

  public String name() {
    return name;
  }

  public List<TrajectorySample> samples() {
    return samples;
  }

  public List<TrajectoryEvent> events() {
    return events;
  }

  /** Rough-terrain spans, sorted by start time (possibly overlapping). */
  public List<TerrainSpan> terrain() {
    return terrain;
  }

  /**
   * The rough-terrain span covering time t, or null. Where spans overlap, the one with the
   * weakest feedback wins.
   */
  public TerrainSpan terrainAt(double t) {
    TerrainSpan best = null;
    for (TerrainSpan s : terrain) {
      if (s.t > t) {
        break;
      }
      if (s.contains(t) && (best == null || s.feedbackScale < best.feedbackScale)) {
        best = s;
      }
    }
    return best;
  }

  public RecoveryData recovery() {
    return recovery;
  }

  public String inputHash() {
    return inputHash;
  }

  public boolean isFlipped() {
    return flipped;
  }

  public double[] waypointTimes() {
    return waypointTimes.clone();
  }

  public double totalTime() {
    return samples.get(samples.size() - 1).t;
  }

  public TrajectorySample initialSample() {
    return samples.get(0);
  }

  public TrajectorySample finalSample() {
    return samples.get(samples.size() - 1);
  }

  public Pose2d initialPose() {
    return initialSample().getPose();
  }

  public Pose2d finalPose() {
    return finalSample().getPose();
  }

  /** Interpolated state at time t (clamped to the trajectory's time range). */
  public TrajectorySample sampleAt(double t) {
    TrajectorySample first = samples.get(0);
    TrajectorySample last = samples.get(samples.size() - 1);
    if (t <= first.t) {
      return first.withTime(t);
    }
    if (t >= last.t) {
      // hold the final pose, at rest if the trajectory ends stopped
      return last.withTime(t);
    }
    int lo = 0;
    int hi = samples.size() - 1;
    while (hi - lo > 1) {
      int mid = (lo + hi) >>> 1;
      if (samples.get(mid).t <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return TrajectorySample.integrate(samples.get(lo), samples.get(hi), t);
  }

  /** Number of split segments (1 if the trajectory has no split points). */
  public int segmentCount() {
    return splits.length + 1;
  }

  /**
   * Split segment {@code i} as its own trajectory with time starting at 0. Events inside the
   * segment are kept (shifted); must-hit times are rebased.
   */
  public MayhemTrajectory segment(int i) {
    if (i < 0 || i >= segmentCount()) {
      throw new IndexOutOfBoundsException("Segment " + i + " of " + segmentCount());
    }
    if (splits.length == 0) {
      return this;
    }
    int start = i == 0 ? 0 : splits[i - 1];
    int end = i == splits.length ? samples.size() - 1 : splits[i];
    double t0 = samples.get(start).t;
    double t1 = samples.get(end).t;
    List<TrajectorySample> sub = new ArrayList<>();
    for (int k = start; k <= end; k++) {
      TrajectorySample s = samples.get(k);
      sub.add(s.withTime(s.t - t0));
    }
    List<TrajectoryEvent> ev = new ArrayList<>();
    boolean last = i == splits.length;
    for (TrajectoryEvent e : events) {
      if (e.t >= t0 - 1e-9 && (e.t < t1 - 1e-9 || (last && e.t <= t1 + 1e-9))) {
        TrajectoryEvent s = e.shifted(-t0);
        if (s.isZone() && s.endT > t1 - t0) {
          s = new TrajectoryEvent(s.name, s.command, s.t, t1 - t0, s.policy, s.mustHit);
        }
        ev.add(s);
      }
    }
    List<TerrainSpan> ter = new ArrayList<>();
    for (TerrainSpan s : terrain) {
      double a = Math.max(s.t, t0);
      double b = Math.min(s.endT, t1);
      if (b > a) {
        ter.add(new TerrainSpan(a - t0, b - t0, s.expectedSpeed, s.feedbackScale));
      }
    }
    List<Double> wt = new ArrayList<>();
    for (double w : waypointTimes) {
      if (w >= t0 - 1e-9 && w <= t1 + 1e-9) {
        wt.add(w - t0);
      }
    }
    RecoveryData rec = recovery;
    if (rec != null) {
      // Must-hit times are exported rounded (0.1 ms), so a must-hit at a split point can land a hair
      // after it; treat anything within MUST_HIT_EPS of a boundary as the boundary itself.
      List<Double> mh = new ArrayList<>();
      for (double m : rec.mustHitTimes) {
        if (m > t0 + MUST_HIT_EPS && m < t1 - MUST_HIT_EPS) {
          mh.add(m - t0);
        }
      }
      mh.add(t1 - t0);
      rec = rec.withMustHitTimes(mh.stream().mapToDouble(Double::doubleValue).distinct().sorted().toArray());
    }
    return new MayhemTrajectory(name + "[" + i + "]", sub, ev, ter, new int[0],
        wt.stream().mapToDouble(Double::doubleValue).toArray(), rec, inputHash, flipped);
  }

  /** The red-alliance version of this trajectory (uses the field's symmetry). */
  public MayhemTrajectory flipped() {
    if (recovery == null) {
      throw new IllegalStateException("Trajectory has no field data to flip with");
    }
    FieldSymmetry sym = recovery.symmetry;
    List<TrajectorySample> fs = new ArrayList<>(samples.size());
    for (TrajectorySample s : samples) {
      fs.add(s.flipped(sym, recovery.fieldLength, recovery.fieldWidth));
    }
    return new MayhemTrajectory(name, fs, events, terrain, splits, waypointTimes, recovery.flipped(),
        inputHash, !flipped);
  }
}
