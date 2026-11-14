# Running autos

An exported routine is a graph of steps: drive to a pose, run an action, wait for a condition. `mayhem::AutoRunner` walks that graph on the robot. You give it the robot's pose and speed every loop, and it returns field-relative speeds for your drivetrain.

## The shape of it

```cpp
#include <mayhem/alliance.hpp>
#include <mayhem/auto_runner.hpp>
#include "MayhemProject.h"  // generated

// Construct once, while disabled (both allocate).
mayhem::AllianceRoutine routine{mayhem_generated::routine_0::info,
                                mayhem_generated::fieldLength, mayhem_generated::fieldWidth};
mayhem::AutoRunner runner{routine.View()};
```

| When | Call |
| --- | --- |
| Startup | `Bind` every action and `BindSignal` every condition input; check `UnboundReport()`. Optionally `Attach` an observer. |
| Autonomous init | `routine.Apply(...)` for the alliance, reset odometry to `routine.StartPose()` if you want, then `runner.Start(measuredVelocity)`. |
| Every loop | `auto speeds = runner.Tick(measuredPose, measuredVelocity);` and drive with `speeds`. |
| Disable or interrupt | `runner.Cancel()`, then stop your outputs. |

`Tick` returns **field-relative** m/s and rad/s, with the pose in **blue-origin** meters and radians. Convert if your drivetrain wants robot-relative speeds.

## Binding actions and conditions

Every action, custom step and event marker you named in the app is a string ID. Bind each one to robot code:

```cpp
runner.Bind("superstructure.intake", mayhem::Instant([&] { intake.Start(); }))
      .Bind("drivetrain.alignAndShoot", {[&] { aim.Begin(); },                // begin
                                         [&] { return aim.Tick(); },          // tick: Running, Succeeded or Failed
                                         [&](bool cancelled) { aim.End(); }}) // end, once
      .BindSignal("superstructure.ready", [&] { return mayhem::SignalValue{shooter.Ready()}; });
```

- `Instant(fn)` runs once and succeeds; use it for fire-and-forget requests.
- A full action has `begin`, `tick` (return `ActionStatus::Running` until it really finishes) and `end(cancelled)`.
- Signals are typed and fail closed: a missing or wrong-typed input is false, even under NOT.

Check for missing bindings before the match, not during it:

```cpp
if (auto missing = runner.UnboundReport(); !missing.empty())
  unboundAlert.SetText("Unhandled Mayhem IDs: " + missing);  // one "<kind> <id> (node <node>)" per line
```

An unbound action fails its step, and the routine fails with it.

::: tip Timeouts are failures, unless you say otherwise
A watchdog timeout fails the routine. For a deliberate fixed window ("aim and shoot for 3.5 s, then go"), turn on **Done when time runs out** for that step in the app. The step then ends as done when its time is up.
:::

## Red alliance

Routines are authored on blue. Never flip nodes by hand; apply a transform when the alliance is known:

```cpp
routine.Apply(isRed ? mayhem::FieldTransform::Flip : mayhem::FieldTransform::None);
drive.ResetPose(routine.StartPose());
runner.Start(measuredVelocity);
```

`Flip` is a 180° rotation, which is right for rotationally symmetric fields (2022, 2025, 2026). Use `MirrorLength` for mirror-symmetric fields (2023, 2024), and `Mirror` for a left/right variant of the same auto. `Apply` re-derives from the blue routine every time, so calling it on every enable is safe. Don't transform measured odometry; it's already blue-origin.

## An auto chooser

`mayhem_generated::routines` holds every routine in project order, each with a `name` for the chooser. `mayhem::FindRoutine(routines, nameOrId)` looks one up. To draw the selected auto on a `Field2d` while disabled, use `mayhem::PreviewPath(info, transform, fieldLength, fieldWidth)`: it's the path the preview drives, corners included, not straight lines between steps.

## Telemetry

- `runner.Status()`: Running, Completed, Failed or Cancelled.
- `runner.ActiveGoal()` and `runner.LastResult()`: the current target and the follower's errors, so you don't recompute them.
- `runner.Overruns()`: loops slower than 0.1 s. The runner clamps them instead of failing; watchdogs still count real time.

Attach an observer so the State machines page can show the routine live and in log replay:

```cpp
mayhem::WpiLogObserver autoLog{frc::DataLogManager::GetLog(), "Autonomous"};
runner.Attach(autoLog, mayhem_generated::autonomous::manifest,
              [] { return frc::Timer::GetFPGATimestamp().value(); });
```

See [Logging and what's deployed](/robot-code/logging).

## Just driving to a pose

For a teleop "go to the scoring spot" button, skip the runner and use `mayhem::PoseDriver` (any loop) or `mayhem::DriveToPose` (a command, from `wpilib.hpp`). Both drive to one goal with a watchdog and stop the drivetrain when they end.

## Before you trust it

The app's preview is kinematic. On the real robot, tune the controller gains, test cancelling mid-auto, test with a sensor unplugged, and check headings on both alliances before running an auto at full speed.
