# Building robot code with Mayhem

Mayhem is a visual workspace and a set of optional tools. Robot code is the source of truth. You may use arbitrary C++, WPILib commands, custom controllers, dynamic targeting, strategy code, and state machines. The editor does not define the limits of an autonomous routine. Publish a machine description and observations when that helps a human review your work; do not rewrite a good robot architecture just to fit the graph.

## Default autonomous approach

Use BLine-style live-pose goals as the normal movement tool. The current implementation is original point-to-point control with proportional correction, braking, acceleration limits, independent heading, and measured arrival. It is not a copy of BLine and is not a time-parameterized trajectory solver.

- Coordinates are blue-origin meters, radians, seconds, and field-relative velocities. Explicitly convert any vendor API that expects robot-relative speeds. Apply alliance transformations once, consistently, including point-at targets.
- Final goals require translation and heading tolerance, measured low speed, and a settling interval. Intermediate goals can use a moving handoff radius. Translation goals may leave heading unconstrained.
- Advance actions on observed conditions: possession, mechanism readiness, action completion, or pose arrival. Timeouts are watchdog failures, never evidence that a movement or mechanism succeeded.
- Use arbitrary action IDs and concurrent `during` actions for robot-owned work. Signal lookup is typed; missing or mismatched inputs fail closed, including under NOT. Transition order is priority order when several guards are true.
- Handle disabled mode, cancellation, actuator limits, lost sensors, and localization quality in robot code. A client disconnect does not stop robot code. Mayhem's live viewer only subscribes to NetworkTables and cannot issue robot commands.

## Shared project files

The public contract is `app/src/suite/core/model.ts`. The versioned JSON format is `mayhem-suite`, version 1. `extensions` is open and round-trips through the editor. Each routine can override the robot's default starting pose. Robot code owns the decision to reset odometry.

In the desktop app, open or save a linked project file. Local edits save with revision checks; agent edits appear within about 1.5 seconds. Use the same lock/revision protocol to prevent competing writes. A conflict preserves local work and requires rereading/reconciling the file. Browser mode imports/exports snapshots and keeps its working copy locally.

Requires Node 22.18+ (or a newer Node with TypeScript stripping and WebSocket support):

```sh
node scripts/mayhem.mjs example > robot.mayhem.json
node scripts/mayhem.mjs inspect robot.mayhem.json
node scripts/mayhem.mjs validate robot.mayhem.json
node scripts/mayhem.mjs simulate robot.mayhem.json '{"signals":{"pieceDetected":true,"shooterReady":true,"shotComplete":true}}'
node scripts/mayhem.mjs simulate robot.mayhem.json '{"freezeDrive":true}'
node scripts/mayhem.mjs cpp robot.mayhem.json > robot_autos.hpp
node scripts/mayhem.mjs analyze run.wpilog
node scripts/mayhem.mjs live roborio-3256-frc.local '{"topics":["/Robot/BatteryVoltage"],"durationMs":1000}'
```

`save <file> '<JSON>'` takes `{ "project": <full project>, "expectedRevision": <current revision or null for a new file> }`. Saves are atomic and increment the revision. Re-read after a revision conflict. Do not delete another writer's lock during an active save.

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

Tools: `inspect_project`, `validate_project`, `save_project`, `simulate_auto`, `export_cpp`, `analyze_log`, `inspect_live_robot`. They do not deploy robot code. Use your normal robot project build/deploy tools.

## State-machine visibility without architectural constraints

`examples/suite/intake.machine.json` demonstrates the `mayhem-machine` v1 format. It lists state IDs, typed inputs, transitions/conditions, optional code references, and optional existing channel names. Import it in State machines, store it under project `extensions.machines`, or publish its JSON at `/Mayhem/Schema/<machine>`.

The defaults are `/Mayhem/States/<machine>/state` for state and the input's key for its channel. You can use custom `stateChannel` and per-input `channel` names. Supply actual inputs as well as the schema: a diagram cannot reconstruct unlogged decisions. Optional C++ observers publish state, transitions, guard results, and goal errors to NetworkTables or WPILOG. See `lib-cpp/README.md`.

Use the live view to inspect actual values. Use recording playback to review prior transitions and values at the same cursor. Local input controls are for exploring a manifest; they do not change the robot.

## Evidence and limits

The built-in preview uses an ideal kinematic plant. It does not run arbitrary C++ actions, model traction/contact, or prove a route is clear. Supply simulation sensor values deliberately. The field warnings are conservative straight-segment checks against enabled field obstacles, not an avoidance controller.

Log analysis runs in a worker and reports recorded symptoms and missing coverage. Current rules include sustained voltage sag/high current, an actual brownout flag, explicit loop timing, fault/reset/timeout flags, disconnections, and rapid state changes. Power integration uses the common recorded voltage/current interval. Keep raw logs; do not infer a mechanical root cause from one threshold.

Before describing an auto as robot-ready, build the target robot code, test cancellation and missing inputs, verify coordinate/heading conventions, and drive the real robot under supervision. Report separately what was simulated, compiled, and physically tested.

## Robot logging references

See [ROBOT_LOGGING.md](ROBOT_LOGGING.md) for the current 2026 example, units, log folders and mapping behavior. It is an optional compatibility reference. Keep future seasons free to change channel names, mechanisms and code architecture; describe changes with mappings/manifests rather than forcing robot code into the app.
