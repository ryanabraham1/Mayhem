# Mayhem suite user guide

The rebuilt app combines pose-based autonomous editing, state-machine inspection, and log analysis. It opens to **Overview**; the top bar switches between Autonomous, State machines, Logs, Robot and Agents. The gear opens Settings, including Light / Dark / Match system themes and the classic planner.

This guide describes the development suite in this checkout. See [suite status](SUITE_STATUS.md) for verification history and release gaps. The [classic planner guide](CLASSIC_PLANNER.md) covers existing solver projects.

## Start and manage projects

Run the browser suite from the repository root:

```sh
cd app
pnpm install
pnpm dev
```

Open `http://localhost:5173`. Pose editing, preview, state simulation and imported-log analysis do not require Python or a robot. See [building](BUILDING.md) for desktop setup.

Click the **project name** in the top bar to create, rename, duplicate, open, or switch saved projects. Each project contains its robot limits, routines, typed inputs and state-machine manifests. Local copies are saved on this computer; use **Autonomous → Export project** for a portable JSON backup.

Suite files use the `mayhem-suite` version 1 JSON format, conventionally `name.mayhem.json`. They are separate from classic `project.mayhem` / `.mtraj` files and the Java trajectory-library workflow. There is no automatic conversion between them.

In the desktop app, **Agents → Save project file** creates a live file link in your robot repository. External edits reload with revision checks; app edits save back. If a conflict banner appears, export your current work before reopening and reconciling the linked file. Browser downloads are snapshots, without live file linking. **Settings → Export recovery snapshot** retrieves a recovery copy when available.

## Author an autonomous routine

1. Open **Robot** and enter the robot dimensions, drive limits and controller gains. Define the typed inputs that your guards will use. Coordinates use the blue-alliance origin; project values use meters, radians and seconds, while heading controls display degrees.
2. Open **Autonomous**. Select or create a routine in the left rail. Drag its starting robot and heading handle, or edit the starting pose in the inspector.
3. Choose **Pose** (`W`), **Translation** (`T`) or **Handoff** (`G`), then click the field. Use **Select** (`V` or Escape) to select and drag goals. A pose constrains heading, a translation allows any heading, and a handoff advances through a goal without settling to a stop.
4. Select a step to edit its name, position, heading policy, arrival tolerances, settle time, handoff radius and limits. Shift-drag a heading knob to snap to 15°. Use the step inspector for callback IDs, concurrent actions, transition conditions, branches, timeouts and failure behavior. Callback IDs must be implemented by your robot code.
5. Reorder steps in the rail, then check project issues and preview the result. Undo/redo uses Command/Ctrl+Z and Shift+Command/Ctrl+Z; Delete removes the selected step.

Standard pose and translation chains use BLine Web's actual ideal kinematic preview engine. Match the starting pose, every translation/rotation target, handoff modes/radii, and velocity/acceleration limits when comparing with bline.run. The preview does not use PID gains, perform obstacle avoidance, or execute your robot's custom code. The exported robot follower uses measured-pose feedback and still requires tuning.

## Tune constraints

Open **Constraints** above the field. The **Map** shows each segment’s speed and
handoff radius side by side. **Generate** uses BLine’s constraint generator to
solve speed caps and corner radii together, running in a worker so editing stays
responsive. Hatched blocks are Auto; solid blocks are Manual. The final handoff
block says Stop because the endpoint finishes by tolerance.

Click a block to select that segment on the field. Switch to **Manual** to pin a
speed or radius; Generate preserves these pins. Switch back to **Auto** to let
the generator manage it. Clear generated constraints removes only automatic
outputs. When poses or limits change, the map says **Path changed** until you
generate again. A best-effort result says **Review limits**; an unsolvable run
asks you to adjust manual values rather than claiming success.

**Path limits** edits velocity, acceleration, turn speed/acceleration and default
handoff radius for this routine, inherited from Robot. **Range** applies just the
values you change to a From/Through step range. A segment’s limits apply while
driving toward its target. Per-segment manual limits override generated and path
limits. Generated speed caps cannot raise a newly lowered path speed limit.

Selecting a pose opens a compact **Pose** tab with X, Y, heading, Stop here and
handoff radius where applicable. **Constraints** holds its motion overrides.
**Advanced** holds heading policies, markers, arrival tolerances, callbacks,
watchdogs and transition conditions. Selecting another pose returns to Pose.

## Preview the path and routine

The bottom dock provides play/pause (Space), reset, a time scrubber, and **Inputs & events**:

| Mode | What it checks |
| --- | --- |
| **Path only** (default) | Drives the pose sequence on the first branch, skipping actions and sensor conditions. Use it to inspect the whole route. |
| **Full routine** | Checks arrival, simulated callback results, transition conditions and watchdogs. Set typed inputs and callback statuses in the expanded dock. |

Playback interpolates fixed 20 ms simulation samples at the display refresh rate; exported frames retain the fixed simulation steps. Mayhem-specific point-at/motion heading policies and explicit conditional open-ended handoffs use the measured-pose controller preview.

If Full routine waits at an action or condition, the status explains what is blocking it. **Freeze drivetrain** exercises watchdog failure. **Export trace JSON** records the preview mode, inputs, action statuses, events and frames. Preview is bounded to 600 seconds or 1,000 execution events; a successful preview still needs robot integration and tuning.

## Inspect state machines

Open **State machines** and select an autonomous routine or a robot state-machine manifest. Use the data-source selector to simulate, watch live values, or replay a recording. In simulation, changing typed inputs steps the machine through its transitions; inspect a node to see its guards and outgoing transitions. Global “from any state” transitions appear as chips to keep the graph readable.

Live inspection uses read-only NT4 subscriptions configured on **Robot**. Manifests must map to the signals your robot publishes. For recorded replay, import a log and select it in the state workspace. See [robot logging](ROBOT_LOGGING.md) for the signal contract.

## Import and analyze logs

In **Logs**, import a `.wpilog` recording, then select it in the library. Originals persist locally in IndexedDB. The report includes a verdict, findings linked to their times, coverage information, and four tabs:

| Tab | Use |
| --- | --- |
| **Health** | Review findings and the signals available to support them. |
| **Power** | Inspect voltage, brownouts, current, energy and ranked current draws; adjust signal mapping when needed. Estimates are labeled in the report. |
| **Signals** | Search channels and plot recorded values at the shared playback cursor. |
| **Field** | Replay recognized pose data at the same cursor. |

Export the original or the analysis report from the recording header. In the desktop app, the **AdvantageScope** button opens the selected original in an installed viewer; set its application path on **Robot** if automatic detection fails.

Imports support WPILOG 1.0 scalars, numeric/boolean arrays and selected common WPILib structs. Unknown types and missing diagnostic coverage are reported. Limits are 250 MB and two million decoded samples per file. Findings depend on available signals and should be checked against their evidence; real match diagnostic accuracy remains unvalidated.

## Connect and collect recordings

On **Robot**, enter your team number or an address override and click **Connect** for live NT4 observations. Live viewing does not command the robot. Direct connections are intended for desktop or localhost; hosted HTTPS pages can be restricted from connecting to a local robot.

Desktop **Automatic log collection** supports **Robot over Ethernet** (SFTP) or **Folder (simulation, USB)**. Configure the source, list files, and download selected recordings, or enable automatic collection. Polling runs every 15 seconds while Mayhem is open and waits for files to stop growing. Connection, collection and upload services continue when you switch pages. The app does not need to remain on Logs.

For **Team upload**, enter the team website and a device upload token obtained from its Logs → Connect Mayhem flow. Enable automatic upload to queue imported/collected logs; failed uploads retry with backoff. Choose **Remember the token on this computer** to resume after restarting, or **Pause uploads** to suspend the queue. See [team log setup](TEAM_LOGS.md) for deployment and token details. Physical roboRIO collection and Windows/Linux viewer behavior still need validation.

## Hand off to robot code or an agent

**Agents** contains a copyable project brief, CLI/MCP setup, the live file link, C++ export and the raw project document. Review the field and graph after agent edits, then validate and preview the routine before using it on hardware.

- [Suite agent guide](SUITE_AGENTS.md): revision-safe editing, CLI commands and MCP tools.
- [C++ integration](../lib-cpp/README.md): pose controller, executor, callbacks and optional WPILib adapters. Exporting a header does not deploy or register callbacks on the robot.
- [Team 3256 example](../examples/suite/team3256/README.md): robot simulation recordings and known findings.
- [Classic planner](CLASSIC_PLANNER.md): Python solver, `.mtraj` generation and the Java MayhemLib workflow.

The new controller still needs physical robot testing. Native collection, updater installation and cross-platform packages need their own checks; browser preview alone does not establish release readiness.
