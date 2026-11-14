# Logging and what's deployed

Mayhem works from what the robot records. Nothing here is required: log what you already log, and add these pieces when you want the matching feature.

| You want | Log this |
| --- | --- |
| Log findings and power on [Logs](/suite/logs) | Battery voltage and the brownout flag; loop time; per-device current if you have it. |
| Pose replay on Logs | The robot pose as a WPILib `Pose2d` struct (blue origin). |
| State machines live and in log replay | Each machine's state and inputs, through a Mayhem observer or your own channels. |
| "On the robot now" and the commit behind every log | The build stamp below. |

## State machines and autos

Attach an observer and the library logs everything the app needs:

```cpp
#include <mayhem/wpilib_log.hpp>

// One observer per machine, named after it.
mayhem::WpiLogObserver intakeLog{frc::DataLogManager::GetLog(), "IntakeMode"};
mayhem::WpiLogObserver autoLog{frc::DataLogManager::GetLog(), "Autonomous"};

intake.Attach(intakeLog, clock, mayhem::InputLogging::On);               // a mechanism machine
runner.Attach(autoLog, mayhem_generated::autonomous::manifest, clock);  // the autonomous runner
```

- `WpiLogObserver` writes to the `.wpilog`; `NtStateObserver` (`networktables_observer.hpp`) publishes to NetworkTables for the live view; `CombinedObserver` forwards to both.
- States go to `Mayhem/States/<machine>/state` unless the manifest names a `stateChannel`.
- `InputLogging::On` logs every declared input each loop, so log replay can show why each transition fired. Leave it off if you already log the inputs on the channels the manifest names.

## Power and health

Battery voltage and brownout channels are recognized by name wherever they are (for example `/RealOutputs/SystemStats/BatteryVoltage`). If Mayhem picks the wrong signals, set them in **Logs → Power → Signal mapping**. Currents estimated from motor data are labeled **estimated**; total battery current is only reported when a measured signal is mapped.

Your own pass/fail rules go in the project under `extensions.logRules`:

```json
{
  "rules": [
    {
      "id": "battery-sag",
      "channel": "/RealOutputs/SystemStats/BatteryVoltage",
      "op": "lt", "value": 8.5, "duration": 0.15,
      "severity": "warning",
      "title": "Battery below project limit"
    }
  ]
}
```

Set `"defaultRules": false` to replace the built-in findings instead of adding to them.

## What's deployed

**Robot → On the robot now** shows the commit on the robot, who built it, whether it had uncommitted changes, and how it differs from `main`. It reads a small build stamp:

1. A Gradle task writes `src/main/deploy/mayhem-build.json` before every build: `sha`, `branch`, `dirty` (changed files), `builtAt`, `builtBy`, `computer`. Git-ignore it. Let `MAYHEM_BUILD_SHA` and `MAYHEM_BUILD_BRANCH` override git, since Mayhem's rollback builds a clean export.
2. GradleRIO deploys it with the rest of `src/main/deploy`.
3. The robot logs it once at boot as `/RealOutputs/Mayhem/Build`.

Every log then names the code it ran, and **Put main back on the robot** can rebuild and deploy `main`.

## Log files

Mayhem collects from `/U/wpilogs` (USB storage) or `/home/lvuser/wpilogs`; set the folder in **Robot → Log collection**. Keep the original `.wpilog` files: AdvantageScope opens them unchanged, whatever Mayhem's own decoder supports.
