package frc.robot;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.concurrent.atomic.AtomicInteger;
import mayhemlib.auto.AutoRoutine;
import mayhemlib.sim.BumpInjector;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectoryLoader;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * End-to-end smoke test: builds the real RobotContainer (CTRE swerve in simulation), then runs the
 * autos in real time and checks that the robot ends where the trajectory ends. This exercises
 * MayhemLib's CTRE integration (ApplyFieldSpeeds + wheel force feedforwards), deploy-directory
 * trajectory loading, marker bindings, alliance flipping and bump recovery.
 */
class AutoSimTest {
  private static RobotContainer rc;

  @BeforeAll
  static void setup() {
    assertTrue(HAL.initialize(500, 0));
    setAlliance(AllianceStationID.Blue1);
    DriverStationSim.setAutonomous(true);
    DriverStationSim.setEnabled(true);
    DriverStationSim.setDsAttached(true);
    DriverStationSim.notifyNewData();
    DriverStation.refreshData();
    rc = new RobotContainer();
  }

  @AfterAll
  static void teardown() {
    CommandScheduler.getInstance().cancelAll();
    CommandScheduler.getInstance().unregisterAllSubsystems();
    CommandScheduler.getInstance().getDefaultButtonLoop().clear();
    rc.drivetrain.close();
  }

  private static void setAlliance(AllianceStationID id) {
    DriverStationSim.setAllianceStationId(id);
    DriverStationSim.notifyNewData();
    DriverStation.refreshData();
  }

  /** Runs the command in real time (the CTRE sim thread runs on wall-clock time). */
  private static void run(Command cmd, double timeoutSeconds) throws InterruptedException {
    CommandScheduler.getInstance().schedule(cmd);
    long start = System.nanoTime();
    while (CommandScheduler.getInstance().isScheduled(cmd)
        && (System.nanoTime() - start) * 1e-9 < timeoutSeconds) {
      DriverStationSim.notifyNewData();
      CommandScheduler.getInstance().run();
      Thread.sleep(20);
    }
    assertFalse(CommandScheduler.getInstance().isScheduled(cmd), cmd.getName() + " timed out");
  }

  /** A routine runs until autonomous ends; in tests, stop it once no path has run for a second. */
  private static Command untilIdle(AutoRoutine routine) {
    return routine.cmd(routine.idle().debounce(1.0));
  }

  private static double distanceToEnd(MayhemTrajectory traj) {
    Pose2d pose = rc.drivetrain.getState().Pose;
    return pose.getTranslation().getDistance(traj.finalPose().getTranslation());
  }

  @Test
  void autosRunInSimulation() throws InterruptedException {
    MayhemTrajectory hub = TrajectoryLoader.load("HubCycle");
    AtomicInteger scores = new AtomicInteger();
    rc.autoFactory.bind("score", () -> Commands.runOnce(scores::incrementAndGet));

    // 1. Full path on blue.
    run(untilIdle(rc.hubCycleFull()), 10);
    System.out.printf("HubCycle full: end error %.3f m%n", distanceToEnd(hub));
    assertEquals(1, scores.get(), "score marker fired once");
    assertTrue(distanceToEnd(hub) < 0.15, "ended near the final pose");

    // 2. Split segments with the branch.
    scores.set(0);
    run(untilIdle(rc.hubCycleSplit()), 12);
    System.out.printf("HubCycle split: end error %.3f m%n", distanceToEnd(hub));
    assertTrue(distanceToEnd(hub) < 0.15);
    assertEquals(1, scores.get(), "score marker fired once (at the start of segment 1)");

    // 3. Red alliance: the trajectory is flipped with the field's rotational symmetry.
    setAlliance(AllianceStationID.Red1);
    MayhemTrajectory straightRed = TrajectoryLoader.load("Straight").flipped();
    run(untilIdle(rc.straight()), 8);
    System.out.printf("Straight red: end error %.3f m%n", distanceToEnd(straightRed));
    assertTrue(distanceToEnd(straightRed) < 0.15);
    setAlliance(AllianceStationID.Blue1);

    // 4. Bump recovery: shove the robot 0.7 m sideways 0.8 s into the full path.
    Command bumped = Commands.deadline(
        untilIdle(rc.hubCycleFull()),
        Commands.waitSeconds(0.8).andThen(BumpInjector.bump(
            () -> rc.drivetrain.getState().Pose, rc.drivetrain::resetPose,
            new Translation2d(0, 0.7), new edu.wpi.first.math.geometry.Rotation2d(0.5))));
    run(bumped, 12);
    double bridges = NetworkTableInstance.getDefault().getTable("Mayhem")
        .getEntry("bridgesPlanned").getDouble(-1);
    System.out.printf("HubCycle bumped: end error %.3f m, bridges %.0f%n", distanceToEnd(hub), bridges);
    assertTrue(bridges >= 1, "planned a recovery bridge");
    assertTrue(distanceToEnd(hub) < 0.15, "recovered and finished");
  }
}
