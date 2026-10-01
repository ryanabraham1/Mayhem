package mayhemlib.runner;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import edu.wpi.first.math.geometry.Translation2d;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.follow.HolonomicFollower;
import mayhemlib.recovery.Bridge;
import mayhemlib.recovery.BridgePlanner;
import mayhemlib.recovery.BeachDetector;
import mayhemlib.recovery.BridgeRefiner;
import mayhemlib.recovery.CollisionDetector;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.recovery.UnbeachConfig;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TerrainSpan;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectorySample;

/**
 * Runs one trajectory: feedforward + saturated feedback, time dilation, bump detection and bridge
 * recovery, auto unbeach, rough-terrain handling, and event markers. Framework-free (no WPILib command dependencies) so it is fully unit
 * testable; {@link mayhemlib.auto.AutoFactory} wraps it in commands.
 *
 * <p>Call {@link #start} once, then {@link #update} every loop with the latest vision-fused pose.
 */
public final class TrajectoryRunner {
  /** Runner state. */
  public enum State {
    IDLE,
    FOLLOWING,
    BRIDGING,
    /** Driving off a pile of fuel the robot is stuck on; the trajectory clock is paused. */
    UNBEACHING,
    SETTLING,
    FINISHED
  }

  /** Receives event markers. Zone markers get onEvent at start and onZoneEnd at end. */
  public interface EventListener {
    void onEvent(TrajectoryEvent event);

    default void onZoneEnd(TrajectoryEvent event) {}
  }

  private static final double REFINE_HANDOFF = 0.12;
  private static ExecutorService refineExecutor;

  private final MayhemTrajectory traj;
  private final HolonomicFollower follower;
  private final RecoveryConfig rc;
  private final BridgePlanner planner;
  private final CollisionDetector detector;
  private final EventListener listener;
  private final BridgeRefiner refiner;

  private final List<TrajectoryEvent> events;
  private final boolean[] fired;
  private final boolean[] zoneEnded;
  private final List<Integer> pendingAtJoin = new ArrayList<>();

  private State state = State.IDLE;
  private double t;
  private double lastNow;
  private double rate = 1;
  private double settleStart;
  private Bridge bridge;
  private double bridgeFrom;
  private double tau;
  private double lastPlanTime = Double.NEGATIVE_INFINITY;
  private CompletableFuture<Optional<Bridge>> refineFuture;
  private TrajectorySample reference;
  private double posError;
  private double headingError;
  private int bridgesPlanned;
  private int bridgesRefined;
  private double lastPlanSeconds;
  private double lastNowForBoost = Double.NEGATIVE_INFINITY;
  private TerrainSpan terrain;
  private double terrainExitTime = Double.NEGATIVE_INFINITY;

  private UnbeachConfig unbeachConfig = new UnbeachConfig().disabled();
  private BeachDetector beach = new BeachDetector(unbeachConfig);
  private double pitchDeg = Double.NaN;
  private double rollDeg = Double.NaN;
  private double unbeachStart;
  private double unbeachRetargetAt;
  private double unbeachCooldownUntil = Double.NEGATIVE_INFINITY;
  private Translation2d unbeachTarget;
  private int unbeachCount;

  public TrajectoryRunner(MayhemTrajectory traj, FollowerConfig fc, RecoveryConfig rc,
      EventListener listener, BridgeRefiner refiner) {
    this.traj = traj;
    this.follower = new HolonomicFollower(fc);
    this.rc = rc;
    this.planner = new BridgePlanner(rc);
    this.detector = new CollisionDetector(rc);
    this.listener = listener == null ? e -> {} : listener;
    this.refiner = refiner;
    this.events = traj.events();
    this.fired = new boolean[events.size()];
    this.zoneEnded = new boolean[events.size()];
    this.reference = traj.initialSample();
  }

  public TrajectoryRunner(MayhemTrajectory traj, FollowerConfig fc, RecoveryConfig rc, EventListener listener) {
    this(traj, fc, rc, listener, null);
  }

  /**
   * Turns on auto unbeach: while the IMU reports the robot tilted on a pile of fuel, the runner
   * pauses the trajectory, drives toward a point downhill of the tilt, and resumes once flat.
   * Feed pitch and roll through {@link #update(double, Pose2d, ChassisSpeeds, double, double, double)}.
   */
  public TrajectoryRunner withUnbeach(UnbeachConfig config) {
    unbeachConfig = config == null ? new UnbeachConfig().disabled() : config;
    beach = new BeachDetector(unbeachConfig);
    return this;
  }

  // --------------------------------------------------------------------------- lifecycle

  public void start(double now) {
    state = State.FOLLOWING;
    t = 0;
    lastNow = now;
    rate = 1;
    bridge = null;
    terrain = null;
    terrainExitTime = Double.NEGATIVE_INFINITY;
    detector.reset();
    beach.reset();
    unbeachTarget = null;
    unbeachCooldownUntil = Double.NEGATIVE_INFINITY;
    java.util.Arrays.fill(fired, false);
    java.util.Arrays.fill(zoneEnded, false);
    pendingAtJoin.clear();
    fireCrossing(-1e-9, 0);
  }

  /** Stops the runner early (e.g. command interrupted); closes open zones. */
  public void stop() {
    if (state != State.FINISHED && state != State.IDLE) {
      closeAllZones();
    }
    state = State.FINISHED;
    if (refineFuture != null) {
      refineFuture.cancel(true);
    }
  }

  /**
   * @param now timestamp [s] (e.g. Timer.getFPGATimestamp())
   * @param pose vision-fused robot pose (alliance-correct field frame)
   * @param fieldSpeeds measured field-relative speeds (may be null)
   * @param accelG horizontal acceleration magnitude in g (NaN if not available)
   */
  public DriveCommand update(double now, Pose2d pose, ChassisSpeeds fieldSpeeds, double accelG) {
    return update(now, pose, fieldSpeeds, accelG, Double.NaN, Double.NaN);
  }

  /**
   * Like {@link #update(double, Pose2d, ChassisSpeeds, double)} with the IMU's pitch and roll for
   * auto unbeach, in degrees and the CTRE Pigeon 2 convention (positive pitch is nose down,
   * positive roll is left side up). NaN disables unbeach detection for this loop.
   */
  public DriveCommand update(double now, Pose2d pose, ChassisSpeeds fieldSpeeds, double accelG,
      double pitchDegrees, double rollDegrees) {
    pitchDeg = pitchDegrees;
    rollDeg = rollDegrees;
    double dt = Math.max(0, Math.min(now - lastNow, 0.1));
    lastNow = now;
    lastNowForBoost = now;
    int nMod = follower.config().modules;
    switch (state) {
      case IDLE:
      case FINISHED:
        return DriveCommand.stop(nMod);
      case BRIDGING:
        return updateBridging(now, dt, pose, fieldSpeeds, accelG);
      case UNBEACHING:
        return updateUnbeaching(now, dt, pose, fieldSpeeds, accelG);
      case SETTLING:
        return updateSettling(now, pose, fieldSpeeds, accelG);
      case FOLLOWING:
      default:
        return updateFollowing(now, dt, pose, fieldSpeeds, accelG);
    }
  }

  // --------------------------------------------------------------------------- states

  private DriveCommand updateFollowing(double now, double dt, Pose2d pose, ChassisSpeeds v, double accelG) {
    TrajectorySample ref = traj.sampleAt(t);
    measure(ref, pose);
    TerrainSpan span = traj.terrainAt(t);
    if (span == null && terrain != null) {
      terrainExitTime = now;
    }
    terrain = span;
    if (span != null) {
      beach.reset(); // a marked bump tilts the robot on purpose
      return updateTerrain(dt, span, ref, pose, v);
    }
    boolean grace = now - terrainExitTime <= rc.terrainGraceSeconds;
    if (grace) {
      detector.reset();
      beach.reset();
    } else if (checkBeached(now, pose)) {
      return updateUnbeaching(now, 0, pose, v, accelG);
    } else if (rc.enabled && detector.update(now, posError, headingError, accelG, accelG(ref))
        && tryPlan(now, pose, v)) {
      return updateBridging(now, 0, pose, v, accelG);
    }
    rate = rc.enabled
        ? Math.min(ramp(posError, rc.dilationStartError, rc.dilationStopError),
            ramp(headingError, rc.dilationStartHeading, rc.dilationStopHeading))
        : 1.0;
    double tNew = Math.min(t + rate * dt, traj.totalTime());
    fireCrossing(t, tNew);
    t = tNew;
    reference = traj.sampleAt(t);
    if (t >= traj.totalTime()) {
      state = State.SETTLING;
      settleStart = now;
    }
    return follower.calculate(reference, pose, v, rate);
  }

  /**
   * Rough terrain: the robot is expected to lose speed, so keep commanding the planned (full)
   * velocity, let the clock follow the robot's progress along the path instead of pulling it
   * forward, soften the feedback, and skip hit detection. Time lost here is not made up.
   */
  private DriveCommand updateTerrain(double dt, TerrainSpan span, TrajectorySample ref, Pose2d pose,
      ChassisSpeeds v) {
    detector.reset();
    double speed = ref.speed();
    double lag = 0;
    if (speed > 1e-3) {
      // along-track offset in seconds of path; negative when the robot is behind the reference
      double along = ((pose.getX() - ref.x) * ref.vx + (pose.getY() - ref.y) * ref.vy) / speed;
      lag = along / Math.max(speed, 0.3);
    }
    rate = Math.max(0, Math.min(1, 1 + rc.terrainClockGain * lag));
    double tNew = Math.min(t + rate * dt, traj.totalTime());
    fireCrossing(t, tNew);
    t = tNew;
    reference = traj.sampleAt(t);
    if (t >= traj.totalTime()) {
      state = State.SETTLING;
      settleStart = lastNow;
    }
    return follower.calculate(reference, pose, v, 1.0, span.feedbackScale);
  }

  private DriveCommand updateSettling(double now, Pose2d pose, ChassisSpeeds v, double accelG) {
    TrajectorySample end = traj.finalSample();
    measure(end, pose);
    boolean endsMoving = end.speed() > 0.05 || Math.abs(end.omega) > 0.05;
    if (rc.enabled && !endsMoving && detector.update(now, posError, headingError, accelG, 0.0)
        && tryPlan(now, pose, v)) {
      return updateBridging(now, 0, pose, v, accelG);
    }
    boolean settled = posError <= rc.endTolerance && headingError <= rc.endHeadingTolerance;
    if (endsMoving || settled || now - settleStart >= rc.endTimeout) {
      finish();
    }
    reference = end;
    rate = 1;
    return follower.calculate(end, pose, v, 1.0);
  }

  private DriveCommand updateBridging(double now, double dt, Pose2d pose, ChassisSpeeds v, double accelG) {
    if (checkBeached(now, pose)) {
      // stuck on fuel mid-bridge: a straight bridge cannot help, so drop it and unbeach first
      bridge = null;
      if (refineFuture != null) {
        refineFuture.cancel(true);
        refineFuture = null;
      }
      return updateUnbeaching(now, 0, pose, v, accelG);
    }
    tau += dt;
    // swap in a refined bridge at the hand-off time if it arrived in time
    if (refineFuture != null && refineFuture.isDone() && tau >= REFINE_HANDOFF) {
      Optional<Bridge> refined = refineFuture.getNow(Optional.empty());
      refineFuture = null;
      if (refined.isPresent() && tau - REFINE_HANDOFF < 0.06
          && refined.get().duration() < bridge.duration() - REFINE_HANDOFF - 0.02) {
        bridge = refined.get();
        tau -= REFINE_HANDOFF;
        bridgesRefined++;
      }
    } else if (refineFuture != null && tau > REFINE_HANDOFF + 0.06) {
      refineFuture.cancel(true);
      refineFuture = null;
    }
    TrajectorySample bs = bridge.sampleAt(tau);
    measure(bs, pose);
    detector.update(now, posError, headingError, accelG, accelG(bs));
    if (posError > rc.replanError && now - lastPlanTime >= rc.minReplanInterval) {
      if (tryPlan(now, pose, v)) {
        bs = bridge.sampleAt(0);
        measure(bs, pose);
      }
    }
    reference = bs;
    rate = 1;
    DriveCommand cmd = follower.calculate(bs, pose, v, 1.0);
    if (tau >= bridge.duration()) {
      // rejoined
      double tj = bridge.joinTime;
      bridge = null;
      if (refineFuture != null) {
        refineFuture.cancel(true);
        refineFuture = null;
      }
      for (int i : pendingAtJoin) {
        fire(i);
      }
      pendingAtJoin.clear();
      // close zones whose end we jumped over
      for (int i = 0; i < events.size(); i++) {
        TrajectoryEvent e = events.get(i);
        if (e.isZone() && fired[i] && !zoneEnded[i] && e.endT <= tj) {
          zoneEnded[i] = true;
          listener.onZoneEnd(e);
        }
      }
      t = tj;
      detector.reset();
      if (t >= traj.totalTime()) {
        state = State.SETTLING;
        settleStart = now;
      } else {
        state = State.FOLLOWING;
      }
    }
    return cmd;
  }

  // --------------------------------------------------------------------------- unbeach

  /** Starts an unbeach if the IMU says the robot is beached; the runner is then UNBEACHING. */
  private boolean checkBeached(double now, Pose2d pose) {
    if (!unbeachConfig.enabled || now < unbeachCooldownUntil
        || !beach.update(now, pitchDeg, rollDeg)) {
      return false;
    }
    unbeachCount++;
    unbeachStart = now;
    unbeachTarget = null;
    unbeachRetargetAt = now;
    state = State.UNBEACHING;
    return true;
  }

  /**
   * Drives toward a point on the downhill side of the tilt until the robot is flat again. The
   * trajectory clock is paused; afterwards normal following (and bump recovery, if the robot ended
   * up far from the path) takes over.
   */
  private DriveCommand updateUnbeaching(double now, double dt, Pose2d pose, ChassisSpeeds v, double accelG) {
    measure(reference, pose);
    UnbeachConfig uc = unbeachConfig;
    boolean flat = !beach.update(now, pitchDeg, rollDeg);
    if (flat || now - unbeachStart >= uc.maxSeconds) {
      state = State.FOLLOWING;
      unbeachTarget = null;
      unbeachCooldownUntil = now + uc.cooldownSeconds;
      beach.reset();
      detector.reset();
      rate = 0;
      return follower.calculate(reference, pose, v, 0);
    }
    Translation2d here = pose.getTranslation();
    boolean reached = unbeachTarget != null && here.getDistance(unbeachTarget) <= uc.reachTolerance;
    if (unbeachTarget == null || reached || now >= unbeachRetargetAt) {
      Translation2d dir = BeachDetector.downhill(pitchDeg, rollDeg, pose.getRotation());
      if (dir.getNorm() > 0) {
        unbeachTarget = clampToField(here.plus(dir.times(uc.escapeDistance)));
        unbeachRetargetAt = now + uc.retargetSeconds;
      }
    }
    rate = 0;
    int nMod = follower.config().modules;
    if (unbeachTarget == null) {
      return DriveCommand.stop(nMod);
    }
    Translation2d delta = unbeachTarget.minus(here);
    double dist = delta.getNorm();
    if (dist < 1e-6) {
      return DriveCommand.stop(nMod);
    }
    double speed = Math.max(uc.minEscapeSpeed, Math.min(uc.escapeSpeed, uc.escapeKp * dist));
    // hold heading: only translate off the pile
    return new DriveCommand(
        new ChassisSpeeds(delta.getX() / dist * speed, delta.getY() / dist * speed, 0),
        new double[nMod], new double[nMod]);
  }

  private Translation2d clampToField(Translation2d p) {
    RecoveryData rd = traj.recovery();
    if (rd == null || rd.fieldLength <= 0 || rd.fieldWidth <= 0) {
      return p;
    }
    double m = unbeachConfig.fieldMargin;
    return new Translation2d(
        Math.max(m, Math.min(rd.fieldLength - m, p.getX())),
        Math.max(m, Math.min(rd.fieldWidth - m, p.getY())));
  }

  // --------------------------------------------------------------------------- recovery

  private boolean tryPlan(double now, Pose2d pose, ChassisSpeeds v) {
    if (now - lastPlanTime < rc.minReplanInterval) {
      return false;
    }
    lastPlanTime = now;
    BridgePlanner.Result res = planner.plan(traj, t, pose, v);
    lastPlanSeconds = res.planSeconds;
    if (res.bridge.isEmpty()) {
      return false;
    }
    Bridge b = res.bridge.get();
    bridgesPlanned++;
    // events between the current clock and the join time: apply their recovery policy
    if (b.joinTime > t) {
      for (int i = 0; i < events.size(); i++) {
        TrajectoryEvent e = events.get(i);
        if (fired[i] || pendingAtJoin.contains(i) || e.t <= t || e.t > b.joinTime) {
          continue;
        }
        switch (e.policy) {
          case FIRE_IMMEDIATELY:
            fire(i);
            break;
          case SKIP:
            fired[i] = true;
            zoneEnded[i] = !e.isZone() || e.endT <= b.joinTime;
            break;
          case FIRE_AT_JOIN:
          default:
            pendingAtJoin.add(i);
            break;
        }
      }
    }
    bridge = b;
    bridgeFrom = t;
    tau = 0;
    state = State.BRIDGING;
    startRefine(b);
    return true;
  }

  private void startRefine(Bridge b) {
    if (refiner == null || b.duration() <= REFINE_HANDOFF + 0.1) {
      return;
    }
    if (refineFuture != null) {
      refineFuture.cancel(true);
    }
    TrajectorySample start = b.sampleAt(REFINE_HANDOFF);
    TrajectorySample target = traj.sampleAt(b.joinTime);
    double remaining = b.duration() - REFINE_HANDOFF;
    refineFuture = CompletableFuture.supplyAsync(
        () -> refiner.refine(start, target, b.joinTime, remaining, traj.recovery()), executor());
  }

  private static synchronized ExecutorService executor() {
    if (refineExecutor == null) {
      refineExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread th = new Thread(r, "mayhem-refiner");
        th.setDaemon(true);
        return th;
      });
    }
    return refineExecutor;
  }

  // --------------------------------------------------------------------------- events

  private void fireCrossing(double from, double to) {
    for (int i = 0; i < events.size(); i++) {
      TrajectoryEvent e = events.get(i);
      if (!fired[i] && e.t > from && e.t <= to) {
        fire(i);
      }
      if (e.isZone() && fired[i] && !zoneEnded[i] && e.endT > from && e.endT <= to) {
        zoneEnded[i] = true;
        listener.onZoneEnd(e);
      }
    }
  }

  private void fire(int i) {
    if (fired[i]) {
      return;
    }
    fired[i] = true;
    TrajectoryEvent e = events.get(i);
    listener.onEvent(e);
    if (e.isZone() && e.endT <= e.t) {
      zoneEnded[i] = true;
      listener.onZoneEnd(e);
    }
  }

  private void finish() {
    // anything left at the very end (e.g. markers at T) fires now
    fireCrossing(t - 1e-9, traj.totalTime() + 1e-6);
    for (int i : pendingAtJoin) {
      fire(i);
    }
    pendingAtJoin.clear();
    closeAllZones();
    state = State.FINISHED;
  }

  private void closeAllZones() {
    for (int i = 0; i < events.size(); i++) {
      if (events.get(i).isZone() && fired[i] && !zoneEnded[i]) {
        zoneEnded[i] = true;
        listener.onZoneEnd(events.get(i));
      }
    }
  }

  // --------------------------------------------------------------------------- helpers

  private void measure(TrajectorySample ref, Pose2d pose) {
    posError = HolonomicFollower.positionError(ref, pose);
    headingError = HolonomicFollower.headingError(ref, pose);
  }

  private static double accelG(TrajectorySample s) {
    return Math.hypot(s.ax, s.ay) / 9.81;
  }

  private static double ramp(double err, double start, double stop) {
    if (err <= start) {
      return 1;
    }
    if (err >= stop) {
      return 0;
    }
    return 1 - (err - start) / (stop - start);
  }

  // --------------------------------------------------------------------------- getters

  public State state() {
    return state;
  }

  public boolean isFinished() {
    return state == State.FINISHED;
  }

  public boolean isRecovering() {
    return state == State.BRIDGING;
  }

  public MayhemTrajectory trajectory() {
    return traj;
  }

  /** Current trajectory clock time [s]. */
  public double trajectoryTime() {
    return t;
  }

  /** Current clock rate in [0, 1] (below 1 while waiting for the robot). */
  public double clockRate() {
    return rate;
  }

  /** The state the follower is currently tracking (trajectory or bridge). */
  public TrajectorySample reference() {
    return reference;
  }

  /** True while driving off a pile of fuel; the trajectory clock is paused. */
  public boolean isUnbeaching() {
    return state == State.UNBEACHING;
  }

  /** The point being driven toward while unbeaching. */
  public Optional<Translation2d> unbeachTarget() {
    return state == State.UNBEACHING ? Optional.ofNullable(unbeachTarget) : Optional.empty();
  }

  /** Number of unbeach maneuvers started during the current run. */
  public int unbeachCount() {
    return unbeachCount;
  }

  /** Robot tilt from vertical at the last update that had an IMU reading [deg], NaN without one. */
  public double tiltDegrees() {
    return BeachDetector.tiltDegrees(pitchDeg, rollDeg);
  }

  public Optional<Bridge> bridge() {
    return Optional.ofNullable(bridge);
  }

  public double positionError() {
    return posError;
  }

  public double headingError() {
    return headingError;
  }

  public int bridgesPlanned() {
    return bridgesPlanned;
  }

  public int bridgesRefined() {
    return bridgesRefined;
  }

  public double lastPlanSeconds() {
    return lastPlanSeconds;
  }

  /**
   * True while the plan has the intake extended: at the current clock time while following, and
   * for the whole bridge if the plan has it out anywhere between the hit and the join.
   */
  public boolean intakeExtended() {
    if (state == State.BRIDGING && bridge != null) {
      return traj.intakeExtendedBetween(bridgeFrom, bridge.joinTime);
    }
    return (state == State.FOLLOWING || state == State.SETTLING) && traj.intakeExtendedAt(t);
  }

  /** True while the reference is on a rough-terrain span. */
  public boolean onRoughTerrain() {
    return terrain != null && state == State.FOLLOWING;
  }

  /**
   * True shortly after a detected hit or after leaving rough terrain (odometry drifts on the
   * terrain): raise vision trust in the pose estimator.
   */
  public boolean visionBoostActive() {
    return detector.visionBoostActive(lastNowForBoost)
        || lastNowForBoost - terrainExitTime <= rc.visionBoostSeconds;
  }
}
