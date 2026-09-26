package mayhemlib.trajectory;

/** A named event marker. Zone markers have a finite {@link #endT}. */
public final class TrajectoryEvent {
  /** What to do with this event if bump recovery skips over its time. */
  public enum RecoveryPolicy {
    /** Fire when the robot rejoins the trajectory (default). */
    FIRE_AT_JOIN,
    /** Fire as soon as recovery starts. */
    FIRE_IMMEDIATELY,
    /** Do not fire. */
    SKIP;

    public static RecoveryPolicy fromString(String s) {
      if ("fireImmediately".equals(s)) {
        return FIRE_IMMEDIATELY;
      }
      if ("skip".equals(s)) {
        return SKIP;
      }
      return FIRE_AT_JOIN;
    }
  }

  public final String name;
  public final String command;
  public final double t;
  /** End time for zone markers, or NaN for instant markers. */
  public final double endT;
  public final RecoveryPolicy policy;
  public final boolean mustHit;

  public TrajectoryEvent(
      String name, String command, double t, double endT, RecoveryPolicy policy, boolean mustHit) {
    this.name = name;
    this.command = command == null || command.isEmpty() ? name : command;
    this.t = t;
    this.endT = endT;
    this.policy = policy;
    this.mustHit = mustHit;
  }

  public boolean isZone() {
    return !Double.isNaN(endT);
  }

  public TrajectoryEvent shifted(double dt) {
    return new TrajectoryEvent(name, command, t + dt, isZone() ? endT + dt : endT, policy, mustHit);
  }

  @Override
  public String toString() {
    return "TrajectoryEvent[" + name + " @" + t + (isZone() ? "-" + endT : "") + "]";
  }
}
