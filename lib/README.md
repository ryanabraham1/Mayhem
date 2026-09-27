# MayhemLib

MayhemLib is the robot-side library for **Mayhem** trajectories on WPILib 2026 (FRC REBUILT). It
loads the `.mtraj` files the Mayhem app writes, follows them with a feedforward plus saturated
feedback controller that includes per-module force feedforward, and runs event markers. When the
robot gets knocked off its path, the library notices and gets it back on the path without hitting
field elements.

- Java 17, package `mayhemlib`, published as `mayhemlib:MayhemLib-java`.
- Built against WPILib 2026.2.x, Phoenix 6 26.x (optional, used for `CtreSwerve`), and
  SleipnirJava 2026 (optional, used for `SleipnirBridgeRefiner`). All three are `compileOnly`
  dependencies. Your robot project supplies them, and MayhemLib bundles none of them.
- A complete robot project lives at [`../examples/robot-2026`](../examples/robot-2026). It has a
  Tuner X swerve, an auto chooser, split and branch autos, alliance flipping, and simulated bumps.
  It also has a JUnit test that runs the autos against the CTRE swerve simulation.

---

## Installation

### Option A: install into a robot project on this machine (recommended)

```bash
cd lib
./gradlew installVendordep -ProbotProject=/path/to/your/robot/project
```

This command does two things:

1. It publishes the jar, sources, and javadoc to `~/wpilib/2026/maven`. GradleRIO always searches
   that directory, so you don't need to add a repository.
2. It writes `vendordeps/MayhemLib.json` into your robot project.

Run it again after you update MayhemLib. Every machine that builds robot code needs the artifact in
its `~/wpilib/2026/maven`, so run the command on each machine or use option B.

To publish without touching a robot project, leave off `-ProbotProject`. To change the version,
add `-PmayhemVersion=2026.1.0`.

### Option B: share a maven repository

```bash
cd lib
./gradlew publishJavaPublicationToLocalRepository            # writes build/repos/releases/
./gradlew vendordepJson -PmavenUrl=https://example.org/maven/ # writes build/vendordeps/MayhemLib.json
```

You have two ways to share the result:

- Copy `build/repos/releases/mayhemlib/` into `~/wpilib/2026/maven/` on every machine.
- Host `build/repos/releases/` somewhere (GitHub Pages works), then commit the generated
  `MayhemLib.json`. Its `mavenUrls` points at the hosted repository, so GradleRIO downloads the
  library the way it does for any other vendordep.

### Robot project requirements

| Dependency | Needed for | How to get it |
| --- | --- | --- |
| WPILib 2026 GradleRIO (`2026.2.1` or newer) | everything | WPILib installer |
| Phoenix 6 vendordep | `mayhemlib.ctre.CtreSwerve` | `https://maven.ctr-electronics.com/release/com/ctre/phoenix6/latest/Phoenix6-frc2026-latest.json` |
| SleipnirJava vendordep | `SleipnirBridgeRefiner` only | `https://file.tavsys.net/sleipnir/SleipnirJava.json` |

Building MayhemLib itself needs JDK 17 or newer. The bytecode always targets Java 17 (`--release 17`).
Run the tests with `./gradlew test`.

---

## Quick start (CTRE Tuner X swerve)

The API follows ChoreoLib's (`AutoFactory`, `AutoRoutine`, `AutoTrajectory`, `AutoChooser`), so
Choreo code ports with few changes. The one real difference is that you don't write a controller:
MayhemLib runs the feedback, time dilation and bump recovery, and gives your drivetrain a finished
`DriveCommand`.

The Mayhem app deploys trajectories to `src/main/deploy/mayhem/<Name>.mtraj`.

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
- **controller output**: `SwerveRequest.ApplyFieldSpeeds` with `DriveRequestType.Velocity`, forward
  perspective `BlueAlliance` (so the operator perspective never affects autos), wheel-speed
  desaturation, and `withWheelForceFeedforwardsX/Y` from the trajectory.
- **alliance flipping**: on, from the Driver Station alliance.
- **accelerometer**: the horizontal acceleration magnitude from the drivetrain's Pigeon 2, in g,
  used for hit detection.
- **requirements**: the drivetrain subsystem.

If your drivetrain and subsystem are separate objects, use
`CtreSwerve.autoFactory(drivetrain, subsystem)`.

### Other drivetrains

The constructor mirrors Choreo's, with a measured-speeds supplier added and a `DriveCommand`
consumer in place of the sample controller:

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

### Coming from Choreo

| Choreo | MayhemLib |
| --- | --- |
| `new AutoFactory(pose, resetOdometry, controller, flip, drive)` | `new AutoFactory(pose, resetOdometry, fieldSpeeds, driveCommandConsumer, flip, drive)`, or `CtreSwerve.autoFactory(drivetrain)` |
| `routine.trajectory("name")`, `routine.trajectory("name", split)` | Same. Loads `deploy/mayhem/<name>.mtraj`. |
| `traj.atTime("event")` | Same. Also stays true for the whole duration of a zone marker. |
| `SwerveSample` + your own PID in the controller | Built in. Tune with `withFollowerConfig(...)`. |
| — | `traj.recovering()`, `withRecoveryConfig(...)`, `withVisionBoost(...)`, `withTelemetry(true)` |

---

## API overview

### `AutoFactory`

Create one factory per drivetrain. The `bind` and `with*` methods return `this`.

| Method | Purpose |
| --- | --- |
| `newRoutine(String name)` | A new, empty `AutoRoutine`. |
| `voidRoutine()` | A routine that does nothing. |
| `trajectoryCmd(name)`, `trajectoryCmd(name, splitIndex)` | Follow command for a trajectory, without a routine. Markers still run bound commands. |
| `resetOdometry(name)`, `resetOdometry(name, splitIndex)` | Resets the pose to the alliance-correct start of a trajectory. |
| `bind(name, Supplier<Command>)` | Runs a fresh command each time a marker with this command name fires. Prefer this form. |
| `bind(name, Command)` | Reuses one command instance (Choreo's form). Don't also put that instance in another composition. |
| `withFollowerConfig(FollowerConfig)` | Follower gains and limits (see [Tuning](#tuning-the-follower)). |
| `withRecoveryConfig(RecoveryConfig)` | Hit detection and recovery knobs (see [Recovery](#bump-recovery)). |
| `withAccelerometer(DoubleSupplier g)` | Horizontal acceleration in g, used for collision detection. `NaN` disables the spike check. |
| `withVisionBoost(Consumer<Boolean>)` | Called with `true` for `visionBoostSeconds` after a detected hit and with `false` otherwise. |
| `withAllianceFlip(BooleanSupplier)` | Overrides alliance detection: return true to run the red-alliance version. |
| `withRefiner(BridgeRefiner)` | Optional background bridge optimizer, for example `SleipnirBridgeRefiner`. |
| `withTelemetry(boolean)` | Publishes follower state to NetworkTables under `/Mayhem`. |

### `AutoRoutine`

A routine owns an event loop that `cmd()` polls, so triggers made from it (and from its
trajectories) only react while it runs. Bind the first step to `active()`.

| Member | Purpose |
| --- | --- |
| `trajectory(name)`, `trajectory(name, splitIndex)`, `trajectory(MayhemTrajectory)` | An `AutoTrajectory` in this routine. Split segments start at time 0. |
| `active()` | `Trigger`: true while the routine runs. |
| `idle()` | `Trigger`: true while none of its trajectories is running. |
| `observe(BooleanSupplier)` | A `Trigger` on the routine's loop. |
| `anyDone(...)`, `allDone(...)`, `anyActive(...)`, `allInactive(...)` | Combined trajectory triggers. |
| `cmd()`, `cmd(BooleanSupplier finish)` | Runs the routine until cancelled (normally when autonomous ends), killed, or `finish` is true. When it ends, its trajectory commands are cancelled. |
| `kill()`, `reset()`, `poll()`, `loop()` | Lifecycle, as in Choreo. |

### `AutoTrajectory`

| Member | Purpose |
| --- | --- |
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
| `getInitialPose()`, `getFinalPose()` | Alliance-correct poses, resolved when called. |
| `getRawTrajectory()` | The underlying `MayhemTrajectory`, as authored (blue). |

You can build routines in the constructor, before the FMS or Driver Station reports an alliance.
Flipping happens when each trajectory command starts.

### `AutoChooser`

A dashboard chooser that only builds the selected option, when it is picked while disabled.

| Member | Purpose |
| --- | --- |
| `addRoutine(name, Supplier<AutoRoutine>)` | Adds a routine option. |
| `addCmd(name, Supplier<Command>)` | Adds a plain command option. |
| `selectedCommand()` | The selected option's command. |
| `selectedCommandScheduler()` | Runs the selected command as a proxy. Use `RobotModeTriggers.autonomous().whileTrue(chooser.selectedCommandScheduler())`. |

### Event markers and zones

The app offers two kinds of markers:

- **Instant markers** fire once, when the trajectory clock crosses their time.
- **Zone markers** ("during" markers) start at `t` and end at `endT`.

When a marker fires, the factory looks up the command bound to the marker's **command** name. If
the app left the command field empty, the lookup uses the marker name. The factory then schedules
that command. When a zone ends, its command is cancelled. The command is also cancelled if the
trajectory command is interrupted. If no command is bound to a name, the marker is ignored, but
`atTime(name)` still works.

```java
autoFactory.bind("intake", () -> intake.run());      // zone: runs while inside the zone
AutoTrajectory t = routine.trajectory("HubCycle");
t.atTime("score").onTrue(shooter.shootOnce());       // trigger style, no bind needed
t.recovering().onTrue(leds.flashRed());
```

- Bound commands **must not require the drivetrain**. If one did, it would interrupt path following.
- Markers follow the **trajectory clock**, not the match clock. When time dilation slows the
  reference, markers wait for the robot too.
- A marker at `t = 0` fires when the command starts. A marker at the very end fires when the clock
  reaches the end, before the robot finishes settling.
- A marker that sits exactly on a split point belongs to the following segment. It fires when that
  segment starts.

### Split segments and branching

Split points in the app divide one solved path into chained segments. Usually the split sits at a
stop waypoint. `routine.trajectory(name, i)` returns segment `i` with its time rebased to start at
0. The rebasing also covers the segment's events, waypoint times, and must-hit times. The segment
end is always a must-hit point, so recovery never skips past it.

```java
AutoRoutine routine = autoFactory.newRoutine("HubCycle");
AutoTrajectory toHub = routine.trajectory("HubCycle", 0);
AutoTrajectory toIntake = routine.trajectory("HubCycle", 1);
routine.active().onTrue(Commands.sequence(toHub.resetOdometry(), toHub.cmd()));
toHub.done().onTrue(shooter.shootOnce().andThen(
    Commands.either(toIntake.cmd(), Commands.none(), intake::hasRoom)));
return routine;
```

Only call `resetOdometry()` on the first segment. Later segments start where the previous one
ended. On a trajectory without splits, split index 0 is the whole trajectory.

### Alliance flipping

Author trajectories in **blue-alliance coordinates**. The red version is derived from the field
symmetry stored in the file:

- `ROTATIONAL` (REBUILT 2026) maps (x, y, θ) to (L − x, W − y, θ + π). Vectors negate, and ω stays
  the same.
- `MIRROR` maps (x, y, θ) to (L − x, y, π − θ). vx negates, ω negates, and the left and right module
  forces swap (FL↔FR, BL↔BR).

Obstacles and the roadmap flip together with the path, so recovery works on both alliances. To
override the alliance, for example with a dashboard toggle during practice, use
`withAllianceFlip(...)`. `MayhemTrajectory.flipped()` is also public if you need it directly.

### Bump recovery

The follower responds to tracking error in three layers:

1. **Saturated feedback.** P feedback on position and heading, added to the feedforward and clamped
   to `maxFeedbackVelocity` and `maxFeedbackOmega`. A large error can never cause a lurch.
2. **Time dilation.** As position or heading error grows, the trajectory clock slows down. The
   feedforward velocity scales by `rate` and the forces by `rate²`. At large error the clock stops,
   so the reference waits for the robot.
3. **Bridge.** A sustained large error or an accelerometer spike counts as a hit. After a hit, the
   planner builds the fastest collision-free quintic "bridge" from the robot's current state back
   onto the trajectory. It considers several join times, bounded by the next must-hit point. If
   every direct bridge is blocked, it routes through the exported roadmap. When the robot rejoins,
   normal following resumes. This is pure Java and typically takes well under 1 ms.

`RecoveryConfig` fields (public, SI units, angles in radians):

| Field | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `new RecoveryConfig().disabled()` leaves only saturated feedback. It also turns off time dilation. |
| `dilationStartError` / `dilationStopError` | 0.08 / 0.40 m | Position error where the clock starts slowing and where it stops completely. |
| `dilationStartHeading` / `dilationStopHeading` | 0.15 / 0.70 rad | The same for heading. The slower of the two rates applies. |
| `bridgeTriggerError` / `bridgeTriggerHeading` | 0.45 m / 0.8 rad | Error that counts as knocked off the path once it persists. |
| `persistenceLoops` | 3 | Consecutive loops the error must stay above the trigger. |
| `accelSpikeG` | 1.0 g | Measured horizontal acceleration **above the planned acceleration** that counts as a hit. A spike only triggers when the position error is at least `dilationStartError`. |
| `joinCandidates` | 12 | Number of join times evaluated per plan. |
| `maxJoinLookahead` / `maxJoinBehind` | 2.5 / 1.0 s | Join window around the current trajectory time. The next must-hit point limits it further. |
| `replanError` | 0.5 m | While bridging, replan if the robot drifts this far from the bridge. |
| `minReplanInterval` | 0.25 s | Minimum time between plans. |
| `limitScale` | 1.0 | Scales the conservative velocity and acceleration limits the app exports for bridges. |
| `collisionCheckStep` | 0.04 s | Time step of the swept-bumper collision check. |
| `visionBoostSeconds` | 1.0 s | How long `withVisionBoost` reports `true` after a hit. |
| `endTolerance` / `endHeadingTolerance` | 0.05 m / 0.05 rad | When the trajectory ends at rest, the command ends once the robot is within these tolerances. |
| `endTimeout` | 1.0 s | Stop waiting to settle after this long. |

**Marker policy during a bridge.** A bridge can jump over part of the trajectory. Each marker in the
jumped-over window follows its policy, which you set in the app:

| Policy | Behavior |
| --- | --- |
| `fireAtJoin` (default) | Fires when the robot rejoins, in order. |
| `fireImmediately` | Fires as soon as the bridge is planned. |
| `skip` | Doesn't fire. Zones with this policy neither start nor end. |

A zone whose end falls inside the jumped window is closed at the join. Markers flagged **must-hit**
bound the join window, so they are never jumped over.

### Telemetry

`withTelemetry(true)` publishes these topics. NetworkTables DataLog captures them too.

| Topic | Type | Contents |
| --- | --- | --- |
| `/Mayhem/trajectory` | `Pose2d[]` (struct) | The active trajectory, downsampled to about 150 poses. |
| `/Mayhem/reference` | `Pose2d` (struct) | The pose the follower is tracking right now, on the trajectory or on a bridge. |
| `/Mayhem/bridge` | `Pose2d[]` (struct) | The current recovery bridge. Empty when there is none. |
| `/Mayhem/state` | string | `FOLLOWING`, `BRIDGING`, `SETTLING`, `FINISHED`, or `IDLE`. |
| `/Mayhem/name` | string | Trajectory name. Segments appear as `Name[i]`. |
| `/Mayhem/time` | double | Trajectory clock [s]. |
| `/Mayhem/clockRate` | double | Time-dilation rate, from 0 to 1. |
| `/Mayhem/positionError` | double | Distance from the reference [m]. |
| `/Mayhem/lastPlanMs` | double | Duration of the last bridge plan [ms]. |
| `/Mayhem/bridgesPlanned` | double | Bridges planned during the current run. |

In AdvantageScope, drag `trajectory`, `reference`, and `bridge` onto a 2D field next to your robot pose.

### Simulated bumps (`mayhemlib.sim.BumpInjector`)

To test recovery at a desk, shove the simulated pose estimate the way a real hit plus vision
correction would:

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

### Optional: `SleipnirBridgeRefiner`

`withRefiner(new SleipnirBridgeRefiner())` adds a second planning stage on a background thread. It
solves a small minimum-time problem with Sleipnir, the optimizer behind Choreo. The robot starts
driving the coarse bridge immediately. If the refined bridge arrives within about 0.12 s and is
faster, it replaces the coarse one. It is still collision-checked before use.

- **This requires the SleipnirJava vendordep**
  (`https://file.tavsys.net/sleipnir/SleipnirJava.json`). Without it, classes such as
  `org.wpilib.math.optimization.Problem` fail to load, but only when the refiner is actually used.
- The refiner is off by default. A roboRIO 2 rarely finishes in time, so the refiner mostly helps on
  faster controllers or in simulation. Solver failures and missing native libraries fall back
  quietly to the coarse bridge.
- The constructor is `SleipnirBridgeRefiner(samples, timeoutSeconds, collisionStep)`. The defaults
  are 16, 0.05 s, and 0.04 s.

### Framework-free runner

`mayhemlib.runner.TrajectoryRunner` is the whole follower (dilation, recovery, and events) with no
command-based dependencies. Call `start(now)`, then call `update(now, pose, fieldSpeeds, accelG)`
every loop, then send the returned `DriveCommand` to your drivetrain. Use it for custom frameworks
and unit tests. See `lib/src/test/java/mayhemlib/RecoveryTest.java`.

---

## Conventions

- **Coordinates:** WPILib blue-origin field frame. +x points from the blue wall toward the red wall,
  +y points left from the blue driver station, and headings are CCW-positive radians. The pose
  supplier must return the blue-origin pose **on both alliances**, which is what CTRE's
  `getState().Pose` returns.
- **Speeds:** `DriveCommand.fieldSpeeds` are field-relative. Use `DriveCommand.robotSpeeds(heading)`
  if your drivetrain wants robot-relative speeds.
- **Forces:** `DriveCommand.wheelForceX/Y` are per-module forces in the **field frame**, in newtons.
  This matches what CTRE's `ApplyFieldSpeeds.withWheelForceFeedforwardsX/Y` expects.
- **Module order:** **FL, FR, BL, BR.** This is the Tuner X order in
  `new CommandSwerveDrivetrain(constants, FrontLeft, FrontRight, BackLeft, BackRight)`. The robot in
  the Mayhem app must use the same order. If the trajectory's force arrays don't match
  `FollowerConfig.modules`, the force feedforward is dropped (sent as zeros).
- **Headings in samples** are unwrapped (continuous). `TrajectorySample.getPose()` wraps them.

---

## Tuning the follower

`FollowerConfig` fields (public, or use the `with*` helpers):

| Field | Default | Notes |
| --- | --- | --- |
| `translationKp` | 6.0 (m/s)/m | Position feedback. |
| `translationKv` | 0 | Optional velocity-error feedback. |
| `rotationKp` | 5.0 (rad/s)/rad | Heading feedback. |
| `maxFeedbackVelocity` / `maxFeedbackOmega` | 1.5 m/s / 3.0 rad/s | Clamp on the feedback part only. |
| `maxVelocity` / `maxOmega` | 5.0 m/s / 12 rad/s | Clamp on the total command. |
| `useForceFeedforward` | true | Sends the trajectory's module forces. |
| `modules` | 4 | Number of swerve modules. |

Tune in this order:

1. **Drivetrain first.** Tune the drive-motor velocity gains (kS, kV, kP) and steer gains with SysId.
   These are in the Tuner X project, and `CommandSwerveDrivetrain` has SysId bindings. No path
   follower can make up for a slow velocity loop.
2. **Check the model.** Robot mass, MOI, wheel radius, and max speed in the Mayhem app must match the
   real robot. If they don't, the feedforward and force feedforward will be wrong.
3. **Feedforward only.** Set `translationKp` and `rotationKp` to 0 and run a path. The robot should
   end up close to the target, within about 10–20 cm. If it overshoots during acceleration phases,
   compare runs with `withForceFeedforward(false)`. The force feedforward depends on accurate motor
   and gearing constants in `TunerConstants`.
4. **Feedback.** Raise `translationKp` until tracking is tight without oscillation. Typical values
   are 4–10. Then raise `rotationKp` (typically 3–8).
5. **Recovery thresholds.** Watch `/Mayhem/positionError` during clean runs. Keep
   `dilationStartError` above your normal tracking error. Keep `bridgeTriggerError` well above your
   worst clean-run error, or bridges will trigger without a real hit.
6. **Accelerometer.** Log the Pigeon's horizontal g during hard accelerations. If `accelSpikeG`
   false-triggers, raise it, or disable the spike check with `withAccelerometer(() -> Double.NaN)`.
   Sustained-error detection still works without it.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Could not read trajectory .../deploy/mayhem/X.mtraj` | The file isn't in `src/main/deploy/mayhem/`, or the name's case differs (the roboRIO file system is case sensitive). In simulation and tests the deploy directory is `<project>/src/main/deploy`. |
| `Trajectory 'X' has not been generated yet` | The file has inputs but no solved output. Solve and deploy it in the app. |
| `uses format N but this MayhemLib supports up to M` | The app is newer than the library. Update MayhemLib and re-run `installVendordep`. |
| `Trajectory has no field data to flip with` | The file has no recovery payload. Re-export it from a current app version. |
| Gradle: `Could not resolve mayhemlib:MayhemLib-java` | This machine hasn't run `installVendordep`, or `MayhemLib.json` has no `mavenUrls` for your hosted repository. |
| `NoClassDefFoundError: com/ctre/phoenix6/...` | You use `CtreSwerve` without the Phoenix 6 vendordep. |
| `NoClassDefFoundError: org/wpilib/math/...` | You use `SleipnirBridgeRefiner` without the SleipnirJava vendordep. |
| Robot drives the wrong way or mirrored on red | The pose isn't blue-origin, you flipped the path yourself as well, or a `withAllianceFlip` override is wrong. Check `/Mayhem/reference` against the robot pose in AdvantageScope. |
| Robot starts in the wrong place | `resetOdometry()` is missing from the first step, or it was called on a later segment. |
| `/Mayhem/state` flips to `BRIDGING` without a hit | Tracking error exceeds `bridgeTriggerError`, often because of vision jumps or pose latency, or the Pigeon spike check is false-triggering. Tune the drivetrain, smooth vision, or raise the thresholds. |
| `clockRate` often drops below 1 | The robot can't keep up with the trajectory. Lower the app's velocity and acceleration limits, fix the drivetrain gains, or check that `maxVelocity` isn't clamping. |
| Auto takes about 1 s longer at the end | The robot never gets within `endTolerance`, so the command waits for `endTimeout`. Raise `translationKp` or loosen the tolerance. |
| A marker never runs its command | The bound name doesn't match the marker's **command** field (which overrides the marker name), or the marker was set to `skip` and recovery jumped over it. |
| "Commands that have been composed may not be added to another composition" | You passed one `Command` instance to `bind` and also used it elsewhere. Use `bind(name, () -> ...)`. |
| Joystick warnings in simulation | Harmless. No controller is plugged in. |

---

## Testing autos without a robot

The example project runs its autos in a JUnit test: `examples/robot-2026/src/test/java/frc/robot/AutoSimTest.java`.
The test builds the real `RobotContainer` with CTRE's swerve simulation, runs the autos in real time
on both alliances, injects a bump, and asserts that the robot finishes on the final pose:

```bash
cd examples/robot-2026
./gradlew test        # uses the WPILib JDK 17, e.g. JAVA_HOME=~/wpilib/2026/jdk
./gradlew simulateJava            # sim GUI; add -Pheadless to run without it
```

## Practice-robot validation

Simulation verifies the command wiring and one tracking-error recovery, but it does not verify
the Pigeon acceleration trigger or planning time on a roboRIO 2. Use this sequence before a match:

1. Run `./gradlew test` in both `lib/` and `examples/robot-2026/`. In the example, enable
   `Sim/Random bumps` in simulation and watch a full and split auto return to its path after
   injected pose offsets. Review `/Mayhem/reference` and `/Mayhem/bridge` against the robot pose.
2. Deploy the example to a practice robot with a current Mayhem path. Confirm blue-origin pose,
   FL/FR/BL/BR module order, alliance rotation, and marker commands at low speed with recovery
   disabled. Then enable recovery and repeat on both alliances.
3. With the robot in a clear, controlled area, apply a gentle manual displacement during a
   slow auto. Log `/Mayhem/state`, `/Mayhem/positionError`, `/Mayhem/clockRate`,
   `/Mayhem/bridge`, `/Mayhem/bridgesPlanned`, and `/Mayhem/lastPlanMs`. The state should move
   through `BRIDGING` and return to `FOLLOWING`; no bridge should cross a field obstacle or a
   must-hit marker. Also log Pigeon horizontal acceleration alongside planned acceleration to
   tune `accelSpikeG` and distinguish a real hit from normal traction-limited driving.
4. On the roboRIO 2, repeat several bumps and inspect the **maximum** `/Mayhem/lastPlanMs`, not
   just its average. Target under 5 ms per bridge plan and confirm the 20 ms robot loop stays
   healthy. If either budget is missed, reduce `joinCandidates`, increase
   `collisionCheckStep` only after checking clearance, and rerun the same obstacle cases.

Keep the refiner disabled on the roboRIO 2 unless its separate runtime and collision checks are
measured there. Record the robot configuration, path, DataLog, largest planning time, and final
pose error for each practice run; simulation results alone do not establish on-field safety.
