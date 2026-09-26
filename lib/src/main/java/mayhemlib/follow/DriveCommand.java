package mayhemlib.follow;

import edu.wpi.first.math.kinematics.ChassisSpeeds;

/**
 * What the drivetrain should do this loop: field-relative (blue origin) chassis speeds plus
 * optional per-module field-frame force feedforwards in newtons (module order FL, FR, BL, BR).
 */
public final class DriveCommand {
  public final ChassisSpeeds fieldSpeeds;
  public final double[] wheelForceX;
  public final double[] wheelForceY;

  public DriveCommand(ChassisSpeeds fieldSpeeds, double[] wheelForceX, double[] wheelForceY) {
    this.fieldSpeeds = fieldSpeeds;
    this.wheelForceX = wheelForceX;
    this.wheelForceY = wheelForceY;
  }

  public static DriveCommand stop(int modules) {
    return new DriveCommand(new ChassisSpeeds(), new double[modules], new double[modules]);
  }

  /** Robot-relative speeds for a given robot heading (radians). */
  public ChassisSpeeds robotSpeeds(double heading) {
    return ChassisSpeeds.fromFieldRelativeSpeeds(
        fieldSpeeds, new edu.wpi.first.math.geometry.Rotation2d(heading));
  }
}
