package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.math.geometry.Translation2d;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.FieldSymmetry;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectoryEvent.RecoveryPolicy;
import mayhemlib.trajectory.TrajectorySample;
import org.junit.jupiter.api.Test;

/** Event markers and zones, with and without a recovery bridge jumping over them. */
class EventPolicyTest {
  /** Straight line along y = 1 at 1 m/s for 8 s on an empty field. */
  static MayhemTrajectory line(List<TrajectoryEvent> events) {
    List<TrajectorySample> samples = new ArrayList<>();
    double[] f = new double[4];
    for (int k = 0; k <= 80; k++) {
      double t = k * 0.1;
      samples.add(new TrajectorySample(t, 1.0 + t, 1.0, 0, 1.0, 0, 0, 0, 0, 0, f, f));
    }
    Translation2d[] bumper = {
        new Translation2d(0.4, 0.4), new Translation2d(-0.4, 0.4),
        new Translation2d(-0.4, -0.4), new Translation2d(0.4, -0.4)};
    RecoveryData rec = new RecoveryData(bumper, List.of(), 16, 8, FieldSymmetry.ROTATIONAL, List.of(),
        List.of(), 3.0, 4.0, 5.0, 10.0, new double[] {8.0});
    return new MayhemTrajectory("line", samples, events, new int[0], new double[] {0, 8}, rec, "", false);
  }

  static TrajectoryEvent instant(String name, double t, RecoveryPolicy p) {
    return new TrajectoryEvent(name, null, t, Double.NaN, p, false);
  }

  static TrajectoryEvent zone(String name, double t, double end, RecoveryPolicy p) {
    return new TrajectoryEvent(name, null, t, end, p, false);
  }

  /** Records "name@now" / "/name@now" and bridge start/end times. */
  static final class Log {
    final Map<String, Double> times = new LinkedHashMap<>();
    final List<String> order = new ArrayList<>();
    double now;
    double bridgeStart = Double.NaN;
    double bridgeEnd = Double.NaN;
    double joinTime = Double.NaN;
    double tAtPlan = Double.NaN;
  }

  /** Runs the line; optionally shoves the robot {@code dx} meters along the path at {@code bumpAt}. */
  static Log run(MayhemTrajectory traj, double bumpAt, double dx) {
    Log log = new Log();
    SimRobot robot = new SimRobot(traj.initialPose());
    TrajectoryRunner runner = new TrajectoryRunner(traj, new FollowerConfig(), new RecoveryConfig(),
        new TrajectoryRunner.EventListener() {
          @Override
          public void onEvent(TrajectoryEvent e) {
            log.order.add(e.name);
            log.times.put(e.name, log.now);
          }

          @Override
          public void onZoneEnd(TrajectoryEvent e) {
            log.order.add("/" + e.name);
            log.times.put("/" + e.name, log.now);
          }
        });
    double dt = 0.02;
    double start = 50.0;
    log.now = start;
    runner.start(start);
    boolean bumped = false;
    for (int i = 0; i < 1500 && !runner.isFinished(); i++) {
      log.now += dt;
      double elapsed = log.now - start;
      if (!bumped && bumpAt >= 0 && elapsed >= bumpAt) {
        robot.bump(dx, 0, 0);
        bumped = true;
      }
      double tBefore = runner.trajectoryTime();
      boolean wasBridging = runner.isRecovering();
      DriveCommand c = runner.update(log.now, robot.pose(), robot.speeds(), robot.lastAccelG);
      if (!wasBridging && runner.isRecovering() && Double.isNaN(log.bridgeStart)) {
        log.bridgeStart = log.now;
        log.tAtPlan = tBefore;
        log.joinTime = runner.bridge().orElseThrow().joinTime;
      }
      if (wasBridging && !runner.isRecovering() && Double.isNaN(log.bridgeEnd)) {
        log.bridgeEnd = log.now;
      }
      robot.step(c, dt);
    }
    assertTrue(runner.isFinished(), "runner finished");
    return log;
  }

  @Test
  void instantAndZoneMarkersFireAtTheirTimesWithoutBumps() {
    MayhemTrajectory t = line(List.of(
        instant("a", 1.0, RecoveryPolicy.FIRE_AT_JOIN),
        zone("z", 2.0, 3.0, RecoveryPolicy.FIRE_AT_JOIN),
        instant("start", 0.0, RecoveryPolicy.FIRE_AT_JOIN),
        instant("end", 8.0, RecoveryPolicy.FIRE_AT_JOIN)));
    Log log = run(t, -1, 0);
    assertEquals(List.of("start", "a", "z", "/z", "end"), log.order);
    assertEquals(50.0, log.times.get("start"), 1e-9, "t = 0 marker fires on start()");
    // tracking is tight, so the clock runs at ~1x
    assertEquals(51.0, log.times.get("a"), 0.1);
    assertEquals(52.0, log.times.get("z"), 0.1);
    assertEquals(53.0, log.times.get("/z"), 0.1);
    assertTrue(Double.isNaN(log.bridgeStart), "no bridge without a bump");
  }

  @Test
  void recoveryPoliciesApplyToMarkersInsideTheBridgeWindow() {
    MayhemTrajectory t = line(List.of(
        instant("now", 1.3, RecoveryPolicy.FIRE_IMMEDIATELY),
        instant("skip", 1.4, RecoveryPolicy.SKIP),
        instant("join", 1.5, RecoveryPolicy.FIRE_AT_JOIN),
        zone("zoneSkipped", 1.35, 1.6, RecoveryPolicy.SKIP),
        zone("zoneNow", 1.45, 1.55, RecoveryPolicy.FIRE_IMMEDIATELY),
        instant("after", 6.0, RecoveryPolicy.FIRE_AT_JOIN)));
    // robot shoved 1.5 m forward along the path: the best bridge rejoins well ahead
    Log log = run(t, 1.0, 1.5);

    assertFalse(Double.isNaN(log.bridgeStart), "planned a bridge");
    assertFalse(Double.isNaN(log.bridgeEnd), "rejoined");
    assertTrue(log.tAtPlan < 1.3 && log.joinTime > 1.6,
        "markers lie inside the bridge window: tAtPlan=" + log.tAtPlan + " join=" + log.joinTime);

    assertEquals(log.bridgeStart, log.times.get("now"), 1e-9, "fireImmediately fires when the bridge is planned");
    assertEquals(log.bridgeStart, log.times.get("zoneNow"), 1e-9);
    assertEquals(log.bridgeEnd, log.times.get("join"), 1e-9, "fireAtJoin fires on rejoin");
    // a zone whose end the bridge jumped over is closed on rejoin
    assertEquals(log.bridgeEnd, log.times.get("/zoneNow"), 1e-9);
    assertFalse(log.order.contains("skip"), "skip never fires");
    assertFalse(log.order.contains("zoneSkipped"), "skipped zone never starts");
    assertFalse(log.order.contains("/zoneSkipped"), "skipped zone never ends");
    assertTrue(log.order.contains("after"), "later markers still fire");
    assertTrue(log.order.indexOf("join") < log.order.indexOf("after"));
  }

  @Test
  void stopClosesOpenZones() {
    MayhemTrajectory t = line(List.of(zone("z", 0.0, 5.0, RecoveryPolicy.FIRE_AT_JOIN)));
    List<String> ev = new ArrayList<>();
    TrajectoryRunner r = new TrajectoryRunner(t, new FollowerConfig(), new RecoveryConfig(),
        new TrajectoryRunner.EventListener() {
          @Override
          public void onEvent(TrajectoryEvent e) {
            ev.add(e.name);
          }

          @Override
          public void onZoneEnd(TrajectoryEvent e) {
            ev.add("/" + e.name);
          }
        });
    r.start(0);
    r.update(0.02, t.initialPose(), null, Double.NaN);
    assertEquals(List.of("z"), ev);
    r.stop();
    assertEquals(List.of("z", "/z"), ev);
    r.stop();
    assertEquals(List.of("z", "/z"), ev, "stopping twice does not re-close");
  }
}
