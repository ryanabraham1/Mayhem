package mayhemlib.ctre;

import com.ctre.phoenix6.hardware.Pigeon2;
import com.ctre.phoenix6.swerve.SwerveDrivetrain;
import com.ctre.phoenix6.swerve.SwerveModule;
import com.ctre.phoenix6.swerve.SwerveRequest;
import edu.wpi.first.math.kinematics.ChassisSpeeds;
import edu.wpi.first.wpilibj2.command.Subsystem;
import mayhemlib.auto.AutoFactory;
import mayhemlib.follow.DriveCommand;

/**
 * CTRE Phoenix 6 swerve integration. Works with the Tuner X generated {@code CommandSwerveDrivetrain}
 * (which extends SwerveDrivetrain and implements Subsystem).
 *
 * <p>Module order must match the trajectory's module order (FL, FR, BL, BR), which is the Tuner X
 * default.
 */
public final class CtreSwerve {
  private CtreSwerve() {}

  /** Factory for a drivetrain that is itself the subsystem (the Tuner X default). */
  public static <T extends SwerveDrivetrain<?, ?, ?> & Subsystem> AutoFactory autoFactory(T drivetrain) {
    return autoFactory(drivetrain, drivetrain);
  }

  public static AutoFactory autoFactory(SwerveDrivetrain<?, ?, ?> drivetrain, Subsystem subsystem) {
    SwerveRequest.ApplyFieldSpeeds request = new SwerveRequest.ApplyFieldSpeeds()
        .withDriveRequestType(SwerveModule.DriveRequestType.Velocity)
        .withForwardPerspective(SwerveRequest.ForwardPerspectiveValue.BlueAlliance)
        .withDesaturateWheelSpeeds(true);
    Pigeon2 pigeon = drivetrain.getPigeon2();
    return new AutoFactory(
            () -> drivetrain.getState().Pose,
            drivetrain::resetPose,
            () -> {
              var st = drivetrain.getState();
              return ChassisSpeeds.fromRobotRelativeSpeeds(st.Speeds, st.Pose.getRotation());
            },
            (DriveCommand dc) -> drivetrain.setControl(request
                .withSpeeds(dc.fieldSpeeds)
                .withWheelForceFeedforwardsX(dc.wheelForceX)
                .withWheelForceFeedforwardsY(dc.wheelForceY)),
            true,
            subsystem)
        .withAccelerometer(() -> Math.hypot(
            pigeon.getAccelerationX().getValueAsDouble(),
            pigeon.getAccelerationY().getValueAsDouble()));
  }
}
