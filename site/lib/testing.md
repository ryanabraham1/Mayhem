# Testing without a robot

## The example project's tests

The example project runs its autos in a JUnit test: `examples/robot-2026/src/test/java/frc/robot/AutoSimTest.java`. The test builds the real `RobotContainer` with CTRE's swerve simulation, runs the autos in real time on both alliances, injects a bump, and asserts that the robot finishes on the final pose:

```bash
cd examples/robot-2026
./gradlew test        # uses the WPILib JDK 17, e.g. JAVA_HOME=~/wpilib/2026/jdk
./gradlew simulateJava            # sim GUI; add -Pheadless to run without it
```

## Simulated bumps

`mayhemlib.sim.BumpInjector` shoves the simulated pose estimate the way a real hit plus vision correction would, so you can test [recovery](/lib/recovery) at a desk:

```java
if (RobotBase.isSimulation()) {
  // one-shot dashboard button: 0.6 m to the left and 20 degrees of rotation
  SmartDashboard.putData("Sim/Bump left", BumpInjector.bump(
      () -> drivetrain.getState().Pose, drivetrain::resetPose,
      new Translation2d(0, 0.6), Rotation2d.fromDegrees(20)));

  // random bumps during auto while a dashboard toggle is on
  SmartDashboard.putBoolean("Sim/Random bumps", false);
  new Trigger(() -> SmartDashboard.getBoolean("Sim/Random bumps", false))
      .and(RobotModeTriggers.autonomous())
      .whileTrue(BumpInjector.randomBumps(() -> drivetrain.getState().Pose, drivetrain::resetPose,
          1.5 /* mean s between bumps */, 0.6 /* max m */, 0.5 /* max rad */, 42 /* seed */));
}
```

`BumpInjector.apply(...)` and `applyRobotRelative(...)` are pure pose helpers for your own tests.

## Practice-robot validation

Simulation verifies the command wiring and one tracking-error recovery, but it does not verify the Pigeon acceleration trigger or planning time on a roboRIO 2. Use this sequence before a match:

1. Run `./gradlew test` in both `lib/` and `examples/robot-2026/`. In the example, enable `Sim/Random bumps` in simulation and watch a full and split auto return to its path after injected pose offsets. Review `/Mayhem/reference` and `/Mayhem/bridge` against the robot pose.
2. Deploy the example to a practice robot with a current Mayhem path. Confirm blue-origin pose, FL/FR/BL/BR module order, alliance rotation, and marker commands at low speed with recovery disabled. Then enable recovery and repeat on both alliances.
3. With the robot in a clear, controlled area, apply a gentle manual displacement during a slow auto. Log `/Mayhem/state`, `/Mayhem/positionError`, `/Mayhem/clockRate`, `/Mayhem/bridge`, `/Mayhem/bridgesPlanned`, and `/Mayhem/lastPlanMs`. The state should move through `BRIDGING` and return to `FOLLOWING`; no bridge should skip a must-hit marker. Bridges do not avoid obstacles, so test bumps away from field structures first. Also log Pigeon horizontal acceleration alongside planned acceleration to tune `accelSpikeG` and distinguish a real hit from normal traction-limited driving.
4. On the roboRIO 2, repeat several bumps and inspect the **maximum** `/Mayhem/lastPlanMs`, not just its average. Target under 5 ms per bridge plan and confirm the 20 ms robot loop stays healthy. If either budget is missed, reduce `joinCandidates`.

Keep the refiner disabled on the roboRIO 2 unless its runtime is measured there. Record the robot configuration, path, DataLog, largest planning time, and final pose error for each practice run; simulation results alone do not establish on-field safety.
