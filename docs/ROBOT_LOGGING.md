# Robot logging compatibility

The [2026 offseason branch](https://github.com/Team3256/FRC_Offseason_2026/tree/claude/friendly-tesla-o02ue3) is a reference implementation, not a required robot architecture or permanent log schema. Reviewed on 2026-11-10 against the remote branch's `Logger.cpp`, `Logger.h`, `Robot.cpp`, `Constants.h`, `Telemetry.h` and `Superstructure.h`. Robot code remains the source of truth; agents can choose libraries, control architecture and channel names freely.

## Current reference

| Recorded data | Meaning / Mayhem use |
| --- | --- |
| `/RealOutputs/SystemStats/BatteryVoltage`, `/RealOutputs/SystemStats/BrownedOut` | Battery sag and actual brownout flag; recognized by suffix regardless of root prefix |
| `/RealOutputs/LoopTimeMS`, `/RealOutputs/LoopPeriodMS` | Milliseconds, recognized for loop warnings. Defaults flag execution above 20 ms and start-to-start periods above 25 ms for at least 100 ms, allowing ordinary scheduling jitter. Compare with the configured robot period. |
| `/RealOutputs/LoggedTracer/*MS` | Individual phase timings; retain for AdvantageScope inspection, not interpreted as total-loop duration |
| `/RealOutputs/Superstructure/State`, `PrevState`, `StateTime` | Existing state and timing. String `State`/`CurrentState` channels can be checked for chatter; no Mayhem-specific root is required. |
| `/RealOutputs/Superstructure/ReadyToShoot` and children | Actual readiness inputs; a machine manifest can map these existing channels directly |
| `NT:/DriveState/Pose` | WPILib Pose2d struct, blue-origin meters/radians. AdvantageScope reads the struct directly. |
| `NT:/SmartDashboard/...` and `NT:/Mayhem/...` | Mirrored NT channels; names and original values are retained |

File logging uses `/U/wpilogs` when configured USB storage exists, otherwise `/home/lvuser/wpilogs`. Simulation can choose `ROBOT_LOG_DIR`. Mayhem offers those presets and an editable folder; saved preferences are preserved. Changing the robot/folder clears old selections and pauses polling so a new source needs explicit selection.

The reviewed Robot.cpp records battery voltage but does not establish a total battery-current signal. Per-motor supply/stator currents are not substituted for total battery current. Total load/Wh remain unavailable until the recording contains an appropriate measured signal and it is mapped. Likewise, Phoenix SignalLogger Hoot output is separate from WPILOG; this import path does not silently treat it as WPILOG.

## Future seasons and other robots

- Keep original WPILOGs. AdvantageScope receives the unchanged file, so its supported types and layouts remain available regardless of Mayhem's quick-analysis decoder.
- Power mapping is selectable per recording. Automatic suffix recognition is a convenience; any appropriate numeric voltage/current channel can be selected.
- State-machine manifests accept arbitrary `stateChannel` and per-input `channel` paths, state IDs and code references. They describe the robot; they do not dictate its implementation. Do not infer decision guards from state names alone.
- Measurements and their units must be explicit. Avoid interpreting degrees as radians, phase timing as total-loop timing, or device current as battery current.
- The reference disables its general NT mirror on a real robot while FMS is attached. Missing live values during a match do not by themselves prove the device disconnected; use the onboard file afterward.
- Include a small logging profile/example manifest with each season's robot project so humans and agents can review mappings. Do not require teams to rename all channels or adopt this year's superstructure.

The existing optional Mayhem C++ observers add visibility when useful, and can coexist with the reference logger. Their use is not mandatory. See [SUITE_AGENTS.md](SUITE_AGENTS.md) and [lib-cpp/README.md](../lib-cpp/README.md).
