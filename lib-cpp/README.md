# Mayhem C++ tools (development)

Header-only C++17 primitives under `include/mayhem`; optional WPILib 2026 adapters (`wpilib_log.hpp`, `wpilib.hpp`, `networktables_observer.hpp`) require C++20 and the WPILib libraries they name. The version is `MAYHEM_CPP_VERSION` / `mayhem::kCppVersion` in `version.hpp` (currently 0.7.0). The Java MayhemLib vendordep does not include it; use the MayhemCpp vendordep or the vendoring command below.

## Installing in a WPILib robot project

**Vendordep (recommended once released).** In WPILib VS Code, Manage Vendor Libraries, Install new libraries (online), paste `https://ryanabraham1.github.io/Mayhem/MayhemCpp.json`. Then `#include <mayhem/state_machine.hpp>` etc. It is header-only: the release workflow publishes a `headers` zip plus intentionally empty `linuxathena`/`systemcore` static-library zips, because GradleRIO only adds a C++ vendordep to roboRIO builds when it lists a robot platform and then requires those archives. Simulation builds get the headers only. Offline: unzip `MayhemCpp-maven.zip` from the release into the WPILib maven folder and copy `MayhemCpp.json` into `vendordeps/`. Build it locally with `python3 scripts/build-cpp-vendordep.py --output build/cpp-vendordep [--maven-url file:///abs/path/build/cpp-vendordep/repos/releases/]`. This layout was verified with GradleRIO 2026.2.1 (roboRIO and desktop, debug and release) against a local `file://` maven; it is hosted from the first release that includes this file.

**Vendoring (works today, no network).** From a Mayhem checkout or the `Mayhem-suite-tools` archive:

```sh
node scripts/mayhem.mjs vendor /path/to/robot                 # -> src/main/include/mayhem + mayhem-vendor.json
node scripts/mayhem.mjs vendor /path/to/robot --snapshot docs/mayhem/vendor-snapshot.json
node scripts/mayhem.mjs vendor /path/to/robot --check         # exit 1 if any header differs
```

It copies every header in `include/mayhem` to `<robot>/src/main/include/mayhem` (`--dest` to change), and writes a snapshot with the version, source commit (and `modified: true` if the headers had uncommitted changes), and the SHA-256 of each header. It removes only headers that the previous snapshot listed and Mayhem no longer ships. `--check` compares contents, not commits. The MCP tool `vendor_cpp` does the same. Do not edit vendored headers; change Mayhem and re-vendor.

**CMake.** See below.

Releases include `Mayhem-cpp-<tag>.zip` with the headers, CMake files, example routine and tests.
Extract the whole archive and run the CMake commands below from its root. SHA-256 hashes are in
`Mayhem-suite-SHA256SUMS.txt` alongside the release archives.

Use the pieces you need:

| Header | Purpose |
| --- | --- |
| `pose_controller.hpp` | Standalone live-pose controller; no framework, IO, network, or per-tick allocation |
| `signals.hpp` | Typed fail-closed guard inputs (`SignalValue`, `Compare`, `CompareTyped`, `Not`/`All`/`Any`, `SignalSource`), `MachineInput` and `ManifestView` |
| `auto_runner.hpp` | Optional graph executor with typed guards, arbitrary action callbacks, concurrent actions, cancellation, watchdogs, goal telemetry, and optional observation |
| `state_machine.hpp` | `StateMachine`: runs an exported `mayhem-machine` graph (typed guards, priority, built-in `stateTime`, `Settle` with one-shot events, clocked ticks, optional observer and input logging); `TypedMachine<Def>` for the generated typed API |
| `alliance.hpp` | `AllianceRoutine`: flipped/mirrored copies of a blue-origin routine (poses, aim points, rotation markers, start) |
| `state_observer.hpp` | Optional observation interface for any robot state machine |
| `pose_driver.hpp` | `PoseDriver`: drive to a goal with a watchdog from any loop (`Start(now)`, `Update(now)`, `Cancel()`); no framework |
| `wpilib_log.hpp` | `WpiLogObserver` (WPILOG); needs only `wpi/DataLog.h`, not the command framework |
| `wpilib.hpp` | `DriveToPose` command (`PoseDriver` as a command; needs wpilibNewCommands); also includes `wpilib_log.hpp` |
| `networktables_observer.hpp` | NetworkTables observer and observer fanout |
| `sim/*.hpp` | Robot physics simulation (C++17, no dependencies): TalonFX emulator, motors, battery, mechanisms, 6-DOF swerve on terrain, field obstacles, game pieces; optional `sim/wpilib_sim.hpp` and `sim/phoenix6.hpp` adapters. See [docs/SIMULATION.md](../docs/SIMULATION.md) |

## CMake installation

Use a source checkout with `add_subdirectory(lib-cpp)` and link `Mayhem::Core`, or install it:

```sh
cmake -S lib-cpp -B lib-cpp/build -DBUILD_TESTING=ON -DCMAKE_INSTALL_PREFIX=/your/install/prefix
cmake --build lib-cpp/build
ctest --test-dir lib-cpp/build --output-on-failure
cmake --install lib-cpp/build
```

An independent CMake project can then use `find_package(MayhemCore 0.2 REQUIRED CONFIG)` and `target_link_libraries(your_target PRIVATE Mayhem::Core)`, with the install prefix in `CMAKE_PREFIX_PATH`. The installed target includes all headers. Optional WPILib headers still require your robot project's WPILib dependencies; they are not linked automatically.

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

`PoseDriver` (`pose_driver.hpp`) adds the watchdog for robots that run their own loop, without the command framework:

```cpp
#include <mayhem/pose_driver.hpp>

mayhem::PoseDriver drive([&] { return measuredPose; }, [&] { return measuredVelocity; },
                         driveFieldRelative, target, limits, /*watchdog seconds*/ 3.0);
drive.Start(frc::Timer::GetFPGATimestamp().value());              // on entering the state
switch (drive.Update(frc::Timer::GetFPGATimestamp().value())) {    // every loop
  case mayhem::PoseCommandStatus::Reached: finishMovement(); break;
  case mayhem::PoseCommandStatus::Failed: failMovement(); break;   // watchdog or invalid input
  default: break;
}
drive.Cancel();                                                    // on leaving early
```

It writes one zero velocity when the drive ends (reached, failed, or cancelled), skips loops with `dt == 0`, and fails on the first update if the watchdog is not positive and finite. `DriveToPose` in `wpilib.hpp` is the same driver as an `frc2` command.

`Goal::headingOffset` (radians) is added to the `Motion` and `PointAt` headings (pi: face backward while moving). `Motion` faces the direction of travel toward the active anchor (along the segment within 0.1 m of it); a `Motion` anchor ahead is a rotation target, reached by the previous anchor's handoff, and every handoff carries the heading actually commanded, so the heading never steps. Hold a heading until progress t with a rotation marker at t carrying that heading. `Constraints::anticipateSpeedCaps` (default false, BLine behavior) makes the follower slow down for a slower step ahead (`speed <= sqrt(cap^2 + 2 a d)`, d = distance to its handoff point); `PathFollower::Calculate` takes the per-anchor caps as an optional last argument and `AutoRunner` passes each step's `maxVelocity`. Both new fields are last in their structs, so existing positional initializers still compile.

`handoffRadius > 0` permits reaching the intermediate target while moving. A final target should normally leave it at zero and settle. Heading modes are Fixed, PointAt, Motion, and Free. Translation and angular speed use separate constraints.

## Optional exported routine executor

Generate a header with `node scripts/mayhem.mjs cpp project.mayhem.json --out src/main/include/MayhemProject.h` (or `> file`), and fail CI when it is stale with `node scripts/mayhem.mjs cpp project.mayhem.json --check src/main/include/MayhemProject.h` (exit 1 with a regenerate command; CRLF checkouts pass). `--out` leaves an up-to-date file untouched. The command prints nothing on stderr when it succeeds. Output depends only on project content: not the project `revision`, not JSON key order. Everything is in `namespace mayhem_generated` and is `constexpr`:

| Name | Contents |
| --- | --- |
| `fieldLength`, `fieldWidth` | Project field size (m), for `AllianceRoutine` |
| `startPose` | Robot default start pose |
| `routine_<i>::name`, `::routine`, `::startPose`, `::info` | Chooser label, `RoutineView`, start pose (routine override or robot default), `RoutineInfo{name, routine, startPose}` |
| `routines` | `std::array<RoutineInfo, N>` of every routine in project order; `mayhem::FindRoutine(routines, nameOrId)` |
| `autonomous::manifest` | `ManifestView` of one `Autonomous` mayhem-machine manifest covering every routine (see below) |
| `machine_<i>::machine`, `::manifest`, `::id`, `::inputs`; alias `<MachineId>::` | Each `extensions.machines` graph as a `MachineView` with its embedded manifest and declared inputs (see Mechanism state machines) |
| `<MachineId>::State`, `::Inputs`, `::Def`, `::Machine` | Typed API: `enum class State`, `struct Inputs` (one field per declared input), and `Machine` = `mayhem::TypedMachine<Def>` |
| `machines` | `std::array<MachineView, M>` of every machine |

Manifests are embedded as canonical JSON (sorted keys) split into ~2 KB literals, because MSVC rejects string literals over 64 KB; `manifest.Text()` returns the joined `std::string` (allocates; call at startup). The exporter validates every machine with the same rules as the editor and fails on an invalid or duplicate one.

**Autonomous manifest convention.** Its states are the union of all routines' nodes (a node ID used by several routines is one state, so give nodes distinct IDs when they mean different things). Its transitions are every routine's transitions with ID `"<routine id>/<transition id>"`, which makes them unique across routines. `AutoRunner::Attach` reports observations with the same IDs under machine `Autonomous` and channel `/Mayhem/States/Autonomous/state`, so the live viewer and log replay show any routine against the one manifest.

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

## Mechanism state machines

`node scripts/mayhem.mjs cpp` exports every `extensions.machines` graph as a `mayhem::MachineView` (`mayhem_generated::machine_<i>::machine`, plus a namespace alias named after the machine ID when it is a valid C++ identifier, e.g. `mayhem_generated::Superstructure::machine`, and the `mayhem_generated::machines` array), and a typed API next to it.

### Typed machines (0.7.0)

```cpp
#include "MayhemProject.h"  // generated

mayhem_generated::IntakeMode::Machine intake;                 // TypedMachine<Def>; not copyable
using Intake = mayhem_generated::IntakeMode::State;          // enum class: STOWED, INTAKING, ...

// Startup: the clock times Settle() and stamps observations; InputLogging::On logs every input.
intake.Attach(observer, [] { return frc::Timer::GetFPGATimestamp().value(); }, mayhem::InputLogging::On);

// Every loop:
auto& in = intake.In();                                       // struct Inputs, one field per input
in.enabled = frc::DriverStation::IsEnabled();
in.intakePressed = controller.GetXButtonPressed();           // "event": true, reset after this loop
in.jitterHeld = controller.GetYButton();
intake.Settle();                                              // or Settle(dt), Tick(dt), Tick()
if (intake.Is(Intake::INTAKING)) rollers.SetVoltage(8);
```

The exporter emits, per machine: `enum class State : int` (values in state declaration order, so `static_cast<int>(state)` is the `StateIndex()`), `struct Inputs` (one field per declared input with the manifest type, `bool`/`double`/`std::string`, and initial value; `stateTime` is built in and not a field), `struct Def` (the `MachineView`, typed guards that read `Inputs` directly with `mayhem::CompareTyped`, `Signal(inputs, key)` for observers and `ClearEvents`), and `using Machine = mayhem::TypedMachine<Def>`. A misspelled input or state is a compile error. Names: characters other than letters, digits and `_` become `_` (`intake.requested` → `intake_requested`), a name not starting with a letter gets a `k` prefix, keywords get a trailing `_`, and repeats get `_2`.

| `TypedMachine<Def>` member | Meaning |
| --- | --- |
| `Inputs& In()` | This loop's inputs. Fields of `event` inputs are reset to their initial value after the first step of each `Tick`/`Settle`. |
| `State Current()`, `bool Is(State)`, `static std::string_view Name(State)`, `std::string_view StateName()` | Current state as the enum; its manifest ID. |
| `Tick(dt)`, `Tick()`, `Settle(dt, maxSteps)`, `Settle()`, `Settled()`, `Reset()`, `StateTime()`, `LastTransition()`, `Valid()`, `SetClock(clock)`, `Attach(...)`, `Detach()` | As `StateMachine`. |
| `const StateMachine& Untyped()` | The string API over the same machine (`Signal(key)`, `View()`, `StateIndex()`). |

### String API

```cpp
#include <mayhem/state_machine.hpp>

// Signals from a callback (or pass any const mayhem::SignalSource&).
mayhem::StateMachine intake(mayhem_generated::IntakeSequence::machine,
                            [this](std::string_view key) { return IntakeSignal(key); });
intake.Attach(observer, [] { return frc::Timer::GetFPGATimestamp().value(); });

// Every loop, after updating the inputs:
intake.Settle();                  // transitions taken this loop; Tick(dt) is a single step
switch (intake.StateIndex()) { /* drive mechanisms from the state */ }
```

| Member | Meaning |
| --- | --- |
| `StateMachine(MachineView, const SignalSource&)` / `StateMachine(MachineView, std::function<SignalValue(std::string_view)>)` | Resolves states to indices and enters `initial`. Allocates. |
| `bool Tick(double dt)` | Adds `dt` to `StateTime()`, evaluates the active state's outgoing guards in declaration order, takes at most one transition (which resets `StateTime()` to 0). Non-finite or negative `dt` does not advance time; guards still run. |
| `int Settle(double dt, int maxSteps = kDefaultSettleSteps)` | Repeats the step within one loop until no transition fires, taking at most `maxSteps` (default 8) transitions. Only the first step adds `dt`; later steps read `event` inputs as their initial value. Returns the transitions taken. |
| `bool Settled()` | False when the last `Settle` stopped at `maxSteps` (possibly a cycle). |
| `bool Tick()`, `int Settle()` | The same with `dt` from the clock: the time since the previous clocked call, `SetClock` or `Reset` (0 without a clock). |
| `void SetClock(Clock)` | Seconds for observer timestamps and clocked ticks. `Attach` with a non-null clock sets it too. |
| `bool Reset()` | Re-enter `initial` with `StateTime() = 0`. |
| `std::string_view State()`, `int StateIndex()`, `double StateTime()`, `std::string_view LastTransition()` | Current state, its index in the view's `states`, seconds in it, last transition taken. |
| `bool Valid()` | False if `initial`, a transition endpoint, or an `except` state is not a declared state (or `except` is set without `from` `"*"`); then `State()` is empty and `Tick` does nothing. |
| `SignalValue Signal(std::string_view)` | What guards see. |
| `template <class O> void Attach(O& observer, Clock clock = nullptr, InputLogging inputs = InputLogging::Off)`, `Detach()` | Describe the embedded manifest and register every guard (input `"condition"`) when the observer supports it; report `Enter` (immediately, and on each entry), `Guard` (every evaluation), and `Transition`. With `InputLogging::On`, register every declared input (`RegisterInput`) and report its value (`Input`) on the first step of each `Tick`/`Settle`. |

**One-shot events.** An input with `"event": true` in the manifest (`MachineInput::event`) is a press or a one-loop request. It counts for the first step of a loop only, so `Settle` cannot use the same press twice: from STOWED, an X press goes to INTAKING and stays there instead of toggling straight back. With the string API the robot still owns the value; `Settle` only hides it on its later steps. The typed API also resets the field after the first step, so code that sets it only on a press needs no clearing.

A transition whose `from` is `"*"` (`mayhem::kAnyState`) is checked in every state except its target and the states in its optional `except` list (`MachineTransition::except`/`exceptCount`, emitted by the exporter), at its position in declaration order. A priority supervisor (each target reachable from every other state) is then one transition per target, in priority order. Observers receive the actual source state in `Transition(machine, id, from, to)`, never `"*"`.

With `MachineView::prioritySelect` (the exporter sets it for a manifest with `"selection": "priority"`), a `"*"` transition is also checked in its own target state, and the first true transition decides. If it leads to the current state, `Tick` returns false, the state is not re-entered (`StateTime()` keeps counting) and lower transitions are not checked. A last transition with an always-true guard (`{"kind": "always"}`) is the "otherwise" row.

Guards are the same fail-closed typed comparisons as `AutoRunner`: a missing or mistyped input is false, including under `Not`; the first true guard in declaration order wins. The built-in `stateTime` input (`mayhem::kStateTimeSignal`) is the real seconds since entering the state and takes precedence over a robot signal of the same name, so `stateTime > 2.5` deadlines need no robot code; declare it as a number input in the manifest so the editor and viewer accept it. Log it on the input's channel too if you want log replay to evaluate those guards. `Tick` and `Reset` never allocate (tested by counting `operator new`); construction and `Attach` do. The machine only decides state: robot code reads it and drives outputs, and owns disabled handling.

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

Create one `WpiLogObserver` (`wpilib_log.hpp`) or `NtStateObserver` per machine. Call `Describe(manifestJson)` once during startup, and `RegisterGuard(transitionId, inputId)` for guards you want to expose before running loops. Use `Enter`, `Guard`, `Transition`, and `GoalProgress` alongside your existing implementation. `CombinedObserver` can forward the same observations to logs and NetworkTables. `StateMachine::Attach` and `AutoRunner::Attach` make these calls for you.

**Input logging.** `StateMachine::Attach(observer, clock, mayhem::InputLogging::On)` logs every declared manifest input each loop, so robot code does not keep its own list of input channels. It calls the `StateObserver` virtuals `RegisterInput(machine, const MachineInput&)` once per input during `Attach` and `Input(machine, key, value, timestamp)` on the first step of each `Tick`/`Settle` (both no-ops by default, so existing observers compile unchanged). `WpiLogObserver` writes a typed entry (boolean, double or string) at the input's manifest `channel`, or `Mayhem/States/<machine>/inputs/<key>` when it has none; several machines may share a channel. `NtStateObserver` publishes `/Mayhem/States/<machine>/inputs/<key>`. `CombinedObserver` forwards both. A composite observer of your own must forward `RegisterInput` and `Input` too. Logging is off by default so robots that already log their inputs do not log them twice.

Schema and observations do not control the machine. Keep allocations, schema construction, and registration outside the control loop. The observer APIs themselves do not start a NetworkTables server or DataLogManager.

## Checks

```sh
cmake -S lib-cpp -B lib-cpp/build -DBUILD_TESTING=ON
cmake --build lib-cpp/build
ctest --test-dir lib-cpp/build --output-on-failure
```

Tests exercise `PoseDriver` (reached, watchdog, invalid input, `dt == 0`, cancel), arrival/settling, moving handoff, invalid data, limits, watchdog behavior, loop-overrun clamping, goal telemetry and observer output, typed conditions and priority in `StateMachine`, `Settle` with one-shot events and clocked ticks, input logging, `TypedMachine`, no allocation per tick (counted `operator new`), alliance transforms including a closed-loop red run that matches the flipped blue run, the generated example header (`examples/suite/competition.hpp`), and agreement with the browser controller. App tests (`app/tests/export-cpp.test.ts`, `cpp-vendor.test.ts`) cover the exporter, `--check`, vendoring, and the vendordep layout. Host timings are not roboRIO benchmarks. No physical robot validation has been completed for this new library.
