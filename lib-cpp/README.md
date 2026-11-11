# Mayhem C++ tools (development)

Header-only C++17 primitives under `include/mayhem`; optional WPILib 2026 adapters require C++20 and the normal WPILib libraries. Add this directory to your robot's includes. The new C++ API is under development; the legacy Java vendordep does not install it.

Use the pieces you need:

| Header | Purpose |
| --- | --- |
| `pose_controller.hpp` | Standalone live-pose controller; no framework, IO, network, or per-tick allocation |
| `auto_runner.hpp` | Optional graph executor with typed guards, arbitrary action callbacks, concurrent actions, cancellation, and watchdogs |
| `state_observer.hpp` | Optional observation interface for any robot state machine |
| `wpilib.hpp` | `DriveToPose` command and WPILOG observer |
| `networktables_observer.hpp` | NetworkTables observer and observer fanout |

## Controller in an existing architecture

```cpp
#include <mayhem/pose_controller.hpp>

mayhem::PoseController controller;
mayhem::Goal target{{5.8, 2.4, -0.35}};
mayhem::Constraints limits;

// On start: reset the controller from the measured field-relative speeds.
controller.Reset(measuredVelocity);

// Every robot loop, with actual pose/speeds and seconds since the last loop:
const auto result = controller.Calculate(measuredPose, measuredVelocity,
                                         target, limits, dt);
if (!result.valid) {
  driveFieldRelative({});
  failMovement();
} else {
  driveFieldRelative(result.command);
  if (result.reached) finishMovement();
}
```

The output is **field-relative meters/second and radians/second**. Convert for your drivetrain API when necessary. Set real robot limits and tune feedback on hardware. An outer watchdog, disabled/cancellation logic, localization checks, and obstacle routing belong to the caller. Invalid numeric/controller input returns zero with `valid=false`.

`handoffRadius > 0` permits reaching the intermediate target while moving. A final target should normally leave it at zero and settle. Heading modes are Fixed, PointAt, Motion, and Free. Translation and angular speed use separate constraints.

## Optional exported routine executor

Generate a header with `node scripts/mayhem.mjs cpp project.mayhem.json > autos.hpp`. It supplies `mayhem_generated::routine_0::routine` and `routine_0::startPose` (and equivalent namespaces for additional routines). The global `startPose` is the robot default.

Derive `RobotHooks` in your robot project. Return real typed `SignalValue`s; implement `BeginAction`, `TickAction`, and `EndAction` with your existing mechanism/scheduler code. `TickAction` explicitly returns Running, Succeeded, or Failed. `EndAction` also receives cancellation. Do not return success merely because time elapsed. String signal views must refer to storage that remains valid during guard evaluation.

Construct `AutoRunner(routine, hooks)`, call `Start(measuredVelocity)` on autonomous start, and apply `Tick(measuredPose, measuredVelocity, dt)` each loop. On disable/interruption call `Cancel()` and explicitly stop outputs. Watch `Status()` for Completed/Failed/Cancelled. The runner owns neither your scheduler nor odometry resets; arbitrary robot code can bypass it entirely. Concurrent actions remain active until leaving their state, even if their callback reports success earlier.

## Optional state observation

Create one `WpiLogObserver` or `NtStateObserver` per machine. Call `Describe(manifestJson)` once during startup, and `RegisterGuard(transitionId, inputId)` for guards you want to expose before running loops. Use `Enter`, `Guard`, `Transition`, and `GoalProgress` alongside your existing implementation. `CombinedObserver` can forward the same observations to logs and NetworkTables.

Log/publish actual input values using your normal WPILib channels, and reference those names in the manifest. Schema and observations do not control the machine. Keep allocations, schema construction, and registration outside the control loop. The observer APIs themselves do not start a NetworkTables server or DataLogManager.

## Checks

```sh
cmake -S lib-cpp -B lib-cpp/build -DBUILD_TESTING=ON
cmake --build lib-cpp/build
ctest --test-dir lib-cpp/build --output-on-failure
```

Tests exercise arrival/settling, moving handoff, invalid data, limits, watchdog behavior, typed conditions, generated routine execution, and agreement with the browser controller. Host timings are not roboRIO benchmarks. No physical robot validation has been completed for this new library.
