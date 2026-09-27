package mayhemlib.auto;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Subsystem;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;
import mayhemlib.follow.DriveCommand;
import mayhemlib.follow.FollowerConfig;
import mayhemlib.recovery.BridgeRefiner;
import mayhemlib.recovery.RecoveryConfig;
import mayhemlib.telemetry.MayhemTelemetry;
import mayhemlib.trajectory.MayhemTrajectory;
import mayhemlib.trajectory.TrajectoryLoader;

/**
 * Entry point for robot code, modeled on Choreo's {@code choreo.auto.AutoFactory}. Create one per
 * drivetrain (see {@link mayhemlib.ctre.CtreSwerve#autoFactory} for a one-liner with CTRE swerve),
 * bind named commands, then build autos from routines.
 *
 * <pre>{@code
 * AutoFactory autoFactory = CtreSwerve.autoFactory(drivetrain);
 * autoFactory.bind("intake", intake.intakeCommand());
 *
 * AutoRoutine routine = autoFactory.newRoutine("TwoPiece");
 * AutoTrajectory traj = routine.trajectory("TwoPiece");
 * routine.active().onTrue(Commands.sequence(traj.resetOdometry(), traj.cmd()));
 * return routine;
 * }</pre>
 *
 * <p>Unlike Choreo, the controller is built in: MayhemLib runs the feedback, time dilation and bump
 * recovery itself, and hands the drivetrain a finished {@link DriveCommand} (field speeds plus
 * per-module force feedforward). That is why the factory also needs measured field speeds.
 */
public final class AutoFactory {
  final Supplier<Pose2d> pose;
  final Consumer<Pose2d> resetOdometry;
  final Supplier<ChassisSpeeds> fieldSpeeds;
  final Consumer<DriveCommand> output;
  final Subsystem driveSubsystem;
  BooleanSupplier useRedAlliance;
  DoubleSupplier accelG = () -> Double.NaN;
  Consumer<Boolean> visionBoost = b -> {};
  FollowerConfig followerConfig = new FollowerConfig();
  RecoveryConfig recoveryConfig = new RecoveryConfig();
  BridgeRefiner refiner;
  MayhemTelemetry telemetry;
  final Map<String, Supplier<Command>> bindings = new HashMap<>();
  private final AutoRoutine voidRoutine;

  /**
   * @param poseSupplier vision-fused robot pose (blue-origin field frame on both alliances)
   * @param resetOdometry resets the pose estimate; used by {@code resetOdometry()}
   * @param fieldSpeedsSupplier measured field-relative chassis speeds
   * @param controller applies a {@link DriveCommand} to the drivetrain
   * @param useAllianceFlipping run the red-alliance version of each path when the Driver Station
   *     reports red
   * @param driveSubsystem the drivetrain; required by every trajectory command
   */
  public AutoFactory(
      Supplier<Pose2d> poseSupplier,
      Consumer<Pose2d> resetOdometry,
      Supplier<ChassisSpeeds> fieldSpeedsSupplier,
      Consumer<DriveCommand> controller,
      boolean useAllianceFlipping,
      Subsystem driveSubsystem) {
    this.pose = poseSupplier;
    this.resetOdometry = resetOdometry;
    this.fieldSpeeds = fieldSpeedsSupplier;
    this.output = controller;
    this.driveSubsystem = driveSubsystem;
    this.useRedAlliance = useAllianceFlipping
        ? () -> DriverStation.getAlliance().orElse(DriverStation.Alliance.Blue) == DriverStation.Alliance.Red
        : () -> false;
    this.voidRoutine = new AutoRoutine(this, "VoidRoutine");
  }

  // --------------------------------------------------------------------------- routines

  /** Creates a new, empty auto routine. Build its trajectories and triggers, then return it. */
  public AutoRoutine newRoutine(String name) {
    return new AutoRoutine(this, name);
  }

  /** A routine that does nothing; handy as a default auto. */
  public AutoRoutine voidRoutine() {
    return voidRoutine;
  }

  // --------------------------------------------------------------------------- one-line commands

  /** Follows {@code deploy/mayhem/<name>.mtraj} without a routine. Markers still run bound commands. */
  public Command trajectoryCmd(String trajectoryName) {
    return voidRoutine.trajectory(trajectoryName).cmd();
  }

  /** Follows split segment {@code splitIndex} of a trajectory without a routine. */
  public Command trajectoryCmd(String trajectoryName, int splitIndex) {
    return voidRoutine.trajectory(trajectoryName, splitIndex).cmd();
  }

  /** Follows an already loaded trajectory without a routine. */
  public Command trajectoryCmd(MayhemTrajectory trajectory) {
    return voidRoutine.trajectory(trajectory).cmd();
  }

  /** Resets odometry to the alliance-correct start of a trajectory. */
  public Command resetOdometry(String trajectoryName) {
    return voidRoutine.trajectory(trajectoryName).resetOdometry();
  }

  /** Resets odometry to the alliance-correct start of split segment {@code splitIndex}. */
  public Command resetOdometry(String trajectoryName, int splitIndex) {
    return voidRoutine.trajectory(trajectoryName, splitIndex).resetOdometry();
  }

  // --------------------------------------------------------------------------- named commands

  /**
   * Binds a command to event markers whose command (or name) matches. The same instance is
   * scheduled on every firing, so don't also put it in another composition.
   */
  public AutoFactory bind(String name, Command cmd) {
    bindings.put(name, () -> cmd);
    return this;
  }

  /** Binds a factory so each firing gets a fresh command instance. */
  public AutoFactory bind(String name, Supplier<Command> cmdFactory) {
    bindings.put(name, cmdFactory);
    return this;
  }

  // --------------------------------------------------------------------------- MayhemLib options

  public AutoFactory withFollowerConfig(FollowerConfig cfg) {
    followerConfig = cfg;
    return this;
  }

  public AutoFactory withRecoveryConfig(RecoveryConfig cfg) {
    recoveryConfig = cfg;
    return this;
  }

  /** Horizontal acceleration magnitude in g (e.g. from a Pigeon 2) for collision detection. */
  public AutoFactory withAccelerometer(DoubleSupplier accelG) {
    this.accelG = accelG;
    return this;
  }

  /** Called with true right after a detected hit and false afterwards: raise vision trust. */
  public AutoFactory withVisionBoost(Consumer<Boolean> visionBoost) {
    this.visionBoost = visionBoost;
    return this;
  }

  /** Overrides alliance detection: return true to run the red-alliance version. */
  public AutoFactory withAllianceFlip(BooleanSupplier useRedAlliance) {
    this.useRedAlliance = useRedAlliance;
    return this;
  }

  /** Optional background bridge refinement (e.g. {@link mayhemlib.recovery.SleipnirBridgeRefiner}). */
  public AutoFactory withRefiner(BridgeRefiner refiner) {
    this.refiner = refiner;
    return this;
  }

  /** Publish reference/bridge/state to NetworkTables under /Mayhem. */
  public AutoFactory withTelemetry(boolean enabled) {
    telemetry = enabled ? new MayhemTelemetry("/Mayhem") : null;
    return this;
  }

  // --------------------------------------------------------------------------- internals

  static MayhemTrajectory load(String name, int splitIndex) {
    MayhemTrajectory t = TrajectoryLoader.load(name);
    return splitIndex < 0 ? t : t.segment(splitIndex);
  }

  boolean isRed() {
    return useRedAlliance.getAsBoolean();
  }

  Optional<Command> boundCommand(String name) {
    Supplier<Command> s = bindings.get(name);
    return s == null ? Optional.empty() : Optional.ofNullable(s.get());
  }
}
