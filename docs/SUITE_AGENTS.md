# Building robot code with Mayhem

Mayhem is a visual workspace and a set of optional tools. Robot code is the source of truth. You may use arbitrary C++, WPILib commands, custom controllers, dynamic targeting, strategy code, and state machines. The editor does not define the limits of an autonomous routine. Publish a machine description and observations when that helps a human review your work; do not rewrite a good robot architecture just to fit the graph.

## Default autonomous approach

Movement: the path follower is ported from BLine-Lib (BSD 3-Clause; see THIRD_PARTY_NOTICES.md) and wrapped in Mayhem's routines, branching and state machines. Pose steps joined by a single "Always" transition form one BLine path. Each intermediate point hands off only once the robot enters its handoff circle (default 0.45 m; set `projectedHandoff: true` on a goal to also hand off by segment progress, which cuts corners). Speed is P on remaining path distance clamped to max velocity, aimed at the active point, with cross-track correction; speeds are capped and their change limited by the accelerations. Heading blends between rotation targets by monotonic path progress; `markers` place rotation targets and event triggers on segments by progress t. A step marked `stop`, or with a conditional exit, ends the path. Defaults match BLine: 4.5 m/s, 12 m/s², 720°/s, 1500°/s², gains 5 / 3 / 2, end tolerances 0.03 m and 2°. Wide swings at corners mean the robot's max acceleration is low for its max speed: lower the step's max speed or add points. Not a time-parameterized trajectory solver.

- **Heading through pickups.** The robot's front is +x (its intake on most robots). Heading blends by path progress from the last rotation target to the next Fixed anchor or rotation marker; Free anchors are not targets, so a route of Free points ending in one Fixed heading rotates the whole way and can hit pieces sideways. On a step where the front must lead, set `goal.headingMode: "motion"`: the robot faces its direction of travel on that segment, is already facing it when the segment starts (the previous segment blends toward it, finishing at the handoff circle), and later segments blend on from the heading actually commanded, with no snap. `goal.headingOffset` (radians) is added to Motion and PointAt headings (`Math.PI`: drive backward through it). To hold a heading until progress t on a segment and only then rotate, put a rotation marker at t with the heading to hold (`{ kind: "rotation", t: 0.7, heading: <held> }`); the segment then blends from the marker to the anchor's heading. `simulate` returns `headingWarnings` for any event marker that fires with the front more than 45° off the direction of travel; preview playback shows the robot's heading on the field.
- **Speed caps ahead.** By default (BLine) a step's `maxVelocity` applies only after its handoff, so the robot reaches a slow step fast and brakes there. `constraints.anticipateSpeedCaps: true` (robot, routine, or step) instead limits speed to `sqrt(cap² + 2·maxAcceleration·d)`, where d is the distance to that step's handoff point, so it arrives at the cap. The editor previews such paths with the native follower. Generated constraints still assume the BLine behavior and may be conservative when this is on.
- Coordinates are blue-origin meters, radians, seconds, and field-relative velocities. Explicitly convert any vendor API that expects robot-relative speeds. Apply alliance transformations once, consistently, including point-at targets.
- Final goals require translation and heading tolerance, measured low speed, and a settling interval. Intermediate goals can use a moving handoff radius. Translation goals may leave heading unconstrained.
- Advance actions on observed conditions: possession, mechanism readiness, action completion, or pose arrival. Timeouts are watchdog failures, never evidence that a movement or mechanism succeeded. The one exception is a deliberate fixed window on an action or custom step (aim and shoot for 3.5 s): set `onTimeout: "succeed"` on that step and its `timeout` becomes the window (editor: Advanced, **Done when time runs out**). Pose steps cannot use it.
- Use arbitrary action IDs and concurrent `during` actions for robot-owned work. Signal lookup is typed; missing or mismatched inputs fail closed, including under NOT. Transition order is priority order when several guards are true.
- Handle disabled mode, cancellation, actuator limits, lost sensors, and localization quality in robot code. A client disconnect does not stop robot code. Mayhem's live viewer only subscribes to NetworkTables and cannot issue robot commands.

## Shared project files

The public contract is `app/src/suite/core/model.ts`. The versioned JSON format is `mayhem-suite`, version 1. `extensions` is open and round-trips through the editor. Each routine can override the robot's default starting pose. Robot code owns the decision to reset odometry.

In the desktop app, open or save a linked project file. Local edits save with revision checks. The app watches the linked file: changes on disk (agents, generators, `git checkout`) appear within about a second, including temp-file-plus-rename writes and writes that keep the same revision, and the top bar says `Reloaded from disk · <time>`. The link is remembered per project, so a relaunch (or switching back to that project) reopens the file and picks up anything written meanwhile. A reload keeps the open page, the selected routine and step, the selected machine, state and edge, and the log replay position; a selection that no longer exists falls back to the routine's first step. A file that does not parse or validate (for example, half written) keeps the last good version on screen with an error banner, and recovers on the next good write. If the file changes while the app has edits it could not save, nothing is overwritten: a prompt offers **Load file version** (your copy is kept as a separate project), **Keep mine** (writes it over the file at the next revision) and **Show changes**. Use the same lock/revision protocol to prevent competing writes. The browser build cannot watch files; live reload needs the desktop app.

**Showing a project to the user.** To put a project file in front of the user, linked and live, run `node scripts/mayhem.mjs open <file>` (MCP: `open_in_app {"path": …}`). It validates the file, then hands it to the desktop app with `open -a Mayhem <file>`. A running app comes to the front and switches to that project instead of launching a second copy. The file becomes the linked, watched file (exactly like Agents → Open project file) and is remembered across relaunches. If the library already holds that project (same project `id`), that copy is reused and refreshed from the file. If that copy has edits the file lacks, the user gets the keep/load/show-changes prompt. `open -a Mayhem <file>` and the link `mayhem://open?path=<url-encoded absolute path>` work the same way without Node. This is macOS-only for now (desktop app 0.9.20 or later). Browser mode imports/exports snapshots and keeps its working copy locally. Click the project name in the top bar to create, rename, duplicate, or switch projects. Saved projects are local snapshots; selecting one preserves the outgoing working copy and detaches any file link. Use Open project file to reconnect to an agent-edited file. Each project has independent undo history and preview state; the recording library is shared across projects.

Release downloads include `Mayhem-suite-tools-<tag>.zip`. Extract the whole archive and run the
commands below from its root; no npm installation is needed. The same commands work in a source
checkout. Requires Node 24+ (the version used by CI, with TypeScript stripping and WebSocket support):

```sh
node scripts/mayhem.mjs example > robot.mayhem.json
node scripts/mayhem.mjs inspect robot.mayhem.json
node scripts/mayhem.mjs validate robot.mayhem.json
node scripts/mayhem.mjs simulate robot.mayhem.json '{"mode":"path"}'
node scripts/mayhem.mjs simulate robot.mayhem.json '{"signals":{"pieceDetected":true,"shooterReady":true,"shotComplete":true},"actions":{"intake.acquire":"succeeded","shooter.fire":"succeeded"}}'
node scripts/mayhem.mjs simulate robot.mayhem.json '{"freezeDrive":true}'
node scripts/mayhem.mjs cpp robot.mayhem.json --out src/main/include/MayhemProject.h
node scripts/mayhem.mjs cpp robot.mayhem.json --check src/main/include/MayhemProject.h
node scripts/mayhem.mjs machine apply robot.mayhem.json tools/mayhem/machines.json
node scripts/mayhem.mjs machine spec robot.mayhem.json ShooterMode
node scripts/mayhem.mjs route import-mtraj robot.mayhem.json tools/mayhem/routes.json --dry-run
node scripts/mayhem.mjs analyze run.wpilog
node scripts/mayhem.mjs review ../FRC_Offseason_2026 main WORKTREE
node scripts/mayhem.mjs live roborio-3256-frc.local '{"topics":["/Robot/BatteryVoltage"],"durationMs":1000}'
```

`save <file> '<JSON>'` takes `{ "project": <full project>, "expectedRevision": <current revision or null for a new file> }`. Saves are atomic and increment the revision. Re-read after a revision conflict. Do not delete another writer's lock during an active save.

Use Node 24 or later. The entry point installs a local import hook for the
the path-preview source, including TypeScript syntax that needs transformation.
No npm install or additional launcher flags are required. For portable tools,
keep the extracted archive's full directory tree (including `pathing` and
`scripts/suite-imports.mjs`); copying just `mayhem.mjs` is insufficient.

Routine `constraints` inherit from robot defaults. A node's `generatedConstraints`
contains automatic `maxVelocity` and/or `handoffRadius`; node `constraints` are
manual overrides. Generated speed caps can tighten but never raise the inherited
path speed limit. Positive `goal.handoffRadius` is an explicit manual radius.
The C++ exporter flattens these layers into the existing runtime fields. The
editor preview uses the ideal kinematics and joint constraint generator;
the C++ feedback controller is unchanged. Do not infer robot tracking accuracy
from a successful editor preview.

The same functions are available as MCP tools over newline-delimited JSON-RPC on stdio:

```json
{
  "mcpServers": {
    "mayhem": {
      "command": "node",
      "args": ["/absolute/path/to/Mayhem/scripts/mayhem.mjs", "mcp"]
    }
  }
}
```

Tools: `inspect_project`, `validate_project`, `save_project`, `simulate_auto`, `export_cpp`, `vendor_cpp`, `open_in_app`, `apply_machine_spec`, `machine_spec`, `import_mtraj_route` (see "Authoring machines and routines"), `behavior_diff` (see "Behavior review"), `run_scenarios` (see "Sim proof"), `list_tasks`, `get_task`, `claim_task`, `propose_plan`, `report_progress`, `finish_task`, `release_task`, `add_feedback` (see "Tasks"), `log_states`, `analyze_log`, `inspect_live_robot`, and the log-investigation tools below. They do not deploy robot code. Use your normal robot project build/deploy tools.

## Authoring machines and routines

Do not keep ad-hoc dict builders in the robot repo for machines or routines. Write a compact spec and apply it; the tools validate it, write the project atomically with a revision bump, and the desktop app reloads it.

### Machine specs

`node scripts/mayhem.mjs machine apply <project> <spec.json | - | JSON> [--dry-run] [--expect-revision N]` (MCP `apply_machine_spec {path, spec, expectedRevision?, dryRun?}`) turns each spec into a `mayhem-machine` manifest and replaces the machine with the same `id` in `extensions.machines`, in place, or appends it. The spec is one machine, a list, or `{"machines": [...]}`. `machine spec <project> <id>` (MCP `machine_spec`) prints an existing machine as a spec, so you can edit it and apply it back. A dry run returns the manifests and writes nothing; a failed apply writes nothing.

```json
{
  "id": "IntakeMode",
  "name": "Intake mode",
  "description": "What the intake is doing.",
  "initial": "STOWED",
  "source": "src/main/cpp/subsystems/Superstructure.cpp",
  "inputChannel": "/RealOutputs/Mayhem/States/Superstructure/inputs/{key}",
  "stateChannel": "/RealOutputs/Superstructure/IntakeMode",
  "inputs": {
    "operator": {
      "intakePressed": { "name": "X pressed (intake on / off)", "event": true },
      "jitterHeld": "Y held (jitter)"
    },
    "internal": {
      "enabled": "Robot enabled",
      "stopAll": { "name": "Stop everything", "event": true },
      "deploy": { "name": "Intake mode wants the slide out", "derivedFrom": ["intakePressed", "jitterHeld"] }
    },
    "sensor": { "distance": { "name": "Shot distance", "type": "number", "unit": "m", "initial": 0 } }
  },
  "states": {
    "STOWED": "Stowed",
    "INTAKING": { "name": "Intaking", "description": "Slide out, rollers in." },
    "JITTERING": "Jittering"
  },
  "transitions": [
    "* -> STOWED: !enabled || stopAll  # Disabled or stop all",
    "STOWED -> INTAKING: enabled && intakePressed  # X",
    "INTAKING -> STOWED: intakePressed  # X",
    "INTAKING -> JITTERING: jitterHeld && distance < 2.5",
    { "from": "JITTERING", "to": "INTAKING", "when": "!jitterHeld", "name": "Y released", "description": "Back to intaking." },
    "* except STOWED -> JITTERING: stateTime > 10"
  ]
}
```

- **Header fields**: `id` (required); `name` (default `id`); `description`; `initial` (default the first state); `selection: "priority"`; `stateChannel`; `source` (code reference for every state); `inputChannel` (each input's `channel`; `{machine}` and `{key}` are replaced).
- **`inputs`**: category (`operator`, `sensor`, `internal`, `timer`, `auto`) → key → a display name, or `{name, type, initial, unit, event, channel, derivedFrom}`. Types default to boolean (initial `false`; numbers `0`, strings `""`). `event: true` marks a one-shot input. `derivedFrom` entries are same-machine keys or `"<Machine>::<key>"` for another machine's input. Inputs appear in the manifest (and the generated `Inputs` struct) in the order written. `stateTime` is declared for you when a condition uses it.
- **`states`**: ID → display name or `{name, description, source}`, in declaration order (or a list of IDs / `{id, ...}` objects).
- **`transitions`**, in priority order: `"FROM -> TO: condition  # name"`, `"* -> TO: ..."` (from any state), `"* except A, B -> TO: ..."`, or `{id, from, to, when, name, description, except}` when a state ID contains spaces or you want a description. IDs default to `<from>-to-<to>` (`any-to-<to>` for `*`; repeats get `-2`).
- **Conditions**: input keys; `&&`/`and`, `||`/`or`, `!`/`not`, parentheses; comparisons `==`, `!=`, `>`, `<`, `>=`, `<=` with `true`/`false`, numbers or quoted strings; `always`. A bare boolean input means `== true` and `!input` means `== false`; `!=`, `>=`, `<=` are stored as `not` of `==`, `<`, `>`. An undeclared input, a type mismatch, or an unknown state is an error naming the machine, the transition and the reason. Inputs that no transition reads are reported as warnings.

### Routes from solved `.mtraj` passes

`node scripts/mayhem.mjs route import-mtraj <project> <spec.json | - | JSON> [--dry-run] [--expect-revision N]` (MCP `import_mtraj_route`) builds or rebuilds routines from solved classic-planner passes. Each pass becomes pose steps at its original waypoints plus the fewest extra points that keep the driven line within `pathTolerance` m and the heading within `headingTolerance` degrees of the solve (Douglas-Peucker between waypoints), merged when closer than `minDt` s. Each step gets the solved position and heading (fixed heading, profiled), and a speed cap equal to the fastest solved speed on its segment × `speedScale`, clamped to [`minSpeed`, `maxSpeed`] (default: the robot's max velocity); the last step of a pass stops, with `finalSpeed`. Pass-through steps hand off at `cornerRadius`. Solved events listed in `events` become event markers at their position on the segment; others are reported and skipped. `.mtraj` paths are relative to the project file. A dry run returns the routines and writes nothing.

```json
{
  "events": { "intake": "superstructure.intake" },
  "endEvents": ["superstructure.stow"],
  "options": { "pathTolerance": 0.15, "headingTolerance": 10, "minDt": 0.15, "finalSpeed": 3 },
  "constraints": { "translationKp": 4.5 },
  "routines": [
    {
      "routine": "depot-sweep",
      "name": "Depot Trench Sweep",
      "finish": { "id": "done" },
      "passes": [
        {
          "mtraj": "tools/mayhem/solved/DepotTrenchSweepBumpPt1.mtraj",
          "after": [{ "id": "align-shoot-0", "name": "Aim and shoot", "kind": "custom",
                      "action": "drivetrain.alignAndShoot", "timeout": 3.5, "onTimeout": "succeed" }]
        }
      ]
    }
  ]
}
```

- Top-level `events`, `endEvents`, `options` and `constraints` are defaults for every routine in `routines` (a single routine spec works too). `endEvents` fire at the end of each pass (t = 1 on its last step).
- `options` (defaults): `pathTolerance` 0.15, `headingTolerance` 10, `minDt` 0.15, `speedScale` 1, `minSpeed` 0.8, `maxSpeed` robot max, `finalSpeed` 3, `cornerRadius` 0.3, `pointTolerance` 0.12, `pointHeadingTolerance` 0.2 rad, `finalTolerance` 0.15, `finalHeadingTolerance` 0.08 rad, `settleTime` 0.04, `stepTimeout` 5.
- `after` steps are appended after their pass (IDs default to `<routine>-pass<n>-after<k>`). Every step continues to the next with an Always transition, then a finish step (`finish: false` to leave it out; `{id, name}` to name it). Step IDs are `<routine>-pass<n>-p<k>`. The routine's start pose is the first pass's first sample, and an existing routine keeps its other fields.
- With the 3256 robot's solved passes this reproduces `rebuild_routes.py` exactly for passes it did not hand-edit. Hand-placed passes and per-point heading overrides are ordinary edits afterwards (in the app or with `save_project`).

## Generated C++ for robot code

**Stable downloads.** Every release `vX.Y.Z` (from v0.9.13) carries, at
`https://github.com/ryanabraham1/Mayhem/releases/download/vX.Y.Z/<file>`:

| File | Contents |
| --- | --- |
| `Mayhem-suite-tools-vX.Y.Z.zip` | Node CLI/MCP (`Mayhem-suite-tools-vX.Y.Z/scripts/mayhem.mjs`), the C++ headers it vendors, docs, examples. Node 24+, no npm install. |
| `Mayhem-cpp-vX.Y.Z.zip` | Header-only C++ library with CMake files and tests. |
| `Mayhem-suite-SHA256SUMS.txt` | SHA-256 of both archives. |
| `MayhemCpp.json`, `MayhemCpp-maven.zip` | The C++ vendordep and its maven repo, for offline installs. |

The hosted vendordep is `https://ryanabraham1.github.io/Mayhem/MayhemCpp.json` (maven at
`https://ryanabraham1.github.io/Mayhem/maven/`, artifact `mayhemlib:MayhemCpp-cpp:<C++ version>`).
Pin the tools to a release in robot CI rather than cloning the repo:

```sh
MAYHEM=v0.9.13
curl -fsSLO "https://github.com/ryanabraham1/Mayhem/releases/download/$MAYHEM/Mayhem-suite-tools-$MAYHEM.zip"
curl -fsSLO "https://github.com/ryanabraham1/Mayhem/releases/download/$MAYHEM/Mayhem-suite-SHA256SUMS.txt"
grep " Mayhem-suite-tools-$MAYHEM.zip\$" Mayhem-suite-SHA256SUMS.txt | shasum -a 256 -c -   # sha256sum -c on Linux
unzip -q "Mayhem-suite-tools-$MAYHEM.zip"
node "Mayhem-suite-tools-$MAYHEM/scripts/mayhem.mjs" cpp robot.mayhem.json --check src/main/include/MayhemProject.h
```

`releases/latest/download/...` is not stable for these because the file names contain the tag;
always pin. Releases built locally while GitHub Actions is unavailable are macOS-only for the
desktop app, but still attach these files.


Use the official exporter; do not maintain a second one in the robot repo. `cpp <project> --out <header>` writes a C++17 header (and leaves an up-to-date file untouched); `cpp <project> --check <header>` exits 1 with a regenerate command when the header is stale, so put it in CI or a Gradle task. Output depends only on project content (not `revision` or key order) and a successful run writes nothing to stderr. The header (`namespace mayhem_generated`) contains:

- every routine: `routine_<i>::routine`, `::name` (chooser label), `::startPose`, `::signalKeys` (the inputs its guards read), `::preview` (its path as the editor's path-only playback drives it, a pose about every 0.1 m from the start pose, blue origin), and the `routines` array of `mayhem::RoutineInfo{name, routine, startPose, preview}` (`mayhem::FindRoutine(routines, nameOrId)`);
- `autonomous::manifest`: one `Autonomous` mayhem-machine manifest for the live viewer and log replay. States are the union of routine nodes; transition IDs are `"<routine id>/<transition id>"` (`mayhem::QualifiedTransitionId`), unique across routines. `AutoRunner::Attach` reports with exactly these IDs;
- every `extensions.machines` graph as a `mayhem::MachineView` (`machine_<i>::machine`, alias `<MachineId>::machine` when the ID is a C++ identifier, and the `machines` array), each with its manifest embedded (`manifest.Text()` for `Describe`);
- `fieldLength` / `fieldWidth` for alliance transforms.

In robot code (details and signatures in `lib-cpp/README.md`):

- Mechanism graphs: use the typed machine `mayhem_generated::<Machine>::Machine` (below): set its `In()` fields, `Settle()` once per loop, and test `Is(State::X)` / `Current()`. The string API (`mayhem::StateMachine(machine, signalCallback)`, `Tick(dt)`, `State()`) still works. Guards are typed and fail closed; declaration order is priority; `stateTime` is built in. Do not emulate a machine with an AutoRunner routine of fake custom nodes.
- Autos: `mayhem::AllianceRoutine(routines[i], fieldLength, fieldWidth)` then `Apply(FieldTransform::Flip)` for red (covers goal poses, PointAt aim points, rotation markers, the start pose and `Preview()`). Do not flip nodes by hand. To draw the selected auto while disabled, use `mayhem::PreviewPath(routines[i], transform, fieldLength, fieldWidth)` (or `AllianceRoutine::Preview()`): it is the path the follower is previewed to drive, not straight lines between steps.
- Robot actions: bind each action, custom step and path-event ID on the runner instead of string if-chains in `RobotHooks` (below), and fail at startup when `Unbound()` is not empty.
- Driving to a live-pose goal: `mayhem::PoseDriver` (`pose_driver.hpp`, framework-free): `Start(now)` once, then `Update(now)` each loop returns `Running`/`Reached`/`Failed`; `Cancel()` stops it. It wraps `PoseController` with a watchdog and writes one zero velocity when it ends. Command-based robots can use `mayhem::DriveToPose` (`wpilib.hpp`, needs wpilibNewCommands), which is the same driver as a command. Log observation without the command framework: `mayhem::WpiLogObserver` from `wpilib_log.hpp` (needs only `wpi/DataLog.h`). A robot without wpilibNewCommands must not include `wpilib.hpp`; every other header compiles without frc2.
- Install the headers with the MayhemCpp vendordep (`https://ryanabraham1.github.io/Mayhem/MayhemCpp.json`) or `node scripts/mayhem.mjs vendor <robot dir>` (copies every header in `lib-cpp/include/mayhem` and writes a SHA-256 snapshot; `--check` for CI). Headers are only compiled when included, so vendoring `wpilib.hpp` into a command-free robot is harmless. Do not hand-copy headers or keep your own hash file.
- `AutoRunner` clamps a loop overrun (`dt > RunnerOptions::maxDt`, default 0.1 s) instead of failing the routine; watchdogs use real time. Read goal errors from `LastResult()` / `ActiveGoal()` instead of recomputing them, or `Attach(observer, autonomous::manifest, clock)` to emit Enter/Guard/Transition/GoalProgress.

### Typed machines, events and settling (C++ library 0.7.0)

For every `extensions.machines` graph, `cpp` also emits a typed API in the machine's namespace: `enum class State` (one value per state, in declaration order), `struct Inputs` (one field per declared input with its manifest type and initial value: `bool`, `double` or `std::string`; `stateTime` is built in), guards that read the struct directly, and `using Machine = mayhem::TypedMachine<Def>`. A misspelled input or state is a compile error, not a guard that silently fails closed. Input keys and state IDs become C++ names by replacing other characters with `_` (`intake.requested` → `intake_requested`); a name that does not start with a letter gets a `k` prefix, a keyword gets a trailing `_`, and the field comment shows the original key.

```cpp
mayhem_generated::ShooterMode::Machine shooter;                    // member; not copyable
using Shooter = mayhem_generated::ShooterMode::State;
shooter.Attach(observer, [] { return frc::Timer::GetFPGATimestamp().value(); },
               mayhem::InputLogging::On);                          // startup: clock + input logging

auto& in = shooter.In();                                          // every loop
in.enabled = frc::DriverStation::IsEnabled();
in.shootHeld = controller.GetAButton();
in.stopAll = stopRequested;                                       // event: reset after this loop
shooter.Settle();                                                 // dt from the clock; or Settle(dt)
if (shooter.Is(Shooter::SHOOTING)) { ... }
switch (shooter.Current()) { case Shooter::OFF: ...; }
```

- **One-shot events.** Mark an input `"event": true` in the manifest (button presses, one-loop requests such as `intakePressed`, `autoIntake`, `stopAll`). It is visible to the first step of a loop only: a typed machine resets the field to its `initial` value after that step, and `StateMachine::Settle` reads it as `initial` on later steps. Inputs without the flag are levels.
- **Settle to a fixpoint.** `Settle(dt, maxSteps = 8)` steps until no transition fires, all in one loop; time advances on the first step only. It returns the transitions taken, and `Settled()` is false if it stopped at `maxSteps` (a cycle). A released inside the alliance zone goes SHOOTING → OFF → REV in one `Settle`, and an X press toggles INTAKING on once instead of on and off again. `Tick(dt)` is still exactly one step. The States page's simulate mode settles the same way, and shows event inputs as **press** buttons.
- **Clocked ticks.** After `SetClock(clock)`, or `Attach(observer, clock)` with a clock, `Tick()` and `Settle()` without a dt use the time since the previous clocked call (or since `SetClock`/`Reset`). Without a clock that dt is 0: guards run, `stateTime` does not advance.
- **Automatic input logging.** `Attach(observer, clock, mayhem::InputLogging::On)` registers every declared input with the observer and reports its value on the first step of every `Tick`/`Settle` (off by default). `WpiLogObserver` writes a typed WPILOG entry at the input's manifest `channel` (or `Mayhem/States/<machine>/inputs/<key>`), and `NtStateObserver` publishes `/Mayhem/States/<machine>/inputs/<key>`, which the live viewer and log replay read. A custom observer implements `RegisterInput(machine, input)` and `Input(machine, key, value, timestamp)` (new `StateObserver` virtuals with no-op defaults; `CombinedObserver` forwards them). Declare `stateTime` as an input to log it too.
- `Untyped()` returns the underlying `StateMachine` (`Signal(key)`, `View()`); `Machine::Name(State::X)` is the manifest ID for logs.

### Binding autonomous actions (C++ library 0.8.0)

```cpp
mayhem::AllianceRoutine routine(*mayhem::FindRoutine(gen::routines, "Depot Trench Sweep"), gen::fieldLength, gen::fieldWidth);
mayhem::AutoRunner runner(routine.View());       // no RobotHooks needed
runner.Bind("superstructure.intake", mayhem::Instant([&] { superstructure.StartIntaking(); }))
      .Bind("superstructure.stow", mayhem::Instant([&] { superstructure.StowIntake(); }))
      .Bind("drivetrain.alignAndShoot", {[&] { /* begin */ },
                                         [&] { /* tick: aim, request the shot */ return mayhem::ActionStatus::Running; },
                                         [&](bool cancelled) { /* end: stop shooting */ }})
      .BindSignal("superstructure.ready", [&] { return mayhem::SignalValue{superstructure.IsReadyToShoot()}; });
if (const auto report = runner.UnboundReport(); !report.empty()) throw std::runtime_error("Unbound auto IDs:\n" + report);
runner.SetClock([] { return frc::Timer::GetFPGATimestamp().value(); });   // or Attach(observer, manifest, clock)

// autonomousInit: routine.Apply(red ? Flip : None); reset odometry to routine.StartPose(); runner.Start(velocity);
// each loop:      drive(runner.Tick(pose, velocity));   // dt from the clock
```

- `Bind(id, {begin, tick, end})`: `begin` on entering the step, `tick` every loop until it returns Succeeded or Failed (an empty `tick` succeeds at once), `end(cancelled)` once on exit. `Instant(fn)` runs `fn` and succeeds. A path event marker with that ID runs `begin` when it fires.
- `BindSignal(key, fn)` supplies a guard input.
- `Unbound()` / `UnboundReport()` list every action, `during` action, path event and guard signal of the routine with no binding (each once, with the first node using it). Check it at boot so a missing binding fails then, not mid-match. An unbound action fails its step.
- `RobotHooks` still works: `AutoRunner(routine, hooks)` sends everything that is not bound to the hooks, so you can migrate one ID at a time (bindings win). Guards receive your hooks object unless you bind signals.
- `Tick(pose, measured)` without a dt uses the clock; without a clock it fails the routine rather than stall. `Tick(pose, measured, dt)` is unchanged.
- A step with `onTimeout: "succeed"` (`AutoNode::onTimeout = TimeoutOutcome::Succeed`) ends as done when its `timeout` expires, so a fixed window such as the 3.5 s align-and-shoot is data in the project instead of a timer in `TickAction`. The action can still succeed sooner or fail. Simulation, validation and the editor treat it the same way.

## Behavior review

People on the team review what a change does to the robot, not the code. The desktop app's **Changes** page and the `behavior_diff` tool (CLI: `node scripts/mayhem.mjs review <robot repo> [before] [after] [--json]`) compare two revisions (`before` defaults to `HEAD`, `after` to the uncommitted working tree, `WORKTREE`). Everything is read deterministically from the files, never from an agent's description:

- **Hardware and values** from `src/main/include/**/*.h`: `constexpr`/`const` constants at namespace or class scope and CTRE configuration chains (`.WithCurrentLimits(CurrentLimitsConfigs{}.WithStatorCurrentLimit(80_A))`), with units from literals (`80_A`, `4.3_tps`), unit types, `[unit]` in the doc comment or the name (`…Seconds`). Derived values are evaluated and report the input that changed them. A CAN ID constant (`kLeftMotorId`, `kMotorIds = {44, // top left …}`) names a device; a configuration applies to the devices its name matches (`RightMotorConfigs` → right motor, `MotorConfigs` → every motor of that subsystem; `auto c = RightMotorConfigs();` inherits). Values in a `sim` namespace or named `kSim…` are simulation-only and not reviewed.
- **State machines and driver controls** from `tools/mayhem/machines.json`: states, transitions (matched by from/to, including priority order) and inputs. Changes that involve an `operator` input are driver-control changes; the team rule is that the same driver inputs give the same outcomes.
- **Autos** from the root `*.mayhem.json`: step changes, and each routine driven in the path preview before and after.

Risk: **red** = a CAN ID, motor direction, brake/coast, current limit, travel limit, gear ratio or calibration offset changed, a device was added/removed, or two devices of the same type now share a CAN ID; **yellow** = controls, machines or other values changed, or a changed auto no longer finishes; **green** = only auto paths changed and every changed path finishes. Run `behavior_diff` on your change before asking for review, and keep these shapes (named constants, one configuration function per motor group, transitions in machines.json) so the review can read your code. People can also edit a value from the page; that rewrites only that literal in the working tree, so expect such edits in `git status`.

## Sim proof

`run_scenarios` (CLI: `node scripts/mayhem.mjs sim <robot repo> [after] [--before <rev>] [--only button,auto,custom]`; the app: Changes → Sim proof) builds a revision with Mayhem's probe test (`app/src/suite/core/review/probe.cpp`, copied into a clean export of that revision, never committed) and runs each scenario through the robot's own `RobotHarness`, one process each, logging a WPILOG:

- every controller button tapped and held for 2 s from teleop (the button → outcome map),
- every routine in the root `*.mayhem.json` as a 20 s auto on the full field (`auto completes`, `no tip-over`),
- the team's `tools/mayhem/scenarios.json`.

`tools/mayhem/scenarios.json` is the regression gate; keep it passing and add a scenario for every behavior a driver relies on:

```json
{ "scenarios": [ {
  "name": "Outtaking blocks shooting (outside the zone)",
  "steps": ["teleop", "wait 0.3", "stick left 0 1", "wait 1.2", "stick left 0 0", "wait 0.5", "down LT", "wait 0.3", "down A", "wait 1", "up A", "up LT"],
  "expect": ["Shooter mode is OFF at 2.2 s", "Shooter mode never SHOOTING"]
} ] }
```

Steps: `teleop` | `auto` | `disabled`, `select auto <name>`, `wait <s>`, `press <button>`, `hold <button> <s>`, `down`/`up <button>`, `stick left|right <x> <y>` (forward +y). Buttons: A B X Y LB RB LT RT Back Start LS RS Up Down Left Right. Expectations: `<machine> is <STATE> by|at <t> s`, `<machine> reaches <STATE>`, `<machine> never <STATE>`, `auto completes`, `no tip-over`, `no collisions`, `battery stays above <v> V` (machine and state by name or id; seconds from the scenario start). A machine state that flips back and forth (6+ changes 0.1 s apart) always fails.

Outcomes are compared on every machine's `Mayhem/States/<id>/state` log channel, the drive mode, the auto status and the simulated robot pose; a difference in what the robot does for the same inputs is reported. Builds and runs are cached per commit in `~/.mayhem/review-sim`. The project file, `machines.json` and the generated `MayhemProject.h` must agree: `behavior_diff` reports red when a source changed but the generated code did not, because the robot (and the sim) would still run the old behavior.

### Closed loop: code, simulate, read, fix

1. Change the robot code (regenerate `MayhemProject.h` with `tools/mayhem/export.sh` if you touched `robot.mayhem.json` or `machines.json`).
2. `run_scenarios` with `after: "WORKTREE"` and either `names` (a few existing scenarios) or inline `scenarios` for the behavior you are testing. The working tree rebuilds incrementally (~45 s); a run of a few scenarios takes seconds. Each failed or changed result carries a `timeline` (every machine's states, flickering collapsed) and its log path.
3. For a state-machine problem, `log_states` on that log: each transition with the inputs at that moment; a flickering burst names both directions and the inputs that kept both guards true. For anything else, `log_anomalies` (flickering first), then `log_what_changed` at the time, then `log_table` of the suspects.
4. Fix and repeat. Before handing off, run everything with `before` set to your base (`run_scenarios {before: "HEAD"}` or the task's base) and add the scenario that reproduces the bug to `tools/mayhem/scenarios.json` so it stays fixed.

## Tasks

People leave feedback in the app (Logs: comment at a moment; Changes: thumbs up/down on any finding, click a field spot; Sim proof: comment at a replay time; Tasks: pit notes and the post-match driver form). Each becomes `tools/mayhem/review/<id>.json` in the robot repo with its context (`anchor`: log name and `logPath`, seconds into it, code revision, field pose, scenario, match).

1. `list_tasks`, then `get_task` for the context; open the log at `anchor.logPath` with the log tools.
2. `claim_task` (records `base` = HEAD).
3. `propose_plan` in plain English for people who don't read code: what changes on the robot and how they can see it. Wait: poll `get_task` until `status` is `approved` (or back to `claimed` with `planDecision.note` asking for something else). Do not change code before approval.
4. Commit with a `Mayhem-Task: <id>` trailer, then `report_progress` with the revision. Mayhem stores `behavior_diff`'s risk on the task: red (CAN IDs, limits, brake/coast, directions, ratios, offsets; or stale generated code), yellow (controls, machines, other values), green (only auto paths changed and every changed path finishes).
5. `finish_task`. If every reported commit is green it is accepted automatically; otherwise it waits in "Ready to check" for a person. `release_task` gives a task back with a note.

The Changes page shows, for the revisions being reviewed, the feedback and approved plan behind them ("Why this change"). Task files are plain JSON and written atomically; commit them with the code (or at least push them) so teammates and agents on other computers see them.

## Digging into logs

`analyze_log` returns a compact summary (add `channels`, `from`/`to` for per-channel stats, or `detail: "full"` for everything). To investigate, use the exploration tools; all take a WPILOG path (parsed once and cached) and return small ranked results:

1. `log_anomalies` — scan every channel for outliers, big jumps, sampling dropouts, flatlined sensors, boolean flapping, and channels that stop or start logging. Each hit has a time.
2. `log_what_changed` — for a suspicious `time`, rank the channels that deviated most from their own normal within `window` seconds, with before/after values.
3. `log_table` — line up to 20 channels on one clock (`step` or `points`, max 500 rows) to compare them at the same instants; up to 8 channels also returns pairwise correlation.
4. `log_events` — merged chronological changes of state/boolean/string channels (state machines, modes, alerts); dashboard plumbing, guard flags and NetworkTables copies are skipped unless `all: true`.
6. `log_states` — each Mayhem state machine's transitions with the inputs at each one; flickering bursts collapsed and explained.
5. `list_log_channels` — find channel names; `filter` takes case-insensitive substrings, which also match derived `/x`, `/heading`, `/0/speed` pose and module channels.

Typical loop: anomalies → what changed at that time → table of the suspects → events for the state that was active. Findings are symptoms to verify, not proven causes. Struct arrays (swerve module states/positions, Pose3d lists) are decoded into per-element channels, capped at 32 elements.

## State-machine visibility without architectural constraints

`examples/suite/intake.machine.json` demonstrates the `mayhem-machine` v1 format. It lists state IDs, typed inputs, transitions/conditions, optional code references, and optional existing channel names. Import it in State machines, store it under project `extensions.machines`, or publish its JSON at `/Mayhem/Schema/<machine>`.

Every transition (machine manifests and routines alike) can carry an optional `name` (short edge label, e.g. `"Hood clear"`) and `description` (why the edge exists). The graph shows `name` when present; otherwise the whole compact condition (`deploy ∧ ¬hoodClear`, `stateTime > 2.5`, `shotDemand ∨ ¬enabled`), wrapped. Only a condition longer than about 96 characters keeps just the terms that tell the state's edges apart (`… shoot ∧ jitter`). States are laid out in layers from the initial state, top to bottom. Every label is measured and placed on its own wire, clear of states and other labels, and edges that loop back get their own lanes. Hovering a state highlights its wires and dims the rest. In an autonomous routine's graph, each run of two or more pass-through poses (one unconditional exit, no event marker, `during` action, stop or settle) shows as one "Drive path" card with its point count, length, time span and a small trace. Click the card to show its points, and use "Collapse paths" to fold them again. Steps that do something (event markers such as intake on, stops, custom actions, branches) keep their own cards. A routine that is a single chain snakes across the view in rows. This is display only; the project's nodes are unchanged. Hover an edge or click its label for the full condition and description; the inspector lists a state's outgoing edges in priority order. Name your transitions: it is the cheapest way to make a large machine reviewable.

A machine transition can leave every state: `{"id": "toShoot", "from": "*", "to": "SHOOT", "except": ["HOME"], "condition": …}` is checked in every state except its target `SHOOT` and the optional `except` states, at its position in declaration order. A priority supervisor (each target reachable from every other state, the first true one winning) is one `"*"` transition per target in priority order, instead of one per source and target. Validation, the C++ exporter and `mayhem::StateMachine`, simulation and log replay all treat it this way, and observers report the real source state. Routines do not accept `"*"`. In the graph, a `"*"` transition, or a target that (almost) every state reaches on the same condition, shows as a "from any state" chip on its target and a row in a priority list above the graph. "Show all wires" draws the wires anyway, and the inspector still lists the selected state's exits in priority order.

For a supervisor that picks one state from the current requests, set `"selection": "priority"` on the machine. Then the rows (usually all `"from": "*"`) are checked from the top on every tick, and a `"*"` row is checked in its own target state too. The first true row picks the state; if that is the current state, the machine stays there (no re-entry: `stateTime` keeps counting, no lower row fires). End with an "otherwise" row whose condition is `{"kind": "always"}`. Each row then states only what it needs, with no negations of the rows above. Holding B keeps `HOME` even while A is also held, because the `home` row comes first:

```json
{"format": "mayhem-machine", "version": 1, "id": "Superstructure", "name": "Superstructure", "initial": "IDLE", "selection": "priority",
 "transitions": [
   {"id": "disabled",  "from": "*", "to": "IDLE",       "name": "Robot disabled",     "condition": {"kind": "signal", "key": "enabled", "op": "eq", "value": false}},
   {"id": "home",      "from": "*", "to": "HOME",       "name": "Home",               "condition": {"kind": "signal", "key": "home", "op": "eq", "value": true}},
   {"id": "shoot",     "from": "*", "to": "SHOOT",      "name": "Shoot",              "condition": {"kind": "signal", "key": "shoot", "op": "eq", "value": true}},
   {"id": "otherwise", "from": "*", "to": "IDLE",       "name": "Nothing requested",  "condition": {"kind": "always"}}
 ], "states": [...], "inputs": [...]}
```

`mayhem::StateMachine` (C++ library 0.5.0, `MachineView::prioritySelect`, emitted by `cpp`), simulation and replay follow the same rule. The State machines page draws a priority machine as a decision ladder instead of a graph. Each question is written with input names and "and" / "or" / "not" (e.g. "O Home requested (B)?"). A "yes" arrow points to the state it picks, a "no" arrow falls to the next question, and the current state and the deciding question are highlighted live, in replay and in simulation. Give inputs readable `name`s (with the button, e.g. "Home requested (B)"), because that is what people read. Both fields round-trip through the editor, `validate`, and the exported manifests.

Every input (machine `inputs[]` and project `signals[]`) can carry an optional `category`: `"operator"` (driver or controller request), `"sensor"` (measured: encoders, beam breaks, flywheel at speed, pose), `"internal"` (code-derived: latched intent, zone flags, demands from another machine; the default when missing), `"timer"` (`stateTime`, also the default for that key), or `"auto"` (requested by the autonomous routine). Graph conditions mark each input with its category as a colored letter badge (O operator, S sensor, I internal, T timer, A auto), with a legend; the inputs panel groups by category; and when the active state changes (simulate, live, or log replay) the view says why, e.g. `Ready → Jittering because O jitterDemand` (the inputs of the taken edge that changed; a `stateTime` deadline blames the timer). An internal flag can list its sources with `derivedFrom: ["shoot", "intake"]` (keys of other inputs of the same machine, or of `signals[]` for a project signal). A source in another machine of the same project is an object, `derivedFrom: [{ "machine": "Superstructure", "key": "jitter" }]`; a dotted string such as `"Superstructure.jitter"` is always a same-machine key, because keys may contain dots. The inputs panel shows such a source as `from Superstructure · jitter` with that input's category badge, its hover names the source input and the categories at the root of the chain (e.g. `driven by operator input`), and a multi-hop chain that ends in a different category says `driven by O operator`. Both fields are validated (`validate` checks that the machine and key exist; a single imported or live-published manifest checks only the shape, since it cannot see the other machines) and round-trip into exported manifests; the C++ runtime does not read them.

An input can also carry `"event": true`: a one-shot press or request that is true for one robot loop only (see "Typed machines, events and settling"). The defaults are `/Mayhem/States/<machine>/state` for state and the input's key for its channel. You can use custom `stateChannel` and per-input `channel` names. Supply actual inputs as well as the schema: a diagram cannot reconstruct unlogged decisions. Optional C++ observers publish state, transitions, guard results, and goal errors to NetworkTables or WPILOG. See `lib-cpp/README.md`.

Use the live view to inspect actual values. Use recording playback to review prior transitions and values at the same cursor. Local input controls are for exploring a manifest; they do not change the robot.

## Evidence and limits

The editor defaults to **Path only** playback: it follows the first outgoing edge in declared order, skips robot actions and sensor guards, and animates the reachable pose sequence. This is a geometric/control preview, not a successful autonomous execution claim. For branch or mechanism validation, select **Full routine with inputs**. Callback result selectors and typed sensor controls are visible beneath playback. A running callback blocks its action state; failure stops the routine; success is latched until the state exits. Concurrent callbacks can also fail the routine. Watchdogs still fail blocked states. Preview cycles stop at 600 seconds or 1000 execution events to bound trace memory.

The CLI/MCP defaults to full routine behavior. Supply an `actions` map keyed by callback ID with `running`, `succeeded`, or `failed` values. Missing callbacks remain running. `mode: "path"` requests pose-only playback explicitly. Trace exports record the selected mode and action assumptions.

The built-in preview uses an ideal kinematic plant. It does not run arbitrary C++ actions, model traction/contact, or prove a route is clear. Supply simulation sensor values deliberately. The field warnings are conservative straight-segment checks against enabled field obstacles, not an avoidance controller.

Log analysis runs in a worker and reports recorded symptoms and missing coverage. Current rules include sustained voltage sag/high current, an actual brownout flag, explicit loop timing, fault/reset/timeout flags, disconnections, and rapid state changes. Power integration uses the common recorded voltage/current interval. Keep raw logs; do not infer a mechanical root cause from one threshold.

Before describing an auto as robot-ready, build the target robot code, test cancellation and missing inputs, verify coordinate/heading conventions, and drive the real robot under supervision. Report separately what was simulated, compiled, and physically tested.

## Robot logging references

See [ROBOT_LOGGING.md](ROBOT_LOGGING.md) for the current 2026 example, units, log folders and mapping behavior. It is an optional compatibility reference. Keep future seasons free to change channel names, mechanisms and code architecture; describe changes with mappings/manifests rather than forcing robot code into the app.
