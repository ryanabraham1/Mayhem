package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.recovery.Bridge;
import mayhemlib.recovery.BridgePlanner;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.IntakeSpan;
import mayhemlib.trajectory.TrajectoryEvent;
import mayhemlib.trajectory.TrajectorySample;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import org.junit.jupiter.api.Test;

class RecoveryTest {
  static final class Run {
    final List<String> events = new ArrayList<>();
    double maxError;
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
    MayhemTrajectory t = Fixtures.load("HubCycle");
    Run r = simulate(t, new RecoveryConfig(), -1, 0, 0, 0);
    assertTrue(r.runner.isFinished());
    assertEquals(0, r.bridges);
    assertTrue(r.maxError < 0.2, "tracking error " + r.maxError);
    assertEquals(List.of("raise", "skipme", "score", "intake", "/intake"), r.events);
    assertTrue(r.endTime < t.totalTime() + 1.2);
    assertTrue(r.robot.pose().getTranslation().getDistance(t.finalPose().getTranslation()) < 0.06);
  }

  @Test
  void recoversFromBump() {
    MayhemTrajectory t = Fixtures.load("HubCycle");
    Run r = simulate(t, new RecoveryConfig(), 0.6, 0.0, 0.7, 0.5);
    assertTrue(r.runner.isFinished(), "finished");
    assertTrue(r.bridges >= 1, "planned a bridge");
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
    MayhemTrajectory t = Fixtures.load("HubCycle");
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
  }

  @Test
  void worksForRedAlliance() {
    MayhemTrajectory t = Fixtures.load("HubCycle").flipped();
    Run r = simulate(t, new RecoveryConfig(), 0.6, 0.0, -0.7, -0.5);
    assertTrue(r.runner.isFinished());
    assertTrue(r.robot.pose().getTranslation().getDistance(t.finalPose().getTranslation()) < 0.08);
  }

  @Test
  void reportsPlannedIntakeSpans() {
    MayhemTrajectory base = Fixtures.load("Straight");
    double T = base.totalTime();
    MayhemTrajectory t = new MayhemTrajectory("intake", base.samples(), base.events(), base.terrain(),
        List.of(new IntakeSpan(0.3 * T, 0.6 * T)), new int[0], base.waypointTimes(), base.recovery(), "", false);
    assertFalse(t.intakeExtendedAt(0.1 * T));
    assertTrue(t.intakeExtendedAt(0.5 * T));
    assertTrue(t.intakeExtendedBetween(0.0, 0.35 * T));
    assertFalse(t.flipped().intakeExtendedAt(0.7 * T));

    Run r = new Run();
    r.robot = new SimRobot(t.initialPose());
    r.runner = new TrajectoryRunner(t, new FollowerConfig(), new RecoveryConfig(),
        new TrajectoryRunner.EventListener() {
          @Override
          public void onEvent(TrajectoryEvent e) {}

          @Override
          public void onZoneEnd(TrajectoryEvent e) {}
        });
    double now = 100.0;
    r.runner.start(now);
    boolean sawOut = false;
    boolean outOfSpan = false;
    for (int i = 0; i < 1000 && !r.runner.isFinished(); i++) {
      now += 0.02;
      DriveCommand c = r.runner.update(now, r.robot.pose(), r.robot.speeds(), r.robot.lastAccelG);
      r.robot.step(c, 0.02);
      double tt = r.runner.trajectoryTime();
      sawOut |= r.runner.intakeExtended();
      outOfSpan |= r.runner.intakeExtended() && (tt < 0.3 * T - 1e-9 || tt > 0.6 * T + 1e-9);
    }
    assertTrue(sawOut);
    assertFalse(outOfSpan);
  }
}
