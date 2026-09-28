# Mayhem

Time-optimal swerve trajectory planning for FRC (2026 REBUILT), with on-robot bump recovery.

## Download the desktop app

Get the latest installer from [GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases/latest):

| System | File to download |
|---|---|
| macOS Apple Silicon | `Mayhem_*_aarch64.dmg` |
| macOS Intel | `Mayhem_*_x64.dmg` |
| Windows 10/11 (x64) | `Mayhem_*_x64-setup.exe` |
| Linux | `.AppImage` (portable) or `.deb` (Ubuntu/Debian) |

On macOS, drag Mayhem into Applications. These builds are not notarized, so if macOS blocks
the first launch, run `xattr -dr com.apple.quarantine /Applications/Mayhem.app` in Terminal.
On Windows, run the setup program; it installs for your user only, without an admin prompt.
The installer is not code-signed, so if SmartScreen stops it, click **More info**, then **Run anyway**.
From 0.6.0 on, Mayhem updates itself. It shows a banner when a new release is out and installs
the update when you click **Install & restart**.
For the robot library, download `MayhemLib-maven.zip` and `MayhemLib.json` from the same release;
see [installation instructions](lib/README.md).

- **Desktop app** (macOS, Windows and Linux): place waypoints on the field. Mayhem computes the fastest path your drivetrain can actually drive: motor torque-speed curves, stator current limits, wheel traction, mass and inertia. It routes around polygon obstacles using the robot's real bumper rectangle.
- **Robust solver**: CasADi + IPOPT, with parallel route candidates, a continuation ladder, and swept-collision verification. When a path truly can't be made, it tells you which waypoint or constraint is the problem and where.
- **MayhemLib** (Java vendordep for WPILib 2026 and CTRE Phoenix 6): follows paths with per-module force feedforward. If the robot gets knocked off its path, it detects the hit and takes the fastest feasible bridge back onto the trajectory (no obstacle avoidance during recovery, to keep the roboRIO load tiny).

| Part | Where | Docs |
|---|---|---|
| Desktop app (Tauri 2 + React) | [app/](app/) | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Solver (Python, CasADi/IPOPT) | [solver/](solver/) | [docs/SOLVER.md](docs/SOLVER.md) |
| Robot library (Java) | [lib/](lib/) | [lib/README.md](lib/README.md) |
| Example robot project | [examples/robot-2026/](examples/robot-2026/) | |
| Building and releasing | | [docs/BUILDING.md](docs/BUILDING.md) |

## Quick start (development)

```bash
cd solver && uv sync && uv run mayhem-solver serve --ws 8765
```

```bash
cd app && pnpm install && pnpm dev
```

Open http://localhost:5173. To run as a desktop app, build the solver sidecar once and use `pnpm tauri dev`; see [docs/BUILDING.md](docs/BUILDING.md).

## Using the paths on the robot (MayhemLib)

MayhemLib's API is modeled on ChoreoLib's `AutoFactory` / `AutoRoutine` / `AutoTrajectory` /
`AutoChooser`, so if you've used Choreo it should feel familiar. The main difference: you don't
write a controller. MayhemLib runs feedback, time dilation and bump recovery itself and hands
your drivetrain field speeds plus per-module force feedforward.

**1. Install the vendordep** into your robot project (or grab `MayhemLib.json` and
`MayhemLib-maven.zip` from the release; see [lib/README.md](lib/README.md#installation)):

```bash
cd lib && ./gradlew installVendordep -ProbotProject=/path/to/robot
```

**2. Generate paths in the app.** Save the project in `src/main/deploy/mayhem/`, or set that as its deploy folder in Project settings. Generated paths are saved and copied there automatically as `<Name>.mtraj`.

**3. Create the factory** once, in `RobotContainer`. For a CTRE Tuner X swerve it's one line:

```java
AutoFactory autoFactory = CtreSwerve.autoFactory(drivetrain)
    .withTelemetry(true);                       // NetworkTables under /Mayhem
```

Other drivetrains use the constructor, which mirrors Choreo's plus a measured-speeds supplier:

```java
AutoFactory autoFactory = new AutoFactory(
    drive::getPose,                  // Supplier<Pose2d>, blue-origin
    drive::resetOdometry,            // Consumer<Pose2d>
    drive::getFieldRelativeSpeeds,   // Supplier<ChassisSpeeds>
    dc -> drive.driveFieldRelative(dc.fieldSpeeds, dc.wheelForceX, dc.wheelForceY),
    true,                            // flip paths for the red alliance
    drive);                          // drive subsystem
```

**4. Bind event markers** to commands by name (the marker's command field, or its name):

```java
autoFactory.bind("intake", () -> intake.run());   // Supplier: fresh command per firing
```

**5. Build routines.** A routine polls its own triggers while it runs:

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

For a one-path auto without triggers:
`Commands.sequence(autoFactory.resetOdometry("Straight"), autoFactory.trajectoryCmd("Straight"))`.

**6. Pick autos from the dashboard.** Only the selected routine is built, while disabled:

```java
AutoChooser autoChooser = new AutoChooser();
autoChooser.addRoutine("Hub Cycle", this::hubCycle);
autoChooser.addCmd("Drive forward", () -> autoFactory.trajectoryCmd("Straight"));
SmartDashboard.putData("Auto Chooser", autoChooser);
RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler());
```

Paths are authored on blue and flipped with the field's symmetry when each trajectory command
starts. Full reference (every trigger, recovery tuning, telemetry, troubleshooting):
[lib/README.md](lib/README.md). A complete robot project: [examples/robot-2026](examples/robot-2026/).

## Tests

```bash
cd solver && uv run pytest -q
```

```bash
cd lib && ./gradlew test
```

```bash
cd app && pnpm test
```
