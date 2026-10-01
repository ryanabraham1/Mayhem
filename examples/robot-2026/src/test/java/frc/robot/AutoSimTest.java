package frc.robot;

import static org.junit.jupiter.api.Assertions.*;

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import mayhemlib.auto.AutoRoutine;
import mayhemlib.sim.BumpInjector;
import mayhemlib.sim.FuelPileInjector;
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

  /** One sample of the robot while it drives into a pile. */
  private record Sample(double t, double x, double y, String state, double tilt) {}

  /**
   * Runs "Straight" through a simulated pile of fuel on its path and records what the robot does.
   * The pile pins the robot and tilts the simulated Pigeon 2, like a real beaching.
   */
  private static List<Sample> driveStraightThroughPile(FuelPileInjector pile, double seconds)
      throws InterruptedException {
    NetworkTable nt = NetworkTableInstance.getDefault().getTable("Mayhem");
    // start from the path's start pose, away from the pile, before arming it
    rc.drivetrain.resetPose(TrajectoryLoader.load("Straight").initialPose());
    Thread.sleep(200);
    pile.reset();
    Command auto = untilIdle(rc.straight());
    CommandScheduler.getInstance().schedule(auto, pile.command());
    List<Sample> trace = new ArrayList<>();
    long start = System.nanoTime();
    double t;
    while (CommandScheduler.getInstance().isScheduled(auto)
        && (t = (System.nanoTime() - start) * 1e-9) < seconds) {
      DriverStationSim.notifyNewData();
      CommandScheduler.getInstance().run();
      Pose2d p = rc.drivetrain.getState().Pose;
      trace.add(new Sample(t, p.getX(), p.getY(), nt.getEntry("state").getString(""),
          nt.getEntry("tiltDegrees").getDouble(Double.NaN)));
      Thread.sleep(20);
    }
    boolean finished = !CommandScheduler.getInstance().isScheduled(auto);
    CommandScheduler.getInstance().cancel(auto, pile.command());
    CommandScheduler.getInstance().cancelAll();
    System.out.println("  (auto " + (finished ? "finished" : "still running at the timeout") + ")");
    return trace;
  }

  private static void printTrace(String title, List<Sample> trace) {
    System.out.println(title);
    String last = "";
    for (int i = 0; i < trace.size(); i++) {
      Sample s = trace.get(i);
      if (!s.state().equals(last) || i % 15 == 0) {
        System.out.printf("  t=%.2fs  x=%.2f y=%.2f  state=%-10s tilt=%5.1f deg%n",
            s.t(), s.x(), s.y(), s.state(), s.tilt());
        last = s.state();
      }
    }
  }

  @Test
  void unbeachGetsOffAPileOfFuelAndFinishesTheAuto() throws InterruptedException {
    setAlliance(AllianceStationID.Blue1);
    MayhemTrajectory straight = TrajectoryLoader.load("Straight");
    FuelPileInjector pile = rc.simFuelPile(new Translation2d(9.0, 6.25), 0.3);

    // Control: with unbeach off, the robot stays stuck on the pile.
    rc.autoFactory.withUnbeach(null);
    List<Sample> control = driveStraightThroughPile(pile, 5);
    printTrace("Unbeach OFF", control);
    assertEquals(1, pile.beachCount(), "the robot reached the pile");
    Sample end = control.get(control.size() - 1);
    assertTrue(pile.isBeached(), "still beached after 5 s without unbeach");
    assertTrue(end.x() < 9.2, "stuck at the pile, x=" + end.x());

    // With unbeach on.
    rc.autoFactory.withUnbeach();
    List<Sample> trace = driveStraightThroughPile(pile, 10);
    printTrace("Unbeach ON", trace);
    assertEquals(2, pile.beachCount(), "beached again on the second run");
    assertTrue(trace.stream().anyMatch(s -> s.state().equals("UNBEACHING")), "entered UNBEACHING");
    double xStuck = trace.stream().filter(s -> s.state().equals("UNBEACHING"))
        .mapToDouble(Sample::x).max().orElse(Double.NaN);
    double xBack = trace.stream().filter(s -> s.state().equals("UNBEACHING"))
        .mapToDouble(Sample::x).min().orElse(Double.NaN);
    assertTrue(xStuck - xBack > 0.3, "backed off down the slope: " + xStuck + " -> " + xBack);
    assertFalse(pile.isBeached(), "got off the pile");
    assertTrue(distanceToEnd(straight) < 0.15,
        "resumed and finished the path, end error " + distanceToEnd(straight));
  }
}
