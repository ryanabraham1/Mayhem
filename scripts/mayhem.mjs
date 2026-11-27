#!/usr/bin/env node
// Node 24+ strips TypeScript: UI and agents share the exact authoring/preview core.
import "./suite-imports.mjs";
// The import hook relies on node:module stripTypeScriptTypes, which prints an
// ExperimentalWarning on first use. CI and Gradle treat stderr output as a problem,
// so drop exactly that warning; every other warning is still reported.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (type === "ExperimentalWarning" && /stripTypeScriptTypes|Type Stripping/.test(text)) return;
  return emitWarning.call(this, warning, ...rest);
};
import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  mkdir,
  stat,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseProject, validateProject } from "../app/src/suite/core/model.ts";
import { sampleProject } from "../app/src/suite/core/sample.ts";
const { exportCpp } = await import("../app/src/suite/core/export-cpp.ts");
const { simulate, unmodeledLimits } = await import("../app/src/suite/core/runtime.ts");
const { headingLints } = await import("../app/src/suite/core/headingLint.ts");
const { createGroup, addGroupUse } = await import("../app/src/suite/core/groups.ts");
import { analyze, parseRecordingJSON, currentBreakdown } from "../app/src/suite/core/analysis.ts";
import { listChannels, logTable, findAnomalies, whatChanged, logEvents, machineStates } from "../app/src/suite/core/logquery.ts";
const { diagnoseLog, compareLogs } = await import("../app/src/suite/core/logdiagnose.ts");
import { NT4Observer } from "../app/src/suite/core/nt4.ts";
import { parseWPILog } from "../app/src/suite/core/wpilog.ts";
import { vendorCpp } from "./cpp-vendor.mjs";
const { applyMachineSpecs, machineFromSpec, specFromMachine, routineFromMtraj } = await import("../app/src/suite/core/authoring.ts");
import { execFile } from "node:child_process";
const { buildReport, WORKTREE, GENERATED_FILE, scenarioChanges, SCENARIOS_FILE, MACHINES_FILE } = await import("../app/src/suite/core/review/report.ts");
const { syncHeader, VENDOR_SNAPSHOT_FILE } = await import("../app/src/suite/core/generated-header.ts");
const { compareWithCommit } = await import("./exporter-compat.mjs");
const { gitSnapshot, mainRef, recordProof, reviewBranches } = await import("./review-git.mjs");
const { nodeRunner } = await import("./review-sim.mjs");
const { scenarioSet, describeTrack } = await import("../app/src/suite/core/review/scenarios.ts");
const { runSimProof, summarizeProof, scenarioTests } = await import("../app/src/suite/core/review/simproof.ts");
const { scenarioCoverage } = await import("../app/src/suite/core/review/coverage.ts");
const { checkMachines } = await import("../app/src/suite/core/review/modelcheck.ts");
const { parseMachineSpecs } = await import("../app/src/suite/core/review/machines.ts");
const { readProject } = await import("../app/src/suite/core/review/autos.ts");
const { proofText } = await import("../app/src/suite/core/review/proofs.ts");
const { motionOfFrames, motionOfLog, logToSamples, logPose, goalRunners, goalInfos, analyzeMotion } = await import("../app/src/suite/core/autoMotion.ts");
const { plotAuto } = await import("../app/src/suite/core/autoPlot.ts");
const { editAuto } = await import("../app/src/suite/core/autoEdit.ts");
const { optimizeAuto, OPTIMIZE_PHASES } = await import("../app/src/suite/core/autoOptimize.ts");
const { valueAt } = await import("../app/src/suite/core/analysis.ts");
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
const tools = [
  {
    name: "apply_machine_spec",
    description:
      "Create or replace state machines in a project from compact specs (docs/SUITE_AGENTS.md, Authoring machines and routines): inputs grouped by category, states, and transitions with readable conditions such as \"FROM -> TO: enabled && deploy && !hoodClear  # name\". A misspelled input or state is an error. Each machine replaces the one with the same id in extensions.machines, in place, or is appended. Saves atomically with a revision bump (expectedRevision optional); dryRun returns the manifests without writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        spec: { description: "One machine spec, a list of them, or { machines: [...] }." },
        expectedRevision: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "spec"],
    },
  },
  {
    name: "machine_spec",
    description: "Return the compact spec of a machine in a project (conditions as text), to edit and pass back to apply_machine_spec.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, machine: { type: "string" } }, required: ["path", "machine"] },
  },
  {
    name: "create_step_group",
    description:
      "Turn steps of a routine into a reusable step group (a template with parameters), kept as the group's first use; or add another use of an existing group. Create: { routine, group: { id, name?, steps: [step IDs], params: { <name>: \"<step id>.<field path>\" | \"exit:<transition id>.to\" } } }: each param path (e.g. \"pickup.goal\", \"arm.action\", \"exit:scored.to\") becomes \"$name\" in the template and an argument of the use. Add a use: { routine, use: { group, like?: <use id to copy arguments from>, args?: { ... } } }. The file then holds project.groups, routine.uses and the produced steps `<use id>.<step id>` (marked fromGroup); edit the group or a use's args, never the produced steps (they are regenerated on load). Saves atomically with a revision bump; dryRun returns the result without writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        routine: { type: "string" },
        group: { type: "object" },
        use: { type: "object" },
        expectedRevision: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "routine"],
    },
  },
  {
    name: "import_mtraj_route",
    description:
      "Build (or rebuild) autonomous routines from solved classic-planner .mtraj passes: each pass becomes key-waypoint pose steps (its waypoints plus the fewest points that stay within pathTolerance m and headingTolerance deg of the solve) with the solved heading and a speed cap from the solved speed, mapped event markers, and optional steps after each pass (e.g. an aim-and-shoot custom step with onTimeout \"succeed\"). .mtraj paths are relative to the project file. Saves atomically with a revision bump; dryRun returns the routines without writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        spec: { description: "One route spec, a list, or { routines: [...], events, endEvents, options } with shared defaults." },
        expectedRevision: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "spec"],
    },
  },
  {
    name: "inspect_live_robot",
    description:
      "Read current NT4 states, schema manifests, and explicitly requested signal topics. This client cannot publish or command the robot.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        topics: { type: "array", items: { type: "string" } },
        durationMs: { type: "integer", minimum: 100, maximum: 5000 },
      },
      required: ["host"],
    },
  },
  {
    name: "export_cpp",
    description:
      "Generate the standalone C++17 header for a robot: every routine (RoutineView, name, start pose, `routines` array), one Autonomous manifest, every extensions.machines graph as a mayhem::StateMachine MachineView with its manifest, and the field size. Deterministic. Custom robot code remains unrestricted. Returns code; does not deploy. From a shell, `cpp <project> --out <header>` writes it and `--check <header>` fails if stale.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vendor_cpp",
    description:
      "Copy Mayhem's header-only C++ library (lib-cpp/include/mayhem) into a robot project (default <robotDir>/src/main/include/mayhem) and write a snapshot with the version, source commit and SHA-256 of every header. check=true only compares and reports problems. Prefer the MayhemCpp vendordep when the robot can use it.",
    inputSchema: {
      type: "object",
      properties: {
        robotDir: { type: "string" },
        dest: { type: "string", description: "Header directory relative to robotDir." },
        snapshot: { type: "string", description: "Snapshot path relative to robotDir (default <dest>/mayhem-vendor.json)." },
        check: { type: "boolean" },
      },
      required: ["robotDir"],
    },
  },
  {
    name: "open_in_app",
    description:
      "Show a project file to the user in the Mayhem desktop app (macOS): validates it, then opens it in the running app (or launches it), which switches to that project and links and watches the file, exactly like Agents → Open project file. Later edits to the file appear live. Use after writing a project the user should look at.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        app: { type: "string", description: "Application name or path (default Mayhem, or MAYHEM_APP)." },
      },
      required: ["path"],
    },
  },
  {
    name: "inspect_project",
    description:
      "Read the full Mayhem project. Extensions and custom action IDs are open; the editor is not a limit on robot code.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "validate_project",
    description: "Validate a Mayhem project and return actionable issues.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "object" } },
      required: ["project"],
    },
  },
  {
    name: "save_project",
    description:
      "Atomically replace a valid project with optimistic revision checking. expectedRevision=null creates a new file. In a robot repo with a generated src/main/include/commands/MayhemProject.h next to the project, also regenerates that header from the saved file (exactly what `cpp --out` writes), unless the robot's pinned Mayhem (docs/mayhem/vendor-snapshot.json) has a different exporter; `header` in the result says what happened and why.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        project: { type: "object" },
        expectedRevision: { type: ["integer", "null"] },
      },
      required: ["path", "project", "expectedRevision"],
    },
  },
  {
    name: "simulate_auto",
    description:
      "Run a deterministic pose/condition preview. This ideal plant cannot validate real mechanism code. Sensors change only through supplied signal values. Frozen drive must fail its watchdog. notModeled lists the steps visited on which robot code limits the speed (a step's robotSpeedLimit note: a keep-out, an anti-tip limit, a live stop deceleration); the preview drives them at the project's limits, so `time` is a lower bound there. headingWarnings lists event markers (pickups) that fire with the robot's front (+x) more than 45° off its direction of travel; fix them with goal.headingMode \"motion\" (optionally goal.headingOffset) on that step. `motion` drives the routine again with the robot runner's own controller (follow(): P law, acceleration-limited; the editor preview brakes on an ideal profile, so it can hide overshoot and be optimistic about time) and has its time, each stop step's timing, peak speed and closest approach, and `motion.issues` the steps that overshoot their goal and crawl back, swing past their heading, or creep in, each with a `fix` and `suggest` (edit_auto `set` ops). Drivetrain lag and traction are not modeled: confirm in the robot's physics sim (run_scenarios, then plot_auto with its log).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        routine: { type: "string" },
        signals: { type: "object" },
        freezeDrive: { type: "boolean" },
        maxSeconds: { type: "number" },
        mode: { type: "string", enum: ["path", "routine"] },
        follower: { type: "string", enum: ["preview", "native"], description: "preview (default): the editor's path preview; native: the robot runner's controller for every step. `motion` always uses native." },
        actions: { type: "object", additionalProperties: { type: "string", enum: ["running", "succeeded", "failed"] } },
      },
      required: ["path"],
    },
  },
  {
    name: "plot_auto",
    description:
      "Draw an auto as a PNG and return its path: read the image to see it. The field with the planned path (the robot runner's controller on an ideal drive, purple; the editor preview faint) and, with `log` (a run_scenarios auto log or a match log), the path the robot really drove (orange); every stop goal with its tolerance ring, numbered; motion problems (overshoot then crawl back, heading swing, creeping in) circled in red with a zoomed inset of each overshoot (10 cm grid); speed and distance-to-goal over time for both, with step boundaries. `issues` lists the same problems as text with a `fix` and `suggest` (edit_auto `set` ops). The routine is found from the log's goal IDs when `routine` is omitted. Use it after every auto change, and whenever a log shows auto findings.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        routine: { type: "string" },
        log: { type: "string", description: "Optional WPILOG of a run of this routine (sim or match)." },
        pose: { type: "string", description: "Robot pose channel prefix in the log (…/Pose with /x, /y, /heading); found automatically when omitted." },
        out: { type: "string", description: "PNG path (default: a file in the system temp folder)." },
        mode: { type: "string", enum: ["path", "routine"], description: "Preview mode (default path; routine with signals/actions)." },
        signals: { type: "object" },
        actions: { type: "object" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_auto",
    description:
      "Change an auto with a few targeted ops instead of rewriting the project, then see what it did: the result has `changes`, and per routine `before` and `after` (status, time, motion issues, driven with the robot runner's controller in path mode) with `fixed` and `new` problems. Ops, applied in order: {\"set\": \"<step>.<field…>\", \"value\": v} (e.g. \"score.constraints.stopDeceleration\", \"score.goal.x\", \"score.goal.markers\"; also \"routine.<field…>\", \"robot.constraints.<field>\", \"use:<use id>.args.<param>\", \"group:<group id>.<field…>\"; null deletes); {\"move\": \"<step>\", \"x\", \"y\", \"heading\"}; {\"insert\": {\"id\", \"x\", \"y\", \"heading\", \"stop\"?, \"markers\"?, \"constraints\"?, …}, \"after\": \"<step>\" (into its exit; name it with \"exit\" when there are several) | \"before\": \"<step>\"}; {\"remove\": \"<step>\"} (its callers go where it went); {\"create\": {\"id\", \"name\", \"start\": {x, y, heading}, \"steps\": [pose shorthand or full steps], \"finish\"?: true}} (a chain: pose steps pass through, the last pose before a non-pose step stops). Pose shorthand fills BLine tolerances (end 0.03 m / 2°, pass-through 0.1 m / 5°). The result is validated, saved atomically with a revision bump (and the generated header refreshed, as save_project), unless dryRun. `plot: true` also draws the edited routine (plot_auto). The preview is the ideal plant: confirm motion fixes in the physics sim (run_scenarios, then plot_auto or log_compare on the log).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        routine: { type: "string", description: "Routine for step ops (default the first; a create switches to the new one)." },
        ops: { type: "array", items: { type: "object" } },
        dryRun: { type: "boolean" },
        expectedRevision: { type: "integer" },
        plot: { type: "boolean" },
      },
      required: ["path", "ops"],
    },
  },
  {
    name: "optimize_auto",
    description:
      "Make an auto faster without leaving the BLine model: it searches the knobs a person would turn (remove pass-through points that do nothing, move them to cut corners, retune their handoff radii, reroute a chain of pass-through points as the shortest way around the field's obstacles, and the braking fixes motion findings suggest) and scores every candidate by driving it with the robot runner's own follower (native, path mode). Stop steps, action points, steps with event markers or `during` actions on their segments, step-group steps, conditional pass-throughs and `lock`ed steps never move. A change is kept only if the routine still finishes, the robot's footprint (at its heading, plus `clearance`) is no deeper into obstacles or walls, motion and heading warnings do not grow, and every event still fires. Returns `before`/`after` (time, distance, pass-through count, warnings, clearance with what was hit), `timeSaved`, `ops` (edit_auto ops that reproduce it), `changes` (each with why and its time change), `suggestions` (faster changes it will not make itself because they change what the auto does: drive through a stop, remove a speed cap) and `fixed` (steps it left alone and why). Writes nothing unless `apply: true` (saved like edit_auto, with a revision bump and the generated header). `plot: true` draws the optimized routine with the old route faint. Use it after building or changing an auto, then read the plot and run run_scenarios: the follower runs on an ideal drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        routine: { type: "string", description: "Routine to optimize (default the first)." },
        lock: { type: "array", items: { type: "string" }, description: "Step IDs never moved, removed or retuned (e.g. a point that keeps the robot in a lane for a reason Mayhem cannot see)." },
        maxMove: { type: "number", description: "Farthest a pass-through point may move from where it was, meters (default 1)." },
        clearance: { type: "number", description: "Margin around the robot footprint for obstacle and wall checks, meters (default 0.05)." },
        phases: { type: "array", items: { type: "string", enum: [...OPTIMIZE_PHASES] }, description: "Searches to run (default all): motion (braking fixes), route (around obstacles), prune, move, handoff." },
        budget: { type: "integer", description: "Most follower runs (default 2500, about 5 ms each)." },
        signals: { type: "object" },
        apply: { type: "boolean", description: "Save the result (default false: only report)." },
        expectedRevision: { type: "integer" },
        plot: { type: "boolean" },
        out: { type: "string", description: "PNG path for plot." },
      },
      required: ["path"],
    },
  },
  {
    name: "behavior_diff",
    description:
      "Compare the behavior of two revisions of a robot repo the way the team reviews it (docs/SUITE_AGENTS.md, Behavior review): hardware (CAN IDs, motor direction, brake/coast, current limits, gear ratios), constants with units, state machines (tools/mayhem/machines.json) including driver-control changes, and autonomous paths (the root *.mayhem.json) driven in the path preview. Returns a risk level: red = safety-related hardware/settings change; yellow = controls, machines or other values changed, other robot code changed that the review can't read (it lists the files; people judge those by the sim proof), or a team sim proof scenario was removed or loosened; green = only auto paths changed and every changed path completes. Run it on your own change before asking a human to review: `base: \"main\"` compares with the commit your branch left main at, which is what the person sees in the app. `before` defaults to HEAD, `after` to the working tree (\"WORKTREE\").",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        before: { type: "string", description: "Git revision (default HEAD)." },
        after: { type: "string", description: "Git revision, or WORKTREE for uncommitted files (default)." },
        base: { type: "string", description: "Instead of `before`: a branch (usually \"main\"). Compares `after` with the commit where it left that branch, i.e. what this branch changes." },
        detail: { type: "string", enum: ["summary", "full"], description: "summary (default): level, findings, errors. full: the whole report (devices, settings, machines, paths)." },
      },
      required: ["repo"],
    },
  },
  {
    name: "run_scenarios",
    description:
      "Sim proof (docs/SUITE_AGENTS.md, Sim proof): build a revision of the robot repo with Mayhem's probe test and run scenarios through the robot's own simulation: every controller button tapped and held from teleop, every auto in the root *.mayhem.json, and the team's tools/mayhem/scenarios.json (plain steps such as \"hold A 2\" and expectations such as \"Shooter mode is SHOOTING by 1.5 s\"). With `before`, each scenario also runs on that revision and differences in what the robot does (machine states, drive mode, auto result) are reported; the team rule is that the same driver inputs give the same outcomes. Takes about a minute per revision the first time (cached per commit). Needs the robot's Gradle/WPILib toolchain on this computer. Red → green: with `before`/`base`, every scenario this change adds or changes in scenarios.json, and every inline one, gets a `tests` verdict from its run on both versions: `red-green` (fails before, passes now: it reproduces what the change fixes), `passes-on-base` (guards old behavior, shows no fix), `still-failing`, `breaks`; `testsNext` says what to do. For a bug fix, write the scenario first and see it fail (inline `scenarios`, before: \"HEAD\"), then fix until it is red-green, then commit it in tools/mayhem/scenarios.json; the commit's proof records which new scenarios reproduced the bug. On a full run, `coverage` lists machine states no scenario checks: `unchecked` gaps carry a `draft` scenario built from the run that reached the state (confirm with the person that the behavior is intended before adding it), `unreached` gaps the transitions and inputs that lead there. When `after` is a commit, this tool records the result on that commit (a git note); the person reviewing the change in the Mayhem app sees that record, so run it on your committed work with `base: \"main\"` and every scenario (no names or groups) before saying a change is ready, and do not describe a proof in words instead.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        after: { type: "string", description: "Revision to test (default WORKTREE, the uncommitted files). A proof is recorded only for a commit, e.g. HEAD." },
        before: { type: "string", description: "Optional revision to compare against, e.g. HEAD or main." },
        base: { type: "string", description: "Instead of `before`: a branch (usually \"main\"). Compares `after` with the commit where it left that branch, which is the comparison the app shows for a branch." },
        by: { type: "string", description: "Your name, recorded with the proof (e.g. \"claude\")." },
        groups: { type: "array", items: { type: "string", enum: ["button", "auto", "custom"] }, description: "Which scenarios (default all)." },
        featureMap: { type: "boolean", description: "On a full run, also return `coverage.map`: every machine state with how a driver reaches it (the first run that got there: its steps and when) and the scenarios that prove it." },
        names: { type: "array", items: { type: "string" }, description: "Only scenarios whose name contains one of these (case-insensitive), e.g. [\"Hold A\", \"Outpost\"]." },
        scenarios: {
          type: "array",
          description: "Extra scenarios to run now without editing scenarios.json (same format: { name, steps, expect }). With `scenarios` and no groups/names, only these run.",
          items: { type: "object", properties: { name: { type: "string" }, steps: { type: "array", items: { type: "string" } }, expect: { type: "array", items: { type: "string" } }, alliance: { type: "string" }, field: { type: "boolean" } }, required: ["name", "steps"] },
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "check_machines",
    description:
      "Model-check the robot's state machines (tools/mayhem/machines.json) the way TLA+ would: every state under every combination of the inputs its exits read (booleans both ways, numbers either side of each threshold), one robot loop each. Reports `unreachable` states, `no-exit` traps, transitions that `never-fires` (an earlier one in priority order is true whenever it is), `loops` (inputs under which one loop never settles: the state flickers, with those inputs) and `unknown-input` keys. Exact for the machine as written; it can't see the code that computes the inputs. With `base`, only the problems the change adds (`new`), removes (`fixed`) and keeps (`existing`). behavior_diff and verify_change include the new ones.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        rev: { type: "string", description: "Revision (default WORKTREE)." },
        base: { type: "string", description: "Compare with where `rev` left this branch (e.g. \"main\")." },
      },
      required: ["repo"],
    },
  },
  {
    name: "verify_change",
    description:
      "The gate before review: runs behavior_diff, the model check and the full sim proof (every button, auto and team scenario, recorded on the commit) against `base`, and judges the result by fixed rules. Not ready when: a scenario fails; a scenario this change adds is `breaks` or `still-failing`; the model check finds a new problem; a scenario was removed or loosened; or robot code or a state machine changed and no new scenario fails without the change (red → green; tuned values and auto paths don't need one). Pass `refactor: true` for a change that should not change behavior: then any scenario that behaves differently fails it. Returns `ready`, `reasons` (fix them in order), `warnings` (differences a person will see, coverage gaps on the machines you touched, safety changes) and `next`. Run it on your committed branch before saying a change is ready; never weaken scenarios to pass it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        after: { type: "string", description: "Commit to verify (default HEAD)." },
        base: { type: "string", description: "Branch it is compared with (default main)." },
        by: { type: "string", description: "Your name, recorded with the proof." },
        refactor: { type: "boolean", description: "Nothing should behave differently." },
      },
      required: ["repo"],
    },
  },
  {
    name: "list_changes",
    description:
      "The robot repo's branches as the Mayhem app lists them for review (Changes page): each with the commit it left main at (`base`), how many commits it adds, and whether main already has it (merged, rebased or squashed). Use `base`..`sha` of your branch with behavior_diff and run_scenarios to see what the person reviewing it will see.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "Robot repository directory." } }, required: ["repo"] },
  },
  {
    name: "analyze_log",
    description:
      "Read a local WPILOG 1.0 or recording JSON and return measured power findings and logging coverage. Returns a compact summary by default (findings, power, top current draws, channel overview). Use `channels` (substring filters) to get per-channel stats and downsampled samples, `from`/`to` to restrict to a time window, and `detail: \"full\"` for the raw legacy dump. Optionally map voltage/current/brownout names.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mapping: { type: "object" },
        policy: { type: "object" },
        detail: { type: "string", enum: ["summary", "full"], description: "summary (default) omits sample arrays; full returns everything." },
        channels: { type: "array", items: { type: "string" }, description: "Case-insensitive substrings; matching channels return stats (min/max/mean/first/last) and downsampled samples. Include \"Estimated total supply current\" to query the estimate." },
        from: { type: "number", description: "Window start, seconds from log start." },
        to: { type: "number", description: "Window end, seconds from log start." },
        maxSamples: { type: "integer", minimum: 0, maximum: 500, description: "Max samples per queried channel (default 40, 0 = stats only)." },
        maxChannels: { type: "integer", minimum: 1, maximum: 200, description: "Max matched channels returned (default 30)." },
      },
      required: ["path"],
    },
  },
  {
    name: "log_diagnose",
    description:
      "Start here with a log: one call returns its failures, grouped and ranked (errors first), each with a stable `id`, evidence, the match phase, and `next` (a ready-to-run log_table/log_events/log_states/log_what_changed call that shows it). Checks: setpoints the mechanism never reaches, cannot reach, oscillates around, is slow to reach or settles off (setpoint/measured pairs found by name, e.g. reqVelocity -> motor velocity, ModuleTargets -> ModuleStates); flickering flags with the signal and threshold they follow; states and Mayhem machines switching back and forth; loop overruns; alerts and console errors; motors pinned at a current limit; pose jumps; power; auto steps that overshoot their goal and crawl back, swing past their heading, or creep in (from Mayhem/Goals/<routine>/*; pass `project` for step names, tolerances and a fix sized to the step's limits, and a plot_auto `next`). `context` has the phases (disabled/auto/teleop), selected auto, state sequences, which pairs were tracked and setpoints it could not pair. `ignore` drops findings whose id contains a string, or a whole kind.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, project: { type: "string", description: "Optional *.mayhem.json the auto came from." }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log." }, from: { type: "number" }, to: { type: "number" }, ignore: { type: "array", items: { type: "string" } }, limit: { type: "integer", description: "Max findings (default 30)." } }, required: ["path"] },
  },
  {
    name: "log_compare",
    description:
      "Did the fix work? Diagnose two logs of the same scenario (`before`, `after`) and line their findings up by id: `fixed`, `new` (with detail and next), and `persisting` (better/worse/same by occurrences and metric), plus metrics that moved (tracking error, loop p99, min voltage) and state sequences that differ. `verdict`: improved, regressed (a new error or a worse one), mixed or unchanged.",
    inputSchema: { type: "object", properties: { before: { type: "string" }, after: { type: "string" }, project: { type: "string", description: "Optional *.mayhem.json, as for log_diagnose." }, mapping: { type: "object" }, from: { type: "number" }, to: { type: "number" }, ignore: { type: "array", items: { type: "string" } } }, required: ["before", "after"] },
  },
  {
    name: "list_log_channels",
    description:
      "Search a WPILOG/recording's channels. Returns name, type, sample count, time span, rate, and min/max/mean for numeric channels. Find what to look at. `filter` = case-insensitive substrings. Arrays with more than 16 elements are one row (`<parent>/*`) unless `expandArrays`.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, filter: { type: "array", items: { type: "string" } }, type: { type: "string" }, limit: { type: "integer", maximum: 300 }, offset: { type: "integer" }, expandArrays: { type: "boolean" } }, required: ["path"] },
  },
  {
    name: "log_table",
    description:
      "Line several channels up on one shared clock (last value held) between `from` and `to`, at `step` seconds or `points` rows (max 500). Use it to compare up to 20 signals at the same moments; for up to 8 channels it also returns pairwise correlation. Names are exact or substring matches.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, step: { type: "number" }, points: { type: "integer" } }, required: ["path", "channels"] },
  },
  {
    name: "log_anomalies",
    description:
      "Scan channels (all by default) for abnormal behavior: outliers, sudden jumps, sampling dropouts, flatlined sensors, boolean flapping, channels that stop/start logging. Returns ranked events with times to investigate with log_table / log_what_changed. `sensitivity` 0.25-4 (higher finds more).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer" }, sensitivity: { type: "number" } }, required: ["path"] },
  },
  {
    name: "log_what_changed",
    description:
      "Given a moment `time` (seconds), rank the channels that deviated most from their own normal within +/- `window` seconds (default 1), with before/after values. Use after finding a suspicious time to see what else was happening.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, time: { type: "number" }, window: { type: "number" }, filter: { type: "array", items: { type: "string" } }, limit: { type: "integer" } }, required: ["path", "time"] },
  },
  {
    name: "log_states",
    description:
      "Why each state machine did what it did: from Mayhem's logged Mayhem/States/<id>/state, /transition and /inputs/*, every state change with the transition that fired and the input values at that moment. Back-and-forth bursts (a machine fighting itself) collapse into one entry naming both transitions and the inputs that kept both true. Start here for state-machine bugs, e.g. on a run_scenarios log.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, machines: { type: "array", items: { type: "string" }, description: "Machine id substrings (default all)." }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer", description: "Entries per machine (default 40, max 200)." } }, required: ["path"] },
  },
  {
    name: "log_events",
    description:
      "Chronological list of value changes for boolean/string/state channels (all meaningful non-numeric channels by default: dashboard plumbing, guard flags and NetworkTables copies of logged channels are skipped unless `all`; or the named `channels`), merged across channels. Shows state-machine transitions, mode changes and alerts in order.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer" }, all: { type: "boolean" } }, required: ["path"] },
  },
];
function pathFor(path) {
  if (typeof path !== "string" || !path.trim())
    throw new Error("A file path is required.");
  return resolve(path);
}
function channelStats(channel, from, to, maxSamples) {
  const inWindow = channel.samples.filter((s) => s.time >= from && s.time <= to);
  const nums = inWindow.filter((s) => typeof s.value === "number" && Number.isFinite(s.value));
  const round = (n) => Math.round(n * 1e4) / 1e4;
  const out = { name: channel.name, type: channel.type, samples: inWindow.length };
  if (nums.length) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (const s of nums) {
      min = Math.min(min, s.value);
      max = Math.max(max, s.value);
      sum += s.value;
    }
    Object.assign(out, { min: round(min), max: round(max), mean: round(sum / nums.length), first: round(nums[0].value), last: round(nums[nums.length - 1].value) });
  } else if (inWindow.length) {
    out.first = inWindow[0].value;
    out.last = inWindow[inWindow.length - 1].value;
  }
  if (maxSamples > 0 && inWindow.length) {
    const step = Math.max(1, Math.ceil(inWindow.length / maxSamples));
    out.series = inWindow
      .filter((_, i) => i % step === 0)
      .map((s) => [round(s.time), typeof s.value === "number" ? round(s.value) : s.value]);
  }
  return out;
}
const logCache = new Map();
/** Agents read whole logs: Node has room for far more samples than the app window (about 80 bytes each). */
const AGENT_LOG_SAMPLES = 10_000_000;
/** Parsed logs kept for reuse, by total samples, so comparing two big runs stays well under Node's heap. */
const LOG_CACHE_SAMPLES = 20_000_000;
const samplesIn = (recording) => recording.channels.reduce((n, c) => n + c.samples.length, 0);
async function loadLog(path, mapping) {
  const { mtimeMs } = await stat(path);
  const key = `${path}|${mtimeMs}|${JSON.stringify(mapping ?? null)}`;
  let hit = logCache.get(key);
  if (!hit) {
    const bytes = await readFile(path);
    const recording = path.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), path, { maxSamples: AGENT_LOG_SAMPLES })
      : parseRecordingJSON(bytes.toString("utf8"));
    const { estimatedCurrent } = analyze(recording, mapping);
    hit = estimatedCurrent
      ? { ...recording, channels: [...recording.channels, estimatedCurrent] }
      : recording;
    // Keep a few, so comparing two runs does not reparse either.
    for (const k of logCache.keys()) if (k.startsWith(`${path}|`)) logCache.delete(k);
    let cached = [...logCache.values()].reduce((n, r) => n + samplesIn(r), samplesIn(hit));
    for (const [k, r] of logCache) {
      if (logCache.size < 4 && cached <= LOG_CACHE_SAMPLES) break;
      logCache.delete(k);
      cached -= samplesIn(r);
    }
    logCache.set(key, hit);
  }
  return hit;
}
/** Open a validated project file in the desktop app; it links and watches the file. */
export async function openInApp(path, app = process.env.MAYHEM_APP || "Mayhem") {
  if (typeof path !== "string" || !path) throw new Error("A project file path is required.");
  const file = resolve(path);
  const problems = validateProject(JSON.parse(await readFile(file, "utf8"))).filter((i) => i.severity === "error");
  if (problems.length) throw new Error(`Not opened; the project is invalid: ${problems.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  if (process.platform !== "darwin")
    throw new Error("Opening in the desktop app from the command line is macOS-only for now. Open it in Mayhem with Agents → Open project file.");
  // macOS delivers the file to the running app (or launches it); the app switches to the
  // project and links the file. `open` returns once Launch Services has handed it over.
  await new Promise((done, fail) =>
    execFile("open", ["-a", app, file], (error, _out, stderr) => (error ? fail(new Error(stderr.trim() || error.message)) : done())),
  );
  return { opened: file, app, note: "The app switches to this project and watches the file; edits on disk appear within about a second." };
}
const asList = (spec, key) => {
  if (Array.isArray(spec)) return spec;
  if (spec && typeof spec === "object" && Array.isArray(spec[key])) return spec[key];
  if (spec && typeof spec === "object") return [spec];
  throw new Error("Expected a spec object or a list of specs.");
};
/** Route specs with shared `events`, `endEvents`, `options`, `constraints` defaults applied. */
const routeSpecs = (spec) => {
  const shared = spec && !Array.isArray(spec) && Array.isArray(spec.routines) ? spec : {};
  return asList(spec, "routines").map((r) => ({
    ...r,
    events: { ...(shared.events ?? {}), ...(r.events ?? {}) },
    endEvents: r.endEvents ?? shared.endEvents,
    options: { ...(shared.options ?? {}), ...(r.options ?? {}) },
    ...(shared.constraints || r.constraints ? { constraints: { ...(shared.constraints ?? {}), ...(r.constraints ?? {}) } } : {}),
  }));
};
/**
 * After a project file is saved: regenerate the robot repo's MayhemProject.h next to it (if it has
 * one) from the saved text, exactly as `cpp <project> --out <header>` would, when the robot's
 * pinned exporter writes the same code as this one. Returns what happened, or undefined when the
 * folder has no generated header.
 */
async function regenerateHeader(path, projectText) {
  const dir = dirname(resolve(path));
  const header = join(dir, GENERATED_FILE);
  const current = await readFile(header, "utf8").catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (current === null) return undefined;
  let pinned;
  try {
    const commit = JSON.parse(await readFile(join(dir, VENDOR_SNAPSHOT_FILE), "utf8")).commit;
    pinned = typeof commit === "string" ? commit : "";
  } catch (e) {
    pinned = e.code === "ENOENT" ? undefined : "";
  }
  const match = pinned ? (await compareWithCommit(pinned, undefined, (text) => exportCpp(parseProject(text)))).status : undefined;
  const { code, result } = syncHeader(projectText, current, pinned, () => match);
  if (code !== undefined) {
    const temporary = `${header}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, code);
      await rename(temporary, header);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return { path: header, ...result };
}
/** Read, change and save a project with the same revision check and atomic write as save_project. */
async function updateProject(path, args, change) {
  const current = parseProject(await readFile(path, "utf8"));
  if (args.expectedRevision !== undefined && args.expectedRevision !== null && args.expectedRevision !== current.revision)
    throw new Error(`Revision conflict: current revision is ${current.revision}. Re-read before editing.`);
  const { project, ...result } = change(current);
  if (args.dryRun) return { dryRun: true, revision: current.revision, ...result };
  const saved = await execute("save_project", { path, project, expectedRevision: current.revision });
  return { ...saved, ...result };
}
const commitOf = (repo, rev) =>
  new Promise((done, fail) => execFile("git", ["-C", repo, "rev-parse", "--verify", `${rev}^{commit}`], (error, out) => (error ? fail(new Error(`${rev} is not a commit.`)) : done(out.trim()))));
/**
 * The version to compare with: `before` as given, or with `base` (a branch, usually "main") the
 * commit where `after` left that branch, which is what a branch changes and what the app reviews.
 */
async function beforeOf(repo, args) {
  if (!args.base) return args.before;
  if (args.before) throw new Error("Give `before` or `base`, not both.");
  const tip = !args.after || args.after === WORKTREE ? "HEAD" : args.after;
  const from = args.base === "main" ? ((await mainRef(repo))?.rev ?? "main") : args.base;
  return new Promise((done, fail) =>
    execFile("git", ["-C", repo, "merge-base", from, tip], (error, out) => (error ? fail(new Error(`No common commit between ${from} and ${tip}.`)) : done(out.trim()))),
  );
}
export async function behaviorDiff(args) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  const [beforeSnap, afterSnap] = [await gitSnapshot(repo, (await beforeOf(repo, args)) ?? "HEAD"), await gitSnapshot(repo, args.after ?? WORKTREE)];
  const report = buildReport(beforeSnap, afterSnap);
  // The machines, model-checked on both versions: a problem this change brings is a finding.
  // Only when the machines changed: the check takes seconds on a big machine.
  const machinesBefore = beforeSnap.files[MACHINES_FILE],
    machinesAfter = afterSnap.files[MACHINES_FILE];
  const model = machinesBefore === machinesAfter ? { new: [], fixed: [], existing: [] } : modelDiff(machinesBefore, machinesAfter);
  for (const p of model.new) report.findings.push({ level: "yellow", area: "machines", text: `Model check: ${p.text}` });
  if (model.new.length && (report.level === "none" || report.level === "green")) report.level = "yellow";
  if (args.detail === "full") return { ...report, modelCheck: model };
  const { level, findings, errors, before, after } = report;
  return { before, after, level, findings, ...(model.new.length || model.fixed.length ? { modelCheck: { new: model.new, fixed: model.fixed, existing: model.existing.length } } : {}), errors };
}

/** Model-check both versions' machines: problems the change adds, removes, and keeps. */
export function modelDiff(beforeText, afterText) {
  const check = (text) => checkMachines(parseMachineSpecs(text).machines).problems;
  const before = beforeText === afterText ? null : check(beforeText);
  const after = check(afterText);
  if (!before) return { new: [], fixed: [], existing: after };
  const had = new Set(before.map((p) => p.id)),
    has = new Set(after.map((p) => p.id));
  return { new: after.filter((p) => !had.has(p.id)), fixed: before.filter((p) => !has.has(p.id)), existing: after.filter((p) => had.has(p.id)) };
}

/** Signal values and action results for a preview, checked against the project. */
function previewRun(project, routine, args) {
  const signals = Object.fromEntries(project.signals.map((s) => [s.key, s.initial]));
  for (const [key, value] of Object.entries(args.signals ?? {})) {
    const definition = project.signals.find((s) => s.key === key);
    if (!definition || typeof value !== definition.type || (typeof value === "number" && !Number.isFinite(value)))
      throw new Error(`Invalid signal ${key}`);
    signals[key] = value;
  }
  if (args.maxSeconds !== undefined && (!Number.isFinite(args.maxSeconds) || args.maxSeconds <= 0 || args.maxSeconds > 600))
    throw new Error("maxSeconds must be in (0,600].");
  if (args.mode !== undefined && !["path", "routine"].includes(args.mode)) throw new Error("mode must be path or routine.");
  if (args.actions !== undefined) {
    const callbacks = new Set(routine.nodes.flatMap((node) => [...(node.during ?? []), ...(node.action ? [node.action] : [])]));
    if (!args.actions || typeof args.actions !== "object" || Array.isArray(args.actions)) throw new Error("actions must map callback IDs to statuses.");
    for (const [id, status] of Object.entries(args.actions))
      if (!callbacks.has(id) || !["running", "succeeded", "failed"].includes(status)) throw new Error(`Invalid action status for ${id}`);
  }
  return simulate(project, routine, signals, args);
}
const round3 = (v) => Math.round(v * 1000) / 1000;
function compactStep(m) {
  return {
    step: m.step, name: m.name, start: m.start, end: m.end, seconds: Math.round((m.end - m.start) * 100) / 100,
    peakSpeed: m.peakSpeed, closest: m.closest, ...(m.reached ? {} : { reached: false }),
    ...(m.overshoot !== undefined ? { overshoot: m.overshoot } : {}), ...(m.headingOvershoot !== undefined ? { headingOvershoot: m.headingOvershoot } : {}),
  };
}
const compactIssue = ({ kind, severity, step, time, amount, timeLost, message, fix, suggest }) => ({ kind, severity, step, time, amount, timeLost, message, fix, ...(suggest ? { suggest } : {}) });
async function withProject(args) {
  if (typeof args.project !== "string" || !args.project) return args;
  const projectPath = resolve(args.project);
  return { ...args, project: parseProject(await readFile(projectPath, "utf8")), projectPath };
}
/** Preview and (optionally) logged run of one routine, as plot series and motion issues. */
async function routineRuns(project, args) {
  let routine = args.routine ? project.routines.find((r) => r.id === args.routine) : undefined;
  if (args.routine && !routine) throw new Error(`No routine ${args.routine}. Routines: ${project.routines.map((r) => r.id).join(", ")}.`);
  let log;
  if (args.log) {
    const recording = await loadLog(pathFor(args.log));
    // The runner and routine whose step IDs the log's goals name.
    let best;
    for (const runner of goalRunners(recording)) {
      const { samples } = logToSamples(recording, runner);
      const goals = new Set(samples.map((s) => s.goal));
      for (const r of routine ? [routine] : project.routines) {
        const hits = r.nodes.filter((n) => goals.has(n.id)).length;
        if (hits && (!best || hits > best.hits)) best = { runner, routine: r, samples: samples.filter((s) => r.nodes.some((n) => n.id === s.goal)), hits };
      }
    }
    if (!best) throw new Error(`The log has no goal progress for ${routine ? `routine ${routine.id}` : "any routine of this project"} (Mayhem/Goals/<runner>/id and /translationError). Is it a run of this auto?`);
    routine = best.routine;
    const t0 = best.samples[0].time, tEnd = best.samples[best.samples.length - 1].time;
    const infos = goalInfos(project, routine);
    const motion = analyzeMotion(best.samples, (g) => infos.get(g));
    const pose = logPose(recording, args.pose);
    const goalAt = (t) => { let lo = 0, hi = best.samples.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (best.samples[mid].time <= t) lo = mid; else hi = mid - 1; } return best.samples[lo]; };
    let actual = [];
    if (pose) {
      const xs = pose.x.samples.filter((s) => s.time >= t0 - 0.05 && s.time <= tEnd + 0.5);
      const raw = xs.map((s) => {
        const y = valueAt(pose.y, s.time), h = pose.heading ? valueAt(pose.heading, s.time) : undefined;
        const g = goalAt(s.time);
        return { time: s.time - t0, x: s.value, y, ...(typeof h === "number" ? { heading: Math.abs(h) > 2 * Math.PI + 0.1 ? (h * Math.PI) / 180 : h } : {}), goal: g.goal, error: s.time <= tEnd + 0.02 ? g.error : undefined };
      }).filter((p) => typeof p.y === "number");
      actual = raw.map((p, i) => {
        const a = raw[Math.max(0, i - 2)], b = raw[Math.min(raw.length - 1, i + 2)];
        const v = b.time > a.time ? Math.hypot(b.x - a.x, b.y - a.y) / (b.time - a.time) : 0;
        // A pose reset (the auto's start pose) is a jump, not a speed.
        return { ...p, speed: v > 8 ? undefined : v };
      });
    } else {
      // No pose channel: still chart distance to goal.
      actual = best.samples.map((s) => ({ time: s.time - t0, x: NaN, y: NaN, error: s.error, goal: s.goal }));
    }
    log = { path: pathFor(args.log), runner: best.runner, start: round3(t0), poseChannel: pose?.channel ?? null, motion, actual, t0 };
  }
  routine ??= project.routines[0];
  if (!routine) throw new Error("The project has no routines.");
  const options = { mode: args.mode ?? (args.signals || args.actions ? "routine" : "path"), signals: args.signals, actions: args.actions };
  // The robot runner's controller; the editor preview is drawn faintly for comparison.
  const result = previewRun(project, routine, { ...options, follower: "native" });
  const editor = previewRun(project, routine, options);
  const nodes = new Map(routine.nodes.map((n) => [n.id, n]));
  const series = (run) => run.frames.map((f) => {
    const g = nodes.get(f.node)?.goal;
    return { time: f.time, x: f.pose.x, y: f.pose.y, heading: f.pose.heading, speed: Math.hypot(f.velocity.vx, f.velocity.vy), goal: f.node, ...(g ? { error: Math.hypot(f.pose.x - g.x, f.pose.y - g.y) } : {}) };
  });
  return { routine, result, editor, planned: series(result), editorPlanned: series(editor), preview: motionOfFrames(project, routine, result.frames), log };
}
async function plotRoutine(path, args) {
  return plotProject(parseProject(await readFile(path, "utf8")), args);
}
/** `args.faint`: { series, label } drawn in place of the editor preview (the route before optimizing). */
async function plotProject(project, args) {
  const { routine, result, editor, planned, editorPlanned, preview, log } = await routineRuns(project, args);
  const shift = (i, dt) => ({ ...i, time: i.time - dt, start: i.start - dt, end: i.end - dt });
  const issues = [
    ...(log ? log.motion.issues.map((i) => ({ ...shift(i, log.t0), source: "log" })) : []),
    ...preview.issues.filter((i) => !log?.motion.issues.some((l) => l.step === i.step && l.kind === i.kind)).map((i) => ({ ...i, source: "preview" })),
  ];
  const png = plotAuto({
    project, routine, planned, editor: args.faint?.series ?? editorPlanned, editorLabel: args.faint?.label, actual: log?.actual.filter((p) => Number.isFinite(p.x)), issues,
    title: args.title ?? `${routine.name} · follower ${round3(result.frame.time)} s ${result.status} · editor ${round3(editor.frame.time)} s${log ? ` · log ${Math.round((log.actual.at(-1)?.time ?? 0) * 100) / 100} s` : ""}`,
  }, (d) => deflateSync(d));
  const out = args.out ? resolve(args.out) : join(tmpdir(), "mayhem-plots", `${routine.id}-${Date.now()}.png`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, png);
  return {
    image: out,
    note: `Read the image to see the auto. Purple: the robot runner's controller on an ideal drive; faint: ${args.faint ? args.faint.label.toLowerCase() : "the editor preview"}; orange: the logged run; red: problems (numbered as in \`issues\`).`,
    routine: routine.id,
    preview: { follower: "native", status: result.status, time: round3(result.frame.time), editorTime: round3(editor.frame.time), issues: preview.issues.map(compactIssue) },
    ...(log ? {
      log: {
        path: log.path, runner: log.runner, autoStart: log.start, poseChannel: log.poseChannel,
        time: round3((log.actual.at(-1)?.time ?? 0)),
        steps: log.motion.steps.filter((m) => m.stop).map(compactStep),
        issues: log.motion.issues.map(compactIssue),
      },
    } : {}),
  };
}
async function editRoutine(path, args) {
  const before = parseProject(await readFile(path, "utf8"));
  const summary = (project, id) => {
    const routine = project.routines.find((r) => r.id === id);
    if (!routine) return null;
    const run = previewRun(project, routine, { mode: "path", follower: "native" });
    const { issues } = motionOfFrames(project, routine, run.frames);
    return { status: run.status, time: round3(run.frame.time), issues };
  };
  const result = await updateProject(path, args, (project) => {
    const { project: edited, changes, routines } = editAuto(project, args.ops, args.routine);
    const next = parseProject(JSON.stringify(edited));
    const effects = routines.map((id) => {
      const b = summary(before, id), a = summary(next, id);
      const key = (i) => `${i.kind}:${i.step}`;
      return {
        routine: id,
        before: b && { status: b.status, time: b.time, issues: b.issues.length },
        after: a && { status: a.status, time: a.time, issues: a.issues.map(compactIssue) },
        ...(b && a ? { timeChange: round3(a.time - b.time), fixed: b.issues.filter((i) => !a.issues.some((j) => key(j) === key(i))).map(key), new: a.issues.filter((i) => !b.issues.some((j) => key(j) === key(i))).map(key) } : {}),
      };
    });
    return { project: next, changes, effects };
  });
  if (args.plot && result.effects?.length) {
    const target = args.dryRun ? undefined : await plotRoutine(path, { routine: result.effects[0].routine });
    if (target) result.plot = { image: target.image, note: target.note };
    else result.plot = "Not drawn on a dry run (the file is unchanged); run plot_auto after saving.";
  }
  return result;
}
async function optimizeRoutine(path, args) {
  const original = parseProject(await readFile(path, "utf8"));
  const options = { routine: args.routine, lock: args.lock, maxMove: args.maxMove, clearance: args.clearance, phases: args.phases, budget: args.budget, signals: args.signals };
  const score = (s) => ({
    status: s.status, time: s.time, distance: s.distance, passThrough: s.passThrough, warnings: s.warnings, headingWarnings: s.headingWarnings,
    clearance: { cost: round3(s.clearance.cost), depth: s.clearance.depth, hits: s.clearance.hits },
  });
  const run = optimizeAuto(original, options);
  const report = {
    routine: run.routine, timeSaved: run.timeSaved, before: score(run.before), after: score(run.after),
    ops: run.ops, changes: run.changes, suggestions: run.suggestions, fixed: run.fixed, evaluations: run.evaluations,
    ...(run.ops.length ? {} : { note: "Nothing to change: no candidate was faster without getting closer to an obstacle or adding a warning." }),
    ...(run.after.issues.length ? { issues: run.after.issues.map(compactIssue) } : {}),
  };
  let result;
  if (args.apply && run.ops.length) {
    result = await updateProject(path, args, () => ({ project: parseProject(JSON.stringify(run.project)), ...report }));
    result.applied = true;
  } else result = { ...report, applied: false, ...(run.ops.length ? { next: { tool: "optimize_auto", args: { path, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)), routine: run.routine, apply: true } } } : {}) };
  if (args.plot) {
    const before = previewRun(original, original.routines.find((r) => r.id === run.routine), { mode: "path", follower: "native" });
    const target = await plotProject(run.project, {
      routine: run.routine, out: args.out,
      faint: { label: "Before optimizing", series: before.frames.map((f) => ({ time: f.time, x: f.pose.x, y: f.pose.y, speed: Math.hypot(f.velocity.vx, f.velocity.vy), goal: f.node })) },
      title: `${run.project.routines.find((r) => r.id === run.routine).name} · optimized ${run.after.time} s (was ${run.before.time} s)`,
    });
    result.plot = { image: target.image, note: target.note };
  }
  return result;
}
export async function runScenarios(args, progress) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  args = { ...args, before: await beforeOf(repo, args) };
  const snapshot = await gitSnapshot(repo, args.after ?? WORKTREE);
  const machines = parseMachineSpecs(snapshot.files["tools/mayhem/machines.json"]).machines;
  const project = Object.keys(snapshot.files).find((p) => /^[^/]+\.mayhem\.json$/.test(p));
  const fileScenarios = snapshot.files["tools/mayhem/scenarios.json"];
  const merged = args.scenarios?.length
    ? JSON.stringify({ scenarios: [...((fileScenarios && JSON.parse(fileScenarios).scenarios) || []), ...args.scenarios] })
    : fileScenarios;
  const { scenarios, errors } = scenarioSet(project ? readProject(snapshot.files[project]).project : undefined, merged);
  const inline = new Set((args.scenarios ?? []).map((s) => s.name));
  const chosen = scenarios.filter(
    (s) =>
      (!args.groups?.length || args.groups.includes(s.group)) &&
      (!args.names?.length || args.names.some((n) => s.name.toLowerCase().includes(String(n).toLowerCase()))) &&
      (args.groups?.length || args.names?.length || !inline.size || inline.has(s.name)),
  );
  const proof = await runSimProof(await nodeRunner(repo), { before: args.before, after: args.after ?? WORKTREE }, chosen, machines, progress);
  // Red → green: what each scenario this change adds or changes (and each inline one) shows when
  // it also runs on the version before it. A scenario for a fix should fail there.
  const beforeScenarios = args.before && args.before !== WORKTREE ? await gitShow(repo, args.before, SCENARIOS_FILE) : undefined;
  const testedNames = new Set([
    ...scenarioChanges(beforeScenarios, fileScenarios).filter((c) => c.kind !== "removed").map((c) => c.name),
    ...inline,
  ]);
  const tests = scenarioTests(proof, testedNames);
  const partial = chosen.length < scenarios.length;
  // A run on a commit is kept on that commit, where the person reviewing it in the app reads it.
  let recorded;
  if (snapshot.rev !== WORKTREE) {
    const before = args.before && args.before !== WORKTREE ? await commitOf(repo, args.before) : undefined;
    const summary = {
      ...summarizeProof(proof, {
        by: (typeof args.by === "string" && args.by.trim()) || "an agent",
        before,
        // Fewer than every button, auto and team scenario: evidence, but not the whole proof.
        partial,
        // Inline scenarios aren't in the commit, so they prove nothing about it.
        tests: tests.filter((t) => !inline.has(t.scenario)),
      }),
      at: new Date().toISOString(),
    };
    await recordProof(repo, snapshot.rev, summary);
    recorded = { commit: snapshot.rev, summary: proofText(summary), ...(summary.partial ? { partial: true } : {}) };
  }
  // Auto runs: how each stop step moved in the physics sim (overshoot, heading swing, creeping in).
  const parsedProject = project ? readProject(snapshot.files[project]).project : undefined;
  const motion = new Map();
  for (const r of proof.results)
    if (r.logs.after && r.scenario.group === "auto") {
      try {
        const runs = motionOfLog(await loadLog(r.logs.after), parsedProject);
        const issues = runs.flatMap((m) => m.issues.map((i) => ({ ...compactIssue(i), routine: m.routine })));
        if (issues.length)
          motion.set(r, {
            issues: issues.map(({ routine, ...i }) => i),
            next: { tool: "plot_auto", args: { path: join(repo, project), ...(issues[0].routine ? { routine: issues[0].routine } : {}), log: r.logs.after } },
          });
      } catch {
        // A log the motion check cannot read is not a scenario failure.
      }
    }
  // Which machine states the runs reach and which a scenario checks; only meaningful on a full run.
  const coverage = partial ? undefined : scenarioCoverage(machines, proof.results);
  return {
    passed: proof.passed,
    changed: proof.changed,
    ...(recorded ? { recorded } : { recorded: false, note: "Not recorded: these are uncommitted files. Commit, then run with after: \"HEAD\" for a proof the reviewer sees." }),
    ...(tests.length || args.before ? { tests, testsNext: testsNext(tests, !!args.before) } : {}),
    ...(coverage
      ? {
          coverage: {
            states: coverage.states,
            reached: coverage.reached,
            checked: coverage.checked,
            gaps: coverage.gaps.slice(0, 12),
            ...(args.featureMap ? { map: coverage.map } : {}),
            ...(coverage.gaps.length > 12 ? { moreGaps: coverage.gaps.length - 12 } : {}),
          },
        }
      : {}),
    errors,
    results: proof.results.map((r) => ({
      scenario: r.scenario.name,
      ...(r.failed ? { failed: true } : {}),
      ...(r.beforeFailed ? { beforeFailed: true } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.checks.length ? { checks: r.checks } : {}),
      ...(r.differences.length ? { differences: r.differences } : {}),
      ...(r.after?.physics?.hits?.length ? { hits: r.after.physics.hits } : {}),
      // What happened, in brief: each machine's states after the scenario started (flapping collapsed).
      ...(r.after && (r.failed || r.differences.length || inline.has(r.scenario.name))
        ? { timeline: Object.fromEntries(r.after.tracks.filter((t) => t.changes.length > 1).map((t) => [t.name, describeTrack(t, 12)])) }
        : {}),
      // Not a failure: what the auto did that a person watching would notice. Fix, rerun, compare.
      ...(motion.has(r) ? { motion: motion.get(r) } : {}),
      logs: r.logs,
    })),
  };
}
/**
 * The gate a change passes before anyone reviews it ("agent verifies it"): the behavior review,
 * the model check and the whole sim proof against `base`, judged by fixed rules rather than by the
 * agent that wrote the change. `ready` is false with `reasons` when any rule fails.
 */
export async function verifyChange(args, progress) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  const base = args.base ?? "main",
    after = args.after ?? "HEAD";
  const reasons = [],
    warnings = [];
  if (after === WORKTREE) reasons.push("These are uncommitted files: commit, then verify the commit (its proof is what the reviewer reads).");
  const review = await behaviorDiff({ repo, base, after, detail: "full" });
  const sim = await runScenarios({ repo, base, after, by: args.by }, progress);
  for (const r of sim.results.filter((r) => r.failed))
    reasons.push(`“${r.scenario}” fails: ${r.error?.split("\n")[0] ?? (r.checks ?? []).filter((c) => !c.pass).map((c) => `${c.text} (${c.detail})`).join("; ")}`);
  for (const e of sim.errors) reasons.push(`scenarios.json: ${e}`);
  for (const t of sim.tests ?? []) {
    if (t.verdict === "breaks") reasons.push(`“${t.scenario}” passed on ${base} and fails now: this change broke it.`);
    if (t.verdict === "still-failing") reasons.push(`“${t.scenario}” fails on ${base} and still fails: the fix doesn't work yet.`);
    if (t.verdict === "passes-on-base") warnings.push(`“${t.scenario}” already passed on ${base}: it guards old behavior but doesn't show this change does anything.`);
  }
  for (const p of review.modelCheck.new) reasons.push(`Model check: ${p.text}`);
  for (const c of review.scenarios ?? []) if (c.weaker) reasons.push(`Scenario “${c.name}” was ${c.kind === "removed" ? "removed" : "loosened"}: never weaken a scenario to make a run pass.`);
  // Logic a scenario can prove: robot code and state machines. Tuned values and auto paths are
  // shown to the reviewer directly (and autos have their own motion checks), so they don't need one.
  const behaviorChanged = !!review.otherCode?.length || review.machines.some((m) => m.kind !== "same");
  const reproduced = (sim.tests ?? []).filter((t) => t.verdict === "red-green");
  if (args.refactor) {
    if (sim.changed) reasons.push(`Declared a refactor, but ${sim.changed} scenario(s) behave differently: ${sim.results.filter((r) => r.differences).map((r) => `“${r.scenario}”`).join(", ")}.`);
  } else if (behaviorChanged && !reproduced.length)
    reasons.push(`The robot's behavior changed (${review.findings.slice(0, 3).map((f) => f.text).join("; ")}) and no new scenario fails without this change. Add the scenario that shows what it fixes or adds (red → green), or pass refactor: true if nothing should behave differently.`);
  for (const r of sim.results.filter((r) => r.differences && !r.failed)) warnings.push(`“${r.scenario}” behaves differently: ${r.differences.slice(0, 2).join("; ")}`);
  if (review.level === "red") warnings.push(`Safety-related change (${review.findings.filter((f) => f.level === "red").map((f) => f.text).join("; ")}): a person must check it carefully.`);
  const touched = new Set(review.machines.filter((m) => m.kind !== "same").map((m) => m.name));
  const gaps = (sim.coverage?.gaps ?? []).filter((g) => touched.has(g.machine));
  for (const g of gaps) warnings.push(`${g.machine} ${g.state}: ${g.kind === "unreached" ? "no scenario reaches it" : "reached but no scenario checks it (see coverage draft)"}.`);
  return {
    ready: reasons.length === 0,
    reasons,
    warnings,
    level: review.level,
    ...(sim.recorded ? { recorded: sim.recorded } : {}),
    tests: sim.tests ?? [],
    // Scenarios that fail on the base and pass here: what this change fixes, team scenarios included.
    fixes: sim.results.filter((r) => r.beforeFailed && !r.failed).map((r) => r.scenario),
    ...(gaps.length ? { gaps } : {}),
    next: reasons.length
      ? "Fix the first reason, commit, and verify again. Don't weaken scenarios or the gate to pass."
      : "Ready for a person to review in the Mayhem app (Changes). Don't merge it yourself.",
  };
}

/** One file at a revision, or undefined when it isn't there. */
export function gitShow(repo, rev, path) {
  return new Promise((done) => execFile("git", ["-C", repo, "show", `${rev}:${path}`], { maxBuffer: 64 << 20 }, (error, out) => done(error ? undefined : out)));
}

/** What to do next about the scenarios a change adds, from their red → green verdicts. */
function testsNext(tests, compared) {
  if (!compared)
    return "Nothing to judge these scenarios against: run again with `before` (e.g. \"HEAD\" before you fix) or `base: \"main\"` to see whether each fails without the change.";
  if (!tests.length)
    return "No scenario was added or changed. For a fix, write the scenario that shows the bug first (inline `scenarios`, before: \"HEAD\"), see it fail, fix, see it pass, then add it to tools/mayhem/scenarios.json.";
  const by = (v) => tests.filter((t) => t.verdict === v).map((t) => `“${t.scenario}”`).join(", ");
  const notes = [];
  if (by("breaks")) notes.push(`${by("breaks")} passed before this change and fail now: this change broke it.`);
  if (by("still-failing")) notes.push(`${by("still-failing")} fail before and after: the fix doesn't work yet, or the expectation is wrong (read its timeline and log_diagnose its log).`);
  if (by("passes-on-base")) notes.push(`${by("passes-on-base")} already passed before this change: fine as a guard, but it doesn't show a fix. For a bug, tighten it until it fails without the fix.`);
  if (by("red-green")) notes.push(`${by("red-green")} fail without this change and pass with it: they reproduce what it fixes. Keep them in tools/mayhem/scenarios.json.`);
  return notes.join(" ");
}

export async function execute(name, args) {
  if (name === "list_changes") {
    if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
    return reviewBranches(resolve(args.repo));
  }
  if (name === "behavior_diff") return behaviorDiff(args);
  if (name === "run_scenarios") return runScenarios(args);
  if (name === "verify_change") return verifyChange(args);
  if (name === "check_machines") {
    if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
    const repo = resolve(args.repo);
    if (args.base) {
      const before = await beforeOf(repo, { base: args.base, after: args.rev });
      const text = async (rev) => (rev === WORKTREE ? (await gitSnapshot(repo, WORKTREE)).files[MACHINES_FILE] : gitShow(repo, rev, MACHINES_FILE));
      const diff = modelDiff(await text(before), await text(args.rev ?? WORKTREE));
      return { new: diff.new, fixed: diff.fixed, existing: diff.existing };
    }
    const rev = args.rev ?? WORKTREE;
    const text = rev === WORKTREE ? (await gitSnapshot(repo, WORKTREE)).files[MACHINES_FILE] : await gitShow(repo, rev, MACHINES_FILE);
    if (text === undefined) throw new Error(`No ${MACHINES_FILE} at ${rev}.`);
    return checkMachines(parseMachineSpecs(text).machines);
  }
  if (name === "validate_project")
    return { issues: validateProject(args.project) };
  if (name === "inspect_live_robot") {
    if (typeof args.host !== "string" || !args.host)
      throw new Error("A robot address is required");
    const duration = args.durationMs ?? 1000;
    if (!Number.isInteger(duration) || duration < 100 || duration > 5000)
      throw new Error("durationMs must be 100–5000");
    if (
      args.topics !== undefined &&
      (!Array.isArray(args.topics) ||
        args.topics.some((t) => typeof t !== "string"))
    )
      throw new Error("Topics must be strings");
    return await new Promise((resolve, reject) => {
      let latest = { status: "disconnected", topics: {} };
      const observer = new NT4Observer(args.host, (value) => {
        latest = value;
      });
      observer.setExtraTopics(args.topics ?? []);
      observer.connect();
      setTimeout(() => {
        const result = latest;
        observer.disconnect();
        if (result.status !== "connected")
          reject(new Error(result.error ?? "Could not read a connected robot"));
        else resolve(result);
      }, duration);
    });
  }
  if (name === "open_in_app") return openInApp(args.path, args.app);
  if (name === "vendor_cpp")
    return vendorCpp(args.robotDir, { dest: args.dest, snapshot: args.snapshot, check: args.check === true });
  if (name === "log_compare") {
    const [before, after] = [pathFor(args.before), pathFor(args.after)];
    return compareLogs(await loadLog(before, args.mapping), await loadLog(after, args.mapping), await withProject(args));
  }
  const path = pathFor(args.path);
  if (name === "apply_machine_spec") {
    const specs = asList(args.spec, "machines");
    return updateProject(path, args, (project) => {
      const { project: next, machines, warnings } = applyMachineSpecs(project, specs);
      return { project: next, machines, warnings, ...(args.dryRun ? { manifests: specs.map(machineFromSpec) } : {}) };
    });
  }
  if (name === "machine_spec") {
    const project = parseProject(await readFile(path, "utf8"));
    const machine = (project.extensions.machines ?? []).find((m) => m?.id === args.machine);
    if (!machine) throw new Error(`No machine ${args.machine}. Machines: ${(project.extensions.machines ?? []).map((m) => m?.id).join(", ") || "none"}.`);
    return specFromMachine(machine);
  }
  if (name === "create_step_group") {
    return updateProject(path, args, (project) => {
      const routine = project.routines.find((r) => r.id === args.routine);
      if (!routine) throw new Error(`No routine ${args.routine}. Routines: ${project.routines.map((r) => r.id).join(", ")}.`);
      if (!!args.group === !!args.use) throw new Error("Give `group` (make a group from steps) or `use` (add a use of a group).");
      let use;
      if (args.group) {
        const group = createGroup(project, routine, args.group);
        use = routine.uses.find((u) => u.group === group.id);
      } else {
        if (!project.groups?.some((g) => g.id === args.use.group)) throw new Error(`No step group ${args.use.group}. Groups: ${(project.groups ?? []).map((g) => g.id).join(", ") || "none"}.`);
        use = addGroupUse(project, routine, args.use.group, routine.uses?.find((u) => u.id === args.use.like));
        Object.assign(use.args, args.use.args ?? {});
      }
      // Regenerate and check (wrong arguments are reported on the steps they produce).
      const next = parseProject(JSON.stringify(project));
      const made = next.routines.find((r) => r.id === routine.id);
      return {
        project: next,
        group: next.groups.find((g) => g.id === use.group),
        use: made.uses.find((u) => u.id === use.id),
        steps: made.nodes.filter((n) => n.fromGroup?.use === use.id).map((n) => n.id),
      };
    });
  }
  if (name === "import_mtraj_route") {
    const specs = routeSpecs(args.spec);
    const base = dirname(path);
    const files = new Map();
    for (const spec of specs)
      for (const pass of spec.passes ?? []) {
        if (typeof pass?.mtraj !== "string") throw new Error(`Routine ${spec.routine}: every pass needs an "mtraj" path.`);
        const file = resolve(base, pass.mtraj);
        if (!files.has(file)) files.set(file, JSON.parse(await readFile(file, "utf8")));
      }
    return updateProject(path, args, (project) => {
      const routines = [], warnings = [];
      for (const spec of specs) {
        const result = routineFromMtraj(project, spec, (p) => files.get(resolve(base, p)));
        project = result.project;
        routines.push({ routine: result.routine, steps: result.steps });
        warnings.push(...result.warnings);
      }
      return {
        project,
        routines,
        warnings,
        ...(args.dryRun ? { preview: project.routines.filter((r) => specs.some((s) => s.routine === r.id)) } : {}),
      };
    });
  }
  if (name === "export_cpp")
    return { code: exportCpp(parseProject(await readFile(path, "utf8"))) };
  if (name === "inspect_project")
    return parseProject(await readFile(path, "utf8"));
  if (name === "save_project") {
    const project = parseProject(JSON.stringify(args.project));
    await mkdir(dirname(path), { recursive: true });
    const lock = await open(path + ".lock", "wx");
    const temporary = `${path}.${process.pid}.tmp`;
    let text;
    try {
      let previous = null;
      try {
        previous = parseProject(await readFile(path, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (args.expectedRevision !== (previous?.revision ?? null))
        throw new Error(
          `Revision conflict: current revision is ${previous?.revision ?? "new"}. Re-read before editing.`,
        );
      project.revision = previous ? previous.revision + 1 : 0;
      text = JSON.stringify(project, null, 2) + "\n";
      await writeFile(temporary, text);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(path + ".lock");
    }
    // The robot drives MayhemProject.h, not the project file: keep the two in step.
    let header;
    try {
      header = await regenerateHeader(path, text);
    } catch (e) {
      header = { status: "failed", message: `The project was saved, but MayhemProject.h could not be regenerated: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (header?.message) process.stderr.write(`Warning: ${header.message}\n`);
    return { path, revision: project.revision, ...(header ? { header } : {}) };
  }
  if (name === "simulate_auto") {
    const project = parseProject(await readFile(path, "utf8"));
    const routine = args.routine
      ? project.routines.find((r) => r.id === args.routine)
      : project.routines[0];
    if (!routine) throw new Error("Routine ID does not exist.");
    const result = previewRun(project, routine, args);
    // Motion as the robot's own controller drives it (the editor preview brakes on an ideal profile).
    const robot = args.follower === "native" ? result : previewRun(project, routine, { ...args, follower: "native" });
    const motion = motionOfFrames(project, routine, robot.frames);
    return {
      mode: args.mode ?? "routine",
      status: result.status,
      time: result.frame.time,
      pose: result.frame.pose,
      events: result.frame.events,
      steps: result.frames.length - 1,
      // Steps where robot code limits the speed (robotSpeedLimit): not modeled, the robot is slower.
      notModeled: unmodeledLimits(routine, result.frames),
      // Event markers (pickups) that fire with the robot front > 45° off its travel direction.
      headingWarnings: headingLints(result.frames, undefined, (id) => routine.nodes.find((n) => n.id === id)?.name ?? id)
        .map(({ time, key, node, degrees, message }) => ({ time, key, node, degrees: Math.round(degrees), message })),
      // How each stop step moved, and the ones that overshoot, swing past their heading or creep in.
      motion: {
        follower: "native",
        status: robot.status,
        time: round3(robot.frame.time),
        ...(Math.abs(robot.frame.time - result.frame.time) > 0.2 ? { note: `The robot's follower takes ${round3(robot.frame.time)} s; the editor preview (${round3(result.frame.time)} s) brakes on an ideal profile the robot's controller does not have.` } : {}),
        steps: motion.steps.filter((m) => m.stop).map(compactStep),
        issues: motion.issues,
      },
    };
  }
  if (name === "log_diagnose") return diagnoseLog(await loadLog(path, args.mapping), await withProject(args));
  if (name === "plot_auto") return plotRoutine(path, args);
  if (name === "edit_auto") return editRoutine(path, args);
  if (name === "optimize_auto") return optimizeRoutine(path, args);
  if (
    ["list_log_channels", "log_table", "log_anomalies", "log_what_changed", "log_events", "log_states"].includes(name)
  ) {
    const recording = await loadLog(path, args.mapping);
    if (name === "log_states") return machineStates(recording, args);
    if (name === "list_log_channels") return listChannels(recording, args);
    if (name === "log_table") return logTable(recording, args);
    if (name === "log_anomalies") return findAnomalies(recording, args);
    if (name === "log_what_changed") return whatChanged(recording, args);
    return logEvents(recording, args);
  }
  if (name === "analyze_log") {
    const bytes = await readFile(path);
    const recording = path.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          path,
          { maxSamples: AGENT_LOG_SAMPLES },
        )
      : parseRecordingJSON(bytes.toString("utf8"));
    const result = analyze(recording, args.mapping, args.policy);
    if (args.detail === "full")
      return {
        name: recording.name,
        duration: recording.duration,
        channels: recording.channels.map((c) => ({ name: c.name, type: c.type, samples: c.samples.length })),
        warnings: recording.warnings,
        ...result,
      };
    const { estimatedCurrent, ...rest } = result;
    const from = Number.isFinite(args.from) ? args.from : -Infinity;
    const to = Number.isFinite(args.to) ? args.to : Infinity;
    const maxSamples = args.maxSamples ?? 40;
    const maxChannels = args.maxChannels ?? 30;
    const pool = estimatedCurrent
      ? [...recording.channels, estimatedCurrent]
      : recording.channels;
    const byType = {};
    for (const c of recording.channels) {
      const e = (byType[c.type] ??= { count: 0, withSamples: 0 });
      e.count++;
      if (c.samples.length) e.withSamples++;
    }
    const prefixes = {};
    for (const c of recording.channels) {
      const key = c.name.split("/").slice(0, 3).join("/");
      prefixes[key] = (prefixes[key] ?? 0) + 1;
    }
    const out = {
      name: recording.name,
      duration: recording.duration,
      warnings: recording.warnings,
      ...rest,
      channelOverview: {
        total: recording.channels.length,
        byType,
        topPrefixes: Object.entries(prefixes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([prefix, count]) => ({ prefix, count })),
      },
      topCurrentDraws: currentBreakdown(
        recording,
        rest.mapping?.current,
        12,
        rest.power?.currentChannels,
      ),
    };
    if (estimatedCurrent)
      out.estimatedCurrentSummary = channelStats(estimatedCurrent, from, to, maxSamples);
    if (Array.isArray(args.channels) && args.channels.length) {
      const needles = args.channels.map((n) => String(n).toLowerCase());
      const matched = pool.filter((c) =>
        needles.some((n) => c.name.toLowerCase().includes(n)),
      );
      out.query = {
        window: { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : recording.duration },
        matched: matched.length,
        truncated: matched.length > maxChannels,
        channels: matched.slice(0, maxChannels).map((c) => channelStats(c, from, to, maxSamples)),
      };
    }
    return out;
  }
  throw new Error(`Unknown tool ${name}`);
}
async function main() {
  const [command, path, json] = process.argv.slice(2);
  if (command === "mcp") {
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      let request;
      try {
        request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result;
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mayhem-suite", version: "0.1.0" },
            instructions:
              "Use live-pose goals and measured-condition transitions by default. You may implement arbitrary C++ and custom action callbacks. The visual model documents behavior, not a restriction on capabilities. People review your robot code changes in the Mayhem app by behavior, per branch: work on a branch (never main), commit, then run behavior_diff and run_scenarios with base \"main\" and after \"HEAD\" before saying a change is ready; run_scenarios records the sim proof on the commit, which is what the reviewer reads. Fixing a bug is test-first: write the scenario that shows it, see run_scenarios fail it on the unfixed code, fix until its `tests` verdict is red-green, and commit the scenario; close `coverage` gaps on the machines you touch. Before saying a change is ready, run verify_change on the commit and fix its reasons; check_machines model-checks the state machines. Given a log (a sim run or a match), start with log_diagnose and run each finding's `next`; after a fix, rerun the same scenario and log_compare the two logs. For autos: change them with edit_auto (small ops, it reports what each change did), run optimize_auto on them (it makes the path faster within the BLine model and returns edit_auto ops; apply: true saves), look at them with plot_auto (read the PNG; pass a run_scenarios log to see the real run), and fix every motion issue (overshoot and crawl back, heading swing, creeping in) that simulate_auto, run_scenarios or log_diagnose reports, using its suggest ops. See docs/SUITE_AGENTS.md.",
          };
        else if (request.method === "tools/list") result = { tools };
        else if (request.method === "tools/call") {
          try {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    await execute(
                      request.params.name,
                      request.params.arguments ?? {},
                    ),
                  ),
                },
              ],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        } else if (request.method === "ping") result = {};
        else {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            }) + "\n",
          );
          continue;
        }
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32700, message: error.message },
          }) + "\n",
        );
      }
    }
    return;
  }
  if (command === "cpp") {
    // cpp <project> [--out <header>] [--check <header>]
    const flags = process.argv.slice(4);
    let out, check;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--out" && flags[i + 1]) out = flags[++i];
      else if (flags[i] === "--check" && flags[i + 1]) check = flags[++i];
      else throw new Error("Usage: node scripts/mayhem.mjs cpp <project> [--out <header>] [--check <header>]");
    }
    const { code } = await execute("export_cpp", { path });
    if (check) {
      let current = null;
      try {
        current = (await readFile(check, "utf8")).replace(/\r\n/g, "\n");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (current !== code) {
        console.error(`${check} is ${current === null ? "missing" : "stale"}. Regenerate: node scripts/mayhem.mjs cpp ${path} --out ${check}`);
        process.exitCode = 1;
      }
      return;
    }
    if (out) {
      // Leave an up-to-date header untouched so builds do not recompile it.
      const current = await readFile(out, "utf8").catch(() => null);
      if (current !== code) {
        await mkdir(dirname(resolve(out)), { recursive: true });
        const temporary = `${out}.${process.pid}.tmp`;
        await writeFile(temporary, code);
        await rename(temporary, out);
      }
      return;
    }
    process.stdout.write(code);
    return;
  }
  if (command === "machine" || command === "route") {
    // machine apply <project> <spec> | machine spec <project> <id> | route import-mtraj <project> <spec>
    const [sub, project, specArg, ...flags] = process.argv.slice(3);
    const usage = "Usage: node scripts/mayhem.mjs machine apply <project> <spec.json|-|JSON> [--dry-run] [--expect-revision N] | machine spec <project> <machine id> | route import-mtraj <project> <spec.json|-|JSON> [--dry-run] [--expect-revision N]";
    if (!project || !specArg) throw new Error(usage);
    if (command === "machine" && sub === "spec") {
      console.log(JSON.stringify(await execute("machine_spec", { path: project, machine: specArg }), null, 2));
      return;
    }
    const tool = command === "machine" && sub === "apply" ? "apply_machine_spec" : command === "route" && sub === "import-mtraj" ? "import_mtraj_route" : null;
    if (!tool) throw new Error(usage);
    const args = { path: project };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--dry-run") args.dryRun = true;
      else if (flags[i] === "--expect-revision" && /^\d+$/.test(flags[i + 1] ?? "")) args.expectedRevision = Number(flags[++i]);
      else throw new Error(usage);
    }
    const text =
      specArg === "-"
        ? await new Promise((done) => { let t = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (t += c)); process.stdin.on("end", () => done(t)); })
        : /^\s*[[{]/.test(specArg) ? specArg : await readFile(specArg, "utf8");
    args.spec = JSON.parse(text);
    console.log(JSON.stringify(await execute(tool, args), null, 2));
    return;
  }
  if (command === "vendor") {
    // vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check]
    const flags = process.argv.slice(4);
    const options = {};
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--check") options.check = true;
      else if ((flags[i] === "--dest" || flags[i] === "--snapshot") && flags[i + 1]) options[flags[i].slice(2)] = flags[++i];
      else throw new Error("Usage: node scripts/mayhem.mjs vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check]");
    }
    const result = await vendorCpp(path, options);
    if (options.check && !result.upToDate) {
      console.error(`Vendored Mayhem C++ headers are stale:\n  ${result.problems.join("\n  ")}\nRun: node scripts/mayhem.mjs vendor ${path}${options.dest ? ` --dest ${options.dest}` : ""}${options.snapshot ? ` --snapshot ${options.snapshot}` : ""}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "review") {
    // review <repo> [before] [after] [--json]
    const rest = process.argv.slice(4);
    const full = rest.includes("--json");
    const [before, after] = rest.filter((a) => a !== "--json");
    const result = await behaviorDiff({ repo: path, before, after, detail: full ? "full" : "summary" });
    if (full) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.before.label}\n  → ${result.after.label}\nRisk: ${result.level}`);
      for (const f of result.findings) console.log(`  [${f.level}] ${f.area}: ${f.text}`);
      const mark = { "red-green": "✓ red→green", "passes-on-base": "· passes on base", "still-failing": "✗ still failing", breaks: "✗ breaks", untested: "? untested" };
      for (const t of result.tests ?? []) console.log(`  ${mark[t.verdict]}  ${t.scenario}${t.caught ? `\n      caught: ${t.caught.join("; ")}` : ""}`);
      if (result.testsNext) console.log(`  ${result.testsNext}`);
      if (result.coverage) {
        const c = result.coverage;
        console.log(`  coverage: ${c.reached}/${c.states} states reached, ${c.checked} checked by a scenario`);
        for (const g of c.gaps)
          console.log(`    ${g.kind === "unreached" ? "never reached" : "unchecked    "} ${g.machine} ${g.state}${g.reachedBy ? ` (reached in “${g.reachedBy[0].scenario}” at ${g.reachedBy[0].time} s)` : g.enteredBy?.length ? ` (via ${g.enteredBy.map((e) => e.transition).join(", ")})` : ""}`);
        if (c.moreGaps) console.log(`    … ${c.moreGaps} more (--json)`);
      }
      for (const e of result.errors) console.log(`  error: ${e}`);
    }
    return;
  }
  if (command === "sim") {
    // sim <repo> [after] [--before <rev> | --base <branch>] [--only button,auto,custom] [--by <name>] [--json]
    const rest = process.argv.slice(4);
    const args = { repo: path };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--before") args.before = rest[++i];
      else if (rest[i] === "--base") args.base = rest[++i];
      else if (rest[i] === "--by") args.by = rest[++i];
      else if (rest[i] === "--only") args.groups = rest[++i].split(",");
      else if (rest[i] === "--json") args.json = true;
      else args.after = rest[i];
    }
    const result = await runScenarios(args, (text, done, total) => process.stderr.write(`\r${done}/${total} ${text.padEnd(60).slice(0, 60)}`));
    process.stderr.write("\n");
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.passed ? "PASSED" : "FAILED"}${args.before || args.base ? ` · ${result.changed} scenario(s) behave differently` : ""}`);
      console.log(result.recorded ? `  recorded on ${result.recorded.commit.slice(0, 7)}: ${result.recorded.summary}` : `  ${result.note}`);
      for (const r of result.results) {
        if (!r.failed && !r.differences) continue;
        console.log(`  ${r.failed ? "✗" : "≠"} ${r.scenario}`);
        for (const c of r.checks ?? []) if (!c.pass) console.log(`      expected: ${c.text} — ${c.detail}`);
        for (const d of r.differences ?? []) console.log(`      ${d}`);
        if (r.error) console.log(`      ${r.error.split("\n")[0]}`);
      }
      const mark = { "red-green": "✓ red→green", "passes-on-base": "· passes on base", "still-failing": "✗ still failing", breaks: "✗ breaks", untested: "? untested" };
      for (const t of result.tests ?? []) console.log(`  ${mark[t.verdict]}  ${t.scenario}${t.caught ? `\n      caught: ${t.caught.join("; ")}` : ""}`);
      if (result.testsNext) console.log(`  ${result.testsNext}`);
      if (result.coverage) {
        const c = result.coverage;
        console.log(`  coverage: ${c.reached}/${c.states} states reached, ${c.checked} checked by a scenario`);
        for (const g of c.gaps)
          console.log(`    ${g.kind === "unreached" ? "never reached" : "unchecked    "} ${g.machine} ${g.state}${g.reachedBy ? ` (reached in “${g.reachedBy[0].scenario}” at ${g.reachedBy[0].time} s)` : g.enteredBy?.length ? ` (via ${g.enteredBy.map((e) => e.transition).join(", ")})` : ""}`);
        if (c.moreGaps) console.log(`    … ${c.moreGaps} more (--json)`);
      }
      for (const e of result.errors) console.log(`  error: ${e}`);
    }
    return;
  }
  if (command === "verify") {
    // verify <repo> [after] [--base <branch>] [--by <name>] [--refactor] [--json]: exit 1 unless ready.
    const rest = process.argv.slice(4);
    const args = { repo: path };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--base") args.base = rest[++i];
      else if (rest[i] === "--by") args.by = rest[++i];
      else if (rest[i] === "--refactor") args.refactor = true;
      else if (rest[i] === "--json") args.json = true;
      else args.after = rest[i];
    }
    const result = await verifyChange(args, (text, done, total) => process.stderr.write(`\r${done}/${total} ${text.padEnd(60).slice(0, 60)}`));
    process.stderr.write("\n");
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.ready ? "READY" : "NOT READY");
      for (const r of result.reasons) console.log(`  ✗ ${r}`);
      for (const w of result.warnings) console.log(`  ! ${w}`);
      for (const t of result.tests) console.log(`  ${t.verdict === "red-green" ? "✓" : "·"} ${t.verdict}: ${t.scenario}`);
      if (result.recorded) console.log(`  proof on ${result.recorded.commit.slice(0, 7)}: ${result.recorded.summary}`);
      console.log(`  ${result.next}`);
    }
    process.exitCode = result.ready ? 0 : 1;
    return;
  }
  if (command === "factory") {
    // factory <repo> [--baseline <rev>] [--max n] [--rounds n] [--existing] [--pr] [--dry-run] [--agent <cli>] [--json]
    const rest = process.argv.slice(4);
    const args = { repo: path };
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--baseline") args.baseline = rest[++i];
      else if (flag === "--max") args.max = Number(rest[++i]);
      else if (flag === "--rounds") args.rounds = Number(rest[++i]);
      else if (flag === "--agent") args.agent = rest[++i];
      else if (flag === "--existing") args.includeExisting = true;
      else if (flag === "--pr") args.pr = true;
      else if (flag === "--dry-run") args.dryRun = true;
      else if (flag === "--json") args.json = true;
      else throw new Error(`Unknown factory flag ${flag}`);
    }
    const { runFactory } = await import("./factory.mjs");
    const result = await runFactory(
      { runScenarios, verifyChange, modelDiff, gitShow, mainRef, diagnose: (log) => execute("log_diagnose", { path: log, limit: 200 }) },
      args,
    );
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.text}\n\nReport: ${result.report}`);
    return;
  }
  if (command === "check") {
    // check <repo> [rev] [--base <branch>] [--json]: model-check the state machines; exit 1 on problems.
    const rest = process.argv.slice(4);
    const args = { repo: path };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--base") args.base = rest[++i];
      else if (rest[i] === "--json") args.json = true;
      else args.rev = rest[i];
    }
    const r = await execute("check_machines", args);
    const problems = r.problems ?? r.new;
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const m of r.machines ?? []) console.log(`${m.machine}: ${m.reachable}/${m.states} states reachable, ${m.combinations} input combinations${m.partial ? " (sampled)" : ""}`);
      for (const p of problems) console.log(`  ✗ [${p.kind}] ${p.text}`);
      for (const p of r.fixed ?? []) console.log(`  ✓ fixed [${p.kind}] ${p.text}`);
      if (!problems.length) console.log(args.base ? "No new problems." : "No problems.");
    }
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (command === "diagnose" || command === "compare") {
    // diagnose <log> [--json] [--ignore a,b] | compare <before log> <after log> [--json] [--ignore a,b]
    const rest = process.argv.slice(command === "compare" ? 5 : 4);
    const flags = { json: rest.includes("--json"), ignore: rest.includes("--ignore") ? rest[rest.indexOf("--ignore") + 1].split(",") : undefined, project: rest.includes("--project") ? rest[rest.indexOf("--project") + 1] : undefined };
    if (command === "compare") {
      const r = await execute("log_compare", { before: path, after: process.argv[4], ignore: flags.ignore, project: flags.project });
      if (flags.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${r.verdict.toUpperCase()} · before ${r.before.counts.error}E/${r.before.counts.warning}W → after ${r.after.counts.error}E/${r.after.counts.warning}W`);
      for (const f of r.fixed) console.log(`  ✓ fixed     ${f.title}`);
      for (const f of r.new) console.log(`  ✗ new       [${f.severity}] ${f.title} @ ${f.at.join(", ")} s\n              ${f.detail}`);
      for (const f of r.persisting) console.log(`  ${f.trend === "better" ? "↓" : f.trend === "worse" ? "↑" : "="} ${f.trend.padEnd(9)} [${f.severity}] ${f.title} (${f.before.occurrences}× → ${f.after.occurrences}×)`);
      for (const m of r.metrics) console.log(`    ${m.name}: ${m.before} → ${m.after}`);
      for (const s of r.states) console.log(`    states ${s.channel}:\n      before ${s.before}\n      after  ${s.after}`);
      return;
    }
    const r = await execute("log_diagnose", { path, ignore: flags.ignore, limit: 200, project: flags.project });
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.info} info · ${r.context.phases.map((p) => `${p.mode} ${p.start}-${p.end}`).join(", ")}`);
    for (const f of r.findings) console.log(`  [${f.severity}] ${f.title} (${f.occurrences}× @ ${f.at.join(", ")} s, ${f.phases.join("/")})\n      ${f.detail}\n      id ${f.id}`);
    return;
  }
  if (command === "tool") {
    // tool <MCP tool name> '<JSON arguments>': any MCP tool from the shell (e.g. list_changes).
    if (!tools.some((t) => t.name === path)) throw new Error(`Unknown tool ${path}. Tools: ${tools.map((t) => t.name).join(", ")}`);
    console.log(JSON.stringify(await execute(path, json ? JSON.parse(json) : {}), null, 2));
    return;
  }
  if (command === "example") {
    console.log(JSON.stringify(sampleProject, null, 2));
    return;
  }
  const names = {
    inspect: "inspect_project",
    validate: "validate_project",
    save: "save_project",
    simulate: "simulate_auto",
    analyze: "analyze_log",
    cpp: "export_cpp",
    live: "inspect_live_robot",
    open: "open_in_app",
    plot: "plot_auto",
    edit: "edit_auto",
    optimize: "optimize_auto",
  };
  if (!names[command])
    throw new Error(
      "Usage: node scripts/mayhem.mjs example | tool <mcp tool> '<JSON>' | review <robot repo> [before] [after] [--json] | sim <robot repo> [after] [--before <rev> | --base <branch>] [--only button,auto,custom] [--json] | verify <robot repo> [after] [--base main] [--by <name>] [--refactor] [--json] | check <robot repo> [rev] [--base main] [--json] | factory <robot repo> [--baseline <rev>] [--max n] [--rounds n] [--existing] [--pr] [--dry-run] [--json] | diagnose <log> [--project <file>] [--ignore a,b] [--json] | compare <before log> <after log> [--project <file>] [--ignore a,b] [--json] | inspect <file> | validate <file> | simulate <file> [options JSON] | analyze <log> [options JSON] | save <file> <{project,expectedRevision}> | cpp <file> [--out <header>] [--check <header>] | vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check] | machine apply <file> <spec> [--dry-run] | machine spec <file> <machine> | route import-mtraj <file> <spec> [--dry-run] | plot <file> [{routine, log, out}] | edit <file> <{ops, routine, dryRun, plot}> | optimize <file> [{routine, lock, maxMove, phases, apply, plot}] | open <file> | live <robot-address> [options JSON] | mcp",
    );
  const args = { ...(json ? JSON.parse(json) : {}), path };
  if (command === "validate")
    args.project = JSON.parse(await readFile(path, "utf8"));
  if (command === "live") args.host = path;
  const result = await execute(names[command], args);
  console.log(
    command === "cpp" ? result.code : JSON.stringify(result, null, 2),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
