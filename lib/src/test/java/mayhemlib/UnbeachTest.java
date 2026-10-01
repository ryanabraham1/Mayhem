package mayhemlib;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import java.util.List;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.recovery.BeachDetector;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.recovery.UnbeachConfig;
import mayhemlib.runner.TrajectoryRunner;
import mayhemlib.trajectory.MayhemTrajectory;
import org.junit.jupiter.api.Test;

/** Auto unbeach: tilt geometry, detection debounce, and a closed-loop escape from a fuel pile. */
class UnbeachTest {
  // ------------------------------------------------------------------ geometry and detection

  @Test
  void tiltCombinesPitchAndRoll() {
    assertEquals(0, BeachDetector.tiltDegrees(0, 0), 1e-9);
    assertEquals(10, BeachDetector.tiltDegrees(10, 0), 1e-9);
    assertEquals(10, BeachDetector.tiltDegrees(0, -10), 1e-9);
    assertTrue(BeachDetector.tiltDegrees(8, 8) > 11 && BeachDetector.tiltDegrees(8, 8) < 11.5);
    assertTrue(Double.isNaN(BeachDetector.tiltDegrees(Double.NaN, 0)));
  }

  @Test
  void downhillIsWhereTheUpAxisLeans() {
    Rotation2d north = Rotation2d.fromDegrees(90);
    // CTRE: positive pitch is nose down, so downhill is the way the nose points
    assertVec(1, 0, BeachDetector.downhill(10, 0, Rotation2d.kZero));
    assertVec(-1, 0, BeachDetector.downhill(-10, 0, Rotation2d.kZero));
    // positive roll is left side up, so downhill is to the robot's right
    assertVec(0, -1, BeachDetector.downhill(0, 10, Rotation2d.kZero));
    assertVec(0, 1, BeachDetector.downhill(0, -10, Rotation2d.kZero));
    // rotated into the field frame by the robot heading: nose up while facing +y rolls back toward -y
    assertVec(0, -1, BeachDetector.downhill(-10, 0, north));
    assertVec(0, 0, BeachDetector.downhill(0, 0, north));
    assertVec(0, 0, BeachDetector.downhill(Double.NaN, 0, north));
  }

  @Test
  void beachedNeedsSustainedTiltAndReleasesWithHysteresis() {
    UnbeachConfig cfg = new UnbeachConfig();
    BeachDetector d = new BeachDetector(cfg);
    double t = 0;
    // brief jolt: not beached
    assertFalse(d.update(t += 0.02, 12, 0));
    assertFalse(d.update(t += 0.02, 12, 0));
    assertFalse(d.update(t += 0.02, 0, 0));
    // sustained tilt: beached once past detectSeconds
    boolean beached = false;
    for (int i = 0; i < 20 && !beached; i++) {
      beached = d.update(t += 0.02, 12, 0);
    }
    assertTrue(beached);
    // between the flat and tilt thresholds it stays beached
    for (int i = 0; i < 30; i++) {
      assertTrue(d.update(t += 0.02, 6, 0));
    }
    // flat long enough releases
    boolean released = false;
    for (int i = 0; i < 20 && !released; i++) {
      released = !d.update(t += 0.02, 1, 0);
    }
    assertTrue(released);
    // a missing sensor is never "beached"
    assertFalse(d.update(t += 0.02, Double.NaN, Double.NaN));
  }

  // ------------------------------------------------------------------ closed loop

  static final double PILE_STUCK_X = 4.3;
  static final double PILE_EDGE_X = 3.9;
  static final double PILE_PITCH = -12; // nose up, climbing the pile

  static final class Result {
    int unbeaches;
    boolean finished;
    boolean wasStuck;
    boolean sawUnbeachState;
    double minXWhileUnbeaching = Double.POSITIVE_INFINITY;
    double clockWhileUnbeaching = Double.NaN;
    boolean clockMovedWhileUnbeaching;
    double finalError;
    double elapsed;
  }

  /**
   * The robot drives along y = 1 and high-centers at x = 4.3: it cannot move forward, and the IMU
   * reads nose-up until it has backed off to x < 3.9. The pile is gone after that (one-shot).
   */
  static Result drive(MayhemTrajectory traj, UnbeachConfig unbeach, double seconds) {
    Result r = new Result();
    SimRobot robot = new SimRobot(traj.initialPose());
    TrajectoryRunner runner = new TrajectoryRunner(traj, new FollowerConfig(), new RecoveryConfig(), null)
        .withUnbeach(unbeach);
    double dt = 0.02;
    double now = 10;
    runner.start(now);
    boolean pile = true;
    boolean stuck = false;
    int i = 0;
    for (; i < seconds / dt && !runner.isFinished(); i++) {
      now += dt;
      double pitch = stuck ? PILE_PITCH : 0;
      double clockBefore = runner.trajectoryTime();
      DriveCommand c = runner.update(now, robot.pose(), robot.speeds(), robot.lastAccelG, pitch, 0);
      if (runner.isUnbeaching()) {
        r.sawUnbeachState = true;
        r.minXWhileUnbeaching = Math.min(r.minXWhileUnbeaching, robot.x);
        if (runner.trajectoryTime() != clockBefore) {
          r.clockMovedWhileUnbeaching = true;
        }
      }
      robot.step(c, dt);
      if (pile && robot.x >= PILE_STUCK_X) {
        robot.x = PILE_STUCK_X;
        robot.vx = 0;
        stuck = true;
        r.wasStuck = true;
      }
      if (stuck && robot.x < PILE_EDGE_X) {
        stuck = false;
        pile = false;
      }
    }
    r.finished = runner.isFinished();
    r.unbeaches = runner.unbeachCount();
    r.elapsed = i * dt;
    r.finalError = robot.pose().getTranslation().getDistance(traj.finalPose().getTranslation());
    return r;
  }

  @Test
  void withoutUnbeachTheRobotStaysStuck() {
    Result r = drive(TerrainTest.line(List.of()), new UnbeachConfig().disabled(), 15);
    assertTrue(r.wasStuck);
    assertFalse(r.finished, "never gets off the pile");
  }

  @Test
  void backsOffTheBeachAndFinishesTheAuto() {
    Result r = drive(TerrainTest.line(List.of()), new UnbeachConfig(), 20);
    assertTrue(r.wasStuck, "the sim beached the robot");
    assertTrue(r.sawUnbeachState, "entered the unbeach state");
    assertTrue(r.unbeaches >= 1);
    assertTrue(r.minXWhileUnbeaching < PILE_STUCK_X - 0.2,
        "drove backward, down the slope: " + r.minXWhileUnbeaching);
    assertFalse(r.clockMovedWhileUnbeaching, "trajectory clock is paused while unbeaching");
    assertTrue(r.finished, "resumed and finished the trajectory");
    assertTrue(r.finalError < 0.1, "finishes on the final pose, error " + r.finalError);
  }

  @Test
  void roughTerrainTiltIsNotABeach() {
    // the same constant tilt, but inside a marked bump: ignored
    MayhemTrajectory traj = TerrainTest.line(List.of(
        new mayhemlib.trajectory.TerrainSpan(0.5, 3.0, 1.0, 0.3)));
    SimRobot robot = new SimRobot(traj.initialPose());
    TrajectoryRunner runner = new TrajectoryRunner(traj, new FollowerConfig(), new RecoveryConfig(), null)
        .withUnbeach(new UnbeachConfig());
    double now = 10;
    runner.start(now);
    for (int i = 0; i < 100; i++) {
      now += 0.02;
      double pitch = runner.trajectoryTime() >= 0.5 ? -15 : 0; // tilted from the bump's start on
      DriveCommand c = runner.update(now, robot.pose(), robot.speeds(), 0, pitch, 0);
      assertFalse(runner.isUnbeaching(), "tilt on a marked bump at loop " + i);
      robot.step(c, 0.02);
    }
    assertEquals(0, runner.unbeachCount());
  }

  @Test
  void givesUpAfterMaxSecondsAndResumes() {
    // tilt that never goes away: the runner must not hold the auto hostage
    MayhemTrajectory traj = TerrainTest.line(List.of());
    SimRobot robot = new SimRobot(traj.initialPose());
    UnbeachConfig cfg = new UnbeachConfig();
    TrajectoryRunner runner = new TrajectoryRunner(traj, new FollowerConfig(), new RecoveryConfig(), null)
        .withUnbeach(cfg);
    double now = 10;
    runner.start(now);
    boolean sawUnbeach = false;
    boolean resumed = false;
    for (int i = 0; i < 400; i++) {
      now += 0.02;
      DriveCommand c = runner.update(now, robot.pose(), robot.speeds(), 0, -15, 0);
      sawUnbeach |= runner.isUnbeaching();
      resumed |= sawUnbeach && !runner.isUnbeaching();
      robot.step(c, 0.02);
    }
    assertTrue(sawUnbeach);
    assertTrue(resumed, "left the unbeach state at maxSeconds");
  }

  private static void assertVec(double x, double y, Translation2d v) {
    assertEquals(x, v.getX(), 1e-6, "x of " + v);
    assertEquals(y, v.getY(), 1e-6, "y of " + v);
  }
}
