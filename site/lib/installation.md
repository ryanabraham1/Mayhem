# Installation

MayhemLib is the robot-side library for Mayhem trajectories on WPILib 2026 (FRC REBUILT). It is Java 17, package `mayhemlib`, published as `mayhemlib:MayhemLib-java`.

It is built against WPILib 2026.2.x, Phoenix 6 26.x (optional, used for `CtreSwerve`), and SleipnirJava 2026 (optional, used for `SleipnirBridgeRefiner`). All three are `compileOnly` dependencies: your robot project supplies them, and MayhemLib bundles none of them.

## Option A: online install (recommended)

In VS Code with the WPILib extension, open the command palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>), run **WPILib: Manage Vendor Libraries**, choose **Install new libraries (online)**, and paste:

```
https://ryanabraham1.github.io/Mayhem/MayhemLib.json
```

That writes `vendordeps/MayhemLib.json` into your project. The first Gradle build then downloads the library from the hosted maven repository, so it works on every machine with no extra setup. Commit the JSON, and teammates and CI get it with the repo.

Without VS Code, download the same file into your project instead:

```bash
curl -L -o vendordeps/MayhemLib.json https://ryanabraham1.github.io/Mayhem/MayhemLib.json
```

To update, run **Manage Vendor Libraries**, then **Check for updates (online)**. WPILib compares the version in your `vendordeps/MayhemLib.json` with the one hosted at that URL and offers the new one.

## Option B: offline (from a release)

Download `MayhemLib-maven.zip` and `MayhemLib.json` from the [latest release](https://github.com/ryanabraham1/Mayhem/releases/latest). Unzip the zip into `~/wpilib/2026/maven` (Windows: `C:\Users\Public\wpilib\2026\maven`), which GradleRIO always searches, and copy `MayhemLib.json` into your project's `vendordeps/`. Every machine that builds the robot code needs the unzipped artifact.

## Option C: from a checkout (library development)

```bash
cd lib
./gradlew installVendordep -ProbotProject=/path/to/your/robot/project
```

This publishes the jar to `~/wpilib/2026/maven` and writes `vendordeps/MayhemLib.json` into your robot project. Leave off `-ProbotProject` to only publish. To try a different version, add `-PmayhemVersion=2026.3.1`. Run it again after each change to the library.

## Robot project requirements

| Dependency | Needed for | How to get it |
|---|---|---|
| WPILib 2026 GradleRIO (`2026.2.1` or newer) | everything | WPILib installer |
| Phoenix 6 vendordep | `mayhemlib.ctre.CtreSwerve` | `https://maven.ctr-electronics.com/release/com/ctre/phoenix6/latest/Phoenix6-frc2026-latest.json` |
| SleipnirJava vendordep | `SleipnirBridgeRefiner` only | `https://file.tavsys.net/sleipnir/SleipnirJava.json` |

Building MayhemLib itself needs JDK 17 or newer. The bytecode always targets Java 17 (`--release 17`).
