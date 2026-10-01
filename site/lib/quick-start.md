# Quick start

The API follows ChoreoLib's (`AutoFactory`, `AutoRoutine`, `AutoTrajectory`, `AutoChooser`), so Choreo code ports with few changes. The one real difference is that you don't write a controller: MayhemLib runs the feedback, time dilation and bump recovery, and gives your drivetrain a finished `DriveCommand`.

The Mayhem app saves generated trajectories to `src/main/deploy/mayhem/<Name>.mtraj` automatically when that folder is the project or the configured deploy folder.

## CTRE Tuner X swerve

```java
import mayhemlib.auto.AutoChooser;
import mayhemlib.auto.AutoFactory;
import mayhemlib.auto.AutoRoutine;
import mayhemlib.auto.AutoTrajectory;
import mayhemlib.ctre.CtreSwerve;

public class RobotContainer {
  public final CommandSwerveDrivetrain drivetrain = TunerConstants.createDrivetrain();
  private final AutoFactory autoFactory;
  private final AutoChooser autoChooser = new AutoChooser();

  public RobotContainer() {
    autoFactory = CtreSwerve.autoFactory(drivetrain)
        .withTelemetry(true)                         // NetworkTables under /Mayhem
        .withVisionBoost(boost -> drivetrain.setVisionMeasurementStdDevs(
            boost ? VecBuilder.fill(0.15, 0.15, 0.5)   // right after a hit: trust vision more
                  : VecBuilder.fill(0.7, 0.7, 9999)));

    // Markers named "intake" / "shoot" in the app run these commands.
    autoFactory.bind("intake", () -> intake.runIntake());   // Supplier: fresh command each time
    autoFactory.bind("shoot", () -> shooter.shootOnce());

    autoChooser.addRoutine("Two piece", this::twoPiece);
    SmartDashboard.putData("Auto Chooser", autoChooser);
    RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler());
  }

  private AutoRoutine twoPiece() {
    AutoRoutine routine = autoFactory.newRoutine("Two piece");
    AutoTrajectory traj = routine.trajectory("TwoPiece");
    routine.active().onTrue(Commands.sequence(traj.resetOdometry(), traj.cmd()));
    return routine;
  }
}
```

`CtreSwerve.autoFactory(drivetrain)` connects the factory to the drivetrain as follows:

- **pose**: `drivetrain.getState().Pose`, which is the vision-fused, blue-origin pose estimate.
- **reset odometry**: `drivetrain.resetPose`.
- **measured speeds**: the robot-relative `getState().Speeds`, rotated into the field frame.
- **controller output**: `SwerveRequest.ApplyFieldSpeeds` with `DriveRequestType.Velocity`, forward perspective `BlueAlliance` (so the operator perspective never affects autos), wheel-speed desaturation, and `withWheelForceFeedforwardsX/Y` from the trajectory.
- **alliance flipping**: on, from the Driver Station alliance.
- **accelerometer**: the horizontal acceleration magnitude from the drivetrain's Pigeon 2, in g, used for hit detection.
- **requirements**: the drivetrain subsystem.

If your drivetrain and subsystem are separate objects, use `CtreSwerve.autoFactory(drivetrain, subsystem)`.

## Other drivetrains

The constructor mirrors Choreo's, with a measured-speeds supplier added and a `DriveCommand` consumer in place of the sample controller:

```java
var autoFactory = new AutoFactory(
        drive::getPose,                  // Supplier<Pose2d>, blue-origin field frame
        drive::resetOdometry,            // Consumer<Pose2d>
        drive::getFieldRelativeSpeeds,   // Supplier<ChassisSpeeds>, field frame
        dc -> drive.driveFieldRelative(dc.fieldSpeeds, dc.wheelForceX, dc.wheelForceY),
        true,                            // useAllianceFlipping
        drive)                           // drive subsystem
    .withAccelerometer(() -> imu.horizontalAccelG());   // optional
```

## Pick autos from the dashboard

Only the selected routine is built, while disabled:

```java
AutoChooser autoChooser = new AutoChooser();
autoChooser.addRoutine("Hub Cycle", this::hubCycle);
autoChooser.addCmd("Drive forward", () -> autoFactory.trajectoryCmd("Straight"));
SmartDashboard.putData("Auto Chooser", autoChooser);
RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler());
```

## Example project

A complete robot project lives at [`examples/robot-2026`](https://github.com/ryanabraham1/Mayhem/tree/main/examples/robot-2026). It has a Tuner X swerve, an auto chooser, split and branch autos, alliance flipping, and simulated bumps. It also has a JUnit test that runs the autos against the CTRE swerve simulation.
