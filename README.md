# Mayhem

Time-optimal swerve trajectory planning for FRC (2026 REBUILT), with on-robot bump recovery.

## Download the desktop app

Get the latest installer from [GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases/latest):

| System | File to download |
|---|---|
| macOS Apple Silicon | `Mayhem_*_aarch64.dmg` |
| macOS Intel | `Mayhem_*_x64.dmg` |
| Linux | `.AppImage` (portable) or `.deb` (Ubuntu/Debian) |

On macOS, drag Mayhem into Applications. These builds are not notarized, so if macOS blocks
the first launch, run `xattr -dr com.apple.quarantine /Applications/Mayhem.app` in Terminal.
For the robot library, download `MayhemLib-maven.zip` and `MayhemLib.json` from the same release;
see [installation instructions](lib/README.md).

- **Desktop app** (macOS and Linux): place waypoints on the field. Mayhem computes the fastest path your drivetrain can actually drive: motor torque-speed curves, stator current limits, wheel traction, mass and inertia. It routes around polygon obstacles using the robot's real bumper rectangle.
- **Robust solver**: CasADi + IPOPT, with parallel route candidates, a continuation ladder, and swept-collision verification. When a path truly can't be made, it tells you which waypoint or constraint is the problem and where.
- **MayhemLib** (Java vendordep for WPILib 2026 and CTRE Phoenix 6): follows paths with per-module force feedforward. If the robot gets knocked off its path, it detects the hit and rejoins the trajectory, catching up without hitting obstacles.

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

## Using the paths on the robot

```bash
cd lib && ./gradlew installVendordep -ProbotProject=/path/to/robot
```

```java
var auto = CtreSwerve.autoFactory(drivetrain).withTelemetry(true);
auto.bind("intake", intake.intakeCommand());
var cycle = auto.trajectory("Hub Cycle");
return Commands.sequence(cycle.resetOdometry(), cycle.cmd());
```

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
