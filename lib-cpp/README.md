# Mayhem C++ tools (development)

Header-only C++17 primitives under `include/mayhem`; optional WPILib 2026 adapters require C++20 and the normal WPILib libraries. Add this directory to your robot's includes. The new C++ API is under development; the legacy Java vendordep does not install it.

Releases include `Mayhem-cpp-<tag>.zip` with the headers, CMake files, example routine and tests.
Extract the whole archive and run the CMake commands below from its root. SHA-256 hashes are in
`Mayhem-suite-SHA256SUMS.txt` alongside the release archives.

Use the pieces you need:

| Header | Purpose |
| --- | --- |
| `pose_controller.hpp` | Standalone live-pose controller; no framework, IO, network, or per-tick allocation |
| `signals.hpp` | Typed fail-closed guard inputs (`SignalValue`, `Compare`, `Not`/`All`/`Any`, `SignalSource`) and `ManifestView` |
| `auto_runner.hpp` | Optional graph executor with typed guards, arbitrary action callbacks, concurrent actions, cancellation, watchdogs, goal telemetry, and optional observation |
| `alliance.hpp` | `AllianceRoutine`: flipped/mirrored copies of a blue-origin routine (poses, aim points, rotation markers, start) |
| `state_observer.hpp` | Optional observation interface for any robot state machine |
| `wpilib.hpp` | `DriveToPose` command and WPILOG observer |
| `networktables_observer.hpp` | NetworkTables observer and observer fanout |

## CMake installation

Use a source checkout with `add_subdirectory(lib-cpp)` and link `Mayhem::Core`, or install it:

```sh
cmake -S lib-cpp -B lib-cpp/build -DBUILD_TESTING=ON -DCMAKE_INSTALL_PREFIX=/your/install/prefix
cmake --build lib-cpp/build
ctest --test-dir lib-cpp/build --output-on-failure
cmake --install lib-cpp/build
```

An independent CMake project can then use `find_package(MayhemCore 0.1 REQUIRED CONFIG)` and `target_link_libraries(your_target PRIVATE Mayhem::Core)`, with the install prefix in `CMAKE_PREFIX_PATH`. The installed target includes all headers. Optional WPILib headers still require your robot project's WPILib dependencies; they are not linked automatically.

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

Construct `AutoRunner(routine, hooks)` (optionally with `RunnerOptions`), call `Start(measuredVelocity)` on autonomous start, and apply `Tick(measuredPose, measuredVelocity, dt)` each loop. On disable/interruption call `Cancel()` and explicitly stop outputs. Watch `Status()` for Completed/Failed/Cancelled. The runner owns neither your scheduler nor odometry resets; arbitrary robot code can bypass it entirely. Successful main and concurrent callbacks are latched and are not ticked again while transition guards wait. They receive exactly one EndAction on state exit. Concurrent actions remain owned by the state until it exits. The runner reserves callback-status storage on construction; its bookkeeping does not allocate during ticks or state transitions.

### Loop timing

Pass the real seconds since the previous tick. A roboRIO loop overrun (the first enabled loop, GC, a log flush) must not kill an autonomous routine, so by default the runner **clamps** instead of failing:

```cpp
struct RunnerOptions {
  double maxDt = 0.1;                    // PathFollower::kDefaultMaxDt
  DtOverrun overrun = DtOverrun::Clamp;  // or DtOverrun::Fail
};
mayhem::AutoRunner runner(routine, hooks, options);
```

- `dt > maxDt`: the follower integrates `maxDt` (rate limits and settling advance by at most `maxDt`; a stalled loop cannot produce a large acceleration step). `Overruns()` counts these ticks since `Start()`. `DtOverrun::Fail` restores the old fail-the-routine behavior.
- Node watchdogs (`timeout`) always count the **real** dt, so clamping cannot extend a watchdog.
- `dt == 0` (WPILib may run `Execute` in the same timestamp as `Initialize`) changes nothing and returns the previous command.
- Negative or non-finite `dt`, and a non-positive or non-finite `maxDt` (checked by `Start()`), fail.

`PathFollower` and `PoseController` clamp the same way (`SetMaxDt`, default 0.1 s); only non-positive or non-finite `dt` is invalid there.

### Goal telemetry and observation

The runner exposes what the follower computed, so robot code does not re-derive goal errors:

```cpp
const mayhem::AutoNode* ActiveNode() const;
const mayhem::Goal* ActiveGoal() const;            // nullptr outside pose states
const mayhem::ControlResult& LastResult() const;  // latest follower result in this state
double StateTime() const;                           // real seconds in the active state
std::size_t Overruns() const;
```

`ControlResult` carries `translationError` (distance to the active anchor), `rotationError` (|error| to the heading the follower steers to this tick, including PointAt, Motion, and rotation markers), `reached`, `handoff`, `progress`, and `remaining`. `LastResult()` resets on each state entry.

Optionally attach a `StateObserver` once during initialization:

```cpp
runner.Attach(observer, mayhem_generated::autonomous::manifest,
              [] { return frc::Timer::GetFPGATimestamp().value(); });
```

`Attach(observer, ManifestView manifest = {}, Clock clock = nullptr, std::string_view machine = "Autonomous")` reports `Enter`, `Guard` (one per evaluated transition, input `"condition"`), `Transition`, and `GoalProgress` (every pose tick, with the follower's errors and `reached`) under the `Autonomous` machine. If the observer type has `Describe(json)` and `RegisterGuard(transition, input)` (as `WpiLogObserver`, `NtStateObserver`, and a composite like the 3256 robot's observer do), `Attach` describes the manifest and registers every guard. Transition IDs reported to observers are `"<routine id>/<transition id>"` (`mayhem::QualifiedTransitionId`), matching the exported Autonomous manifest; `RobotHooks` callbacks still receive the unqualified IDs. Without a clock, timestamps are 0, which `WpiLogObserver` records as the current time. `Attach` allocates; ticks do not (beyond what the observer's sink does).

## Alliance flipping

Exported routines are blue-origin. Do not hand-copy nodes to flip them; use `AllianceRoutine` (C++17, `alliance.hpp`):

```cpp
#include <mayhem/alliance.hpp>

// Construct once (allocates its node and marker copies), next to the runner.
mayhem::AllianceRoutine routine(mayhem_generated::routine_0::info,
                                mayhem_generated::fieldLength, mayhem_generated::fieldWidth);
mayhem::AutoRunner runner(routine.View(), hooks);

// autonomousInit: the alliance is known now. Apply() never allocates.
routine.Apply(red ? mayhem::FieldTransform::Flip : mayhem::FieldTransform::None);
drive.ResetPose(routine.StartPose());  // if your robot resets odometry
runner.Start(measuredVelocity);
```

| `FieldTransform` | Mapping | Use |
| --- | --- | --- |
| `None` | unchanged | blue |
| `Flip` | `x' = L - x`, `y' = W - y`, `h' = h + pi` (180 degree rotation, `FlipPose`) | red on a rotationally symmetric field (2022, 2025, 2026) |
| `Mirror` | `y' = W - y`, `h' = -h` (`MirrorPose`) | left/right variant of the same auto |
| `MirrorLength` | `x' = L - x`, `h' = pi - h` | red on a mirror-symmetric field (2023, 2024) |

Every field-frame value is transformed: each node's goal pose (x, y, heading), `aimX`/`aimY` (PointAt), every rotation marker's heading, and the routine start pose (`StartPose()`; `Resolve(pose)` transforms any other blue pose, e.g. for a field preview). Event markers, progress `t`, tolerances, limits, actions, transitions, and guards are unchanged, and the view shares the blue transitions. `Apply()` always re-derives from the blue source, so calling it every enable is safe; apply before `Start()`, not mid-run. It returns false and applies `None` if the field size is not finite and positive. The object is movable (views stay valid) but not copyable. Never transform measured odometry; it is already blue-origin. The free functions `TransformPose`, `TransformGoal`, `TransformMarker`, and `TransformHeading` are available for custom code.

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
