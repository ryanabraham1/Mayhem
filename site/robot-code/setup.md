# Set up a robot repo

The robot code stays yours: any architecture, any libraries, any C++. Mayhem adds a project file, a generated header and a small C++ library, and reads the rest of your code as it is.

## 1. Install the C++ library

**Vendordep (recommended).** In WPILib VS Code: **Manage Vendor Libraries → Install new libraries (online)**, and paste:

```
https://ryanabraham1.github.io/Mayhem/MayhemCpp.json
```

The library is header-only. Include what you use, such as `#include <mayhem/auto_runner.hpp>`. Offline: unzip `MayhemCpp-maven.zip` from a release into the WPILib maven folder and copy `MayhemCpp.json` into `vendordeps/`.

**Or copy the headers into the repo.** This works with no network, and pins the exact headers in git:

```sh
node scripts/mayhem.mjs vendor /path/to/robot --snapshot docs/mayhem/vendor-snapshot.json
```

That copies every header to `src/main/include/mayhem` and records the version and a SHA-256 of each file. Add `--check` in CI to fail when they've drifted. Don't edit vendored headers; change Mayhem and re-vendor.

| Header | Use it for |
| --- | --- |
| `auto_runner.hpp` | Running an exported routine: actions, conditions, watchdogs, telemetry. |
| `state_machine.hpp` | Running an exported mechanism state machine. |
| `alliance.hpp` | Flipping a blue-origin routine for red. |
| `pose_driver.hpp` | Driving to one pose with a watchdog, from any loop. |
| `pose_controller.hpp` | The bare controller, for your own architecture. |
| `wpilib_log.hpp`, `networktables_observer.hpp` | Logging states and transitions so the app can replay and show them live. |
| `wpilib.hpp` | `DriveToPose` as a command (needs the command framework). |

The full API is in the [C++ library README](https://github.com/ryanabraham1/Mayhem/blob/main/lib-cpp/README.md).

## 2. Add the project file

Save the project as `robot.mayhem.json` at the root of the repo: open the robot code folder in the app and use **Settings → Agents and the project file → Save project file**. The file stays linked, so app edits save back to it and edits made by agents or `git checkout` reload in the app.

Commit it. The Changes page reads autos from it, and teammates who open the folder get the same project.

## 3. Generate `MayhemProject.h`

The routines and state machines reach the robot as a generated header:

```sh
node scripts/mayhem.mjs cpp robot.mayhem.json --out src/main/include/MayhemProject.h
```

Everything in it is `constexpr`, in `namespace mayhem_generated`: each routine (`routine_<i>::info`, its start pose and preview path), the `routines` array for an auto chooser, every state machine with a typed API, and the field size for alliance flipping.

Keep the header in sync in CI. This exits 1 with the command to run when the header is stale:

```sh
node scripts/mayhem.mjs cpp robot.mayhem.json --check src/main/include/MayhemProject.h
```

::: tip A script for the team
Put both commands in `tools/mayhem/export.sh` (write the header; `--check` for CI). The Changes page tells people to run it when the generated code is out of date, and agents use it after editing the project.
:::

Pin the tools to a release in CI rather than cloning Mayhem. Each release has `Mayhem-suite-tools-<version>.zip` and `Mayhem-suite-SHA256SUMS.txt` to verify it.

## 4. Wire it up

- [Running autos](/robot-code/autos): bind your action and signal IDs, flip for red, and start the runner.
- [State machines](/robot-code/state-machines): describe mechanism machines in `tools/mayhem/machines.json` and run them with the typed API.
- [Logging and what's deployed](/robot-code/logging): what to log so Logs, State machines and "On the robot now" have something to show.
- [Sim proof scenarios](/robot-code/scenarios): the regression tests that the Changes page runs.

## What Mayhem reads from your code

The Changes and Robot → Values pages read values straight from your headers, so keep them in shapes it can read:

- Named constants at namespace or class scope in `src/main/include/**/*.h`, with units in the literal (`80_A`), the type, the name (`kTimeoutSeconds`) or `[unit]` in the doc comment.
- CAN IDs as named constants (`kLeftMotorId`, or an array with a comment per entry).
- One CTRE configuration function per motor group (`RightMotorConfigs()`, `MotorConfigs()`).
- State machine transitions in `tools/mayhem/machines.json`, not only in C++.

Values in a `sim` namespace or named `kSim…` are treated as simulation-only. Anything else that reaches the robot is still compared file by file and listed as **Other code**.
