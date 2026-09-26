package mayhemlib.auto;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
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
 * Entry point for robot code. Create one per drivetrain (see {@link mayhemlib.ctre.CtreSwerve} for
 * a one-liner with CTRE swerve), bind named commands, then build autos from trajectories.
 *
 * <pre>{@code
 * var auto = CtreSwerve.autoFactory(drivetrain);
 * auto.bind("intake", intake.runOnce(...));
 * var traj = auto.trajectory("TwoPiece");
 * return Commands.sequence(traj.resetOdometry(), traj.cmd());
 * }</pre>
 */
public final class MayhemAutoFactory {
  final Supplier<Pose2d> pose;
  final Supplier<ChassisSpeeds> fieldSpeeds;
  final Consumer<DriveCommand> output;
  final Subsystem[] requirements;
  BooleanSupplier useRedAlliance = () ->
      DriverStation.getAlliance().orElse(DriverStation.Alliance.Blue) == DriverStation.Alliance.Red;
  DoubleSupplier accelG = () -> Double.NaN;
  Consumer<Pose2d> resetPose = p -> {};
  Consumer<Boolean> visionBoost = b -> {};
  FollowerConfig followerConfig = new FollowerConfig();
  RecoveryConfig recoveryConfig = new RecoveryConfig();
  BridgeRefiner refiner;
  MayhemTelemetry telemetry;
  final Map<String, Supplier<Command>> bindings = new HashMap<>();

  /**
   * @param pose vision-fused robot pose (blue-origin field frame)
   * @param fieldSpeeds measured field-relative speeds
   * @param output applies a {@link DriveCommand} to the drivetrain
   * @param requirements drivetrain subsystem(s)
   */
  public MayhemAutoFactory(Supplier<Pose2d> pose, Supplier<ChassisSpeeds> fieldSpeeds,
      Consumer<DriveCommand> output, Subsystem... requirements) {
    this.pose = pose;
    this.fieldSpeeds = fieldSpeeds;
    this.output = output;
    this.requirements = requirements;
  }

  public MayhemAutoFactory withFollowerConfig(FollowerConfig cfg) {
    followerConfig = cfg;
    return this;
  }

  public MayhemAutoFactory withRecoveryConfig(RecoveryConfig cfg) {
    recoveryConfig = cfg;
    return this;
  }

  /** Horizontal acceleration magnitude in g (e.g. from a Pigeon 2) for collision detection. */
  public MayhemAutoFactory withAccelerometer(DoubleSupplier accelG) {
    this.accelG = accelG;
    return this;
  }

  /** Called with true right after a detected hit and false afterwards: raise vision trust. */
  public MayhemAutoFactory withVisionBoost(Consumer<Boolean> visionBoost) {
    this.visionBoost = visionBoost;
    return this;
  }

  public MayhemAutoFactory withResetPose(Consumer<Pose2d> resetPose) {
    this.resetPose = resetPose;
    return this;
  }

  /** Override alliance detection (default: DriverStation alliance). */
  public MayhemAutoFactory withAllianceFlip(BooleanSupplier useRedAlliance) {
    this.useRedAlliance = useRedAlliance;
    return this;
  }

  /** Optional background bridge refinement (e.g. {@link mayhemlib.recovery.SleipnirBridgeRefiner}). */
  public MayhemAutoFactory withRefiner(BridgeRefiner refiner) {
    this.refiner = refiner;
    return this;
  }

  /** Publish reference/bridge/state to NetworkTables under /Mayhem. */
  public MayhemAutoFactory withTelemetry(boolean enabled) {
    telemetry = enabled ? new MayhemTelemetry("/Mayhem") : null;
    return this;
  }

  /** Bind a named command to event markers whose command (or name) matches. */
  public MayhemAutoFactory bind(String name, Command command) {
    bindings.put(name, () -> command);
    return this;
  }

  /** Bind a factory so each firing gets a fresh command instance. */
  public MayhemAutoFactory bind(String name, Supplier<Command> factory) {
    bindings.put(name, factory);
    return this;
  }

  /** Loads {@code deploy/mayhem/<name>.mtraj}. */
  public AutoTrajectory trajectory(String name) {
    return new AutoTrajectory(this, TrajectoryLoader.load(name), -1);
  }

  public AutoTrajectory trajectory(MayhemTrajectory trajectory) {
    return new AutoTrajectory(this, trajectory, -1);
  }

  boolean isRed() {
    return useRedAlliance.getAsBoolean();
  }

  Optional<Command> boundCommand(String name) {
    Supplier<Command> s = bindings.get(name);
    return s == null ? Optional.empty() : Optional.ofNullable(s.get());
  }

  /** A command that does nothing; handy as a default auto. */
  public Command none() {
    return Commands.none();
  }
}
