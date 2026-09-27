package mayhemlib.recovery;

/** Tuning for bump detection and recovery. Distances in meters, angles in radians. */
public final class RecoveryConfig {
  /** Enables hit recovery and ordinary error-based time dilation. Rough-terrain behavior remains active. */
  public boolean enabled = true;

  /** Position error where the trajectory clock starts slowing down. */
  public double dilationStartError = 0.08;
  /** Position error where the trajectory clock fully pauses. */
  public double dilationStopError = 0.40;
  /** Heading error where the clock starts slowing. */
  public double dilationStartHeading = 0.15;
  /** Heading error where the clock fully pauses. */
  public double dilationStopHeading = 0.70;

  /** Position error that triggers a bridge replan (after {@link #persistenceLoops}). */
  public double bridgeTriggerError = 0.45;
  /** Heading error that triggers a bridge replan. */
  public double bridgeTriggerHeading = 0.8;
  /**
   * Horizontal acceleration in excess of the planned acceleration (in g) treated as a collision.
   * NaN accelerometer input disables this check.
   */
  public double accelSpikeG = 1.0;
  /** Loops the error must persist before a bridge is planned. */
  public int persistenceLoops = 3;

  /** Number of candidate join times evaluated per plan. */
  public int joinCandidates = 12;
  /** How far ahead of the current trajectory time a bridge may rejoin [s]. */
  public double maxJoinLookahead = 2.5;
  /** How far behind the current trajectory time a bridge may rejoin [s]. */
  public double maxJoinBehind = 1.0;
  /** While bridging, replan if the robot is this far from the bridge path. */
  public double replanError = 0.5;
  /** Minimum time between two bridge plans [s]. */
  public double minReplanInterval = 0.25;
  /** Scales the conservative limits exported by the app. */
  public double limitScale = 1.0;
  /** How long after a detected hit to report "trust vision more" [s]. */
  public double visionBoostSeconds = 1.0;
  /**
   * On rough terrain the clock tracks the robot's progress along the path: how fast it closes the
   * along-track lag [1/s]. Higher keeps the reference closer to the robot.
   */
  public double terrainClockGain = 10.0;
  /** Hit detection stays off for this long after leaving rough terrain [s] (landing, settling). */
  public double terrainGraceSeconds = 0.3;

  /** Give up waiting for the robot to settle at the end of the trajectory after this long [s]. */
  public double endTimeout = 1.0;
  /** Position tolerance for considering the trajectory finished. */
  public double endTolerance = 0.05;
  /** Heading tolerance for considering the trajectory finished. */
  public double endHeadingTolerance = 0.05;

  public RecoveryConfig disabled() {
    enabled = false;
    return this;
  }
}
