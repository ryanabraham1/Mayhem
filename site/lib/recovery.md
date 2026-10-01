# Bump recovery

The follower responds to tracking error in three layers:

1. **Saturated feedback.** P feedback on position and heading, added to the feedforward and clamped to `maxFeedbackVelocity` and `maxFeedbackOmega`. A large error can never cause a lurch.
2. **Time dilation.** As position or heading error grows, the trajectory clock slows down. The feedforward velocity scales by `rate` and the forces by `rate²`. At large error the clock stops, so the reference waits for the robot.
3. **Bridge.** A sustained large error or an accelerometer spike counts as a hit. After a hit, the planner builds the fastest quintic "bridge" from the robot's current state back onto the trajectory that respects the exported velocity and acceleration limits. It considers several join times, bounded by the next must-hit point.

::: warning No obstacle avoidance during recovery
Bridges go straight back to the path. There is **no obstacle avoidance** while recovering: this keeps planning cheap on the roboRIO (well under 1 ms). When the robot rejoins, normal following resumes. Test bumps away from field structures first.
:::

Use `traj.recovering()` to react to a bridge in robot code, for example to flash LEDs.

## `RecoveryConfig`

Pass it with `withRecoveryConfig(...)`. Fields are public, in SI units, with angles in radians.

| Field | Default | What it does |
|---|---|---|
| `enabled` | `true` | Enables hit recovery and ordinary error-based time dilation. Rough-terrain handling still applies when disabled. |
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
| `visionBoostSeconds` | 1.0 s | How long `withVisionBoost` reports `true` after a hit or after leaving rough terrain. |
| `terrainClockGain` | 10.0 1/s | How quickly the reference clock follows along-track lag on rough terrain. |
| `terrainGraceSeconds` | 0.3 s | How long hit detection stays off after leaving rough terrain. |
| `endTolerance` / `endHeadingTolerance` | 0.05 m / 0.05 rad | When the trajectory ends at rest, the command ends once the robot is within these tolerances. |
| `endTimeout` | 1.0 s | Stop waiting to settle after this long. |

## Intake spans

Where a path has an [Intake extended](/app/constraints#intake-extended) constraint, the solver keeps the extended intake clear of obstacles and walls, and the exported file marks that time. `AutoTrajectory.intakeExtended()` is a trigger that is true while the plan has the intake out, so bind your deploy command to it:

```java
traj.intakeExtended().whileTrue(intake.deploy());
```

During a bridge it stays true if the plan has the intake out anywhere between the hit and the join.

## Rough-terrain zones

Mark each bump as [rough terrain](/app/constraints#rough-terrain) in the app's Field mode (the REBUILT preset already does, and it applies to every path), or draw a zone on a single path. The solver marks the covered trajectory time without reducing planned speed. In the zone, the runner keeps the planned feedforward command, softens feedback, and advances trajectory time according to the robot's along-track progress. It skips hit detection and replanning there and for a short grace period after exit.

`withVisionBoost` rises after the zone so the pose estimator can correct drift. Markers remain attached to trajectory time. `AutoTrajectory.onRoughTerrain()` exposes the active zone as a trigger, and `/Mayhem/onRoughTerrain` reports it through [telemetry](/lib/telemetry).

## Auto unbeach

Fuel can high-center the robot: it climbs a pile and its belly ends up resting on the balls, wheels
spinning. Auto unbeach uses the IMU to notice, backs the robot off the pile, and then continues the
auto.

```java
AutoFactory autoFactory = CtreSwerve.autoFactory(drivetrain)   // wires the drivetrain's Pigeon 2
    .withUnbeach();                                            // opt in; or withUnbeach(new UnbeachConfig()...)
```

How it works:

1. **Detect.** Tilt is the angle between the robot's up axis and vertical, from the Pigeon 2's pitch
   and roll. Tilt of at least `tiltThresholdDegrees` for `detectSeconds` counts as beached. It is
   not checked on [rough-terrain zones](#rough-terrain-zones), where tilting is expected, so mark
   every real bump as rough terrain.
2. **Escape.** The trajectory clock pauses. The robot drives toward a point `escapeDistance` away
   in the downhill direction (the way the robot's up axis leans, so nose-up means backward), at up
   to `escapeSpeed`, holding its heading. The point is kept `fieldMargin` inside the field walls.
   It is re-picked from the current tilt every `retargetSeconds`, or when reached while still tilted.
3. **Resume.** After the tilt stays under `flatThresholdDegrees` for `flatSeconds`, the trajectory
   continues from where the clock paused. If the escape left the robot far from the path, normal
   [time dilation and bridge recovery](/lib/recovery) bring it back. If it is still tilted after
   `maxSeconds`, the runner gives up and resumes anyway, and waits `cooldownSeconds` before trying again.

Like bridges, the escape has **no obstacle avoidance**. It works inside a trajectory (following or
bridging); it does not run between trajectories or while a trajectory is settling at its end.

Pitch and roll must follow the CTRE Pigeon 2 convention (positive pitch is nose down, positive roll
is left side up), and the Pigeon's mount pose in Tuner X must be correct. With a different IMU,
pass your own suppliers (in degrees) to `withTiltSensor(pitch, roll)`.

`traj.unbeaching()` is a trigger that is true during the escape, for example to stop a spinning
intake: `traj.unbeaching().whileTrue(intake.stopCommand())`.

`UnbeachConfig` fields (public, SI units, tilt in degrees):

| Field | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `tiltThresholdDegrees` | 8 | Tilt at or above which the robot may be beached. |
| `detectSeconds` | 0.2 s | How long the tilt must persist. |
| `flatThresholdDegrees` / `flatSeconds` | 4 / 0.15 s | Tilt at or below which the robot is flat, and how long it must stay so, before the auto resumes. |
| `escapeDistance` | 1.0 m | Distance of the escape point from the robot. |
| `escapeSpeed` / `minEscapeSpeed` | 2.0 / 0.8 m/s | Fastest and slowest speed toward the escape point. |
| `escapeKp` | 4.0 | Gain on distance to the escape point [(m/s)/m]. |
| `reachTolerance` | 0.1 m | Distance at which the escape point counts as reached. |
| `retargetSeconds` | 0.75 s | How often a new escape point is chosen while still beached. |
| `maxSeconds` | 2.5 s | Give up and resume the auto after this long. |
| `cooldownSeconds` | 0.75 s | Wait after an unbeach before another can start. |
| `fieldMargin` | 0.4 m | Keep escape points this far inside the field walls. |

## Optional: `SleipnirBridgeRefiner`

`withRefiner(new SleipnirBridgeRefiner())` adds a second planning stage on a background thread. It solves a small minimum-time problem with Sleipnir, the optimizer behind Choreo. The robot starts driving the coarse bridge immediately. If the refined bridge arrives within about 0.12 s and is faster, it replaces the coarse one. It is still collision-checked before use.

- **This requires the SleipnirJava vendordep** (`https://file.tavsys.net/sleipnir/SleipnirJava.json`). Without it, classes such as `org.wpilib.math.optimization.Problem` fail to load, but only when the refiner is actually used.
- The refiner is off by default. A roboRIO 2 rarely finishes in time, so the refiner mostly helps on faster controllers or in simulation. Solver failures and missing native libraries fall back quietly to the coarse bridge.
- The constructor is `SleipnirBridgeRefiner(samples, timeoutSeconds, collisionStep)`. The defaults are 16, 0.05 s, and 0.04 s.
