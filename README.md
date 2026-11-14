# Mayhem

The place where people work with a robot whose code is written by coding agents. People say what the robot should do differently, by pointing at what it did; agents plan and change the code; people review the result by what the robot does, not by reading the diff. Around that loop: pose-based autonomous tools, state-machine inspection, and robot log playback/analysis.

The new suite is in active development. The original time-optimal trajectory planner stays available from **Settings → Classic trajectory planner**. This checkout contains the overhaul; check the assets and notes of a published release before assuming it includes the suite.

## New suite (development)

- **Overview:** what's waiting for you (agent plans to approve, changes to check), every routine as a field thumbnail, the latest logs with their red flags, and setup checks.
- **Changes:** what a robot code change does, read from the code instead of the diff: driver controls, state machines, values, hardware, autos, any other code that changed, and a sim proof that runs both versions in the robot's own simulation.
- **Tasks:** feedback from the team (right-click almost anything, pit notes, a post-match driver form) becomes tasks for coding agents. An agent proposes a plain-English plan, a person approves it, the agent changes the code, and a person checks the result by behavior.
- **Autonomous:** pose-to-pose routines on the REBUILT field: click to place, drag goals and the start, heading knobs, moving handoffs, robot actions between steps, per-step limits, and a preview with a driven-path trail. Inspector edits arrival, heading policy, watchdogs, concurrent callbacks and branches.
- **State machines:** a layered graph of autonomous routines or any robot state machine. Simulate by toggling inputs (the machine steps through its transitions), watch it live over NetworkTables, or replay a recorded log. "From any state" bindings collapse into chips so large superstructures stay readable.
- **Logs:** a library of recordings with red-flag badges, a verdict and finding timeline per log, Health / Power / Signals / Field tabs, per-mechanism current ranking, and battery sag against the brownout line.
- **Robot:** what code is on the robot now and how it differs from `main`, every value in the code (editable), team number, live connection, automatic log collection from the robot over Ethernet or from a folder (simulation output, USB sticks), team upload with retry, drive limits and robot inputs. Collection runs on every screen, not just Logs.
- **Connecting agents** (bottom of Tasks): a copyable prompt that puts any coding agent on the task queue, a plain-text project brief, MCP and CLI setup, a live file link agents edit, C++ export, and the raw project document.
- **Team sharing:** companion 3256-Tools web library/viewer source, private cloud uploads, and deployment instructions. Live at https://3256tools.vercel.app/logs, with actual hosted AdvantageScope Lite and selected-log handoff.

```sh
cd app
pnpm install
pnpm dev
```

Open http://localhost:5173. The new browser suite needs no Python solver. Desktop builds retain the sidecar for the legacy planner; see the existing build instructions below.

Start with the [suite user guide](docs/USER_GUIDE.md) for project switching, autonomous previews, state inspection, and log collection. Suite projects use `.mayhem.json`; classic `project.mayhem` / `.mtraj` projects have a [separate guide](docs/CLASSIC_PLANNER.md).

Read [suite status and remaining work](docs/SUITE_STATUS.md), [agent/tool usage](docs/SUITE_AGENTS.md), [C++ integration](lib-cpp/README.md), and [team log setup](docs/TEAM_LOGS.md). Physical robot tests and production cloud verification remain outstanding.

## Legacy trajectory planner

**Documentation: <https://ryanabraham1.github.io/Mayhem/>**

## Published desktop downloads

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
The robot library installs as a vendordep from a hosted URL; see [installation instructions](lib/README.md#installation).

- **Desktop app** (macOS, Windows and Linux): place waypoints on the field. Mayhem computes the fastest path your drivetrain can actually drive: motor torque-speed curves, stator current limits, wheel traction, mass and inertia. It routes around polygon obstacles using the robot's real bumper rectangle.
- **Robust solver**: CasADi + IPOPT, with parallel route candidates, a continuation ladder, and swept-collision verification. When a path truly can't be made, it tells you which waypoint or constraint is the problem and where.
- **MayhemLib** (Java vendordep for WPILib 2026 and CTRE Phoenix 6): follows paths with per-module force feedforward. If the robot gets knocked off its path, it detects the hit and takes the fastest feasible bridge back onto the trajectory (no obstacle avoidance during recovery, to keep the roboRIO load tiny).

| Part | Where | Docs |
|---|---|---|
| Suite and classic app (Tauri 2 + React) | [app/](app/) | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Suite C++ controller | [lib-cpp/](lib-cpp/) | [lib-cpp/README.md](lib-cpp/README.md) |
| Solver (Python, CasADi/IPOPT) | [solver/](solver/) | [docs/SOLVER.md](docs/SOLVER.md) |
| Robot library (Java) | [lib/](lib/) | [lib/README.md](lib/README.md) |
| Example robot project | [examples/robot-2026/](examples/robot-2026/) | |
| Building and releasing | | [docs/BUILDING.md](docs/BUILDING.md) |

## Classic planner development

```bash
cd solver && uv sync && uv run mayhem-solver serve --ws 8765
```

```bash
cd app && pnpm install && pnpm dev
```

Open http://localhost:5173. To run as a desktop app, build the solver sidecar once and use `pnpm tauri dev`; see [docs/BUILDING.md](docs/BUILDING.md).

## Classic planner AI agent integration

Mayhem has a local MCP server for discovering and editing saved projects,
generating trajectories, inspecting solver diagnostics, and copying current paths
to a robot deploy folder. It uses revision checks and explicit solve/save/deploy
steps. See [AI agent setup and tool reference](docs/AI_AGENTS.md).

## Using classic paths on the robot (Java MayhemLib)

MayhemLib's API is modeled on ChoreoLib's `AutoFactory` / `AutoRoutine` / `AutoTrajectory` /
`AutoChooser`, so if you've used Choreo it should feel familiar. The main difference: you don't
write a controller. MayhemLib runs feedback, time dilation and bump recovery itself and hands
your drivetrain field speeds plus per-module force feedforward.

**1. Install the vendordep.** In VS Code run **WPILib: Manage Vendor Libraries**, then
**Install new libraries (online)**, and paste this URL (details in [lib/README.md](lib/README.md#installation)):

```
https://ryanabraham1.github.io/Mayhem/MayhemLib.json
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
