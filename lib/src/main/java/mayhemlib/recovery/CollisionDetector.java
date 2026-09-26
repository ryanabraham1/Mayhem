package mayhemlib.recovery;

/**
 * Decides when the robot has been knocked off its path: either a horizontal accelerometer spike,
 * or tracking error that stays above the bridge thresholds for several loops.
 */
public final class CollisionDetector {
  private final RecoveryConfig cfg;
  private int overCount;
  private double lastHitTime = Double.NEGATIVE_INFINITY;

  public CollisionDetector(RecoveryConfig cfg) {
    this.cfg = cfg;
  }

  public void reset() {
    overCount = 0;
    lastHitTime = Double.NEGATIVE_INFINITY;
  }

  /**
   * @param now timestamp [s]
   * @param posError position tracking error [m]
   * @param headingError absolute heading error [rad]
   * @param accelG measured horizontal acceleration magnitude in g, or NaN if unavailable
   * @param expectedAccelG the reference trajectory's acceleration magnitude in g at this time
   * @return true if recovery should plan a bridge this loop
   */
  public boolean update(double now, double posError, double headingError, double accelG, double expectedAccelG) {
    // A traction-limited swerve can legitimately pull >1 g, so only acceleration beyond what the
    // plan asked for counts as a hit.
    boolean spike = !Double.isNaN(accelG) && accelG - expectedAccelG >= cfg.accelSpikeG;
    if (spike) {
      lastHitTime = now;
    }
    boolean over = posError >= cfg.bridgeTriggerError || headingError >= cfg.bridgeTriggerHeading;
    overCount = over ? overCount + 1 : 0;
    boolean sustained = overCount >= cfg.persistenceLoops;
    if (sustained) {
      lastHitTime = now;
    }
    // a spike alone only matters if it actually pushed us off (some error)
    return sustained || (spike && posError >= cfg.dilationStartError);
  }

  /** True shortly after a detected hit: localization should trust vision more. */
  public boolean visionBoostActive(double now) {
    return now - lastHitTime <= cfg.visionBoostSeconds;
  }
}
