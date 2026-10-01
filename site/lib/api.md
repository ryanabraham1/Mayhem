# AutoFactory, routines and triggers

## `AutoFactory`

Create one factory per drivetrain. The `bind` and `with*` methods return `this`.

| Method | Purpose |
|---|---|
| `newRoutine(String name)` | A new, empty `AutoRoutine`. |
| `voidRoutine()` | A routine that does nothing. |
| `trajectoryCmd(name)`, `trajectoryCmd(name, splitIndex)` | Follow command for a trajectory, without a routine. Markers still run bound commands. |
| `resetOdometry(name)`, `resetOdometry(name, splitIndex)` | Resets the pose to the alliance-correct start of a trajectory. |
| `bind(name, Supplier<Command>)` | Runs a fresh command each time a marker with this command name fires. Prefer this form. |
| `bind(name, Command)` | Reuses one command instance (Choreo's form). Don't also put that instance in another composition. |
| `withFollowerConfig(FollowerConfig)` | Follower gains and limits. See [Tuning](/lib/tuning). |
| `withRecoveryConfig(RecoveryConfig)` | Hit detection and recovery knobs. See [Bump recovery](/lib/recovery). |
| `withAccelerometer(DoubleSupplier g)` | Horizontal acceleration in g, used for collision detection. `NaN` disables the spike check. |
| `withTiltSensor(DoubleSupplier pitchDeg, DoubleSupplier rollDeg)` | IMU pitch and roll for auto unbeach (CTRE Pigeon 2 convention). `CtreSwerve` sets it for you. |
| `withUnbeach()`, `withUnbeach(UnbeachConfig)` | Turns on auto unbeach. See [Auto unbeach](/lib/recovery#auto-unbeach). |
| `withVisionBoost(Consumer<Boolean>)` | Called with `true` for `visionBoostSeconds` after a detected hit or after leaving rough terrain, and with `false` otherwise. |
| `withAllianceFlip(BooleanSupplier)` | Overrides alliance detection: return true to run the red-alliance version. |
| `withRefiner(BridgeRefiner)` | Optional background bridge optimizer, for example `SleipnirBridgeRefiner`. |
| `withTelemetry(boolean)` | Publishes follower state to NetworkTables under `/Mayhem`. |

## `AutoRoutine`

A routine owns an event loop that `cmd()` polls, so triggers made from it (and from its trajectories) only react while it runs. Bind the first step to `active()`.

| Member | Purpose |
|---|---|
| `trajectory(name)`, `trajectory(name, splitIndex)`, `trajectory(MayhemTrajectory)` | An `AutoTrajectory` in this routine. Split segments start at time 0. |
| `active()` | `Trigger`: true while the routine runs. |
| `idle()` | `Trigger`: true while none of its trajectories is running. |
| `observe(BooleanSupplier)` | A `Trigger` on the routine's loop. |
| `anyDone(...)`, `allDone(...)`, `anyActive(...)`, `allInactive(...)` | Combined trajectory triggers. |
| `cmd()`, `cmd(BooleanSupplier finish)` | Runs the routine until cancelled (normally when autonomous ends), killed, or `finish` is true. When it ends, its trajectory commands are cancelled. |
| `kill()`, `reset()`, `poll()`, `loop()` | Lifecycle, as in Choreo. |

## `AutoTrajectory`

| Member | Purpose |
|---|---|
| `cmd()` | Follows the trajectory with recovery, requires the drivetrain, and ends when finished. It resolves the alliance and flips when the command **starts**. |
| `spawnCmd()` | Schedules `cmd()` without waiting for it. |
| `resetOdometry()` | Resets the pose to the alliance-correct start pose. |
| `chain(next)` | Starts `next.cmd()` when this one is done. |
| `active()`, `inactive()` | `Trigger`: while `cmd()` runs / doesn't. |
| `done()`, `doneDelayed(cycles)` | `Trigger`: true for one cycle after `cmd()` finishes (not when interrupted). |
| `doneFor(seconds)`, `recentlyDone()` | `Trigger`: true for a time after finishing / until another trajectory in the routine starts. |
| `atTime(double seconds)` | `Trigger`: true for one cycle when the trajectory clock passes that time. |
| `atTime(String event)` | `Trigger`: true for one cycle when an instant marker fires, or for the whole duration of a zone marker. |
| `atPose(event, tolM, tolRad)`, `atTranslation(event, tolM)` | `Trigger`: while the robot is near where that marker sits on the path. `Pose2d`/`Translation2d` overloads take blue-alliance coordinates. |
| `recovering()` | `Trigger`: true while the robot follows a recovery bridge. MayhemLib only. |
| `intakeExtended()` | `Trigger`: true while the plan has the intake out. See [Constraints](/app/constraints#intake-extended). |
| `unbeaching()` | `Trigger`: true while auto unbeach drives the robot off a pile of fuel. MayhemLib only. |
| `onRoughTerrain()` | `Trigger`: true while the reference is inside a rough-terrain zone. |
| `getInitialPose()`, `getFinalPose()` | Alliance-correct poses, resolved when called. |
| `getRawTrajectory()` | The underlying `MayhemTrajectory`, as authored (blue). |

You can build routines in the constructor, before the FMS or Driver Station reports an alliance. Flipping happens when each trajectory command starts.

## `AutoChooser`

A dashboard chooser that only builds the selected option, when it is picked while disabled.

| Member | Purpose |
|---|---|
| `addRoutine(name, Supplier<AutoRoutine>)` | Adds a routine option. |
| `addCmd(name, Supplier<Command>)` | Adds a plain command option. |
| `selectedCommand()` | The selected option's command. |
| `selectedCommandScheduler()` | Runs the selected command as a proxy. Use `RobotModeTriggers.autonomous().whileTrue(chooser.selectedCommandScheduler())`. |

## A complete routine

```java
AutoRoutine hubCycle() {
  AutoRoutine routine = autoFactory.newRoutine("Hub Cycle");
  AutoTrajectory toHub = routine.trajectory("Hub Cycle", 0);     // split segment 0
  AutoTrajectory toIntake = routine.trajectory("Hub Cycle", 1);  // split segment 1

  routine.active().onTrue(Commands.sequence(toHub.resetOdometry(), toHub.cmd()));
  toHub.done().onTrue(shooter.shootOnce().andThen(toIntake.cmd()));
  toIntake.atTime("deploy").onTrue(intake.deploy());   // marker (or zone) named "deploy"
  toHub.recovering().onTrue(leds.flashRed());          // MayhemLib extra: bumped off the path
  return routine;
}
```

## Framework-free runner

`mayhemlib.runner.TrajectoryRunner` is the whole follower (dilation, recovery, and events) with no command-based dependencies. Call `start(now)`, then call `update(now, pose, fieldSpeeds, accelG)` every loop, then send the returned `DriveCommand` to your drivetrain. Use it for custom frameworks and unit tests. See `lib/src/test/java/mayhemlib/RecoveryTest.java` in the repo.
