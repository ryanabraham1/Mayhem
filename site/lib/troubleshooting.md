# Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Could not read trajectory .../deploy/mayhem/X.mtraj` | The file isn't in `src/main/deploy/mayhem/`, or the name's case differs (the roboRIO file system is case sensitive). In simulation and tests the deploy directory is `<project>/src/main/deploy`. |
| `Trajectory 'X' has not been generated yet` | The file has inputs but no solved output. Generate it in the app; saving and deploy-folder copying happen automatically. |
| `uses format N but this MayhemLib supports up to M` | The app is newer than the library. Update MayhemLib (**Manage Vendor Libraries**, then **Check for updates (online)**). |
| `Trajectory has no field data to flip with` | The file has no recovery payload. Re-export it from a current app version. |
| Gradle: `Could not resolve mayhemlib:MayhemLib-java` | The machine is offline on first build, or `vendordeps/MayhemLib.json` is an old or hand-edited copy (no `mavenUrls`). Reinstall it with [Option A](/lib/installation#option-a-online-install-recommended), or use Option B offline. |
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
