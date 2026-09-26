package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.geometry.ConvexPolygon;
import mayhemlib.recovery.Bridge;
import mayhemlib.recovery.BridgePlanner;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.RecoveryData;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectorySample;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import org.junit.jupiter.api.Test;

class RecoveryTest {
  /** Real contact: exported obstacles include a 3 cm margin, so shrink the bumper by that much. */
  static boolean collides(RecoveryData rec, Pose2d p) {
    edu.wpi.first.math.geometry.Translation2d[] shrunk = new edu.wpi.first.math.geometry.Translation2d[rec.bumper.length];
    for (int i = 0; i < shrunk.length; i++) {
      var c = rec.bumper[i];
      shrunk[i] = new edu.wpi.first.math.geometry.Translation2d(
          c.getX() - Math.signum(c.getX()) * 0.03, c.getY() - Math.signum(c.getY()) * 0.03);
    }
    ConvexPolygon fp = ConvexPolygon.footprint(shrunk, p.getX(), p.getY(), p.getRotation().getRadians());
    for (ConvexPolygon o : rec.obstacles) {
      if (fp.intersects(o)) {
        return true;
      }
    }
    return false;
  }

  static final class Run {
    final List<String> events = new ArrayList<>();
    double maxError;
    boolean collided;
    double endTime;
    int bridges;
    TrajectoryRunner runner;
    SimRobot robot;
  }

  static Run simulate(MayhemTrajectory traj, RecoveryConfig rc, double bumpAt, double dx, double dy, double dth) {
    Run r = new Run();
    r.robot = new SimRobot(traj.initialPose());
    r.runner = new TrajectoryRunner(traj, new FollowerConfig(), rc, new TrajectoryRunner.EventListener() {
      @Override
      public void onEvent(TrajectoryEvent e) {
        r.events.add(e.name);
      }

      @Override
      public void onZoneEnd(TrajectoryEvent e) {
        r.events.add("/" + e.name);
      }
    });
    double dt = 0.02;
    double now = 100.0;
    r.runner.start(now);
    boolean bumped = false;
    for (int i = 0; i < 2000 && !r.runner.isFinished(); i++) {
      now += dt;
      double elapsed = now - 100.0;
      if (!bumped && bumpAt >= 0 && elapsed >= bumpAt) {
        r.robot.bump(dx, dy, dth);
        bumped = true;
      }
      DriveCommand c = r.runner.update(now, r.robot.pose(), r.robot.speeds(), r.robot.lastAccelG);
      r.robot.step(c, dt);
      if (!bumped || elapsed > bumpAt + 0.1) {
        boolean hit = collides(traj.recovery(), r.robot.pose()) && !(bumped && elapsed < bumpAt + 0.4);
        if (hit && !r.collided && System.getenv("MAYHEM_DEBUG") != null) {
          System.out.println("collision at t=" + elapsed + " pose=" + r.robot.pose() + " state=" + r.runner.state()
              + " ref=" + r.runner.reference().getPose() + " bridges=" + r.runner.bridgesPlanned());
        }
        r.collided |= hit;
      }
      if (r.runner.state() == TrajectoryRunner.State.FOLLOWING) {
        r.maxError = Math.max(r.maxError, r.runner.positionError());
      }
      r.endTime = elapsed;
    }
    r.bridges = r.runner.bridgesPlanned();
    return r;
  }

  @Test
  void followsWithoutBumpAndFiresEventsInOrder() {
    MayhemTrajectory t = Fixtures.load("AroundReef");
    Run r = simulate(t, new RecoveryConfig(), -1, 0, 0, 0);
    assertTrue(r.runner.isFinished());
    assertEquals(0, r.bridges);
    assertTrue(r.maxError < 0.2, "tracking error " + r.maxError);
    assertEquals(List.of("raise", "skipme", "score", "intake", "/intake"), r.events);
    assertTrue(r.endTime < t.totalTime() + 1.2);
    assertTrue(r.robot.pose().getTranslation().getDistance(t.finalPose().getTranslation()) < 0.06);
  }

  @Test
  void recoversFromBumpWithoutCollision() {
    MayhemTrajectory t = Fixtures.load("AroundReef");
    Run r = simulate(t, new RecoveryConfig(), 0.6, 0.0, 0.7, 0.5);
    assertTrue(r.runner.isFinished(), "finished");
    assertTrue(r.bridges >= 1, "planned a bridge");
    assertFalse(r.collided, "never hit an obstacle");
    assertTrue(r.robot.pose().getTranslation().getDistance(t.finalPose().getTranslation()) < 0.08);
    assertTrue(r.events.contains("score"), "must-hit marker fired");
    assertTrue(r.runner.lastPlanSeconds() < 0.05, "plan time " + r.runner.lastPlanSeconds());
  }

  @Test
  void recoveryDisabledStillFinishesViaDilation() {
    MayhemTrajectory t = Fixtures.load("Straight");
    Run r = simulate(t, new RecoveryConfig().disabled(), 0.8, 0, -0.5, 0);
    assertTrue(r.runner.isFinished());
    assertEquals(0, r.bridges);
  }

  @Test
  void bridgeEndsOnTrajectoryAndRespectsWindow() {
    MayhemTrajectory t = Fixtures.load("AroundReef");
    RecoveryConfig rc = new RecoveryConfig();
    BridgePlanner planner = new BridgePlanner(rc);
    TrajectorySample ref = t.sampleAt(0.5);
    Pose2d pushed = new Pose2d(ref.x - 0.2, ref.y + 0.6, new Rotation2d(ref.heading + 0.4));
    BridgePlanner.Result res = planner.plan(t, 0.5, pushed, new ChassisSpeeds(ref.vx, ref.vy + 1.0, 0));
    assertTrue(res.bridge.isPresent());
    Bridge b = res.bridge.get();
    TrajectorySample end = b.sampleAt(b.duration());
    TrajectorySample target = t.sampleAt(b.joinTime);
    assertEquals(target.x, end.x, 1e-6);
    assertEquals(target.y, end.y, 1e-6);
    assertEquals(target.vx, end.vx, 1e-6);
    double nextMust = 999;
    for (double m : t.recovery().mustHitTimes) {
      if (m > 0.5) {
        nextMust = Math.min(nextMust, m);
      }
    }
    assertTrue(b.joinTime <= nextMust + 1e-9);
    assertTrue(BridgePlanner.isCollisionFree(b, t.recovery(), 0.02));
  }

  @Test
  void worksForRedAlliance() {
    MayhemTrajectory t = Fixtures.load("AroundReef").flipped();
    Run r = simulate(t, new RecoveryConfig(), 0.6, 0.0, -0.7, -0.5);
    assertTrue(r.runner.isFinished());
    assertFalse(r.collided);
  }

  @Test
  void routesAroundReefWhenDirectBridgeIsBlocked() {
    MayhemTrajectory t = Fixtures.load("AroundReef");
    double tScore = t.waypointTimes()[2];
    RecoveryConfig rc = new RecoveryConfig();
    rc.maxJoinLookahead = 1.0;
    BridgePlanner planner = new BridgePlanner(rc);
    // robot shoved to the far (right) side of the blue reef while the reference is on the left
    Pose2d pushed = new Pose2d(5.95, 4.03, new Rotation2d(Math.PI));
    BridgePlanner.Result res = planner.plan(t, tScore - 0.6, pushed, new ChassisSpeeds());
    assertTrue(res.bridge.isPresent(), "found a bridge");
    Bridge b = res.bridge.get();
    assertTrue(BridgePlanner.isCollisionFree(b, t.recovery(), 0.01));
    System.out.println("routed bridge: " + b.segments().size() + " segments, " + b.duration() + " s, plan "
        + res.planSeconds * 1000 + " ms");
  }

  @Test
  void usesRoadmapBehindAWall() {
    // straight trajectory along y = 1 at 1 m/s; a long wall separates it from the robot
    List<TrajectorySample> samples = new ArrayList<>();
    double[] f = new double[4];
    for (int k = 0; k <= 80; k++) {
      double tt = k * 0.1;
      samples.add(new TrajectorySample(tt, 1.0 + tt, 1.0, 0, 1.0, 0, 0, 0, 0, 0, f, f));
    }
    var bumper = new edu.wpi.first.math.geometry.Translation2d[] {
        new edu.wpi.first.math.geometry.Translation2d(0.4, 0.4), new edu.wpi.first.math.geometry.Translation2d(-0.4, 0.4),
        new edu.wpi.first.math.geometry.Translation2d(-0.4, -0.4), new edu.wpi.first.math.geometry.Translation2d(0.4, -0.4)};
    var wall = new ConvexPolygon(new double[] {2, 11, 11, 2}, new double[] {2.5, 2.5, 3.5, 3.5});
    var nodes = List.of(new edu.wpi.first.math.geometry.Translation2d(1.2, 4.3),
        new edu.wpi.first.math.geometry.Translation2d(1.2, 1.7));
    var rec = new RecoveryData(bumper, List.of(wall), 16, 8, mayhemlib.trajectory.FieldSymmetry.ROTATIONAL,
        nodes, List.of(new int[] {0, 1}), 3.0, 4.0, 5.0, 10.0, new double[] {8.0});
    var traj = new MayhemTrajectory("wall", samples, List.of(), new int[0], new double[] {0, 8}, rec, "", false);
    RecoveryConfig rc = new RecoveryConfig();
    rc.maxJoinLookahead = 3.0;
    var res = new BridgePlanner(rc).plan(traj, 1.0, new Pose2d(4.0, 4.5, new Rotation2d()), new ChassisSpeeds());
    assertTrue(res.bridge.isPresent(), "found a routed bridge");
    assertTrue(res.bridge.get().routed);
    assertTrue(BridgePlanner.isCollisionFree(res.bridge.get(), rec, 0.01));
  }
}
