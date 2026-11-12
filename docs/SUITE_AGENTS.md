# Building robot code with Mayhem

Mayhem is a visual workspace and a set of optional tools. Robot code is the source of truth. You may use arbitrary C++, WPILib commands, custom controllers, dynamic targeting, strategy code, and state machines. The editor does not define the limits of an autonomous routine. Publish a machine description and observations when that helps a human review your work; do not rewrite a good robot architecture just to fit the graph.

## Default autonomous approach

Movement: the path follower is ported from BLine-Lib (BSD 3-Clause; see THIRD_PARTY_NOTICES.md) and wrapped in Mayhem's routines, branching and state machines. Pose steps joined by a single "Always" transition form one BLine path. Each intermediate point hands off only once the robot enters its handoff circle (default 0.45 m; set `projectedHandoff: true` on a goal to also hand off by segment progress, which cuts corners). Speed is P on remaining path distance clamped to max velocity, aimed at the active point, with cross-track correction; speeds are capped and their change limited by the accelerations. Heading blends between rotation targets by monotonic path progress; `markers` place rotation targets and event triggers on segments by progress t. A step marked `stop`, or with a conditional exit, ends the path. Defaults match BLine: 4.5 m/s, 12 m/s², 720°/s, 1500°/s², gains 5 / 3 / 2, end tolerances 0.03 m and 2°. Wide swings at corners mean the robot's max acceleration is low for its max speed: lower the step's max speed or add points. Not a time-parameterized trajectory solver.

- **Heading through pickups.** The robot's front is +x (its intake on most robots). Heading blends by path progress from the last rotation target to the next Fixed anchor or rotation marker; Free anchors are not targets, so a route of Free points ending in one Fixed heading rotates the whole way and can hit pieces sideways. On a step where the front must lead, set `goal.headingMode: "motion"`: the robot faces its direction of travel on that segment, is already facing it when the segment starts (the previous segment blends toward it, finishing at the handoff circle), and later segments blend on from the heading actually commanded, with no snap. `goal.headingOffset` (radians) is added to Motion and PointAt headings (`Math.PI`: drive backward through it). To hold a heading until progress t on a segment and only then rotate, put a rotation marker at t with the heading to hold (`{ kind: "rotation", t: 0.7, heading: <held> }`); the segment then blends from the marker to the anchor's heading. `simulate` returns `headingWarnings` for any event marker that fires with the front more than 45° off the direction of travel; preview playback shows the robot's heading on the field.
- **Speed caps ahead.** By default (BLine) a step's `maxVelocity` applies only after its handoff, so the robot reaches a slow step fast and brakes there. `constraints.anticipateSpeedCaps: true` (robot, routine, or step) instead limits speed to `sqrt(cap² + 2·maxAcceleration·d)`, where d is the distance to that step's handoff point, so it arrives at the cap. The editor previews such paths with the native follower. Generated constraints still assume the BLine behavior and may be conservative when this is on.
- Coordinates are blue-origin meters, radians, seconds, and field-relative velocities. Explicitly convert any vendor API that expects robot-relative speeds. Apply alliance transformations once, consistently, including point-at targets.
- Final goals require translation and heading tolerance, measured low speed, and a settling interval. Intermediate goals can use a moving handoff radius. Translation goals may leave heading unconstrained.
- Advance actions on observed conditions: possession, mechanism readiness, action completion, or pose arrival. Timeouts are watchdog failures, never evidence that a movement or mechanism succeeded.
- Use arbitrary action IDs and concurrent `during` actions for robot-owned work. Signal lookup is typed; missing or mismatched inputs fail closed, including under NOT. Transition order is priority order when several guards are true.
- Handle disabled mode, cancellation, actuator limits, lost sensors, and localization quality in robot code. A client disconnect does not stop robot code. Mayhem's live viewer only subscribes to NetworkTables and cannot issue robot commands.

## Shared project files

The public contract is `app/src/suite/core/model.ts`. The versioned JSON format is `mayhem-suite`, version 1. `extensions` is open and round-trips through the editor. Each routine can override the robot's default starting pose. Robot code owns the decision to reset odometry.

In the desktop app, open or save a linked project file. Local edits save with revision checks; agent edits appear within about 1.5 seconds. Use the same lock/revision protocol to prevent competing writes. A conflict preserves local work and requires rereading/reconciling the file. Browser mode imports/exports snapshots and keeps its working copy locally. Click the project name in the top bar to create, rename, duplicate, or switch projects. Saved projects are local snapshots; selecting one preserves the outgoing working copy and detaches any file link. Use Open project file to reconnect to an agent-edited file. Each project has independent undo history and preview state; the recording library is shared across projects.

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
node scripts/mayhem.mjs analyze run.wpilog
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

Tools: `inspect_project`, `validate_project`, `save_project`, `simulate_auto`, `export_cpp`, `vendor_cpp`, `analyze_log`, `inspect_live_robot`, and the log-investigation tools below. They do not deploy robot code. Use your normal robot project build/deploy tools.

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

- every routine: `routine_<i>::routine`, `::name` (chooser label), `::startPose`, and the `routines` array of `mayhem::RoutineInfo{name, routine, startPose}` (`mayhem::FindRoutine(routines, nameOrId)`);
- `autonomous::manifest`: one `Autonomous` mayhem-machine manifest for the live viewer and log replay. States are the union of routine nodes; transition IDs are `"<routine id>/<transition id>"` (`mayhem::QualifiedTransitionId`), unique across routines. `AutoRunner::Attach` reports with exactly these IDs;
- every `extensions.machines` graph as a `mayhem::MachineView` (`machine_<i>::machine`, alias `<MachineId>::machine` when the ID is a C++ identifier, and the `machines` array), each with its manifest embedded (`manifest.Text()` for `Describe`);
- `fieldLength` / `fieldWidth` for alliance transforms.

In robot code (details and signatures in `lib-cpp/README.md`):

- Mechanism graphs: `mayhem::StateMachine(machine, signalCallback)`, `Tick(dt)` each loop, read `State()` / `StateIndex()`. Guards are typed and fail closed; declaration order is priority; `stateTime` is built in. Do not emulate a machine with an AutoRunner routine of fake custom nodes.
- Autos: `mayhem::AllianceRoutine(routines[i], fieldLength, fieldWidth)` then `Apply(FieldTransform::Flip)` for red (covers goal poses, PointAt aim points, rotation markers and the start pose). Do not flip nodes by hand.
- Driving to a live-pose goal: `mayhem::PoseDriver` (`pose_driver.hpp`, framework-free): `Start(now)` once, then `Update(now)` each loop returns `Running`/`Reached`/`Failed`; `Cancel()` stops it. It wraps `PoseController` with a watchdog and writes one zero velocity when it ends. Command-based robots can use `mayhem::DriveToPose` (`wpilib.hpp`, needs wpilibNewCommands), which is the same driver as a command. Log observation without the command framework: `mayhem::WpiLogObserver` from `wpilib_log.hpp` (needs only `wpi/DataLog.h`). A robot without wpilibNewCommands must not include `wpilib.hpp`; every other header compiles without frc2.
- Install the headers with the MayhemCpp vendordep (`https://ryanabraham1.github.io/Mayhem/MayhemCpp.json`) or `node scripts/mayhem.mjs vendor <robot dir>` (copies every header in `lib-cpp/include/mayhem` and writes a SHA-256 snapshot; `--check` for CI). Headers are only compiled when included, so vendoring `wpilib.hpp` into a command-free robot is harmless. Do not hand-copy headers or keep your own hash file.
- `AutoRunner` clamps a loop overrun (`dt > RunnerOptions::maxDt`, default 0.1 s) instead of failing the routine; watchdogs use real time. Read goal errors from `LastResult()` / `ActiveGoal()` instead of recomputing them, or `Attach(observer, autonomous::manifest, clock)` to emit Enter/Guard/Transition/GoalProgress.

## Digging into logs

`analyze_log` returns a compact summary (add `channels`, `from`/`to` for per-channel stats, or `detail: "full"` for everything). To investigate, use the exploration tools; all take a WPILOG path (parsed once and cached) and return small ranked results:

1. `log_anomalies` — scan every channel for outliers, big jumps, sampling dropouts, flatlined sensors, boolean flapping, and channels that stop or start logging. Each hit has a time.
2. `log_what_changed` — for a suspicious `time`, rank the channels that deviated most from their own normal within `window` seconds, with before/after values.
3. `log_table` — line up to 20 channels on one clock (`step` or `points`, max 500 rows) to compare them at the same instants; up to 8 channels also returns pairwise correlation.
4. `log_events` — merged chronological changes of state/boolean/string channels (state machines, modes, alerts).
5. `list_log_channels` — find channel names; `filter` takes case-insensitive substrings, which also match derived `/x`, `/heading`, `/0/speed` pose and module channels.

Typical loop: anomalies → what changed at that time → table of the suspects → events for the state that was active. Findings are symptoms to verify, not proven causes. Struct arrays (swerve module states/positions, Pose3d lists) are decoded into per-element channels, capped at 32 elements.

## State-machine visibility without architectural constraints

`examples/suite/intake.machine.json` demonstrates the `mayhem-machine` v1 format. It lists state IDs, typed inputs, transitions/conditions, optional code references, and optional existing channel names. Import it in State machines, store it under project `extensions.machines`, or publish its JSON at `/Mayhem/Schema/<machine>`.

Every transition (machine manifests and routines alike) can carry an optional `name` (short edge label, e.g. `"Hood clear"`) and `description` (why the edge exists). The graph shows `name` when present; otherwise a compact condition (`deploy ∧ ¬hoodClear`, `stateTime > 2.5`, `shotDemand ∨ ¬enabled`) that, when too long, keeps only the terms that tell the state's edges apart (`… shoot ∧ jitter`). Hover an edge or click its label for the full condition and description; the inspector lists a state's outgoing edges in priority order. Name your transitions: it is the cheapest way to make a large machine reviewable.

A machine transition can leave every state: `{"id": "toShoot", "from": "*", "to": "SHOOT", "except": ["HOME"], "condition": …}` is checked in every state except its target `SHOOT` and the optional `except` states, at its position in declaration order. A priority supervisor (each target reachable from every other state, the first true one winning) is one `"*"` transition per target in priority order, instead of one per source and target. Validation, the C++ exporter and `mayhem::StateMachine`, simulation and log replay all treat it this way, and observers report the real source state. Routines do not accept `"*"`. In the graph, a `"*"` transition, or a target that (almost) every state reaches on the same condition, shows as a "from any state" chip on its target and a row in a priority list above the graph. "Show all wires" draws the wires anyway, and the inspector still lists the selected state's exits in priority order. Both fields round-trip through the editor, `validate`, and the exported manifests.

Every input (machine `inputs[]` and project `signals[]`) can carry an optional `category`: `"operator"` (driver or controller request), `"sensor"` (measured: encoders, beam breaks, flywheel at speed, pose), `"internal"` (code-derived: latched intent, zone flags, demands from another machine; the default when missing), `"timer"` (`stateTime`, also the default for that key), or `"auto"` (requested by the autonomous routine). Graph conditions mark each input with its category as a colored letter badge (O operator, S sensor, I internal, T timer, A auto), with a legend; the inputs panel groups by category; and when the active state changes (simulate, live, or log replay) the view says why, e.g. `Ready → Jittering because O jitterDemand` (the inputs of the taken edge that changed; a `stateTime` deadline blames the timer). An internal flag can list its sources with `derivedFrom: ["shoot", "intake"]` (keys of other inputs of the same machine, or of `signals[]` for a project signal). A source in another machine of the same project is an object, `derivedFrom: [{ "machine": "Superstructure", "key": "jitter" }]`; a dotted string such as `"Superstructure.jitter"` is always a same-machine key, because keys may contain dots. The inputs panel shows such a source as `from Superstructure · jitter` with that input's category badge, its hover names the source input and the categories at the root of the chain (e.g. `driven by operator input`), and a multi-hop chain that ends in a different category says `driven by O operator`. Both fields are validated (`validate` checks that the machine and key exist; a single imported or live-published manifest checks only the shape, since it cannot see the other machines) and round-trip into exported manifests; the C++ runtime does not read them.

The defaults are `/Mayhem/States/<machine>/state` for state and the input's key for its channel. You can use custom `stateChannel` and per-input `channel` names. Supply actual inputs as well as the schema: a diagram cannot reconstruct unlogged decisions. Optional C++ observers publish state, transitions, guard results, and goal errors to NetworkTables or WPILOG. See `lib-cpp/README.md`.

Use the live view to inspect actual values. Use recording playback to review prior transitions and values at the same cursor. Local input controls are for exploring a manifest; they do not change the robot.

## Evidence and limits

The editor defaults to **Path only** playback: it follows the first outgoing edge in declared order, skips robot actions and sensor guards, and animates the reachable pose sequence. This is a geometric/control preview, not a successful autonomous execution claim. For branch or mechanism validation, select **Full routine with inputs**. Callback result selectors and typed sensor controls are visible beneath playback. A running callback blocks its action state; failure stops the routine; success is latched until the state exits. Concurrent callbacks can also fail the routine. Watchdogs still fail blocked states. Preview cycles stop at 600 seconds or 1000 execution events to bound trace memory.

The CLI/MCP defaults to full routine behavior. Supply an `actions` map keyed by callback ID with `running`, `succeeded`, or `failed` values. Missing callbacks remain running. `mode: "path"` requests pose-only playback explicitly. Trace exports record the selected mode and action assumptions.

The built-in preview uses an ideal kinematic plant. It does not run arbitrary C++ actions, model traction/contact, or prove a route is clear. Supply simulation sensor values deliberately. The field warnings are conservative straight-segment checks against enabled field obstacles, not an avoidance controller.

Log analysis runs in a worker and reports recorded symptoms and missing coverage. Current rules include sustained voltage sag/high current, an actual brownout flag, explicit loop timing, fault/reset/timeout flags, disconnections, and rapid state changes. Power integration uses the common recorded voltage/current interval. Keep raw logs; do not infer a mechanical root cause from one threshold.

Before describing an auto as robot-ready, build the target robot code, test cancellation and missing inputs, verify coordinate/heading conventions, and drive the real robot under supervision. Report separately what was simulated, compiled, and physically tested.

## Robot logging references

See [ROBOT_LOGGING.md](ROBOT_LOGGING.md) for the current 2026 example, units, log folders and mapping behavior. It is an optional compatibility reference. Keep future seasons free to change channel names, mechanisms and code architecture; describe changes with mappings/manifests rather than forcing robot code into the app.
