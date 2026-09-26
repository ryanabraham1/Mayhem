// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

package frc.robot;

import static edu.wpi.first.units.Units.*;

import com.ctre.phoenix6.swerve.SwerveModule.DriveRequestType;
import com.ctre.phoenix6.swerve.SwerveRequest;

import edu.wpi.first.math.Matrix;
import edu.wpi.first.math.VecBuilder;
import edu.wpi.first.math.geometry.Rotation2d;
import edu.wpi.first.math.geometry.Translation2d;
import edu.wpi.first.math.numbers.N1;
import edu.wpi.first.math.numbers.N3;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.RobotBase;
import edu.wpi.first.wpilibj.smartdashboard.SendableChooser;
import edu.wpi.first.wpilibj.smartdashboard.SmartDashboard;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.button.CommandXboxController;
import edu.wpi.first.wpilibj2.command.button.RobotModeTriggers;
import edu.wpi.first.wpilibj2.command.button.Trigger;
import edu.wpi.first.wpilibj2.command.sysid.SysIdRoutine.Direction;

import frc.robot.generated.TunerConstants;
import frc.robot.subsystems.CommandSwerveDrivetrain;

import mayhemlib.auto.AutoTrajectory;
import mayhemlib.auto.MayhemAutoFactory;
import mayhemlib.ctre.CtreSwerve;
import mayhemlib.sim.BumpInjector;

public class RobotContainer {
    private double MaxSpeed = 1.0 * TunerConstants.kSpeedAt12Volts.in(MetersPerSecond); // kSpeedAt12Volts desired top speed
    private double MaxAngularRate = RotationsPerSecond.of(0.75).in(RadiansPerSecond); // 3/4 of a rotation per second max angular velocity

    /* Setting up bindings for necessary control of the swerve drive platform */
    private final SwerveRequest.FieldCentric drive = new SwerveRequest.FieldCentric()
            .withDeadband(MaxSpeed * 0.1).withRotationalDeadband(MaxAngularRate * 0.1) // Add a 10% deadband
            .withDriveRequestType(DriveRequestType.OpenLoopVoltage); // Use open-loop control for drive motors
    private final SwerveRequest.SwerveDriveBrake brake = new SwerveRequest.SwerveDriveBrake();
    private final SwerveRequest.PointWheelsAt point = new SwerveRequest.PointWheelsAt();

    private final Telemetry logger = new Telemetry(MaxSpeed);

    private final CommandXboxController joystick = new CommandXboxController(0);

    public final CommandSwerveDrivetrain drivetrain = TunerConstants.createDrivetrain();

    /*
     * Vision trust. Feed your AprilTag measurements into drivetrain.addVisionMeasurement(...) as usual
     * (see CTRE's examples for Limelight/PhotonVision). Right after MayhemLib detects a hit it asks us
     * to trust vision more, so the pose estimate snaps back to where the robot really is and the
     * recovery bridge is planned from the right place.
     */
    private static final Matrix<N3, N1> kVisionStdDevs = VecBuilder.fill(0.7, 0.7, 9999);
    private static final Matrix<N3, N1> kVisionStdDevsAfterHit = VecBuilder.fill(0.15, 0.15, 0.5);

    /* Path follower */
    public final MayhemAutoFactory autoFactory;
    private final SendableChooser<Command> autoChooser = new SendableChooser<>();

    public RobotContainer() {
        autoFactory = CtreSwerve.autoFactory(drivetrain)
            // Publishes reference pose, bridge path and follower state under /Mayhem in NetworkTables.
            .withTelemetry(true)
            .withVisionBoost(boost ->
                drivetrain.setVisionMeasurementStdDevs(boost ? kVisionStdDevsAfterHit : kVisionStdDevs))
            // Trajectories are authored on the blue side and flipped for red using the field's symmetry
            // (REBUILT is rotationally symmetric). This is the default; shown here so you can override it.
            .withAllianceFlip(() ->
                DriverStation.getAlliance().orElse(DriverStation.Alliance.Blue) == DriverStation.Alliance.Red);
        drivetrain.setVisionMeasurementStdDevs(kVisionStdDevs);

        configureNamedCommands();
        configureAutos();
        configureBindings();
        if (RobotBase.isSimulation()) {
            configureSimulation();
        }
    }

    /**
     * Event markers placed in the Mayhem app run the command bound to their name. Use the Supplier
     * overload so every firing gets a fresh command instance. Replace these stand-ins with your
     * real intake/shooter commands (and their subsystem requirements).
     */
    private void configureNamedCommands() {
        autoFactory.bind("intake", () -> Commands.print("[auto] intake running")
            .andThen(Commands.waitSeconds(10)) // a zone marker cancels this when the zone ends
            .finallyDo(() -> System.out.println("[auto] intake stopped"))
            .withName("intake"));
        autoFactory.bind("shoot", RobotContainer::shootCommand);
        // Markers can use any name; several can map to the same command.
        autoFactory.bind("score", RobotContainer::shootCommand);
        autoFactory.bind("raise", () -> Commands.print("[auto] raise"));
    }

    private static Command shootCommand() {
        return Commands.print("[auto] shoot").andThen(Commands.waitSeconds(0.5)).withName("shoot");
    }

    private void configureAutos() {
        autoChooser.setDefaultOption("Do nothing", Commands.none());
        autoChooser.addOption("HubCycle (full path)", hubCycleFull());
        autoChooser.addOption("HubCycle (split + branch)", hubCycleSplit());
        autoChooser.addOption("Straight", straight());
        SmartDashboard.putData("Auto Chooser", autoChooser);
        SmartDashboard.putBoolean("Auto/Run second leg", true);
    }

    /** Follows the whole trajectory; markers fire their bound commands along the way. */
    Command hubCycleFull() {
        AutoTrajectory traj = autoFactory.trajectory("HubCycle");
        // Triggers are an alternative to bind(): react to a marker (or zone) from robot code.
        traj.atMarker("score").onTrue(Commands.print("[auto] reached the scoring pose"));
        traj.recovering().onTrue(Commands.print("[auto] bumped, bridging back onto the path"));
        return Commands.sequence(traj.resetOdometry(), traj.cmd()).withName("HubCycle (full path)");
    }

    /**
     * The HubCycle trajectory has a split point at the scoring stop. Each segment is followed as its
     * own command, so the robot can shoot while stopped and then decide whether to continue.
     */
    Command hubCycleSplit() {
        AutoTrajectory traj = autoFactory.trajectory("HubCycle");
        AutoTrajectory toHub = traj.segment(0);
        AutoTrajectory toIntake = traj.segment(1);
        return Commands.sequence(
            toHub.resetOdometry(),
            toHub.cmd(),
            shootCommand(),
            Commands.either(
                toIntake.cmd(),
                Commands.print("[auto] skipping second leg"),
                () -> SmartDashboard.getBoolean("Auto/Run second leg", true)))
            .withName("HubCycle (split + branch)");
    }

    Command straight() {
        AutoTrajectory traj = autoFactory.trajectory("Straight");
        return Commands.sequence(traj.resetOdometry(), traj.cmd()).withName("Straight");
    }

    private void configureBindings() {
        // Note that X is defined as forward according to WPILib convention,
        // and Y is defined as to the left according to WPILib convention.
        drivetrain.setDefaultCommand(
            // Drivetrain will execute this command periodically
            drivetrain.applyRequest(() ->
                drive.withVelocityX(-joystick.getLeftY() * MaxSpeed) // Drive forward with negative Y (forward)
                    .withVelocityY(-joystick.getLeftX() * MaxSpeed) // Drive left with negative X (left)
                    .withRotationalRate(-joystick.getRightX() * MaxAngularRate) // Drive counterclockwise with negative X (left)
            )
        );

        // Idle while the robot is disabled. This ensures the configured
        // neutral mode is applied to the drive motors while disabled.
        final var idle = new SwerveRequest.Idle();
        RobotModeTriggers.disabled().whileTrue(
            drivetrain.applyRequest(() -> idle).ignoringDisable(true)
        );

        joystick.a().whileTrue(drivetrain.applyRequest(() -> brake));
        joystick.b().whileTrue(drivetrain.applyRequest(() ->
            point.withModuleDirection(new Rotation2d(-joystick.getLeftY(), -joystick.getLeftX()))
        ));

        // Run SysId routines when holding back/start and X/Y.
        // Note that each routine should be run exactly once in a single log.
        joystick.back().and(joystick.y()).whileTrue(drivetrain.sysIdDynamic(Direction.kForward));
        joystick.back().and(joystick.x()).whileTrue(drivetrain.sysIdDynamic(Direction.kReverse));
        joystick.start().and(joystick.y()).whileTrue(drivetrain.sysIdQuasistatic(Direction.kForward));
        joystick.start().and(joystick.x()).whileTrue(drivetrain.sysIdQuasistatic(Direction.kReverse));

        // Reset the field-centric heading on left bumper press.
        joystick.leftBumper().onTrue(drivetrain.runOnce(drivetrain::seedFieldCentric));

        drivetrain.registerTelemetry(logger::telemeterize);
    }

    /**
     * Simulation only: knock the robot around to watch bump recovery at your desk. A bump shifts the
     * pose estimate, which is what the vision-fused estimator reports after a real hit.
     */
    private void configureSimulation() {
        SmartDashboard.putBoolean("Sim/Random bumps", false);
        new Trigger(() -> SmartDashboard.getBoolean("Sim/Random bumps", false))
            .and(RobotModeTriggers.autonomous())
            .whileTrue(BumpInjector.randomBumps(
                () -> drivetrain.getState().Pose, drivetrain::resetPose,
                1.5,   // mean seconds between bumps
                0.6,   // max translation [m]
                0.5,   // max rotation [rad]
                42));  // seed, for repeatable runs
        // A dashboard button for a single 0.6 m sideways shove.
        SmartDashboard.putData("Sim/Bump left", BumpInjector.bump(
            () -> drivetrain.getState().Pose, drivetrain::resetPose,
            new Translation2d(0, 0.6), Rotation2d.fromDegrees(20)));
    }

    public Command getAutonomousCommand() {
        /* Run the routine selected from the auto chooser */
        return autoChooser.getSelected();
    }
}
