# Conventions

These apply to the app's files and to MayhemLib. Getting one wrong usually shows up as a robot that drives mirrored or in the wrong place.

- **Coordinates.** WPILib blue-origin field frame. +x points from the blue wall toward the red wall, +y points left from the blue driver station, and headings are CCW-positive radians. The pose supplier must return the blue-origin pose **on both alliances**, which is what CTRE's `getState().Pose` returns.
- **Speeds.** `DriveCommand.fieldSpeeds` are field-relative. Use `DriveCommand.robotSpeeds(heading)` if your drivetrain wants robot-relative speeds.
- **Forces.** `DriveCommand.wheelForceX/Y` are per-module forces in the **field frame**, in newtons. This matches what CTRE's `ApplyFieldSpeeds.withWheelForceFeedforwardsX/Y` expects.
- **Module order.** **FL, FR, BL, BR.** This is the Tuner X order in `new CommandSwerveDrivetrain(constants, FrontLeft, FrontRight, BackLeft, BackRight)`. The robot in the Mayhem app must use the same order. If the trajectory's force arrays don't match `FollowerConfig.modules`, the force feedforward is dropped (sent as zeros).
- **Headings in samples** are unwrapped (continuous). `TrajectorySample.getPose()` wraps them.
- **Alliance.** Paths are authored on blue and flipped using the field symmetry stored in the file. See [Splits and alliance flipping](/lib/splits-and-alliance#alliance-flipping).
