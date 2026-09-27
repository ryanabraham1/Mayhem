package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.math.geometry.Translation2d;
import java.util.ArrayList;
import java.util.List;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.FieldSymmetry;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TerrainSpan;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectoryLoader;
import mayhemlib.trajectory.TrajectorySample;
import org.junit.jupiter.api.Test;

/** Rough-terrain zones: the robot slows on a bump without triggering recovery or a slow command. */
class TerrainTest {
  static final double SPEED = 3.0;
  /** The physical bump: robot center between these x values moves at BUMP_SPEED of its command. */
  static final double BUMP_X0 = 5.5;
  static final double BUMP_X1 = 7.3;
  static final double BUMP_SPEED = 0.55;

  /** Straight line along y = 1 at 3 m/s, then braking smoothly to x = 13. */
  static MayhemTrajectory line(List<TerrainSpan> terrain) {
    return line(terrain, List.of());
  }

  static MayhemTrajectory line(List<TerrainSpan> terrain, List<TrajectoryEvent> events) {
    List<TrajectorySample> samples = new ArrayList<>();
    double[] f = new double[4];
    for (int k = 0; k <= 45; k++) {
      double t = k * 0.1;
      double braking = Math.max(0, t - 3.5);
      double x = braking == 0 ? 1.0 + SPEED * t : 11.5 + SPEED * braking - 1.5 * braking * braking;
      samples.add(new TrajectorySample(t, x, 1.0, 0, SPEED - 3.0 * braking,
          0, 0, braking > 0 ? -3.0 : 0, 0, 0, f, f));
    }
    Translation2d[] bumper = {
        new Translation2d(0.4, 0.4), new Translation2d(-0.4, 0.4),
        new Translation2d(-0.4, -0.4), new Translation2d(0.4, -0.4)};
    RecoveryData rec = new RecoveryData(bumper, List.of(), 16, 8, FieldSymmetry.ROTATIONAL, List.of(),
        List.of(), 3.0, 4.0, 5.0, 10.0, new double[] {4.5});
    return new MayhemTrajectory("line", samples, events, terrain, new int[0], new double[] {0, 4.5}, rec, "",
        false);
  }

  /** Span matching the physical bump, in trajectory time. */
  static TerrainSpan bumpSpan() {
    return new TerrainSpan((BUMP_X0 - 1) / SPEED, (BUMP_X1 - 1) / SPEED, BUMP_SPEED, 0.3);
  }

  static final class Result {
    int bridges;
    double elapsed;
    double minCommandOnBump = Double.POSITIVE_INFINITY;
    boolean sawTerrain;
    boolean boostAfterBump;
    double finalError;
    double bridgeX = Double.NaN;
    double markerX = Double.NaN;
    double markerWallTime = Double.NaN;
  }

  static Result drive(MayhemTrajectory traj) {
    return drive(traj, new RecoveryConfig());
  }

  static Result drive(MayhemTrajectory traj, RecoveryConfig config) {
    Result r = new Result();
    SimRobot robot = new SimRobot(traj.initialPose());
    double[] wallTime = {0};
    TrajectoryRunner runner = new TrajectoryRunner(traj, new FollowerConfig(), config, event -> {
      r.markerX = robot.x;
      r.markerWallTime = wallTime[0];
    });
    double dt = 0.02;
    double now = 10.0;
    runner.start(now);
    boolean wasOnBump = false;
    int i = 0;
    for (; i < 1000 && !runner.isFinished(); i++) {
      now += dt;
      wallTime[0] = i * dt;
      boolean onBump = robot.x >= BUMP_X0 && robot.x <= BUMP_X1;
      if (onBump != wasOnBump) {
        robot.lastAccelG = 2.0; // hitting the ramp / landing jolts the IMU
      }
      DriveCommand c = runner.update(now, robot.pose(), robot.speeds(), robot.lastAccelG);
      r.sawTerrain |= runner.onRoughTerrain();
      if (runner.onRoughTerrain()) {
        r.minCommandOnBump = Math.min(r.minCommandOnBump,
            Math.hypot(c.fieldSpeeds.vxMetersPerSecond, c.fieldSpeeds.vyMetersPerSecond));
      }
      if (robot.x > BUMP_X1 + 0.3 && robot.x < BUMP_X1 + 1.0 && runner.visionBoostActive()) {
        r.boostAfterBump = true;
      }
      if (runner.isRecovering()) {
        if (Double.isNaN(r.bridgeX)) r.bridgeX = robot.x;
        r.bridges = Math.max(r.bridges, runner.bridgesPlanned());
      }
      robot.step(c, dt);
      if (onBump) {
        // the bump eats part of the motion the wheels asked for
        robot.x -= robot.vx * dt * (1 - BUMP_SPEED);
      }
      wasOnBump = onBump;
    }
    assertTrue(runner.isFinished(), "runner finished");
    r.bridges = runner.bridgesPlanned();
    r.elapsed = i * dt;
    r.finalError = robot.pose().getTranslation().getDistance(traj.finalPose().getTranslation());
    return r;
  }

  @Test
  void withoutTerrainTheBumpLooksLikeAHit() {
    Result r = drive(line(List.of()));
    assertTrue(r.bridges > 0, "a bump the runner does not know about triggers recovery");
  }

  @Test
  void terrainZoneKeepsFullSpeedAndSkipsRecovery() {
    MayhemTrajectory traj = line(List.of(bumpSpan()));
    Result r = drive(traj);
    assertEquals(0, r.bridges, "no false hit on the bump, bridge at x=" + r.bridgeX);
    assertTrue(r.sawTerrain, "runner reported the terrain");
    assertTrue(r.minCommandOnBump >= 0.95 * SPEED,
        "keeps commanding full speed on the bump, got " + r.minCommandOnBump);
    assertTrue(r.boostAfterBump, "vision boost after leaving the terrain");
    assertTrue(r.finalError < 0.06, "finishes on the final pose, error " + r.finalError);
    // time lost is roughly what the bump costs, not a recovery detour
    double expected = traj.totalTime() + bumpSpan().expectedDelay();
    assertEquals(expected, r.elapsed, 0.5, "elapsed " + r.elapsed + " vs expected " + expected);
  }

  @Test
  void eventMarkerFollowsProgressThroughTerrain() {
    double markerT = 1.8;
    TrajectoryEvent event = new TrajectoryEvent("inside-bump", null, markerT, Double.NaN,
        TrajectoryEvent.RecoveryPolicy.FIRE_AT_JOIN, false);
    Result r = drive(line(List.of(bumpSpan()), List.of(event)));
    assertFalse(Double.isNaN(r.markerX), "marker fired");
    assertEquals(1.0 + SPEED * markerT, r.markerX, 0.2,
        "marker fires near its trajectory position");
    assertTrue(r.markerWallTime >= markerT + 0.08,
        "wall clock reflects the physical bump delay, fired at " + r.markerWallTime + " s and x=" + r.markerX);
  }

  @Test
  void terrainStillTracksProgressWhenRecoveryIsDisabled() {
    Result r = drive(line(List.of(bumpSpan())), new RecoveryConfig().disabled());
    assertTrue(r.sawTerrain);
    assertEquals(0, r.bridges);
    assertTrue(r.elapsed > 4.5, "the clock still slows over the bump");
  }

  @Test
  void segmentsClipAndFlipKeepsTerrain() {
    MayhemTrajectory traj = line(List.of(bumpSpan()));
    assertEquals(1, traj.flipped().terrain().size());
    assertNotNull(traj.terrainAt(1.8));
    assertNull(traj.terrainAt(0.5));
    assertEquals(bumpSpan().t, traj.flipped().terrain().get(0).t, 1e-12);
  }

  @Test
  void loaderReadsTerrainAndIgnoresItsAbsence() {
    String base = "{\"name\":\"x\",\"formatVersion\":1,\"output\":{\"samples\":["
        + "{\"t\":0,\"x\":0,\"y\":0,\"heading\":0,\"vx\":1,\"vy\":0,\"omega\":0,\"ax\":0,\"ay\":0,\"alpha\":0,\"fx\":[],\"fy\":[]},"
        + "{\"t\":1,\"x\":1,\"y\":0,\"heading\":0,\"vx\":1,\"vy\":0,\"omega\":0,\"ax\":0,\"ay\":0,\"alpha\":0,\"fx\":[],\"fy\":[]}],"
        + "\"events\":[],\"splits\":[],\"waypointTimes\":[0,1]%s}}";
    assertTrue(TrajectoryLoader.parse(String.format(base, "")).terrain().isEmpty());
    MayhemTrajectory t = TrajectoryLoader.parse(String.format(base,
        ",\"terrain\":[{\"t\":0.2,\"endT\":0.6,\"expectedSpeed\":0.5,\"feedbackScale\":0.2,\"expectedDelay\":0.4}]"));
    assertEquals(1, t.terrain().size());
    assertEquals(0.2, t.terrain().get(0).feedbackScale, 1e-12);
    assertEquals(0.4, t.terrain().get(0).expectedDelay(), 1e-12);
  }
}
