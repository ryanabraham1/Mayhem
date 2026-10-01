# Coming from Choreo

MayhemLib's API is modeled on ChoreoLib's. The one real difference is that you don't write a controller. MayhemLib runs feedback, time dilation and bump recovery itself and hands your drivetrain field speeds plus per-module force feedforward.

| Choreo | MayhemLib |
|---|---|
| `new AutoFactory(pose, resetOdometry, controller, flip, drive)` | `new AutoFactory(pose, resetOdometry, fieldSpeeds, driveCommandConsumer, flip, drive)`, or `CtreSwerve.autoFactory(drivetrain)` |
| `routine.trajectory("name")`, `routine.trajectory("name", split)` | Same. Loads `deploy/mayhem/<name>.mtraj`. |
| `traj.atTime("event")` | Same. Also stays true for the whole duration of a zone marker. |
| `SwerveSample` + your own PID in the controller | Built in. Tune with `withFollowerConfig(...)`. |
| — | `traj.recovering()`, `withRecoveryConfig(...)`, `withVisionBoost(...)`, `withTelemetry(true)` |

## Differences to keep in mind

- **No controller to write.** Pass a measured-speeds supplier and a `DriveCommand` consumer instead. Tune the built-in follower under [Tuning the follower](/lib/tuning).
- **Force feedforward.** The command carries per-module wheel forces (`wheelForceX/Y`, field frame, newtons) in addition to field speeds.
- **Bump recovery.** If the robot gets knocked off the path, it takes the fastest feasible bridge back. See [Bump recovery](/lib/recovery).
- **Module order.** FL, FR, BL, BR. The robot in the Mayhem app must use the same order as your drivetrain. See [Conventions](/reference/conventions).
